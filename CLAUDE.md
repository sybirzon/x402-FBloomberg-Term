# FBloomberg Terminal — x402 Micropayments Demo

An end-to-end demo of AI-native payments using the x402 protocol. An AI agent (Claude via MCP) pays $0.01–$0.02 USDC per request to unlock gated Bloomberg-style market data, settled on-chain via Fireblocks on Base Sepolia.

## Architecture

```
Claude Code (MCP client)
    │
    ▼
agent/src/mcp-server.mts        ← MCP server: signs EIP-3009, calls merchant
    │
    ▼
merchant/src/index.ts           ← Express: gates /premium and /spcx behind x402
    │
    ▼
x402-facilitator/               ← Verifies payment signatures, settles via Fireblocks
    │
    ▼
Fireblocks (Base Sepolia)       ← Submits transferWithAuthorization on-chain
    │
dashboard/src/                  ← React UI: shows purchased data, polls for MCP updates
```

## Prerequisites

- Node.js 20+
- A Fireblocks account with:
  - A vault named `402` with a Base Sepolia USDC deposit address
  - An API key and RSA private key (`.pem`)
- Testnet funds in the agent wallet:
  - Base Sepolia ETH (for gas): [Coinbase faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)
  - Base Sepolia USDC: [Circle faucet](https://faucet.circle.com/)

## Project Structure

```
example/
├── .mcp.json                   ← Claude Code MCP server config
├── agent/                      ← MCP server (Claude tool: purchase_bloomberg, bloomberg_balance)
│   ├── src/mcp-server.mts      ← MCP server entry point
│   ├── src/index.ts            ← CLI test client (npm run dev) — same payment flow, posts steps to dashboard
│   └── .env
├── merchant/                   ← x402-gated Express API
│   ├── src/index.ts
│   └── .env
├── x402-facilitator/           ← Payment verification + Fireblocks settlement
│   ├── config/facilitator.json
│   ├── secrets/fireblocks.pem
│   └── .env
├── dashboard/                  ← React frontend (Vite, port 5174)
│   └── src/
└── wallet-ui/                  ← Wallet interface
```

## Setup

### 1. Facilitator

```bash
cd x402-facilitator
cp .env.example .env
npm install
```

Edit `config/facilitator.json` and fill in your Fireblocks credentials:
```json
{
  "configurations": [{
    "fireblocks": {
      "api_key": "<your-fireblocks-api-key>",
      "api_secret_path": "./secrets/fireblocks.pem",
      "receiver_vault": "402",
      "base_url": "https://api.fireblocks.io"
    }
  }]
}
```

Copy your Fireblocks RSA private key to `secrets/fireblocks.pem`.

Run setup to scaffold products and API keys:
```bash
npm run setup
```

Start:
```bash
npm run dev   # runs on port 3001
```

### 2. Merchant

```bash
cd merchant
cp .env.example .env
npm install
```

Edit `.env`:
```env
PORT=3010
FACILITATOR_URL=http://localhost:3001
FACILITATOR_API_KEY=<key from facilitator setup>
PREMIUM_PRODUCT_ID=<product_id from facilitator setup>
SPCX_PRODUCT_ID=<product_id from facilitator setup>
SETTLEMENT_MODE=optimistic
```

Start:
```bash
npm run dev   # runs on port 3010
```

### 3. Agent (MCP server)

```bash
cd agent
npm install
```

Edit `.env`:
```env
PRIVATE_KEY=0x<your-agent-wallet-private-key>
MERCHANT_URL=http://localhost:3010/premium
RPC_URL_BASE_SEPOLIA=https://base-sepolia-rpc.publicnode.com
```

The MCP server starts automatically when Claude Code opens this project — no manual start needed. It is configured in `.mcp.json` at the project root.

> **Important:** `dotenv` is loaded using an explicit path based on `import.meta.url`, not `process.cwd()`. This is required because Claude Code does not honor the `cwd` field in `.mcp.json` when launching the server subprocess.

### 4. Dashboard

```bash
cd dashboard
npm install
npm run dev   # runs on port 5174
```

Open `http://localhost:5174`.

## Connecting to Claude Code

The `.mcp.json` at the project root registers the `bloomberg-payments` MCP server automatically. When you open this project in Claude Code:

1. Run `/mcp` to check connection status
2. If it shows `✘ failed`, run `/mcp` again to reconnect
3. The server exposes two tools:
   - `purchase_bloomberg` — pays $0.01–$0.02 USDC and returns market data
   - `bloomberg_balance` — checks the agent wallet's USDC and ETH balance

## Usage

Once all services are running, ask Claude:

```
Use the bloomberg MCP to buy the premium endpoint
```

```
buy spcx
```

```
check my bloomberg balance
```

Each purchase:
1. Hits the merchant, receives a 402 challenge
2. Signs an EIP-3009 `TransferWithAuthorization` off-chain (no gas)
3. Submits the signed payment to the merchant
4. Merchant returns 200 with data immediately (optimistic mode)
5. Fireblocks settles the USDC transfer on-chain asynchronously
6. Dashboard at `localhost:5174` updates within 3 seconds — activity log shows all steps including settlement confirmation

## Resetting the Dashboard

To clear all purchased data and start fresh:

```bash
# Restart the merchant — clears the in-memory data store
pkill -f "tsx.*merchant" 2>/dev/null; lsof -ti :3010 | xargs kill -9 2>/dev/null
cd merchant && npm run dev
```

Then do a hard refresh in the browser (`Cmd+Shift+R`) to clear the React activity log.

## Known Gotchas

**MCP server shows `Failed to reconnect: -32000`**
The `PRIVATE_KEY` env var is missing because Claude Code ignores the `cwd` field in `.mcp.json`. The fix is already applied in `mcp-server.mts` (explicit dotenv path). If you see this, run `/mcp` to reconnect — if it persists, verify `agent/.env` has `PRIVATE_KEY` set.

**Dashboard purchase button does nothing**
The payment payload must include `resource: { url }`. This is already fixed in `dashboard/src/x402Client.ts`. If you fork and rewrite the client, don't omit this field.

**Settlement is async — balance doesn't drop immediately**
`SETTLEMENT_MODE=optimistic` means the merchant returns 200 before the Fireblocks transaction lands. The on-chain USDC transfer happens seconds to minutes later. Check the Fireblocks console for pending contract calls.

**No Fireblocks signing request appearing**
After the first purchase, open the Fireblocks mobile app or console and approve the pending `transferWithAuthorization` contract call. Each purchase (MCP or dashboard) creates a separate signing request — approve all of them. Unsigned transactions silently block settlement.

**Dashboard not showing MCP-purchased data**
The dashboard polls `GET /agent-data?endpoint=/premium` and `GET /agent-data?endpoint=/spcx` every 3 seconds. If data isn't appearing, confirm the merchant is running on port 3010 and was started with the latest code (restart if in doubt).

**Dashboard shows stale data after merchant restart**
Restarting the merchant clears the server-side store. The dashboard detects `{ data: null }` on the next poll (within 3 seconds) and clears both panels automatically. If panels don't clear, do a hard refresh (`Cmd+Shift+R`).

**MCP purchase activity log missing from dashboard**
Each MCP purchase (both MCP server and `npm run dev` CLI agent) posts its step-by-step activity (GET, 402, sign, 200) to `/agent-data`. The dashboard replays these steps in the activity log and polls for settlement confirmation automatically. If the activity log shows no entries after an agent run, confirm the merchant is running on port 3010 and the agent `.env` has `MERCHANT_URL` pointing to it.

**"Settlement confirmed" never appears after MCP purchase**
The dashboard polls `/settlement-status?payer=<agent-wallet>` after each MCP purchase, only accepting confirmations whose `ts` is newer than when the purchase started (prevents stale records from a prior payment triggering a false confirmation). If it never resolves, either the Fireblocks contract call was not approved or the facilitator lost the settlement event. Check `/tmp/bloomberg-facilitator.log` and the Fireblocks console.

**"Settlement confirmed" fires before the Fireblocks contract call is signed**
This was a known bug caused by the `settlementStore` returning a stale record from a previous payment. It is fixed: the dashboard captures a `startedAt` timestamp before each purchase and only accepts `/settlement-status` responses whose `ts ≥ startedAt - 2s`.

## Observing Agent Output by Flow

Where you can see step-by-step output depends on which flow triggered the purchase:

| Flow | Signing steps visible? | Where to look |
|------|----------------------|---------------|
| `npm run dev` (CLI agent) | Yes — full output | Terminal running the agent |
| MCP (Claude Code tool call) | No | Dashboard activity log; merchant terminal |
| Web UI (dashboard button) | No | Dashboard activity log; merchant terminal |

**CLI agent** prints everything: balance probes, EIP-712 typed data, signature, raw HTTP response.

**MCP server** runs as a stdio subprocess under Claude Code. Its stdout is the JSON-RPC wire protocol, so it cannot log there. Stderr is captured internally by Claude Code and is not written to a file. What you see in the Claude Code conversation is the tool return value — not a live stream. The dashboard activity log is the closest equivalent.

**Web UI** signs entirely in the browser. No server-side process produces CLI output for the signing steps.

**Following server-side traffic for any flow:**

```bash
tail -f /tmp/bloomberg-merchant.log      # HTTP requests, 402/200, facilitator calls
tail -f /tmp/bloomberg-facilitator.log   # Fireblocks CONTRACT_CALL submission and settlement
```

These show the merchant and facilitator sides of every purchase regardless of which client triggered it, but they do not include the client-side signing steps.

## Activity Log

Each purchase — whether from the dashboard or via the MCP agent in Claude Code — produces a step-by-step activity log showing the full x402 payment flow:

| Step | Source | Description |
|------|--------|-------------|
| `GET /premium` | agent | Initial unauthenticated request to the gated endpoint |
| `402 Payment Required — 0.01 USDC` | merchant | Server rejects with payment invoice (amount, asset, payTo, network) |
| `Signing EIP-3009 typed data...` | agent | Off-chain EIP-712 `TransferWithAuthorization` signature — no gas |
| `EIP-3009 typed data signed` | agent | Signature complete with nonce, validBefore, from/to/value |
| `Sending signed payment...` | agent | Retry request with `payment-signature` header containing base64 x402 payload |
| `200 OK — payment accepted` | merchant | Merchant verifies signature and returns gated data |
| `Settlement confirmed — balance: X USDC` | facilitator | On-chain transfer mined; balance updated. Appears only after Fireblocks approves the CONTRACT_CALL. |
| `Settlement timed out` | facilitator | Fireblocks CONTRACT_CALL was not approved within ~2 minutes. Approve in the Fireblocks console and re-run. |

Each entry in the dashboard has a `▶` expand arrow revealing the full HTTP request/response, EIP-712 typed data, signature components, and RPC call details in a single scrollable panel.

### Activity Log CSS notes (`dashboard/src/App.css`)

- `.log-message` — `white-space: normal; word-break: break-word` — messages wrap fully, no truncation
- `.log-details` — `white-space: pre; max-height: 480px; overflow-y: auto` — expanded HTTP/JSON panel, scrollable
- `.log-entry` — no `overflow: hidden` — allows wrapped messages to render at full height

## Running Everything

To start all services, ask Claude:

```
start the bloomberg terminal
```

Claude will run `scripts/start-all.sh` which starts the facilitator (port 3001), merchant (port 3010), and dashboard (port 5174) in the background. Logs are written to `/tmp/bloomberg-*.log`.

The MCP server starts automatically via `.mcp.json` — run `/mcp` in Claude Code to confirm `bloomberg-payments` is connected.

To start manually in separate terminals:

```bash
# Terminal 1 — Facilitator
cd x402-facilitator && npm run dev

# Terminal 2 — Merchant
cd merchant && npm run dev

# Terminal 3 — Dashboard
cd dashboard && npm run dev
```
