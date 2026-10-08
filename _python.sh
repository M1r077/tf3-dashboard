# Shared helper, sourced by the other .sh scripts: sets PY to a Python 3.10+ interpreter (python3, then python).
# Nothing is installed; stdlib only is required. Linux counterpart of _python.cmd.
PY=
for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
        PY=$c
        break
    fi
done
if [ -z "$PY" ]; then
    echo
    echo "[TF3 Dashboard] Python 3.10+ (with sqlite3) was not found. Install it with your package manager, e.g.:"
    echo "  Arch / CachyOS / Manjaro:  sudo pacman -S python"
    echo "  Debian / Ubuntu / Mint:    sudo apt install python3"
    echo "  Fedora:                    sudo dnf install python3"
    echo "  openSUSE:                  sudo zypper install python3"
    echo "Nothing else is needed: no pip, no venv, no packages."
    echo
    return 1 2>/dev/null || exit 1
fi
export PYTHONIOENCODING=utf-8
export PYTHONDONTWRITEBYTECODE=1
