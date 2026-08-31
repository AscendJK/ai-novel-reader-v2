#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "Stopping AI Novel Reader (server + TTS inference)..."
echo ""

# 清理残留：本项目 node 进程 + Python TTS 推理进程(tts-worker.py) + 端口兜底
bash "$(dirname "$0")/scripts/cleanup-processes.sh"

echo ""
echo "Done"
