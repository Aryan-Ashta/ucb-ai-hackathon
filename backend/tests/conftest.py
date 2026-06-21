"""Shared pytest fixtures.

Swaps the real Redis connection for an in-memory fakeredis instance so the Redis
integration logic runs without a server. Autouse so every test gets a clean store.

Also re-initialises Sentry with dsn=None and an explicit null transport so
breadcrumbs/spans/profiles are dropped on the floor rather than queued for an
HTTP send. Without this the SDK flushes buffered events on interpreter shutdown
and pytest output ends with the noisy "Sentry is attempting to send N pending
events" line.
"""
import fakeredis.aioredis
import pytest
import sentry_sdk

import backend.services.redis_client as redis_client


@pytest.fixture(autouse=True, scope="session")
def sentry_test_safe():
    """Drop any Sentry events queued during tests so pytest output stays clean."""
    # Force the import-time SDK (which may have set up an HttpTransport) to
    # release its queue before we swap in a no-op transport.
    pre_client = sentry_sdk.get_client()
    if pre_client is not None:
        pre_client.close()

    # Re-init with dsn=None and transport=None: events are dropped, not queued.
    sentry_sdk.init(
        dsn=None,
        traces_sample_rate=0,
        profiles_sample_rate=0,
        transport=None,
    )

    yield

    # Final drain at session end — drop anything queued during tests.
    client = sentry_sdk.get_client()
    if client is not None:
        client.close()


@pytest.fixture(autouse=True)
def fake_redis():
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis_client._redis = fake
    yield fake
    redis_client._redis = None
