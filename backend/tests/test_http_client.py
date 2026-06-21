"""Tests for the shared httpx.AsyncClient singleton.

httpx.AsyncClient instances bind to the asyncio loop they were created in,
so we don't call `close_all()` between tests (that would try to aclose
clients from a loop that has already been torn down). Instead each test
uses a distinct name so state doesn't bleed.
"""
from httpx import AsyncClient

from backend.services.http_client import shared_client


def test_shared_client_returns_singleton_per_name():
    a = shared_client("singleton-A")
    b = shared_client("singleton-A")
    assert a is b


def test_shared_client_returns_distinct_per_distinct_names():
    a = shared_client("distinct-A")
    b = shared_client("distinct-B")
    assert a is not b


def test_shared_client_is_httpx_async_client():
    assert isinstance(shared_client("async-client-A"), AsyncClient)


def test_close_all_signature():
    """Smoke check that close_all is async-callable without actually
    closing any client (see module docstring)."""
    import inspect
    from backend.services.http_client import close_all
    assert inspect.iscoroutinefunction(close_all)
