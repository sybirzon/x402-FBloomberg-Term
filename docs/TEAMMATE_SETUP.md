# FBloomberg Terminal × x402 — Teammate Setup Guide

This guide is for **anyone running the demo on their own laptop** with their **own Fireblocks workspace and own agent wallet**. Nothing here is workspace-specific — you supply your own credentials.

The setup has two parts:
- **Part A** — things you do by hand (account creation, API key generation, vault setup, faucet runs). Required before any code can help you.
- **Part B** — a single prompt you paste into Claude Code that drives the rest end-to-end.

Architecture (what you're building):

```
Claude Code (MCP) ──▶ agent (signs EIP-3009) ──▶ merchant (gates /premium, /spcx)
                                                       │
                                                       ▼
                                                facilitator ──▶ Fireblocks ──▶ Base Sepolia USDC
                                                                                       │
                                                                                       ▼
                                                                  dashboard (localhost:5174)
```

End-to-end cost per call: **$0.01 USDC** (Premium) or **$0.02 USDC** (SPCX), settled on Base Sepolia in ~30–60s.

---

## Part A — Do these by hand BEFORE opening Claude Code

### A1. Local toolchain

- **Node.js 20+** (`node -v`). Install from <https://nodejs.org>.
- **npm 10+** (ships with Node).
- **git** (`git --version`).
- **Claude Code** — <https://claude.ai/code>.

### A2. Fireblocks workspace prep

You need a testnet-capable Fireblocks workspace.

1. **Create a vault** (any name; the demo doesn't care about the name).
2. **Enable `USDC_BASECHAIN_ETH_TEST5_8SH8`** (Base Sepolia USDC) on that vault. Console → vault → "+ Asset" → search USDC → pick Base Sepolia (chain 84532). If it goes to `WAITING_FOR_APPROVAL`, approve in the mobile app.
3. **Enable `BASECHAIN_ETH_TEST5`** (Base Sepolia ETH) on the same vault — for gas during settlement.
4. **Note the vault's numeric ID** (Console → click into the vault → URL contains `/vault/<ID>` or details panel shows it). Vault IDs are integers (0, 1, 2, …) and are immutable; the **name** is just a display label and is NOT used by the API. You'll need the numeric ID later.
5. **Note the vault's deposit address** for USDC on Base Sepolia (Console → vault → USDC → Deposit). It'll look like `0x…`. Same address works for both USDC and ETH (it's an EVM chain).

### A3. Fireblocks API key

1. Console → **Settings → API Keys → Add User**.
2. Role: any role that allows vault read + transaction create on Base Sepolia USDC. Editor is fine for a demo.
3. Generate the API key — Console gives you a CSR flow or a private-key download.
4. Save the **private key** to `~/fireblocks_api_secret.pem` (or any path you like). `chmod 600` it. **NEVER commit this file.**
5. Copy the **API key UUID** (e.g. `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). This is a public identifier; the PEM is the actual secret.
6. Note the base URL for your workspace:
   - Sandbox: `https://sandbox-api.fireblocks.io`
   - Other testnet workspaces (production endpoint): `https://api.fireblocks.io`

### A4. Faucets — fund the vault AND fund a new agent wallet later

The receiver side (your Fireblocks vault) only needs ETH for gas — it will accumulate USDC as payments settle, no pre-funding required:
- Base Sepolia ETH (≥0.05): <https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet> — pays gas for the `receiveWithAuthorization` contract call submitted by the facilitator.

You will fund the **agent wallet** (the payer) with both ETH and USDC AFTER the setup script generates it — see Part B Step 7.

### A5. (Optional) Dynamic.xyz embedded-wallet panel

The dashboard has an **optional** Dynamic.xyz embedded-wallet UI panel. If you don't want it (or just want to get the core x402 demo running first), **skip this section** — the setup script will leave the panel disabled and the rest of the demo still works.

If you do want it:
1. Sign up at <https://app.dynamic.xyz>.
2. Create an Environment (e.g. "Bloomberg demo").
3. Copy the Environment ID (UUID).

### A6. Stage credentials in a single env file (NOT inside any repo)

Create `~/.bloomberg-x402.env` with `chmod 600` and these values filled in:

```env
FIREBLOCKS_API_KEY=<your UUID>
FIREBLOCKS_BASE_URL=<https://api.fireblocks.io OR https://sandbox-api.fireblocks.io>
FIREBLOCKS_PEM_PATH=<absolute path to your fireblocks PEM, e.g. /Users/you/fireblocks_api_secret.pem>
FIREBLOCKS_VAULT_ID=<any non-negative integer, e.g. 0, 1, 2, 10>
FIREBLOCKS_VAULT_DEPOSIT_ADDR=<your vault's Base Sepolia USDC deposit address, 0x…>
# Optional — leave blank or unset to disable the Dynamic panel in the dashboard
DYNAMIC_ENV_ID=<your Dynamic Environment ID UUID, or blank>
```

This file is for **your** convenience — neither the setup script nor Claude Code reads it directly. You'll paste the values when prompted.

---

## Part B — Paste this entire block into Claude Code as one message

Open Claude Code in your home directory. Paste **everything** between the dashes below as a single message. Claude will execute the steps, asking you for input only where strictly necessary.

```
I want to set up the FBloomberg Terminal × x402 micropayments demo on this laptop.

The repo is github.com/sybirzon/x402-Bloomberg-Term. I have already completed Part A
of the teammate setup guide (toolchain installed, Fireblocks vault + API key + PEM
ready, faucets done, ~/.bloomberg-x402.env staged with my workspace identifiers).

Drive these steps end-to-end. Don't ask me to confirm between steps — just do them
and report what each step did. Treat ~/.bloomberg-x402.env as the only source of
workspace credentials; don't hardcode anything elsewhere.

==================================================================
STEP 1 — Verify prerequisites
==================================================================
- node -v >= 20 and npm -v >= 10
- git installed
- ~/.bloomberg-x402.env exists, is mode 600, defines:
    FIREBLOCKS_API_KEY, FIREBLOCKS_BASE_URL, FIREBLOCKS_PEM_PATH,
    FIREBLOCKS_VAULT_ID, FIREBLOCKS_VAULT_DEPOSIT_ADDR
    (DYNAMIC_ENV_ID is optional — fine to be missing or blank)
- The file referenced by FIREBLOCKS_PEM_PATH exists and is mode 600.

If anything is missing, stop and tell me.

==================================================================
STEP 2 — Clone the demo repo
==================================================================
- mkdir -p ~/x402-Bloomberg-Term's parent dir if needed (this is just $HOME)
- git clone git@github.com:sybirzon/x402-Bloomberg-Term ~/x402-Bloomberg-Term
  (fall back to https if SSH fails)

==================================================================
STEP 3 — Pre-flight checks on the cloned repo
==================================================================
Verify before running the setup script (these are known papercuts the script
handles, but worth confirming):
- ~/x402-Bloomberg-Term/dashboard/.npmrc exists with legacy-peer-deps=true
  (works around an @dynamic-labs-sdk/react-hooks peer conflict)
- ~/x402-Bloomberg-Term/dashboard/stubs/dynamic-metamask/ exists with
  package.json + index.js + index.cjs
  (no-op stub for @dynamic-labs-sdk/metamask; the dashboard postinstall
  expects this dir; some clones may be missing it. If missing, ask me to fix.)
- ~/x402-Bloomberg-Term/.mcp.json.template exists
  (template the setup script substitutes to produce a local .mcp.json with
  absolute paths matching this machine; if missing, MCP integration breaks.)

==================================================================
STEP 4 — Run the setup script
==================================================================
- cd ~/x402-Bloomberg-Term
- bash scripts/setup-fbloomberg.sh

The script will prompt for:
  • Fireblocks API key             → use $FIREBLOCKS_API_KEY from ~/.bloomberg-x402.env
  • Fireblocks vault ID            → use $FIREBLOCKS_VAULT_ID
  • PEM file path                  → use $FIREBLOCKS_PEM_PATH (paste the absolute path)
  • Wallet choice (1/2)            → choose 1 (generate fresh agent wallet)
  • "Press Enter to continue"      → after capturing the printed agent address, press Enter
  • Dynamic Environment ID         → use $DYNAMIC_ENV_ID if set, else press Enter to skip

Capture the printed agent address. Tell me the address when the script finishes.

The setup script:
  1. Installs deps in x402-facilitator, merchant, agent, dashboard
  2. Clones github.com/fireblocks/x402-facilitator into ./x402-facilitator
  3. Builds the @x402/express workspace package (merchant depends on its dist/)
  4. Writes config/facilitator.json with my vault ID + API key
  5. Mints a fresh JWT + admin token, mints a merchant bearer token, creates
     Premium ($0.01) and SPCX ($0.02) products on Base Sepolia USDC
  6. Writes merchant/.env, agent/.env, and dashboard/.env (Dynamic panel
     active only if I supplied an env ID)
  7. Generates .mcp.json from .mcp.json.template with my local absolute path
     (so Claude Code's MCP integration works without manual rewiring)

==================================================================
STEP 5 — Verify the new agent wallet is the payer it needs to be
==================================================================
Read agent/.env, derive the public address from the PRIVATE_KEY (use the agent
dir's ethers install for this, not the repo root). Confirm the address matches
what the script printed.

==================================================================
STEP 6 — Confirm @x402/express was built
==================================================================
setup-fbloomberg.sh builds the @x402/express workspace package automatically as
part of Step 4. Just verify dist/ exists:
    ls ~/x402-Bloomberg-Term/x402-facilitator/packages/x402-express/dist
If for some reason it's missing, run:
    cd ~/x402-Bloomberg-Term/x402-facilitator && npm run build --workspace=@x402/express

==================================================================
STEP 7 — Stop, tell me to fund the new agent wallet, wait for me
==================================================================
Print the agent address one more time. Tell me to:
  1. Go to https://faucet.circle.com, select Base Sepolia, paste the agent address,
     request USDC. Wait for the tx to confirm on https://sepolia.basescan.org/
  2. Reply with "funded" once the USDC balance is non-zero on Base Sepolia.

Do not proceed to Step 8 until I confirm.

==================================================================
STEP 8 — Start the three services
==================================================================
Once I confirm the agent is funded, start:

Terminal-style (you launch in the background, log to /tmp):
  1. cd ~/x402-Bloomberg-Term/x402-facilitator && npm run dev  > /tmp/bloomberg-facilitator.log 2>&1 &
     Wait until http://localhost:3001/ returns ANY HTTP status (up to 30s).
  2. cd ~/x402-Bloomberg-Term/merchant && npm run dev  > /tmp/bloomberg-merchant.log 2>&1 &
     Wait until http://localhost:3010/ returns 200 (up to 30s).
  3. cd ~/x402-Bloomberg-Term/dashboard && npm run dev  > /tmp/bloomberg-dashboard.log 2>&1 &
     Wait until http://localhost:5174/ returns 200 (up to 30s).

The merchant MUST be started AFTER the facilitator is reachable, or it'll log
"facilitator_error: fetch failed" on first request.

==================================================================
STEP 9 — Smoke test
==================================================================
Curl http://localhost:3010/premium with no payment header. Expect HTTP 402
with a `PAYMENT-REQUIRED` header (base64-encoded x402 quote). If you get 502,
the facilitator → Fireblocks chain is broken (most likely: receiver_vault in
config/facilitator.json doesn't match my actual numeric vault ID).

==================================================================
STEP 10 — Hand off to me
==================================================================
Print:
  - Dashboard URL: http://localhost:5174
  - "Click Buy Premium or Buy SPCX. Each click triggers a Fireblocks signing
     request — approve it in the mobile app or console. ~30–60s later, the
     dashboard shows the on-chain tx hash and the data."
  - The agent wallet address (so I can monitor balance on sepolia.basescan.org)
  - The vault's deposit address (so I can verify USDC arrives there after settlement)

==================================================================
STEP 11 — Security sanity check
==================================================================
Verify and report any deviation:
  - ~/.bloomberg-x402.env             chmod 600, not inside any git repo
  - FIREBLOCKS_PEM_PATH               chmod 600
  - x402-facilitator/secrets/         not in git (gitignored)
  - x402-facilitator/config/facilitator.json   gitignored
  - agent/.env                        chmod 600, gitignored
  - merchant/.env                     chmod 600, gitignored
  - No secret values were echoed beyond what was strictly necessary.

Done.
```

---

## After the demo is running

To stop:
```bash
for p in 3001 3010 5174; do PIDS=$(lsof -ti :$p 2>/dev/null); [ -n "$PIDS" ] && kill $PIDS; done
```

To restart on a subsequent day (no re-setup needed):
```bash
cd ~/x402-Bloomberg-Term && bash scripts/start-all.sh
```

To wipe and start fresh:
```bash
cd ~/x402-Bloomberg-Term
rm -rf x402-facilitator
rm -f merchant/.env agent/.env
bash scripts/setup-fbloomberg.sh
```

Your Fireblocks vault balances survive a repo wipe — they live in your Fireblocks workspace, not in this repo.

---

## Security guardrails

- All secrets live in `~/.bloomberg-x402.env`, the PEM file, and `.env` files — all `chmod 600`. None of them belong in git.
- The repo's `.gitignore` already covers `.env`, `*.pem`, `*.key`, `secrets/`, and `x402-facilitator/config/facilitator.json`. Don't override these.
- Demo runs on **Base Sepolia testnet only**. No mainnet keys, no production funds.
- The agent's local-key signing model is fine for a demo; production deployments should use Fireblocks-side signing (Dynamic Server Wallets or similar) instead of a raw `PRIVATE_KEY=` in `.env`.

---

## When things break

Run any of these in your shell:

```bash
# What's listening on the demo ports?
for p in 3001 3010 5174; do
  PID=$(lsof -ti :$p 2>/dev/null); [ -n "$PID" ] && echo ":$p → pid $PID" || echo ":$p down"
done

# Facilitator log
tail -50 /tmp/bloomberg-facilitator.log

# Merchant log
tail -50 /tmp/bloomberg-merchant.log

# Check the vault config the facilitator is actually using
grep receiver_vault ~/x402-Bloomberg-Term/x402-facilitator/config/facilitator.json
```

Common failure modes:
- **Dashboard shows "Failed to fetch"** → merchant isn't reachable. Check `:3010` is bound. If it is, the merchant is probably returning 502 from a downstream failure — curl the merchant directly and read its response body.
- **Merchant returns `facilitator_error: fetch failed`** → facilitator is down or wrong port. Check `:3001`.
- **Facilitator returns `The Provided Vault Account ID is invalid: <X>`** → `receiver_vault` in `config/facilitator.json` is wrong. Edit it to your numeric vault ID and the facilitator will hot-reload.
- **Settlement never confirms** → Fireblocks `CONTRACT_CALL` is waiting for approval. Open the Fireblocks mobile app or console and approve.

For unresolved issues, [open an issue on the repo](https://github.com/sybirzon/x402-Bloomberg-Term/issues) or contact security@fireblocks.com for Fireblocks-side problems.
