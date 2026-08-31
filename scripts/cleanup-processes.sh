#!/usr/bin/env bash
# 清理 AI Novel Reader 残留进程（Unix / macOS）
# 被 start.sh / start-backend.sh / stop.sh 调用（含打包后端包内的 start.sh）
#
# 清理对象（精确匹配，避免误杀其他项目的 node/python）：
#   1. Node.js 进程：命令行含 server/index.js 或本项目路径
#   2. Python 进程：命令行含 tts-worker.py（服务端 TTS 推理常驻进程）
#   3. 兜底：占用本项目端口 (8443/5173/5174) 的 node 进程
# 所有匹配都先验证进程类型（comm 名），防止误杀同目录下其他程序。
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTS="8443 5173 5174"
FOUND=0

# pgrep -f 使用扩展正则：转义路径中的特殊字符，避免误匹配
escape_regex() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{|}]/\\&/g'; }
PROJ_RE="$(escape_regex "$PROJ_DIR")"

is_node() { case "$(ps -p "$1" -o comm= 2>/dev/null || true)" in *node*) return 0 ;; *) return 1 ;; esac; }
is_py() { case "$(ps -p "$1" -o comm= 2>/dev/null || true)" in python*|py*) return 0 ;; *) return 1 ;; esac; }

kill_if() {
  local pid="$1" name="$2"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "  Stopping $name PID $pid"
    kill -9 "$pid" 2>/dev/null || true
    FOUND=1
  fi
}

# 1) 按命令行精确匹配（验证进程类型后再杀）
for pid in $(pgrep -f "server/index\.js" 2>/dev/null); do
  is_node "$pid" && kill_if "$pid" "node(server/index.js)"
done
for pid in $(pgrep -f "tts-worker\.py" 2>/dev/null); do
  is_py "$pid" && kill_if "$pid" "python(tts-worker.py)"
done
for pid in $(pgrep -f "$PROJ_RE" 2>/dev/null); do
  is_node "$pid" && kill_if "$pid" "node(project dir)"
done

# 2) 端口兜底（lsof 可用时）：验证是 node 才杀
if command -v lsof >/dev/null 2>&1; then
  for port in $PORTS; do
    pid=$(lsof -ti:"$port" 2>/dev/null | head -1 || true)
    if [ -n "$pid" ] && is_node "$pid"; then
      kill_if "$pid" "node(port $port)"
    fi
  done
fi

if [ "$FOUND" -eq 0 ]; then echo "  No leftover processes found."; fi
