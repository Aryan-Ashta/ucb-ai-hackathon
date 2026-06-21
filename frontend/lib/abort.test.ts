import { describe, expect, it } from "vitest";
import { anySignal } from "./abort";

describe("anySignal", () => {
  it("aborts when any source aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(false);

    a.abort();
    expect(composed.signal.aborted).toBe(true);
  });

  it("ignores null sources", () => {
    const a = new AbortController();
    const composed = anySignal([null, a.signal, null]);
    expect(composed.signal.aborted).toBe(false);

    a.abort();
    expect(composed.signal.aborted).toBe(true);
  });

  it("starts aborted if any source is already aborted", () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(true);
  });

  it("manual abort() propagates to the composed signal", () => {
    const composed = anySignal([null]);
    expect(composed.signal.aborted).toBe(false);
    composed.abort();
    expect(composed.signal.aborted).toBe(true);
  });
});
