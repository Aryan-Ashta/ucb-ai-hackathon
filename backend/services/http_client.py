"""Shared httpx.AsyncClient singleton.

Before this module: every outbound HTTP call site did
    async with httpx.AsyncClient() as client: await client.post(...)
which opens a fresh TCP connection per call (no keep-alive benefit).

After: each service gets a long-lived client at module load via
`shared_client("name")` and reuses it across requests. The connection
pool lives for the lifetime of the process — the win is real TCP/TLS
keep-alive to the third-party APIs (Deepgram, Poke, Browserbase,
GitHub, Bear-2).

Notes:
    • Tests mock at the service-level seam (`github_oauth._request`,
      `auth`'s direct `httpx.AsyncClient()` patch, etc.). Those still
      work — the client is constructed exactly once at service module
      load instead of per request.
    • Timeouts are per-request via httpx's normal `timeout=` kwarg; the
      shared client doesn't pin a global timeout.
    • Single-worker, single-event-loop deployment per `STATUS.md`
      "Known scaling debt" — this is the natural fit for that model.
"""
from threading import Lock

import httpx

_clients: dict[str, httpx.AsyncClient] = {}
_lock = Lock()


def shared_client(name: str = "default") -> httpx.AsyncClient:
    """Return the process-wide httpx.AsyncClient for `name`, creating it on
    first call. Thread-safe via a lock; the lock is only held during the
    dict lookup, not during HTTP calls.
    """
    client = _clients.get(name)
    if client is not None:
        return client
    with _lock:
        client = _clients.get(name)
        if client is not None:
            return client  # another thread won the race
        client = httpx.AsyncClient()
        _clients[name] = client
        return client


async def close_all() -> None:
    """Close every shared client. Useful for test teardown + lifespan hooks."""
    for client in list(_clients.values()):
        await client.aclose()
    _clients.clear()
