#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader - Admin ====="
echo ""

if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not found."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

# Check if server is already running on port 5173
nc_pid=$(lsof -ti:5173 2>/dev/null || true)
if [ -z "$nc_pid" ]; then
  echo "Starting server..."
  nohup node server/index.js > server/server.log 2>&1 &
  sleep 3
  echo "Server started."
else
  echo "Server already running on port 5173."
fi

# Get admin token
TOKEN=""
if [ -f "server/data/.admin_token" ]; then
  TOKEN=$(cat server/data/.admin_token)
fi

URL="http://localhost:5173/admin?token=$TOKEN"
echo ""
echo "Opening: $URL"
echo "Token: $TOKEN"
echo ""

if command -v open &>/dev/null; then
  open "$URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$URL"
else
  echo "Please open this URL in your browser:"
  echo "  $URL"
fi
