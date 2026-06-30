# Bloomberg Terminal — x402 Payment Flow

```mermaid
sequenceDiagram
    actor User
    participant Dashboard
    participant Agent as Agent<br/>(MCP / CLI / Web UI)
    participant Merchant as Merchant<br/>:3010
    participant Facilitator as Facilitator<br/>:3001
    participant Fireblocks
    participant USDC as USDC Contract<br/>(Base Sepolia)

    User->>Agent: buy premium / spcx

    %% Step 1 — probe
    Agent->>Merchant: GET /premium
    Merchant->>Facilitator: POST /api/payments/create
    Facilitator-->>Merchant: quote (amount, asset, payTo, network)
    Merchant-->>Agent: 402 Payment Required

    %% Step 2 — sign
    Note over Agent: Generate nonce (crypto.randomBytes)<br/>Sign EIP-712 TransferWithAuthorization<br/>(off-chain, no gas)

    %% Step 3 — pay
    Agent->>Merchant: GET /premium + payment-signature header
    Merchant->>Facilitator: POST /api/payments/verify
    Facilitator-->>Merchant: { isValid: true }
    Merchant-->>Agent: 200 OK + market data
    Agent-->>Dashboard: POST /agent-data (steps + data)

    %% Step 4 — settle (async)
    Merchant->>Facilitator: POST /api/payments/settle
    Facilitator->>Fireblocks: CONTRACT_CALL<br/>transferWithAuthorization
    Fireblocks-->>User: signing request (mobile app)
    User->>Fireblocks: approve
    Fireblocks->>USDC: transferWithAuthorization on-chain
    Fireblocks-->>Facilitator: tx confirmed
    Facilitator-->>Merchant: onSettlement callback
    Merchant-->>Dashboard: GET /settlement-status (polled)
```

## Component Responsibilities

| Component | Role | Port |
|-----------|------|------|
| **Agent** | Signs EIP-3009, manages nonce, posts activity to dashboard | — |
| **Merchant** | Gates `/premium` and `/spcx`, calls facilitator, serves data | 3010 |
| **Facilitator** | Issues quotes, verifies signatures, submits Fireblocks settlements | 3001 |
| **Fireblocks** | Signs and broadcasts `transferWithAuthorization` on-chain | — |
| **Dashboard** | Polls `/agent-data` + `/settlement-status`, displays activity log | 5174 |

## Key Design Points

- **No gas for the payer** — EIP-3009 is an off-chain signature; Fireblocks pays gas for the on-chain settlement
- **Optimistic mode** — merchant returns 200 immediately after verify; settlement happens in the background
- **Nonce** — generated client-side by the agent (`crypto.randomBytes(32)`), embedded in the signed authorization, prevents replay
- **Activity log** — agent streams steps incrementally via partial POSTs to `/agent-data` as each step completes
