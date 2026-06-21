from backend.services.sm2 import sm2_next


def test_sm2():
    initial = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}

    # Correct answer progression.
    s1 = sm2_next(initial, quality=5)
    assert s1["interval"] == 1, f"Expected interval=1, got {s1['interval']}"
    assert s1["repetitions"] == 1

    s2 = sm2_next(s1, quality=5)
    assert s2["interval"] == 6, f"Expected interval=6, got {s2['interval']}"

    s3 = sm2_next(s2, quality=5)
    assert s3["interval"] > 6, f"Expected interval>6, got {s3['interval']}"

    # Wrong answer — reset.
    s_wrong = sm2_next(s3, quality=0)
    assert s_wrong["interval"] == 1, "Wrong answer should reset interval to 1"
    assert s_wrong["repetitions"] == 0, "Wrong answer should reset repetitions to 0"

    # Ease factor clamp.
    s_clamped = sm2_next(
        {"ease_factor": 1.31, "interval": 1, "repetitions": 2, "next_review": 0},
        quality=0,
    )
    assert s_clamped["ease_factor"] >= 1.3, "Ease factor below minimum 1.3"

    print("✓ All SM-2 tests passed")


if __name__ == "__main__":
    test_sm2()


# ── Gap-analysis coverage: documented-but-untested SM-2 behaviors ───────────


def test_sm2_demo_mode_uses_minutes():
    """In DEMO_MODE, a first-review (interval=1) must schedule ~60s ahead, not ~1 day."""
    import time as _time
    initial = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}
    s = sm2_next(initial, quality=5)
    delta = s["next_review"] - int(_time.time())
    assert 55 <= delta <= 65, (
        f"DEMO_MODE first-review should be ~60s ahead, got {delta}s"
    )


def test_sm2_quality_3_advances_schedule():
    """Quality boundary: q=3 is the lowest passing grade and must advance."""
    initial = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}
    s = sm2_next(initial, quality=3)
    assert s["interval"] == 1, f"q=3 at reps=0 → interval=1, got {s['interval']}"
    assert s["repetitions"] == 1, f"q=3 at reps=0 → reps=1, got {s['repetitions']}"


def test_sm2_quality_2_resets_schedule():
    """Quality boundary: q=2 is below passing and must reset the schedule."""
    advanced = {"ease_factor": 2.6, "interval": 6, "repetitions": 2, "next_review": 0}
    s = sm2_next(advanced, quality=2)
    assert s["interval"] == 1, f"q=2 must reset interval to 1, got {s['interval']}"
    assert s["repetitions"] == 0, f"q=2 must reset repetitions to 0, got {s['repetitions']}"


def test_sm2_long_progression_grows_interval():
    """Five correct answers in a row must produce a non-decreasing interval sequence."""
    state = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}
    intervals = []
    next_reviews = []
    for _ in range(5):
        state = sm2_next(state, quality=5)
        intervals.append(state["interval"])
        next_reviews.append(state["next_review"])

    # Repetitions increases monotonically.
    # (We don't track repetitions here but the call sequence guarantees it.)
    # Interval must be non-decreasing.
    for prev, curr in zip(intervals, intervals[1:]):
        assert curr >= prev, (
            f"Interval must be non-decreasing across correct answers: {intervals}"
        )

    # next_review strictly increases per step.
    for prev, curr in zip(next_reviews, next_reviews[1:]):
        assert curr > prev, (
            f"next_review must strictly increase per step: {next_reviews}"
        )

    # Final state: at least 5 reps in (so last interval came from ceil(interval*ef)).
    assert state["repetitions"] == 5
    assert intervals[-1] >= 6, f"After 5 correct answers, interval should be >= 6, got {intervals[-1]}"


def test_sm2_ease_factor_penalty_on_wrong_answer():
    """A wrong answer (q<3) must subtract 0.2 from ease_factor (no clamp)."""
    state = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}
    s = sm2_next(state, quality=0)
    assert s["ease_factor"] == 2.3, (
        f"Wrong answer penalty should drop ef by 0.2 (2.5 → 2.3), got {s['ease_factor']}"
    )


def test_sm2_ease_factor_clamp_at_exactly_1_3():
    """ef below 1.3 after a penalty must clamp to exactly 1.3."""
    state = {"ease_factor": 1.35, "interval": 1, "repetitions": 2, "next_review": 0}

    # First wrong answer: 1.35 - 0.2 = 1.15 → clamped to 1.3.
    s1 = sm2_next(state, quality=0)
    assert s1["ease_factor"] == 1.3, (
        f"First penalty from 1.35 should clamp to 1.3, got {s1['ease_factor']}"
    )

    # Second wrong answer: 1.3 - 0.2 = 1.1 → clamped to 1.3 again.
    s2 = sm2_next(s1, quality=0)
    assert s2["ease_factor"] == 1.3, (
        f"Second penalty from already-clamped 1.3 should stay at 1.3, got {s2['ease_factor']}"
    )


def test_sm2_quality_out_of_range_does_not_crash():
    """An out-of-range quality must not raise.

    sm2_next currently does not clamp/validate quality. With quality=99 the
    formula produces a nonsense ease_factor (subsequently clamped to the 1.3
    minimum), but the function returns without raising. This pins that
    permissiveness — if future code adds a hard reject, this test will fail
    and force an intentional decision.

    P2: production should clamp inside sm2_next, not just rely on the caller.
    """
    state = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}
    # Must not raise.
    s = sm2_next(state, quality=99)
    # Result is well-formed (ease_factor is bounded by the 1.3 floor).
    assert 1.3 <= s["ease_factor"] <= 5.0, (
        f"ease_factor must remain within [1.3, 5.0], got {s['ease_factor']}"
    )
