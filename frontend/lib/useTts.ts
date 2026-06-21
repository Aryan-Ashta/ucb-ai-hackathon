"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "./api";

function playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
      signal.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
    };

    const onAbort = () => {
      audio.pause();
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal.aborted) {
      URL.revokeObjectURL(url);
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Audio playback failed"));
    };
    void audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

export function useTts() {
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => abort, [abort]);

  const speak = useCallback(async (text: string, token: string): Promise<void> => {
    abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const blob = await api.synthesizeSpeech(token, text, ctrl.signal);
    await playBlob(blob, ctrl.signal);
  }, [abort]);

  const speakSequence = useCallback(
    async (texts: string[], token: string): Promise<void> => {
      abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      for (const text of texts) {
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const blob = await api.synthesizeSpeech(token, text, ctrl.signal);
        await playBlob(blob, ctrl.signal);
      }
    },
    [abort],
  );

  return { speak, speakSequence, abort };
}
