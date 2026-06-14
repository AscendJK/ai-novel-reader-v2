#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "Stopping AI Novel Reader..."
echo ""

for port in 8443 5173 5174; do
  PID=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    # Verify it's a Node.js process before killing
    PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null || true)
    if [[ "$PROC_NAME" == *"node"* ]]; then
      echo "Stopping port $port (PID $PID, process: $PROC_NAME)..."
      kill -9 "$PID" 2>/dev/null || true
    else
      echo "Skipping non-Node.js process on port $port (PID $PID, process: $PROC_NAME)"
    fi
  else
    echo "No process on port $port"
  fi
done

echo ""
echo "Done"
