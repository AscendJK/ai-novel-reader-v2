#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader — Admin ====="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not found."
  exit 1
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

# Determine port: admin is served by Express (3001 in dev, 5173 in prod)
if [ -f "dist/index.html" ]; then
  ADMIN_PORT=5173
  echo "Mode: Production (single port $ADMIN_PORT)"
  nc_pid=$(lsof -ti:$ADMIN_PORT 2>/dev/null || true)
  if [ -z "$nc_pid" ]; then
    echo "Starting server..."
    nohup node server/index.js --full > server/server.log 2>&1 &
    sleep 2
  else
    echo "Server already running on port $ADMIN_PORT"
  fi
else
  ADMIN_PORT=3001
  echo "Mode: Development (Vite + Express)"
  # Start Express if not running
  ex_pid=$(lsof -ti:3001 2>/dev/null || true)
  if [ -z "$ex_pid" ]; then
    echo "Starting sync server on port 3001..."
    nohup node server/index.js > server/server.log 2>&1 &
    sleep 1
  fi
  # Start Vite if not running
  vi_pid=$(lsof -ti:5173 2>/dev/null || true)
  if [ -z "$vi_pid" ]; then
    echo "Starting Vite on port 5173..."
    nohup npx vite --host 0.0.0.0 --port 5173 > /dev/null 2>&1 &
    sleep 2
  fi
  echo "Express running on port $ADMIN_PORT"
fi

# Get admin token
TOKEN=""
if [ -f "server/data/.admin_token" ]; then
  TOKEN=$(cat server/data/.admin_token)
fi

# Open browser
URL="http://localhost:$ADMIN_PORT/admin?token=$TOKEN"
echo ""
echo "Opening: $URL"
echo ""

if command -v open &>/dev/null; then
  open "$URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$URL"
elif command -v start &>/dev/null; then
  start "$URL"
else
  echo "Please open this URL in your browser:"
  echo "  $URL"
fi

echo ""
echo "Token: $TOKEN"
echo "Server log: server/server.log"
echo ""
