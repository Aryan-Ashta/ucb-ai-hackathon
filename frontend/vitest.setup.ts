// Test environment setup. Runs before every test file.
import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship Web Audio / MediaRecorder / MediaStream. The hook tests
// stub these via vi.stubGlobal when needed; we just register safe defaults
// here so module-load doesn't blow up.
if (typeof globalThis.window !== "undefined") {
  if (!("AudioContext" in globalThis.window)) {
    class FakeAudioContext {
      state = "running";
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 32,
          getByteFrequencyData: () => {},
        };
      }
      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }
    (globalThis.window as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
  }
}

// React 18 act() warnings → silence in tests.
const _origError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("not wrapped in act(")) return;
  _origError(...args);
};
