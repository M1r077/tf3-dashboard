#!/bin/sh
# Starts the collector alone (watches live.lua, fills the SQLite db). Ctrl+C to stop.
# Extra arguments are passed through, e.g. run_collector.sh --status / --once / --list-games
cd "$(dirname "$0")/.." || exit 1
. ./_python.sh || exit 1
exec "$PY" collector/collector.py "$@"
