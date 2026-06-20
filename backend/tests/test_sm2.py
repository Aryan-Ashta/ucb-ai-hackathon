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
