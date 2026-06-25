#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bloomberg Terminal — x402 Micropayments Demo
# Team setup script
#
# Repo:     https://github.com/sybirzon/x402-Bloomberg-Term
# Run once from the repo root:  bash scripts/setup-bloomberg.sh
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
echo -e "${BOLD}Bloomberg Terminal — x402 Micropayments Demo${RESET}"
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

# ── 3. Facilitator — Fireblocks credentials ───────────────────────────────────
hr
echo -e "${BOLD}Step 1 of 4 — Fireblocks credentials (x402-facilitator)${RESET}"
echo ""
echo "You need a Fireblocks account with:"
echo "  • A vault named exactly  ${BOLD}402${RESET}"
echo "  • An API key (from Fireblocks console → Settings → API Keys)"
echo "  • The RSA private key .pem for that API key"
echo ""
echo "Faucets for testnet funds (fund the 402 vault deposit address):"
echo "  Base Sepolia ETH:  https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"
echo "  Base Sepolia USDC: https://faucet.circle.com"
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

# ── 3b. Fireblocks API key ────────────────────────────────────────────────────
echo ""
read -rp "  Fireblocks API key: " FB_API_KEY
[[ -z "$FB_API_KEY" ]] && die "API key is required."

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
python3 - "$CONFIG_FILE" "$FB_API_KEY" <<'PYEOF'
import json, sys

config_path, api_key = sys.argv[1], sys.argv[2]

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
        "receiver_vault": "402",
        "base_url": "https://api.fireblocks.io",
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

(cd "$FACILITATOR_DIR" && npm run dev > /tmp/bloomberg-setup-facilitator.log 2>&1) &
FAC_PID=$!
sleep 5

# Verify it started
if ! lsof -ti :3001 >/dev/null 2>&1; then
  cat /tmp/bloomberg-setup-facilitator.log
  die "Facilitator failed to start. Check the log above."
fi
ok "Facilitator running (pid $FAC_PID)"

# Mint merchant API key
info "Minting merchant API key..."
MINT_OUT=$(cd "$FACILITATOR_DIR" && npx tsx src/cli/index.ts keys create \
  --scopes process-payments --label merchant 2>/dev/null) || die "Failed to mint API key"

MERCHANT_KEY=$(echo "$MINT_OUT" | grep -oE 'x402_[a-zA-Z0-9_]+' | head -1)
[[ -z "$MERCHANT_KEY" ]] && die "Could not parse API key from: $MINT_OUT"
ok "Merchant API key: ${MERCHANT_KEY:0:16}…"

# Create Premium product ($0.01)
info "Creating Premium product (\$0.01 USDC)..."
PREMIUM_OUT=$(cd "$FACILITATOR_DIR" && npx tsx src/cli/index.ts products add \
  --name Premium \
  --endpoint /premium \
  --asset USDC_BASECHAIN_ETH_TEST5_8SH8 \
  --price 10000 \
  --mechanism eip-3009 2>/dev/null) || die "Failed to create Premium product"

PREMIUM_ID=$(echo "$PREMIUM_OUT" | grep -oE 'prod_[a-zA-Z0-9]+' | head -1)
[[ -z "$PREMIUM_ID" ]] && die "Could not parse Premium product_id from: $PREMIUM_OUT"
ok "Premium product: $PREMIUM_ID"

# Create SPCX product ($0.02)
info "Creating SPCX product (\$0.02 USDC)..."
SPCX_OUT=$(cd "$FACILITATOR_DIR" && npx tsx src/cli/index.ts products add \
  --name SPCX \
  --endpoint /spcx \
  --asset USDC_BASECHAIN_ETH_TEST5_8SH8 \
  --price 20000 \
  --mechanism eip-3009 2>/dev/null) || die "Failed to create SPCX product"

SPCX_ID=$(echo "$SPCX_OUT" | grep -oE 'prod_[a-zA-Z0-9]+' | head -1)
[[ -z "$SPCX_ID" ]] && die "Could not parse SPCX product_id from: $SPCX_OUT"
ok "SPCX product: $SPCX_ID"

# Stop temporary facilitator
kill $FAC_PID 2>/dev/null; wait $FAC_PID 2>/dev/null || true
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
echo "The agent signs EIP-3009 payments. It needs a Base Sepolia wallet"
echo "funded with USDC (for payments) and ETH (for gas)."
echo ""
echo "Options:"
echo "  1) Generate a new wallet (you'll need to fund it)"
echo "  2) Paste an existing private key"
echo ""
read -rp "  Choice [1/2]: " WALLET_CHOICE

if [[ "$WALLET_CHOICE" == "2" ]]; then
  read -rp "  Private key (0x...): " AGENT_PK
  [[ -z "$AGENT_PK" ]] && die "Private key required."
else
  info "Generating new wallet..."
  AGENT_PK=$(node -e "const {Wallet}=require('ethers'); const w=Wallet.createRandom(); console.log(w.privateKey+' '+w.address)")
  AGENT_ADDR=$(echo "$AGENT_PK" | awk '{print $2}')
  AGENT_PK=$(echo "$AGENT_PK" | awk '{print $1}')
  echo ""
  warn "New wallet generated!"
  echo "  Address:     ${AGENT_ADDR}"
  echo "  Private key: ${AGENT_PK}"
  echo ""
  echo "  Fund this address with Base Sepolia ETH and USDC before running purchases:"
  echo "    ETH:  https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"
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
if [[ -f "$ROOT/dashboard/.env.example" ]] && [[ ! -f "$ROOT/dashboard/.env" ]]; then
  cp "$ROOT/dashboard/.env.example" "$ROOT/dashboard/.env"
  ok "dashboard/.env written from example"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
hr
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${RESET}"
echo ""
echo "Open 3 terminal tabs and run:"
echo ""
echo -e "  ${BOLD}Tab 1 — Facilitator${RESET}"
echo "    cd x402-facilitator && npm run dev"
echo ""
echo -e "  ${BOLD}Tab 2 — Merchant${RESET}"
echo "    cd merchant && npm run dev"
echo ""
echo -e "  ${BOLD}Tab 3 — Dashboard${RESET}"
echo "    cd dashboard && npm run dev"
echo "    Open http://localhost:5174"
echo ""
echo "The MCP server starts automatically when Claude Code opens this project."
echo "Run /mcp in Claude Code to confirm bloomberg-payments is connected."
echo ""
warn "IMPORTANT: Approve Fireblocks signing requests in the mobile app or console"
warn "           when prompted after each purchase."
echo ""
