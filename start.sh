#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader ====="
echo ""

if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Install Node.js first: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')

# Check version range: only 18-22 supported
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[ERROR] Node.js $NODE_MAJOR is too old. Please use 18-22 LTS."
  echo ""
  echo "  Download: https://nodejs.org (select 18-22 LTS)"
  echo "  Or use nvm: nvm install 22 && nvm use 22"
  echo ""
  exit 1
fi

if [ "$NODE_MAJOR" -gt 22 ]; then
  echo "[ERROR] Node.js $NODE_MAJOR is not supported. Please use 18-22 LTS."
  echo ""
  echo "  Node.js 23+ has breaking changes that are not compatible."
  echo "  Download: https://nodejs.org (select 18-22 LTS)"
  echo "  Or use nvm: nvm install 22 && nvm use 22"
  echo ""
  exit 1
fi

echo "Node.js version: $(node -v) [OK]"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

echo "Building for production..."
npm run build
echo ""

# Install SSL certificate if mkcert is available and cert doesn't exist
if [ ! -f "server/data/cert.pem" ] || [ ! -f "server/data/key.pem" ]; then
  if command -v mkcert &>/dev/null; then
    echo "Generating SSL certificate with mkcert..."
    mkdir -p server/data
    mkcert -install -cert-file server/data/cert.pem -key-file server/data/key.pem localhost 127.0.0.1 $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -5) 2>/dev/null || echo "Warning: mkcert failed, using HTTP only"
  fi
fi

echo "Starting server..."
echo "Prod running: https://localhost:8443 or http://localhost:5173"
echo "Press Ctrl+C to stop the server."
echo ""
node server/index.js --full
