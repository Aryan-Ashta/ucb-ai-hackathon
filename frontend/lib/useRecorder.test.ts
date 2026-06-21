/**
 * Tests for useRecorder hook — the most state-heavy piece of the quiz UI.
 *
 * MediaRecorder + AudioContext don't exist in jsdom; we stub them with
 * controllable fakes so we can drive transitions deterministically.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRecorder, type RecorderState } from "@/lib/useRecorder";

class FakeMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  constructor(public stream: MediaStream) {}
  start() {
    this.state = "recording";
    // Simulate one chunk arriving.
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) });
    });
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

function installFakeMediaRecorder() {
  // The hook does `new MediaRecorder(stream)` — install a permissive stub on
  // the global scope. The cast is double because MediaRecorder's full
  // surface (BlobEvent, MediaRecorderOptions, etc.) isn't worth modeling in
  // the test — we only exercise the slice the hook actually uses.
  (globalThis as unknown as Record<string, unknown>).MediaRecorder =
    FakeMediaRecorder as unknown as typeof MediaRecorder;
}

function installFakeGetUserMedia(opts: { deny?: boolean } = {}) {
  // Build the tracks ONCE so the stop() spy is stable across calls. If we
  // rebuild inside getTracks() the hook's cleanup will see a different
  // spy than the test captured, and the assertion fails.
  const track = { stop: vi.fn() };
  const fakeStream = {
    getTracks: () => [track],
  } as unknown as MediaStream;

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: opts.deny
        ? vi.fn().mockRejectedValue(new Error("Permission denied"))
        : vi.fn().mockResolvedValue(fakeStream),
    },
  });
}

beforeEach(() => {
  installFakeMediaRecorder();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRecorder", () => {
  it("starts in idle state with zero levels", () => {
    const { result } = renderHook(() => useRecorder());
    expect(result.current.state).toBe<RecorderState>("idle");
    expect(result.current.seconds).toBe(0);
    expect(result.current.levels).toHaveLength(28);
    expect(result.current.levels.every((v) => v === 0)).toBe(true);
  });

  it("transitions idle → requesting → recording on start()", async () => {
    installFakeGetUserMedia();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe<RecorderState>("recording");
  });

  it("sets state=denied when getUserMedia rejects", async () => {
    installFakeGetUserMedia({ deny: true });
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe<RecorderState>("denied");
  });

  it("sets state=error when getUserMedia is unavailable", async () => {
    // Remove mediaDevices entirely.
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe<RecorderState>("error");
  });

  it("stop() resolves with the captured blob and returns to idle", async () => {
    installFakeGetUserMedia();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    let blob: Blob | null = null;
    await act(async () => {
      blob = await result.current.stop();
    });

    expect(blob).not.toBeNull();
    expect(blob).toBeInstanceOf(Blob);
    expect(result.current.state).toBe<RecorderState>("idle");
  });

  it("stop() returns null when called before any recording started", async () => {
    const { result } = renderHook(() => useRecorder());

    let blob: Blob | null = "sentinel" as unknown as Blob;
    await act(async () => {
      blob = await result.current.stop();
    });

    expect(blob).toBeNull();
    expect(result.current.state).toBe<RecorderState>("idle");
  });

  it("reset() returns to idle and clears the levels array", async () => {
    installFakeGetUserMedia();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe<RecorderState>("recording");

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe<RecorderState>("idle");
    expect(result.current.seconds).toBe(0);
    expect(result.current.levels.every((v) => v === 0)).toBe(true);
  });

  it("cleans up the underlying stream tracks on stop()", async () => {
    installFakeGetUserMedia();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    // mock.results[0].value is the Promise itself (vi.fn with
    // mockResolvedValue returns a Promise); await it to grab the stream.
    const fakeStream = await (globalThis.navigator.mediaDevices
      .getUserMedia as ReturnType<typeof vi.fn>).mock.results[0].value;
    const stopSpy = fakeStream.getTracks()[0].stop;

    await act(async () => {
      await result.current.stop();
    });

    expect(stopSpy).toHaveBeenCalled();
  });
});
