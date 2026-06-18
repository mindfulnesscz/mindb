#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Package Collector — macOS launcher
# Double-click this file to run the app.
# On first run it creates a local .venv and installs dependencies.
# On subsequent runs it checks for updates once a day.
# ─────────────────────────────────────────────────────────────────────────────

# Always run from the folder this script lives in
cd "$(dirname "$0")"

VENV=".venv"
PYTHON="$VENV/bin/python"
PIP="$VENV/bin/pip"
REQUIREMENTS="requirements.txt"
STAMP=".venv/.last_update"
UPDATE_INTERVAL_DAYS=1

# ── Step 1: Create venv if it doesn't exist ───────────────────────────────────
if [ ! -f "$PYTHON" ]; then
    echo "🔧 First run — setting up environment..."
    python3 -m venv "$VENV"
    if [ $? -ne 0 ]; then
        echo "❌ Failed to create virtual environment."
        echo "   Make sure Python 3.10+ is installed: https://python.org"
        read -p "Press Enter to close..."
        exit 1
    fi
    echo "✅ Environment created."
fi

# ── Step 2: Install / update dependencies ────────────────────────────────────
needs_install=false

# Always install on first run (no stamp file yet)
if [ ! -f "$STAMP" ]; then
    needs_install=true
fi

# Check if stamp is older than UPDATE_INTERVAL_DAYS
if [ -f "$STAMP" ]; then
    last=$(cat "$STAMP")
    now=$(date +%s)
    diff=$(( (now - last) / 86400 ))
    if [ "$diff" -ge "$UPDATE_INTERVAL_DAYS" ]; then
        needs_install=true
    fi
fi

if [ "$needs_install" = true ]; then
    echo "📦 Installing / updating dependencies..."
    "$PIP" install --upgrade -r "$REQUIREMENTS" -q
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies. Check your internet connection."
        read -p "Press Enter to close..."
        exit 1
    fi
    date +%s > "$STAMP"
    echo "✅ Dependencies ready."
fi

# ── Step 3: Launch app ────────────────────────────────────────────────────────
echo "🚀 Launching Package Collector..."
"$PYTHON" app.py
