#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

for port in 5173 3001; do
  PID=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Stopping port $port (PID $PID)..."
    kill -9 "$PID" 2>/dev/null || true
  else
    echo "No process on port $port"
  fi
done
echo "Done"
