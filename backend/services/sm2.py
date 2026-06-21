import math
import os
import time
import warnings

# Hackathon demo: scale intervals to minutes instead of days so the spaced-repetition
# loop is demonstrable in real time during judging.
#
# P2-B2: make this env-driven so a prod deploy can't accidentally inherit the demo
# timing. Default still True (matching previous behaviour) so existing imports keep
# working without any extra config in the demo deployment.
DEMO_MODE = os.environ.get("VIBESCHOOL_DEMO_MODE", "true").lower() in ("1", "true", "yes")

# P2-B2: warn loudly if we boot into demo timing in a context that looks like
# production — either NODE_ENV=production, or no VIBESCHOOL_DEMO_MODE opt-in was
# provided at all (a missing env var is treated as a deploy mistake worth flagging).
if DEMO_MODE:
    if os.environ.get("NODE_ENV") == "production" or "VIBESCHOOL_DEMO_MODE" not in os.environ:
        warnings.warn(
            "DEMO_MODE is enabled — SM-2 intervals are scaled to minutes, not days. "
            "This is intended for the hackathon demo only. Set VIBESCHOOL_DEMO_MODE=false "
            "(and ideally NODE_ENV=production) for real users.",
            RuntimeWarning,
            stacklevel=1,
        )


def sm2_next(state: dict, quality: int) -> dict:
    """
    SM-2 spaced repetition algorithm.

    Args:
        state: {ease_factor, interval, repetitions, next_review}
        quality: int 0-5 from grader

    Returns:
        Updated state dict with new ease_factor, interval, repetitions, next_review.
    """
    ef = state["ease_factor"]
    interval = state["interval"]
    repetitions = state["repetitions"]

    if quality >= 3:
        # Correct answer — advance the schedule.
        if repetitions == 0:
            new_interval = 1
        elif repetitions == 1:
            new_interval = 6
        else:
            new_interval = math.ceil(interval * ef)

        new_ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        new_ef = max(1.3, new_ef)  # clamp minimum
        new_repetitions = repetitions + 1
    else:
        # Wrong answer — reset to the beginning.
        new_interval = 1
        new_ef = max(1.3, ef - 0.2)  # slight ease factor penalty
        new_repetitions = 0

    seconds_per_unit = 60 if DEMO_MODE else 86400  # 1 minute per "day" in demo
    next_review = int(time.time()) + new_interval * seconds_per_unit

    return {
        "ease_factor": round(new_ef, 3),
        "interval": new_interval,
        "repetitions": new_repetitions,
        "next_review": next_review,
    }
