import sentry_sdk

from backend.config import SENTRY_DSN

# Empty DSN keeps the SDK in a no-op state — breadcrumbs/spans still work locally
# without shipping anywhere, so the rest of the code can call sentry unconditionally.
sentry_sdk.init(
    dsn=SENTRY_DSN or None,
    traces_sample_rate=1.0,
    profiles_sample_rate=1.0,
)
