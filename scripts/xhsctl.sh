#!/usr/bin/env sh
# 启动 / 停止本机 xiaohongshu-mcp(node) 服务和它拉起的浏览器。
# 用法：scripts/xhsctl.sh start|stop|restart|status|browser
set -u
APP=$(cd "$(dirname "$0")/.." && pwd)
PAT_BROWSER=${XHS_BROWSER_PATTERN:-"chrome|chromium"}
PORT=${MCP_PORT:-18060}

stop_app() {
  for d in /proc/[0-9]*; do
    [ -d "$d" ] || continue
    pid=${d#/proc/}
    c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$c" in
      *"server.mjs"*)
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
        if [ "$cwd" = "$APP" ]; then kill "$pid" 2>/dev/null; fi
        ;;
    esac
  done
}

stop_browser() {
  case "$(uname -s)" in
    Darwin|Linux) pkill -f "$PAT_BROWSER" 2>/dev/null ;;
  esac
}

start_app() {
  cd "$APP" || exit 1
  nohup node server.mjs >> server.log 2>&1 &
  sleep 2
  tail -3 server.log 2>/dev/null
}

case "${1:-}" in
  start) start_app ;;
  restart) stop_app; stop_browser; sleep 1; start_app ;;
  stop) stop_app; stop_browser ;;
  browser) stop_browser ;;
  status) curl -sS -m 3 "http://127.0.0.1:${PORT}/health"; echo ;;
  *) echo "用法: $0 start|stop|restart|status|browser" ;;
esac
