#!/usr/bin/env bash
# Start the VibeSchool backend locally and expose it via a Cloudflare tunnel.
#
# Usage: ./start-local.sh
#
# What it does:
#   1. Boots uvicorn on localhost:8000
#   2. Starts cloudflared and waits for the public tunnel URL
#   3. Prints the URL — copy it into Vercel as NEXT_PUBLIC_BACKEND_URL
#
# Stop: Ctrl-C kills both processes.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
VENV="$REPO/.venv/bin"

if [[ ! -x "$VENV/uvicorn" ]]; then
  echo "ERROR: venv not found at $REPO/.venv — run: pip install -r backend/requirements.txt" >&2
  exit 1
fi

if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared not found — install with: brew install cloudflared" >&2
  exit 1
fi

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$UVICORN_PID" 2>/dev/null || true
  wait "$UVICORN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting uvicorn on http://localhost:8000"
cd "$REPO"
"$VENV/uvicorn" backend.main:app --host 0.0.0.0 --port 8000 &
UVICORN_PID=$!

# Give uvicorn a moment to bind before starting the tunnel
sleep 2

echo "==> Starting cloudflared tunnel..."
echo ""

# Stream cloudflared output, extract the public URL and print it prominently,
# then keep streaming so the user sees any errors.
cloudflared tunnel --url http://localhost:8000 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    url="${BASH_REMATCH[1]}"
    echo ""
    echo "============================================================"
    echo "  Tunnel URL: $url"
    echo ""
    echo "  Set this in Vercel → Settings → Environment Variables:"
    echo "    NEXT_PUBLIC_BACKEND_URL = $url"
    echo ""
    echo "  Or for local frontend dev, update frontend/.env.local:"
    echo "    NEXT_PUBLIC_BACKEND_URL=$url"
    echo "============================================================"
    echo ""
  fi
done
