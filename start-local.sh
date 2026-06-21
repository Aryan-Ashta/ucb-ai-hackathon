#!/usr/bin/env bash
# Start the bananaduck backend and frontend together, locally.
#
# Usage: ./start-local.sh
#
# What it does:
#   1. Boots uvicorn on http://localhost:8000
#   2. Boots `bun dev` on http://localhost:3000
#   3. Streams both processes' output, prefixed so you can tell them apart
#
# Prerequisites:
#   - .venv at the repo root with -r backend/requirements.txt installed
#   - bun on PATH
#   - frontend deps installed (`cd frontend && bun install`)
#   - backend/.env populated from backend/.env.example
#   - frontend/.env.local populated from frontend/.env.local.example
#
# Stop: Ctrl-C kills both processes.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
VENV="$REPO/.venv/bin"
BACKEND_PORT=8000
FRONTEND_PORT=3000

# ── prerequisite checks ────────────────────────────────────────────────────
if [[ ! -x "$VENV/uvicorn" ]]; then
  echo "ERROR: venv not found at $REPO/.venv — run:" >&2
  echo "  python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt" >&2
  exit 1
fi

if ! command -v bun &>/dev/null; then
  echo "ERROR: bun not found — install from https://bun.sh" >&2
  exit 1
fi

if [[ ! -d "$REPO/frontend/node_modules" ]]; then
  echo "ERROR: frontend deps not installed — run: cd frontend && bun install" >&2
  exit 1
fi

if [[ ! -f "$REPO/backend/.env" ]]; then
  echo "ERROR: backend/.env missing — copy from backend/.env.example and fill in keys" >&2
  exit 1
fi

if [[ ! -f "$REPO/frontend/.env.local" ]]; then
  echo "ERROR: frontend/.env.local missing — copy from frontend/.env.local.example" >&2
  exit 1
fi

# ── spawn both processes ──────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [[ -n "$BACKEND_PID"  ]] && kill "$BACKEND_PID"  2>/dev/null || true
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID"  2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting backend  on http://localhost:$BACKEND_PORT"
cd "$REPO"
"$VENV/uvicorn" backend.main:app --host 0.0.0.0 --port "$BACKEND_PORT" \
  2>&1 | sed -u "s/^/[backend]  /" &
BACKEND_PID=$!

echo "==> Starting frontend on http://localhost:$FRONTEND_PORT"
cd "$REPO/frontend"
bun dev \
  2>&1 | sed -u "s/^/[frontend] /" &
FRONTEND_PID=$!

cd "$REPO"

echo ""
echo "============================================================"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo ""
echo "  Open the frontend URL in your browser."
echo "  Ctrl-C stops both processes."
echo "============================================================"
echo ""

# If either process dies, kill the other and exit with its status.
wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_CODE=$?
echo ""
echo "A process exited (status $EXIT_CODE) — stopping the other."
exit "$EXIT_CODE"