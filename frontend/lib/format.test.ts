import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  daysUntil,
  formatDue,
  formatNextReview,
  formatTime,
  getDueStatus,
  masteryPct,
  mergedAgo,
} from "./format";

const NOW = new Date("2026-06-20T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("getDueStatus", () => {
  it("returns 'overdue' for past timestamps", () => {
    expect(getDueStatus(iso(NOW - 1000))).toBe("overdue");
  });
  it("returns 'today' for under-24h future timestamps", () => {
    expect(getDueStatus(iso(NOW + 60 * 60 * 1000))).toBe("today");
  });
  it("returns 'upcoming' for >24h future timestamps", () => {
    expect(getDueStatus(iso(NOW + 25 * 60 * 60 * 1000))).toBe("upcoming");
  });
});

describe("formatDue", () => {
  it("formats minutes overdue", () => {
    expect(formatDue(iso(NOW - 5 * 60 * 1000))).toBe("5m overdue");
  });
  it("formats hours overdue", () => {
    expect(formatDue(iso(NOW - 3 * 60 * 60 * 1000))).toBe("3h overdue");
  });
  it("formats days overdue", () => {
    expect(formatDue(iso(NOW - 2 * 24 * 60 * 60 * 1000))).toBe("2d overdue");
  });
  it("formats minutes ahead", () => {
    expect(formatDue(iso(NOW + 5 * 60 * 1000))).toBe("in 5m");
  });
  it("formats hours ahead", () => {
    expect(formatDue(iso(NOW + 3 * 60 * 60 * 1000))).toBe("in 3h");
  });
  it("formats days ahead", () => {
    expect(formatDue(iso(NOW + 5 * 24 * 60 * 60 * 1000))).toBe("in 5d");
  });
});

describe("mergedAgo", () => {
  it("returns 'just now' for <1h", () => {
    expect(mergedAgo(iso(NOW - 30 * 60 * 1000))).toBe("just now");
  });
  it("returns hours for <24h", () => {
    expect(mergedAgo(iso(NOW - 3 * 60 * 60 * 1000))).toBe("3h ago");
  });
  it("returns 'yesterday' for exactly 1 day", () => {
    expect(mergedAgo(iso(NOW - 24 * 60 * 60 * 1000))).toBe("yesterday");
  });
  it("returns days for >1 day", () => {
    expect(mergedAgo(iso(NOW - 5 * 24 * 60 * 60 * 1000))).toBe("5d ago");
  });
});

describe("masteryPct", () => {
  it("0 → 0", () => expect(masteryPct(0)).toBe(0));
  it("30 → 100", () => expect(masteryPct(30)).toBe(100));
  it("15 → 50", () => expect(masteryPct(15)).toBe(50));
  it("caps at 100 for very large intervals", () => expect(masteryPct(365)).toBe(100));
  it("rounds to nearest percent", () => expect(masteryPct(10)).toBe(33));
});

describe("formatTime", () => {
  it("zero-pads seconds", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(125)).toBe("2:05");
    expect(formatTime(3600)).toBe("60:00");
  });
});

describe("daysUntil", () => {
  it("clamps past timestamps to 0", () => {
    expect(daysUntil(iso(NOW - 24 * 60 * 60 * 1000))).toBe(0);
  });
  it("returns fractional days for future timestamps", () => {
    expect(daysUntil(iso(NOW + 12 * 60 * 60 * 1000))).toBeCloseTo(0.5);
  });
});

describe("formatNextReview", () => {
  it("'in about an hour' for under 1.5h", () => {
    expect(formatNextReview(iso(NOW + 60 * 60 * 1000))).toBe("in about an hour");
  });
  it("'in N hours' for 2-23h", () => {
    expect(formatNextReview(iso(NOW + 5 * 60 * 60 * 1000))).toBe("in 5 hours");
  });
  it("'tomorrow' for ~24h", () => {
    expect(formatNextReview(iso(NOW + 24 * 60 * 60 * 1000))).toBe("tomorrow");
  });
  it("'in N days' for >24h", () => {
    expect(formatNextReview(iso(NOW + 5 * 24 * 60 * 60 * 1000))).toBe("in 5 days");
  });
});
