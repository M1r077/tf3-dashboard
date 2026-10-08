#!/bin/sh
# TF3 Dashboard - starts the collector (live.lua -> SQLite) and the web server in this terminal, then opens the
# browser. Ctrl+C or closing the terminal stops everything. Put the browser full screen (F11) on your second monitor.
# Options are passed to launch.py, e.g. --port N, --no-browser, --install-desktop (application menu entry).
# Optional: config.json next to this file -> { "export_dir": "...", "port": 8765 }
cd "$(dirname "$0")" || exit 1
. ./_python.sh || exit 1
exec "$PY" launch.py "$@"
