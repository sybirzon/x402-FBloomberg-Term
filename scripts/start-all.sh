#!/bin/bash
# Bloomberg Terminal — x402 Micropayments Demo
# Repo: https://github.com/sybirzon/x402-Bloomberg-Term
#
# Starts facilitator, merchant, and dashboard in the background.
# Logs go to /tmp/bloomberg-*.log — tail them to debug.
# Run setup first if you haven't: bash scripts/setup-fbloomberg.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$ROOT/x402-facilitator" ]]; then
  echo "x402-facilitator not found — run bash scripts/setup-fbloomberg.sh first"
  exit 1
fi

start_service() {
  local name=$1 dir=$2 cmd=$3 port=$4

  if lsof -ti ":$port" > /dev/null 2>&1; then
    echo "[$name] already running on port $port"
    return
  fi

  echo "[$name] starting on port $port..."
  (cd "$ROOT/$dir" && eval "$cmd" > "/tmp/bloomberg-${name}.log" 2>&1) &
  sleep 2

  if lsof -ti ":$port" > /dev/null 2>&1; then
    echo "[$name] ready ✓"
  else
    echo "[$name] FAILED — check /tmp/bloomberg-${name}.log"
  fi
}

start_service "facilitator" "x402-facilitator" "npm run dev" 3001
start_service "merchant"    "merchant"          "npm run dev" 3010
start_service "dashboard"   "dashboard"         "npm run dev" 5174

echo ""
echo "Bloomberg Terminal services:"
echo "  Facilitator: http://localhost:3001"
echo "  Merchant:    http://localhost:3010"
echo "  Dashboard:   http://localhost:5174"
echo ""
echo "MCP server starts automatically via .mcp.json"
echo "Run /mcp in Claude Code to confirm bloomberg-payments is connected."
