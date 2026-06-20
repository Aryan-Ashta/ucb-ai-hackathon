"""Shared pytest fixtures.

Swaps the real Redis connection for an in-memory fakeredis instance so the Redis
integration logic runs without a server. Autouse so every test gets a clean store.
"""
import fakeredis.aioredis
import pytest

import backend.services.redis_client as redis_client


@pytest.fixture(autouse=True)
def fake_redis():
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis_client._redis = fake
    yield fake
    redis_client._redis = None
