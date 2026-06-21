/**
 * Combine multiple AbortSignals into one that aborts when ANY source aborts.
 * Used to compose per-mount signals with per-call signals.
 */
export function anySignal(signals: Array<AbortSignal | null>): { signal: AbortSignal; abort: () => void } {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      // `reason` is on AbortSignal in lib.dom but not in older type defs.
      // Cast through `unknown` to satisfy the strict TS check.
      ctrl.abort((s as unknown as { reason?: unknown }).reason as DOMException | undefined);
      break;
    }
    s.addEventListener(
      "abort",
      () => ctrl.abort((s as unknown as { reason?: unknown }).reason as DOMException | undefined),
      { once: true },
    );
  }
  return { signal: ctrl.signal, abort: () => ctrl.abort() };
}
