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

# TTS 服务端推理依赖 Python + sherpa-onnx（可选）：缺失仅影响"服务端推理"引擎，
# 浏览器推理与 Web Speech 不受影响。探测并提示，不阻塞启动。
PY_OK=0
for CMD in python python3 py; do
  if command -v "$CMD" &>/dev/null; then
    if "$CMD" -c "import sherpa_onnx" &>/dev/null; then
      PY_OK=1
      break
    fi
  fi
done
if [ "$PY_OK" -eq 0 ]; then
  echo ""
  echo "[NOTE] Python + sherpa-onnx 未检测到（可选依赖）。"
  echo "  服务端推理引擎将不可用。如需使用，请安装 Python 3.9+ 后运行："
  echo "    pip install sherpa-onnx"
  echo "  浏览器推理与 Web Speech 朗读不受影响。"
  echo ""
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

echo "Starting server..."
echo "Backend running at: http://localhost:5173"
echo "Admin panel: http://localhost:5173/admin"
echo ""
echo "Open https://ascendjk.github.io/ai-novel-reader-v2/ and enter your backend address."
echo "Press Ctrl+C to stop the server."
echo ""
node server/index.js
