#!/bin/sh
# Demo without the game: regenerates simulated data and serves the dashboard on port 8766 (commands disabled).
cd "$(dirname "$0")" || exit 1
. ./_python.sh || exit 1
"$PY" test/make_fake_data.py || exit 1
exec "$PY" launch.py --only server --db test/fake.db --port 8766 --no-cmd "$@"
