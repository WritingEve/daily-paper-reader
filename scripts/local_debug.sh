#!/usr/bin/env bash
set -euo pipefail

HOST="${DPR_LOCAL_HOST:-127.0.0.1}"
PORT="${DPR_LOCAL_PORT:-8567}"

cd "$(dirname "$0")/.."
exec python3 src/local_debug_server.py --host "$HOST" --port "$PORT"
