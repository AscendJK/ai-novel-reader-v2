#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader - Backend ====="
echo ""

if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Install Node.js first: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -ge 24 ]; then
  echo "[ERROR] Node.js version $(node -v) is not supported."
  echo ""
  echo "  better-sqlite3 has no prebuilt binaries for Node.js 24+."
  echo "  This project requires Node.js 18-22 LTS."
  echo ""
  echo "  Fix: Install Node.js 22 LTS"
  echo "  - Download: https://nodejs.org (select 22.x.x LTS)"
  echo "  - Or use nvm: nvm install 22 && nvm use 22"
  echo ""
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

echo "Starting server..."
echo "Backend running at: http://0.0.0.0:5173"
echo "Admin panel: http://localhost:5173/admin"
echo ""
echo "Open https://ascendjk.github.io/ai-novel-reader-v2/ and enter your backend address."
echo "Press Ctrl+C to stop the server."
echo ""
node server/index.js
