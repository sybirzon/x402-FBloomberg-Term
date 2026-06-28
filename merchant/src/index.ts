/**
 * Example merchant server that uses @x402/express to gate a paid
 * endpoint. Talks to the local x402 facilitator for the quote
 * (/api/payments/create), verification, and settlement.
 *
 * Env:
 * PORT                 default 3010
 * FACILITATOR_URL      default http://localhost:3011
 * FACILITATOR_API_KEY  required (mint with `x402 keys create --scopes process-payments`)
 * PREMIUM_PRODUCT_ID   required — the product_id returned by `x402 products add`
 * SETTLEMENT_MODE      optimistic | settle-first (default optimistic)
 */

import 'dotenv/config';

import express from 'express';

import { x402Middleware } from '@x402/express';

const PORT = Number(process.env.PORT || 3010);

const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3001';

const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;

const PREMIUM_PRODUCT_ID = process.env.PREMIUM_PRODUCT_ID;

const SPCX_PRODUCT_ID = process.env.SPCX_PRODUCT_ID;

const SETTLEMENT_MODE = (process.env.SETTLEMENT_MODE || 'optimistic') as
  | 'optimistic'
  | 'settle-first';

if (!FACILITATOR_API_KEY) {
  console.error(
    'FACILITATOR_API_KEY is not set. Mint one with:\n' +
      ' x402 keys create --scopes process-payments --label merchant',
  );
  process.exit(1);
}

if (!PREMIUM_PRODUCT_ID) {
  console.error(
    'PREMIUM_PRODUCT_ID is not set. Add a product on the facilitator and copy its product_id:\n' +
      ' x402 products add --name Premium --endpoint /premium --asset <ASSET> --price 100000',
  );
  process.exit(1);
}

if (!SPCX_PRODUCT_ID) {
  console.error(
    'SPCX_PRODUCT_ID is not set. Add a product on the facilitator and copy its product_id:\n' +
      ' x402 products add --name SPCX --endpoint /spcx --asset <ASSET> --price 20000',
  );
  process.exit(1);
}

const GATED_PATHS = new Set(['/premium', '/spcx']);

type AgentStep = { message: string; status: 'info' | 'success' | 'error'; source: 'agent' | 'merchant' | 'facilitator' | 'fireblocks'; dest?: 'agent' | 'merchant' | 'facilitator' | 'fireblocks'; details?: unknown };
// Last data purchased by the MCP agent, keyed by endpoint
const agentDataStore = new Map<string, { data: unknown; ts: number; steps?: AgentStep[]; payer?: string }>();

interface SettlementRecord {
  status: 'submitted' | 'confirmed' | 'failed';
  txHash: string | null;
  error: string | null;
  endpoint: string;
  ts: number;
}
// Keyed by lowercase payer address. Cleared after 5 minutes.
const settlementStore = new Map<string, SettlementRecord>();

function log(msg: string): void {
  console.log(msg);
}

function logPaymentRequired(path: string, body: any): void {
  // Show what the merchant is telling the agent: how much to pay, to whom, on what network
  const accepts = body?.accepts?.[0];
  log(`\n[merchant → agent] 402 — here's what you need to pay:`);
  log(`  amount:  ${accepts?.amount ?? '?'} (${accepts?.extra?.priceUsd ?? '?'} USD)`);
  log(`  asset:   ${accepts?.asset ?? '?'}`);
  log(`  payTo:   ${accepts?.payTo ?? '?'}`);
  log(`  network: ${accepts?.network ?? '?'}`);
  log(`  mechanisms: ${body?.accepts?.map((a: any) => a.extra?.assetTransferMethod).join(', ') ?? '?'}`);
}

function logTxInitiation(req: express.Request, res: express.Response): void {
  const sig = req.headers['payment-signature'];
  if (typeof sig !== 'string') return;
  try {
    const payload = JSON.parse(Buffer.from(sig, 'base64').toString('utf-8'));
    const accepted = payload?.accepted;
    // Extract payer from whichever mechanism was used
    const auth = payload?.payload?.authorization as any;
    const delegation = payload?.payload?.delegation as any;
    const payer = auth?.from ?? delegation?.delegator ?? '?';
    const mechanism = accepted?.extra?.assetTransferMethod ?? '?';
    const sig64 = payload?.payload?.signature;
    log(`\n[agent → merchant] signed payment — agent wants to pay:`);
    log(`  payer:     ${payer}`);
    log(`  amount:    ${accepted?.amount ?? '?'}`);
    log(`  mechanism: ${mechanism}`);
    log(`  signature: ${typeof sig64 === 'string' ? sig64.slice(0, 20) + '…' : '?'}`);
    if (auth) {
      log(`  auth.validBefore: ${auth.validBefore ?? '?'}`);
      log(`  auth.nonce:       ${auth.nonce ?? '?'}`);
    }
    if (payer && payer !== '?') res.locals.payer = payer.toLowerCase();
  } catch {
    log(`[merchant] could not decode payment-signature`);
  }
}

// ── Intercept fetch to log merchant ↔ facilitator traffic ──────────
const _origFetch = globalThis.fetch;
globalThis.fetch = async (input: Parameters<typeof _origFetch>[0], init?: Parameters<typeof _origFetch>[1]): Promise<Response> => {
  const url =
    typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : (input as Request).url;

  const isFacilitator = url.startsWith(FACILITATOR_URL);
  if (isFacilitator) {
    const method = init?.method ?? 'GET';
    const path = url.slice(FACILITATOR_URL.length) || '/';
    log(`\n[merchant → facilitator] ${method} ${path}`);
    if (init?.body) {
      try {
        const parsed = JSON.parse(init.body as string);
        log(`  body: ${JSON.stringify(parsed).slice(0, 300)}`);
      } catch { /* non-JSON body */ }
    }
  }

  const response = await _origFetch(input, init);

  if (isFacilitator) {
    const clone = response.clone();
    let bodyText = '';
    try { bodyText = JSON.stringify(await clone.json()); } catch { /* ignore */ }
    log(`[facilitator → merchant] ${response.status} ${response.statusText}`);
    if (bodyText) log(`  body: ${bodyText.slice(0, 300)}`);
  }

  return response;
};

const app = express();

// ── CORS — allow dashboard (and any origin) to access the merchant ───
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, payment-signature',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'payment-response, PAYMENT-REQUIRED, X-402-Integrity',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// ── log 402 payloads and payment-signature before x402 runs ─────────
app.use((req, res, next) => {
  const silent = ['/agent-data', '/settlement-status'];
  if (!silent.includes(req.path)) console.log(`[merchant] request: ${req.method} ${req.path}`);
  if (!GATED_PATHS.has(req.path)) return next();
  logTxInitiation(req, res);
  if (typeof req.headers['payment-signature'] === 'string') return next();
  // Intercept res.json to capture the 402 body
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 402) logPaymentRequired(req.path, body);
    return origJson(body);
  };
  next();
});

// ── x402 middleware — gates '/premium' by product_id ────────────────

app.use(
  x402Middleware({
    facilitatorUrl: FACILITATOR_URL,
    apiKey: FACILITATOR_API_KEY,
    settlement: SETTLEMENT_MODE,
    products: [
      { endpoint: '/premium', productId: PREMIUM_PRODUCT_ID },
      { endpoint: '/spcx', productId: SPCX_PRODUCT_ID },
    ],
    onSettlement: (o) => {
      // Fall back to the submitted-state entry if the facilitator didn't return a payer
      let payer: string | undefined = o.payer?.toLowerCase();
      if (!payer) {
        for (const [k, v] of settlementStore.entries()) {
          if (v.status === 'submitted' && v.endpoint === o.endpoint) { payer = k; break; }
        }
      }

      console.log(
        `[merchant] ${o.success ? '✓ settled' : '✗ failed'} ${o.endpoint} payer=${payer ?? '?'} tx=${o.txHash ?? '(none)'} err=${o.error ?? ''}`,
      );
      if (payer) {
        settlementStore.set(payer, {
          status: o.success ? 'confirmed' : 'failed',
          txHash: o.txHash ?? null,
          error: o.error ?? null,
          endpoint: o.endpoint,
          ts: Date.now(),
        });
      }
    },
  }),
);

// ── Log 200 OK and mark settlement as submitted ──────────────────────
app.use((req, res, next) => {
  if (!GATED_PATHS.has(req.path)) return next();
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200) {
      log(`\n[merchant → agent] 200 OK — payment accepted, serving ${req.path}`);
      const payer = res.locals.payer as string | undefined;
      if (payer) {
        settlementStore.set(payer, {
          status: 'submitted',
          txHash: null,
          error: null,
          endpoint: req.path,
          ts: Date.now(),
        });
        log(`[merchant] settlement submitted — payer=${payer} endpoint=${req.path} → awaiting Fireblocks signature`);
      }
    }
    return origJson(body);
  };
  next();
});

app.get('/settlement-status', (req, res) => {
  const payer = (req.query.payer as string | undefined)?.toLowerCase();
  if (!payer) { res.json({ status: 'unknown' }); return; }
  const r = settlementStore.get(payer);
  if (!r) { res.json({ status: 'pending' }); return; }
  if (Date.now() - r.ts > 5 * 60_000) {
    settlementStore.delete(payer);
    res.json({ status: 'unknown' });
    return;
  }
  res.json({
    status: r.status,
    txHash: r.txHash,
    error: r.error,
    endpoint: r.endpoint,
    ts: r.ts,
  });
});

// MCP agent posts purchased data here; dashboard polls to display it
app.post('/agent-data', (req, res) => {
  const { endpoint, data, steps, payer, partial } = req.body as { endpoint: string; data: unknown; steps?: AgentStep[]; payer?: string; partial?: boolean };
  if (!endpoint) { res.status(400).json({ error: 'missing endpoint' }); return; }
  if (partial) {
    // Incremental step stream — preserve existing data and ts, only update steps
    const existing = agentDataStore.get(endpoint);
    agentDataStore.set(endpoint, {
      data: existing?.data ?? null,
      ts: existing?.ts ?? Date.now(),
      steps,
      payer: payer ?? existing?.payer,
    });
    res.json({ ok: true });
    return;
  }
  if (!data) { res.status(400).json({ error: 'missing data' }); return; }
  log(`\n[agent → merchant] POST /agent-data — storing result for ${endpoint}`);
  if (payer) log(`  payer: ${payer}`);
  if (steps?.length) log(`  steps: ${steps.length} activity entries`);
  agentDataStore.set(endpoint, { data, ts: Date.now(), steps, payer });
  res.json({ ok: true });
});

app.get('/agent-data', (req, res) => {
  const endpoint = (req.query.endpoint as string | undefined) ?? '/premium';
  const entry = agentDataStore.get(endpoint);
  if (!entry) { res.json({ data: null }); return; }
  res.json({ data: entry.data, ts: entry.ts, steps: entry.steps, payer: entry.payer });
});

app.post('/reset', (_req, res) => {
  agentDataStore.clear();
  settlementStore.clear();
  console.log('[merchant] store reset via dashboard');
  res.json({ ok: true });
});

app.get('/hello', (_req, res) => {
  res.json({
    tier: 'free',
    assets: [
      { symbol: 'BTC', price: 65432, change24h: 2.34 },
      { symbol: 'ETH', price: 3421, change24h: -0.52 },
      { symbol: 'SOL', price: 172, change24h: 1.12 },
    ],
  });
});

app.get('/premium', (_req, res) => {
  res.json({
    tier: 'premium',
    timestamp: new Date().toISOString(),
    assets: [
      {
        symbol: 'BTC',
        price: 65432,
        change24h: 2.34,
        volume24h: 38241000000,
        marketCap: 1287000000000,
        high24h: 66102,
        low24h: 63250,
        rsi: 62.4,
        sentiment: 'bullish',
        dominance: 52.3,
      },
      {
        symbol: 'ETH',
        price: 3421,
        change24h: -0.52,
        volume24h: 18923000000,
        marketCap: 411000000000,
        high24h: 3498,
        low24h: 3380,
        rsi: 44.1,
        sentiment: 'neutral',
      },
      {
        symbol: 'SOL',
        price: 172,
        change24h: 1.12,
        volume24h: 4821000000,
        marketCap: 79000000000,
        high24h: 178,
        low24h: 168,
        rsi: 58.7,
        sentiment: 'bullish',
      },
    ],
  });
});

app.get('/spcx', async (_req, res) => {
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/SPCX?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
    );
    if (!r.ok) throw new Error(`Yahoo Finance HTTP ${r.status}`);
    const raw = await r.json() as any;
    const meta = raw?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('empty Yahoo Finance response');

    const price: number = meta.regularMarketPrice;
    const prevClose: number = meta.previousClose ?? meta.chartPreviousClose ?? meta.regularMarketPreviousClose;
    const change = price - prevClose;
    const changePct = (change / prevClose) * 100;

    res.json({
      tier: 'spcx',
      timestamp: new Date().toISOString(),
      stock: {
        ticker: meta.symbol ?? 'SPCX',
        company: meta.longName ?? meta.shortName ?? 'SpaceX',
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? '—',
        currency: meta.currency ?? 'USD',
        marketState: meta.marketState ?? 'CLOSED',
        sharePrice: price,
        change,
        changePct,
        previousClose: prevClose,
        high: meta.regularMarketDayHigh,
        low: meta.regularMarketDayLow,
        high52w: meta.fiftyTwoWeekHigh,
        low52w: meta.fiftyTwoWeekLow,
        volume: meta.regularMarketVolume,
        marketCap: meta.marketCap ?? null,
      },
    });
  } catch (err) {
    console.error('[merchant] /spcx fetch error:', (err as Error).message);
    res.status(502).json({ error: 'Failed to fetch SPCX data', details: (err as Error).message });
  }
});

app.get('/', (_req, res) => {
  res.json({
    name: 'x402 example merchant',
    endpoints: {
      '/hello': 'free',
      '/premium': `paid $0.01 (product ${PREMIUM_PRODUCT_ID})`,
      '/spcx': `paid $0.02 (product ${SPCX_PRODUCT_ID})`,
    },
    facilitator: FACILITATOR_URL,
  });
});

app.listen(PORT, () => {
  console.log(`[merchant] ★ NEW CODE LOADED — logging active`);
  console.log(`x402 example merchant listening on ${PORT}`);
  console.log(` facilitator: ${FACILITATOR_URL}`);
  console.log(` gated path: /premium → product ${PREMIUM_PRODUCT_ID}`);
  console.log(` settlement mode: ${SETTLEMENT_MODE}`);
});
