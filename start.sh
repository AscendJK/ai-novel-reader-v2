#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "===== AI Novel Reader ====="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Install Node.js first: https://nodejs.org"
  exit 1
fi

# Check Node.js version
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

echo "Select launch mode:"
echo "  [1] Dev mode  (fast reload, sync server + Vite)"
echo "  [2] Prod mode (stable, single port, recommended for mobile/LAN)"
echo "  [0] Exit"
echo ""
read -r -p "Enter choice: " mode

case "$mode" in
  0) exit 0 ;;

  2)
    # Production mode: install all dependencies (build needs devDependencies)
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
      echo ""
      echo "Installing dependencies..."
      echo "This may take 1-2 minutes, please wait..."
      echo ""
      if ! npm install --loglevel info; then
        echo ""
        echo "[ERROR] Failed to install dependencies."
        echo ""
        echo "  This is likely because better-sqlite3 could not compile."
        echo "  Please install Node.js 22 LTS: https://nodejs.org"
        echo ""
        exit 1
      fi
      echo ""
      echo "Dependencies installed!"
      echo ""
    fi

    PID=$(lsof -ti:5173 2>/dev/null || true)
    if [ -n "$PID" ]; then
      echo "Stopping old instance PID $PID..."
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Building for production..."
    npm run build

    # Install SSL certificate to trusted root store
    if [ -f "server/data/cert.pem" ]; then
      echo "Installing SSL certificate..."
      if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain server/data/cert.pem 2>/dev/null && \
          echo "SSL certificate installed (macOS)" || \
          echo "[WARNING] Failed to install certificate. Run with sudo if needed."
      elif [ -f /etc/debian_version ]; then
        # Ubuntu/Debian
        sudo cp server/data/cert.pem /usr/local/share/ca-certificates/ai-novel-reader.crt 2>/dev/null && \
        sudo update-ca-certificates 2>/dev/null && \
          echo "SSL certificate installed (Debian/Ubuntu)" || \
          echo "[WARNING] Failed to install certificate. Run with sudo if needed."
      elif [ -f /etc/redhat-release ]; then
        # CentOS/RHEL
        sudo cp server/data/cert.pem /etc/pki/ca-trust/source/anchors/ai-novel-reader.crt 2>/dev/null && \
        sudo update-ca-trust 2>/dev/null && \
          echo "SSL certificate installed (CentOS/RHEL)" || \
          echo "[WARNING] Failed to install certificate. Run with sudo if needed."
      else
        echo "[INFO] Please manually install server/data/cert.pem to your system trust store."
      fi
    fi

    echo "Starting production server (port 5173)..."
    nohup node server/index.js --full > /dev/null 2>&1 &
    sleep 2
    echo "=============================="
    echo "  PROD http://localhost:5173"
    echo "=============================="
    ;;

  *)
    # Dev mode: install all dependencies (including dev tools)
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
      echo ""
      echo "First run: installing all dependencies (including dev tools)..."
      echo "This may take 1-2 minutes, please wait..."
      echo ""
      if ! npm install --loglevel info; then
        echo ""
        echo "[ERROR] Failed to install dependencies."
        echo ""
        echo "  This is likely because better-sqlite3 could not compile."
        echo "  Please install Node.js 22 LTS: https://nodejs.org"
        echo ""
        exit 1
      fi
      echo ""
      echo "All dependencies installed!"
      echo ""
    fi

    # Kill old processes
    for port in 5173 3001; do
      PID=$(lsof -ti:"$port" 2>/dev/null || true)
      if [ -n "$PID" ]; then
        echo "Stopping old instance on port $port (PID $PID)..."
        kill -9 "$PID" 2>/dev/null || true
      fi
    done
    echo "Starting sync server (port 3001)..."
    nohup node server/index.js > server/server.log 2>&1 &
    sleep 1
    echo "Starting Vite dev server (port 5173)..."
    nohup npx vite --host 0.0.0.0 --port 5173 > /dev/null 2>&1 &
    sleep 3
    echo "=============================="
    echo "  DEV  http://localhost:5173"
    echo "=============================="
    ;;
esac

echo ""
echo "Stop server: run ./stop.sh"
echo ""
