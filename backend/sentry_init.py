import os

import sentry_sdk

from backend.config import SENTRY_DSN


def _coerce_float(env_value: str | None, default: float) -> float:
    """Parse a Sentry sample-rate env var.

    A bad value (empty, non-numeric, out-of-range) must not crash the SDK init —
    silently fall back to the default so an operator typo doesn't take the
    service down. Negative rates are clamped to 0.0; rates above 1.0 are
    clamped to 1.0.
    """
    if env_value is None or env_value.strip() == "":
        return default
    try:
        rate = float(env_value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, rate))


# P2-B10: drives these from env so a prod deploy doesn't burn 100% of the
# transaction quota on a demo project. Defaults are deliberately conservative.
TRACES_SAMPLE_RATE = _coerce_float(
    os.environ.get("SENTRY_TRACES_SAMPLE_RATE"), 0.1
)
PROFILES_SAMPLE_RATE = _coerce_float(
    os.environ.get("SENTRY_PROFILES_SAMPLE_RATE"), 0.0
)

# Empty DSN keeps the SDK in a no-op state — breadcrumbs/spans still work locally
# without shipping anywhere, so the rest of the code can call sentry unconditionally.
sentry_sdk.init(
    dsn=SENTRY_DSN or None,
    traces_sample_rate=TRACES_SAMPLE_RATE,
    profiles_sample_rate=PROFILES_SAMPLE_RATE,
)
