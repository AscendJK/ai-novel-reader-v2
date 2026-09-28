#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader (Full Bundle) ====="

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed."
    exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ] || [ "$NODE_MAJOR" -gt 22 ]; then
    echo "[ERROR] Node.js $(node -v) is not supported. Please use 18-22 LTS."
    exit 1
fi

echo "Node.js version: $(node -v) [OK]"

if [ -f scripts/cleanup-processes.sh ]; then
    bash scripts/cleanup-processes.sh || true
fi

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    # The package ships package-lock.json so npm ci installs exactly the versions
    # the real-backend bench verified; fall back to npm install when the lock is
    # missing (old extracted dirs) or ci fails (hand-edited package.json).
    if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi
fi

echo "Starting server (full mode, frontend included)..."
echo "Open in browser: http://localhost:5173/ai-novel-reader-v2/"
node server/index.js --full
