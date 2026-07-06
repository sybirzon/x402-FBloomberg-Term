#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FBloomberg Terminal — x402 Micropayments Demo
# Team setup script
#
# Repo:     https://github.com/sybirzon/x402-FBloomberg-Term
# Run once from the repo root:  bash scripts/setup-fbloomberg.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET}  $*"; }
info() { echo -e "${CYAN}→${RESET}  $*"; }
warn() { echo -e "${YELLOW}!${RESET}  $*"; }
die()  { echo -e "${RED}✗  $*${RESET}"; exit 1; }
hr()   { echo -e "${CYAN}────────────────────────────────────────────────────${RESET}"; }

echo ""
echo -e "${BOLD}FBloomberg Terminal — x402 Micropayments Demo${RESET}"
echo -e "End-to-end AI-native payments on Base Sepolia via Fireblocks"
hr

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
info "Checking prerequisites..."

NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
[[ -z "$NODE_VER" ]] && die "Node.js not found. Install Node.js 20+ from https://nodejs.org"
[[ "$NODE_VER" -lt 20 ]] && die "Node.js 20+ required (found v${NODE_VER}). Upgrade at https://nodejs.org"
ok "Node.js $(node --version)"

command -v npm >/dev/null 2>&1 || die "npm not found."
ok "npm $(npm --version)"

command -v git >/dev/null 2>&1 || die "git not found."
ok "git $(git --version | awk '{print $3}')"

# ── 2. Clone x402-facilitator if not present ─────────────────────────────────
hr
if [[ ! -d "$ROOT/x402-facilitator" ]]; then
  info "Cloning x402-facilitator from github.com/fireblocks/x402-facilitator..."
  git clone --depth 1 https://github.com/fireblocks/x402-facilitator.git "$ROOT/x402-facilitator" \
    || die "Failed to clone x402-facilitator. Check your internet connection."
  ok "x402-facilitator cloned"
else
  ok "x402-facilitator already present"
fi

# ── 2b. Patch x402-facilitator to use tsx instead of ts-node ─────────────────
# jose v6 (used by the facilitator) is ESM-only and cannot be loaded by ts-node
# in CJS mode. tsx handles ESM/CJS interop transparently. We pin 4.22.4 because
# 4.23.0 is listed as the npm latest dist-tag but the tarball is not published.
info "Patching x402-facilitator to use tsx (ESM/CJS interop fix)..."
python3 - "$ROOT/x402-facilitator/package.json" <<'PYEOF'
import json, sys

path = sys.argv[1]
with open(path) as f:
    pkg = json.load(f)

# Add tsx as pinned devDependency
pkg.setdefault('devDependencies', {})['tsx'] = '4.22.4'

# Replace ts-node with tsx in all npm scripts
for key, val in pkg.get('scripts', {}).items():
    if isinstance(val, str):
        pkg['scripts'][key] = val.replace('ts-node ', 'tsx ')

with open(path, 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
print("  patched")
PYEOF
ok "x402-facilitator patched (tsx@4.22.4)"

# ── 3. Install dependencies ───────────────────────────────────────────────────
hr
info "Installing dependencies for all services..."

for dir in x402-facilitator merchant agent dashboard; do
  if [[ -d "$ROOT/$dir" ]]; then
    info "  npm install — $dir"
    (cd "$ROOT/$dir" && npm install --silent) || die "npm install failed in $dir"
    ok "  $dir"
  fi
done

# The merchant imports @x402/express via file:../x402-facilitator/packages/x402-express.
# That package ships TypeScript sources only — npm install links the source dir into
# merchant/node_modules but doesn't build dist/, so the merchant fails to resolve it
# at runtime ("Cannot find module '@x402/express'"). Build it here, once.
info "Building @x402/express workspace package..."
(cd "$ROOT/x402-facilitator" && npm run build --workspace=@x402/express --silent) \
  || die "Failed to build @x402/express. Run manually: cd x402-facilitator && npm run build --workspace=@x402/express"
ok "@x402/express built"

# ── 3. Facilitator — Fireblocks credentials ───────────────────────────────────
hr
echo -e "${BOLD}Step 1 of 4 — Fireblocks credentials (x402-facilitator)${RESET}"
echo ""
echo "You need a Fireblocks account with:"
echo "  • A vault (any name) with Base Sepolia USDC (USDC_BASECHAIN_ETH_TEST5_8SH8) enabled"
echo "  • The numeric ${BOLD}vault ID${RESET} for that vault (Console → Vault → click the vault → shown in URL/details)"
echo "  • An API key UUID (from Fireblocks console → Settings → API Keys)"
echo "  • The RSA private key .pem for that API key"
echo ""
echo "Note: Fireblocks vault IDs are immutable numbers (0, 1, 2, …). The vault NAME"
echo "      is just a display label and is not used by the API."
echo ""
echo "Faucet for the Fireblocks vault (receiver — only needs ETH for gas):"
echo "  Base Sepolia ETH:  https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet"
echo ""
echo "Note: The vault receives USDC from payments — no USDC pre-funding needed."
echo ""

FACILITATOR_DIR="$ROOT/x402-facilitator"
CONFIG_FILE="$FACILITATOR_DIR/config/facilitator.json"
PEM_FILE="$FACILITATOR_DIR/secrets/fireblocks.pem"
mkdir -p "$FACILITATOR_DIR/config" "$FACILITATOR_DIR/secrets"

# ── 3a. Run npm run setup (scaffolds JWT key + starter config) ────────────────
if [[ ! -f "$FACILITATOR_DIR/secrets/jwt-hs256.key" ]]; then
  info "Scaffolding facilitator config and JWT key..."
  (cd "$FACILITATOR_DIR" && npm run setup --silent 2>/dev/null || true)
  ok "Scaffolded secrets/jwt-hs256.key"
else
  ok "JWT key already present — skipping scaffold"
fi

# ── 3a2. Workspace type (Sandbox vs production testnet) ──────────────────────
echo ""
echo "  Workspace type:"
echo "    1) Sandbox (sandbox-api.fireblocks.io) — recommended for first-time setup"
echo "    2) Production testnet (api.fireblocks.io)"
read -rp "  Choice [1/2, default 1]: " FB_WORKSPACE_CHOICE
case "${FB_WORKSPACE_CHOICE:-1}" in
  2) FB_BASE_URL="https://api.fireblocks.io" ;;
  *) FB_BASE_URL="https://sandbox-api.fireblocks.io" ;;
esac

# ── 3b. Fireblocks API key ────────────────────────────────────────────────────
echo ""
read -rp "  Fireblocks API key: " FB_API_KEY
[[ -z "$FB_API_KEY" ]] && die "API key is required."

# ── 3b2. Fireblocks vault ID (numeric, immutable) ─────────────────────────────
echo ""
read -rp "  Fireblocks vault ID (any non-negative integer, e.g. 0, 1, 2, 10 ...): " FB_VAULT_ID
[[ -z "$FB_VAULT_ID" ]] && die "Vault ID is required."
[[ ! "$FB_VAULT_ID" =~ ^[0-9]+$ ]] && die "Vault ID must be a non-negative integer (got: '$FB_VAULT_ID')."

# ── 3c. PEM file path ─────────────────────────────────────────────────────────
echo ""
echo "  Paste the full path to your Fireblocks RSA private key .pem file,"
echo "  or press Enter to paste the key contents directly."
read -rp "  PEM file path (or Enter to paste): " PEM_PATH

if [[ -n "$PEM_PATH" ]]; then
  [[ ! -f "$PEM_PATH" ]] && die "File not found: $PEM_PATH"
  cp "$PEM_PATH" "$PEM_FILE"
  chmod 600 "$PEM_FILE"
  ok "Copied PEM → $PEM_FILE"
else
  echo "  Paste your PEM key now (paste all lines, then press Ctrl+D):"
  cat > "$PEM_FILE"
  chmod 600 "$PEM_FILE"
  ok "Wrote PEM → $PEM_FILE"
fi

# ── 3d. Write facilitator.json ────────────────────────────────────────────────
info "Writing config/facilitator.json..."
python3 - "$CONFIG_FILE" "$FB_API_KEY" "$FB_VAULT_ID" "$FB_BASE_URL" <<'PYEOF'
import json, sys

config_path, api_key, vault_id, base_url = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

config = {
  "tenant_id": "default",
  "default_configuration_id": "default",
  "assets": [
    {
      "asset_id": "USDC_BASECHAIN_ETH_TEST5_8SH8",
      "blockchain_id": "0318d40f-7709-4f10-b980-11f3abaf31ac",
      "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "decimals": 6,
      "chain_id": 84532,
      "eip712_name": "USDC",
      "eip712_version": "2",
      "transfer_mechanism": "eip-3009",
      "is_testnet": True,
      "stable": True,
      "price_symbol": None
    }
  ],
  "configurations": [
    {
      "configuration_id": "default",
      "public_host": "http://localhost:3001",
      "fireblocks": {
        "api_key": api_key,
        "api_secret_path": "./secrets/fireblocks.pem",
        "receiver_vault": vault_id,
        "base_url": base_url,
        "deposit_address_cache": {}
      },
      "api_keys": [],
      "products": []
    }
  ]
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
print("  written")
PYEOF
ok "config/facilitator.json written"

# ── 3e. Facilitator .env ──────────────────────────────────────────────────────
if [[ ! -f "$FACILITATOR_DIR/.env" ]]; then
  cat > "$FACILITATOR_DIR/.env" <<'ENV'
PORT=3001
ALLOWED_ORIGINS=http://localhost:5174,http://localhost:3010
NODE_ENV=development
PAYMENT_STORE=memory
ENV
  ok "x402-facilitator/.env written"
else
  ok "x402-facilitator/.env already present — leaving it"
fi

# ── 4. Start facilitator temporarily to mint API key + products ───────────────
hr
echo -e "${BOLD}Step 2 of 4 — Mint API key and products${RESET}"
echo ""
info "Starting facilitator briefly to mint credentials via CLI..."

# Run the facilitator WITHOUT nodemon during setup. nodemon watches files and
# restarts the server on every change to config/facilitator.json — and every CLI
# admin call (mint token, mint key, add product) mutates that file. The next CLI
# call then hits a server in mid-restart → "fetch failed". tsx directly gives
# us a stable server for the duration of Step 2.
(cd "$FACILITATOR_DIR" && ./node_modules/.bin/tsx src/index.ts > /tmp/fbloomberg-setup-facilitator.log 2>&1) &
FAC_PID=$!

# Cleanup trap — runs on success, failure, and Ctrl+C alike, so any subsequent
# die() never leaves an orphan facilitator listening on :3001.
cleanup_facilitator() {
  if [[ -n "${FAC_PID:-}" ]]; then
    pkill -P "$FAC_PID" 2>/dev/null || true
    kill "$FAC_PID" 2>/dev/null || true
  fi
  local pids
  pids=$(lsof -ti :3001 2>/dev/null || true)
  [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
  sleep 1
  pids=$(lsof -ti :3001 2>/dev/null || true)
  [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
}
trap cleanup_facilitator EXIT

# Poll for readiness instead of a flat sleep — npm → nodemon → ts-node → node can take
# 10–20s on a cold start (esbuild + first ts-node compile).
info "Waiting for facilitator on :3001 (up to 30s)..."
READY=0
for _ in $(seq 1 30); do
  if lsof -ti :3001 >/dev/null 2>&1; then
    # Port is open — confirm it's actually serving HTTP, not just half-bound
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:3001/ 2>/dev/null || echo "000")
    case "$HTTP_CODE" in
      2*|3*|4*|5*) READY=1; break ;;
    esac
  fi
  # If the subshell died before becoming ready, bail with the log
  if ! kill -0 "$FAC_PID" 2>/dev/null && ! lsof -ti :3001 >/dev/null 2>&1; then
    cat /tmp/fbloomberg-setup-facilitator.log
    die "Facilitator process exited before becoming ready. Log above."
  fi
  sleep 1
done
if [[ "$READY" -ne 1 ]]; then
  cat /tmp/fbloomberg-setup-facilitator.log
  die "Facilitator did not respond on :3001 within 30s. Log above."
fi
ok "Facilitator ready (subshell pid $FAC_PID)"

# Mint a short-lived admin JWT — the facilitator's CLI requires X402_ADMIN_TOKEN
# to authorize keys/products operations. The token is signed with the local HS256
# secret in secrets/jwt-hs256.key (scaffolded earlier) and verified by this same
# running facilitator, so no external trust is needed.
info "Minting admin token for CLI..."
ADMIN_OUT=$(cd "$FACILITATOR_DIR" && npm run --silent setup:admin-token -- --preset full 2>&1) \
  || { echo "$ADMIN_OUT"; die "Failed to mint admin token (see output above)"; }
# Pull the JWT (three base64url segments) out of the wizard's output
X402_ADMIN_TOKEN=$(echo "$ADMIN_OUT" | grep -oE 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -1)
[[ -z "$X402_ADMIN_TOKEN" ]] && { echo "$ADMIN_OUT"; die "Could not parse admin JWT from output above."; }
export X402_ADMIN_TOKEN
ok "Admin token minted (…${X402_ADMIN_TOKEN: -8})"

# The CLI's default URL is http://localhost:3000 but the facilitator listens on :3001
# (see x402-facilitator/.env). Point the CLI at the right port for all subsequent calls.
export X402_URL="http://localhost:3001"

# Mint merchant API key
# Note 1: 2>&1 (not 2>/dev/null) so CLI errors are captured into MINT_OUT and shown to the user
#         if mint fails — important if a future facilitator release renames a flag.
# Note 2: uses ./node_modules/.bin/tsx directly (pinned 4.22.4, installed via npm install)
#         to avoid npx fetching tsx from the registry — tsx@4.23.0 is not yet published.
info "Minting merchant API key..."
MINT_OUT=$(cd "$FACILITATOR_DIR" && ./node_modules/.bin/tsx src/cli/index.ts keys create \
  --scopes process-payments --label merchant 2>&1) \
  || { echo "$MINT_OUT"; die "Failed to mint API key (see CLI output above)"; }

MERCHANT_KEY=$(echo "$MINT_OUT" | grep -oE 'x402_[a-zA-Z0-9_-]+' | head -1)
[[ -z "$MERCHANT_KEY" ]] && { echo "$MINT_OUT"; die "Could not parse API key from CLI output above."; }
ok "Merchant API key: ${MERCHANT_KEY:0:16}…"

# Create Premium product ($0.01)
info "Creating Premium product (\$0.01 USDC)..."
PREMIUM_OUT=$(cd "$FACILITATOR_DIR" && ./node_modules/.bin/tsx src/cli/index.ts products add \
  --name Premium \
  --endpoint /premium \
  --asset USDC_BASECHAIN_ETH_TEST5_8SH8 \
  --price 10000 2>&1) \
  || { echo "$PREMIUM_OUT"; die "Failed to create Premium product (see CLI output above)"; }

PREMIUM_ID=$(echo "$PREMIUM_OUT" | grep -oE 'prod_[a-zA-Z0-9]+' | head -1)
[[ -z "$PREMIUM_ID" ]] && { echo "$PREMIUM_OUT"; die "Could not parse Premium product_id from CLI output above."; }
ok "Premium product: $PREMIUM_ID"

# Create SPCX product ($0.02)
info "Creating SPCX product (\$0.02 USDC)..."
SPCX_OUT=$(cd "$FACILITATOR_DIR" && ./node_modules/.bin/tsx src/cli/index.ts products add \
  --name SPCX \
  --endpoint /spcx \
  --asset USDC_BASECHAIN_ETH_TEST5_8SH8 \
  --price 20000 2>&1) \
  || { echo "$SPCX_OUT"; die "Failed to create SPCX product (see CLI output above)"; }

SPCX_ID=$(echo "$SPCX_OUT" | grep -oE 'prod_[a-zA-Z0-9]+' | head -1)
[[ -z "$SPCX_ID" ]] && { echo "$SPCX_OUT"; die "Could not parse SPCX product_id from CLI output above."; }
ok "SPCX product: $SPCX_ID"

# Stop temporary facilitator (the same logic the EXIT trap would run anyway)
cleanup_facilitator
wait "$FAC_PID" 2>/dev/null || true
FAC_PID=""  # trap is now a no-op
ok "Facilitator stopped"

# ── 5. Merchant .env ──────────────────────────────────────────────────────────
hr
echo -e "${BOLD}Step 3 of 4 — Merchant${RESET}"

cat > "$ROOT/merchant/.env" <<ENV
PORT=3010
FACILITATOR_URL=http://localhost:3001
NODE_ENV=development
FACILITATOR_API_KEY=${MERCHANT_KEY}
PREMIUM_PRODUCT_ID=${PREMIUM_ID}
SPCX_PRODUCT_ID=${SPCX_ID}
SETTLEMENT_MODE=optimistic
ENV
ok "merchant/.env written"

# ── 6. Agent wallet ───────────────────────────────────────────────────────────
hr
echo -e "${BOLD}Step 4 of 4 — Agent wallet${RESET}"
echo ""
echo "The agent signs EIP-3009 payments off-chain (no gas). It needs a Base Sepolia"
echo "wallet funded with USDC only."
echo ""
echo "Options:"
echo "  1) Generate a new wallet (you'll need to fund it)"
echo "  2) Paste an existing private key"
echo ""
read -rp "  Choice [1/2]: " WALLET_CHOICE

if [[ "$WALLET_CHOICE" == "2" ]]; then
  # -s: silent (don't echo the key to the terminal / scrollback)
  read -rsp "  Private key (0x..., input hidden): " AGENT_PK
  echo ""
  [[ -z "$AGENT_PK" ]] && die "Private key required."
else
  info "Generating new wallet..."
  # node -e needs to run from a dir whose node_modules contains ethers.
  # agent/ has it (installed at the top of this script). The repo root does not.
  AGENT_OUT=$(cd "$ROOT/agent" && node -e "const {Wallet}=require('ethers'); const w=Wallet.createRandom(); console.log(w.privateKey+' '+w.address)") \
    || die "Failed to generate agent wallet — is ethers installed in agent/?"
  AGENT_ADDR=$(echo "$AGENT_OUT" | awk '{print $2}')
  AGENT_PK=$(echo "$AGENT_OUT"  | awk '{print $1}')
  echo ""
  warn "New wallet generated!"
  echo "  Address:     ${AGENT_ADDR}"
  echo "  Private key: ${AGENT_PK}"
  echo ""
  echo "  Fund this address with Base Sepolia USDC before running purchases:"
  echo "    USDC: https://faucet.circle.com"
  echo ""
  read -rp "  Press Enter to continue..."
fi

cat > "$ROOT/agent/.env" <<ENV
PRIVATE_KEY=${AGENT_PK}
MERCHANT_URL=http://localhost:3010/premium
RPC_URL_BASE_SEPOLIA=https://sepolia.base.org
ENV
ok "agent/.env written"

# ── 7. Dashboard ──────────────────────────────────────────────────────────────
hr
echo -e "${BOLD}Dashboard — optional Dynamic embedded wallet${RESET}"
echo ""
echo "The dashboard has an optional Dynamic.xyz embedded-wallet panel."
echo "If you don't supply a Dynamic Environment ID, the panel is hidden and the"
echo "core x402 demo (local-key agent → merchant → facilitator) still works."
echo ""
echo "To get one (optional): sign up at https://app.dynamic.xyz → Developer → API."
echo ""
read -rp "  Dynamic Environment ID (or press Enter to skip): " DYNAMIC_ENV_ID

if [[ -n "$DYNAMIC_ENV_ID" ]]; then
  cat > "$ROOT/dashboard/.env" <<ENV
# Real Dynamic Environment ID — embedded-wallet panel will be active.
VITE_DYNAMIC_ENV_ID=${DYNAMIC_ENV_ID}
ENV
  ok "dashboard/.env written with Dynamic env ID (…${DYNAMIC_ENV_ID: -6})"
else
  cat > "$ROOT/dashboard/.env" <<'ENV'
# No Dynamic Environment ID supplied — embedded-wallet panel hidden.
# To enable, uncomment the line below and paste your env ID from app.dynamic.xyz.
# VITE_DYNAMIC_ENV_ID=your-environment-id-here
ENV
  ok "dashboard/.env written (Dynamic panel disabled — VITE_DYNAMIC_ENV_ID commented out)"
fi
chmod 600 "$ROOT/dashboard/.env"

# ── 8. .mcp.json — substitute the local agent dir into the template ───────────
hr
info "Generating .mcp.json from .mcp.json.template..."
if [[ ! -f "$ROOT/.mcp.json.template" ]]; then
  warn ".mcp.json.template missing — Claude Code MCP integration will not work until restored."
else
  # Use python rather than sed to avoid escaping headaches with absolute paths.
  python3 - "$ROOT/.mcp.json.template" "$ROOT/agent" "$ROOT/.mcp.json" <<'PYEOF'
import sys
template_path, agent_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(template_path) as f:
    text = f.read()
text = text.replace("__AGENT_DIR__", agent_dir)
with open(out_path, "w") as f:
    f.write(text)
PYEOF
  ok ".mcp.json generated (agent dir: $ROOT/agent)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
hr
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${RESET}"
echo ""
echo "Open 3 terminal tabs and run:"
echo ""
echo -e "  ${BOLD}Tab 1 — Facilitator${RESET}"
echo "    cd $ROOT/x402-facilitator && npm run dev"
echo ""
echo -e "  ${BOLD}Tab 2 — Merchant${RESET}"
echo "    cd $ROOT/merchant && npm run dev"
echo ""
echo -e "  ${BOLD}Tab 3 — Dashboard${RESET}"
echo "    cd $ROOT/dashboard && npm run dev"
echo "    Open http://localhost:5174"
echo ""
echo "The MCP server starts automatically when Claude Code opens this project."
echo "Run /mcp in Claude Code to confirm fbloomberg-payments is connected."
echo ""
echo ""
