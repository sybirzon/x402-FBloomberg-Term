# FBloomberg Terminal × x402

An end-to-end demo of AI-native micropayments. A Claude Code agent pays **$0.01–$0.02 USDC** per request to unlock gated Bloomberg-style market data, settled on Base Sepolia via Fireblocks using the [x402 protocol](https://x402.org).

```
Claude Code (MCP) → agent (signs EIP-3009) → merchant (gates /premium, /spcx)
                                                    │
                                                    ▼
                                           facilitator → Fireblocks → Base Sepolia USDC
                                                                              │
                                                                              ▼
                                                             dashboard (localhost:5174)
```

## Prerequisites

- Node.js 20+
- Git
- [Claude Code](https://claude.ai/code)
- A Fireblocks workspace (sandbox or testnet) — see [Workspace Setup](#fireblocks-workspace-setup) below

## Quick Start

```bash
git clone https://github.com/sybirzon/x402-Bloomberg-Term.git
cd x402-Bloomberg-Term
```

Then open the project in Claude Code and follow the [Teammate Setup Guide](docs/TEAMMATE_SETUP.md) — it walks you through credentials, runs the setup script, and starts all services.

## Fireblocks Workspace Setup

You need a testnet-capable Fireblocks workspace. Two options:

### Sandbox (recommended for first-time setup)

Free, isolated environment with an API co-signer — transactions are auto-approved, no policy configuration needed.

- Sign up: [sandbox.fireblocks.io](https://sandbox.fireblocks.io)
- Use `base_url: https://sandbox-api.fireblocks.io` in the facilitator config

### Testnet Workspace (production workspace with testnet assets)

Standard Fireblocks workspace pointed at testnet networks. Requires two Transaction Policy rules:
- `CONTRACT_CALL` — for the on-chain settlement transaction
- `Typed Message` — for EIP-712 signing of the payment authorization

Signing is configurable (API co-signer or manual approval).

- Use `base_url: https://api.fireblocks.io`

### Switching Workspaces

To switch API user or vault after setup, tell Claude:

```
Change the Fireblocks workspace — API user is <uuid> and vault ID is <id>
```

## Testnet Funds

The **agent wallet** (payer) needs:
- Base Sepolia ETH (gas): [Coinbase faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
- Base Sepolia USDC: [Circle faucet](https://faucet.circle.com)

The **Fireblocks vault** (receiver) only needs Base Sepolia ETH for gas — it accumulates USDC from settled payments.

## Services

| Service | Port | Description |
|---------|------|-------------|
| Facilitator | 3001 | Verifies x402 payments, settles via Fireblocks |
| Merchant | 3010 | Express API gating `/premium` and `/spcx` |
| Dashboard | 5174 | React UI showing purchased data and activity log |
| MCP server | stdio | Claude Code tool: `purchase_bloomberg`, `bloomberg_balance` |

## Usage

Once all services are running, ask Claude Code:

```
buy premium
```

```
buy spcx
```

```
check my bloomberg balance
```

## Further Reading

- [Teammate Setup Guide](docs/TEAMMATE_SETUP.md) — full setup walkthrough
- [Architecture](ARCHITECTURE.md) — detailed system design
- [CLAUDE.md](CLAUDE.md) — Claude Code context and known gotchas
