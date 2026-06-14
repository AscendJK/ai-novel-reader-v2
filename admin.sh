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

# Admin is always served by Express on port 5173
ADMIN_PORT=5173

# Check if server is already running
ex_pid=$(lsof -ti:$ADMIN_PORT 2>/dev/null || true)
if [ -z "$ex_pid" ]; then
  echo "Starting server on port $ADMIN_PORT..."
  nohup node server/index.js > server/server.log 2>&1 &
  sleep 2
else
  echo "Server already running on port $ADMIN_PORT"
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
