#!/bin/bash
# start_desk.sh — One-click launcher for Coderix Desktop (Electron)
#
# Usage:
#   ./start_desk.sh
#
# This script:
#   1. Frees port 5173 (kills any stale process)
#   2. Starts electron-vite dev server + Electron app
#   3. Cleans up on Ctrl+C
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# 1. Free port 5173
# ---------------------------------------------------------------------------
free_port() {
  local port=$1
  local pids=$(lsof -ti tcp:$port 2>/dev/null)
  if [ -n "$pids" ]; then
    echo -e "${CYAN}Killing stale process(es) on port $port: $pids${NC}"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

free_port 5173

# ---------------------------------------------------------------------------
# 2. Cleanup handler
# ---------------------------------------------------------------------------
cleanup() {
  echo ""
  echo -e "${CYAN}Shutting down Coderix Desktop...${NC}"
  kill $ELECTRON_PID 2>/dev/null || true
  wait $ELECTRON_PID 2>/dev/null || true
  echo -e "${GREEN}Done.${NC}"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 3. Start
# ---------------------------------------------------------------------------
echo -e "${GREEN}Starting Coderix Desktop...${NC}"
echo ""

cd "$ROOT" && pnpm --filter @coderix/desktop dev &
ELECTRON_PID=$!

echo ""
echo -e "  Desktop: ${CYAN}Electron window${NC}"
echo -e "  Dev URL: ${CYAN}http://localhost:5173${NC}"
echo ""
echo "Press Ctrl+C to stop."
echo ""

wait
