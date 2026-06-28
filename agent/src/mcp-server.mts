/**
 * Bloomberg Payments MCP Server
 *
 * Exposes x402 micropayments as Claude tools.
 *
 * Tools:
 *   purchase_bloomberg   – buy premium or spcx endpoint data
 *   bloomberg_balance    – read wallet USDC / ETH balances
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenvConfig({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { z } from 'zod';
import crypto from 'crypto';
import { Wallet, Signature, formatUnits } from 'ethers';
import { ActivityLog } from './activity.js';

// ── Config ─────────────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MERCHANT_BASE =
  (process.env.MERCHANT_URL ?? 'http://localhost:3010/premium').replace(/\/(premium|spcx)$/, '');
const RPC_URL =
  process.env.RPC_URL_BASE_SEPOLIA ?? 'https://base-sepolia-rpc.publicnode.com';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;

if (!PRIVATE_KEY) {
  process.stderr.write('PRIVATE_KEY not set in environment\n');
  process.exit(1);
}

const wallet = new Wallet(PRIVATE_KEY);

// ── RPC helpers ────────────────────────────────────────────────────────
async function rpcCall(method: string, params: unknown[]): Promise<string | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { result?: string }).result ?? null;
  } catch {
    return null;
  }
}

async function getUsdcBalance(addr: string): Promise<string> {
  const data = '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');
  const raw = await rpcCall('eth_call', [{ to: USDC_ADDRESS, data }, 'latest']);
  return raw && raw !== '0x' ? formatUnits(BigInt(raw), 6) : '0.000000';
}

async function getEthBalance(addr: string): Promise<string> {
  const raw = await rpcCall('eth_getBalance', [addr, 'latest']);
  return raw ? formatUnits(BigInt(raw), 18) : '0.000000';
}

// ── Payment types ──────────────────────────────────────────────────────
interface PaymentRequirements {
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: string };
}

interface PaymentRequired {
  x402Version: number;
  resource: { url: string };
  accepts: PaymentRequirements[];
}

// ── EIP-3009 signer ────────────────────────────────────────────────────
interface SignResult {
  header: string;
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
  signature: string;
  authorization: Record<string, string>;
  payload: Record<string, unknown>;
}

async function signEip3009(
  accepted: PaymentRequirements,
  resourceUrl: string,
): Promise<SignResult> {
  const validBefore = Math.floor(Date.now() / 1000) + Math.max(accepted.maxTimeoutSeconds, 300);
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const domain = {
    name: accepted.extra.name,
    version: accepted.extra.version,
    chainId: CHAIN_ID,
    verifyingContract: accepted.asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = {
    from: wallet.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: 0,
    validBefore,
    nonce,
  };
  const rawSig = await wallet.signTypedData(domain, types, message);
  const signature = Signature.from(rawSig).serialized;
  const authorization = {
    from: message.from,
    to: message.to,
    value: message.value,
    validAfter: String(message.validAfter),
    validBefore: String(message.validBefore),
    nonce: message.nonce,
  };
  const payload = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted,
    payload: { signature, authorization },
  };
  return {
    header: Buffer.from(JSON.stringify(payload)).toString('base64'),
    domain,
    types,
    message: { ...message, validAfter: String(message.validAfter), validBefore: String(message.validBefore) },
    signature,
    authorization,
    payload,
  };
}

// ── Core payment flow ──────────────────────────────────────────────────
async function purchaseEndpoint(endpoint: 'premium' | 'spcx'): Promise<string> {
  const url = `${MERCHANT_BASE}/${endpoint}`;
  const log = new ActivityLog();
  log.streamTo((steps) => {
    fetch(`${MERCHANT_BASE}/agent-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: `/${endpoint}`, data: null, steps, payer: wallet.address, partial: true }),
    }).catch(() => {});
  });
  const push = (
    source: Parameters<ActivityLog['push']>[0],
    status: Parameters<ActivityLog['push']>[1],
    label: string,
    details?: unknown,
    dest?: Parameters<ActivityLog['push']>[4],
  ) => log.push(source, status, label, details, dest);

  push('agent', '→', `GET /${endpoint}`, {
    http: `GET /${endpoint} HTTP/1.1\nHost: ${new URL(url).host}\nAccept: application/json`,
  }, 'merchant');

  const first = await fetch(url);
  if (first.status === 200) {
    push('merchant', '✓', '200 OK — access granted (no payment needed)', undefined, 'agent');
    return log.text() + '\n' + (await first.text()).slice(0, 500);
  }
  if (first.status !== 402) {
    push('merchant', '✗', `Unexpected status ${first.status}`, undefined, 'agent');
    throw new Error(`Unexpected status ${first.status} from merchant`);
  }

  const quote = (await first.json()) as PaymentRequired;
  const accepted =
    quote.accepts.find((a) => Number(a.network.split(':')[1]) === CHAIN_ID) ??
    quote.accepts[0];
  const amountHuman = formatUnits(BigInt(accepted.amount), 6);

  push('merchant', '✓', 'POST /api/payments/create — quote issued', {
    http: `[Facilitator] POST /api/payments/create\nAuthorization: Bearer ***\nContent-Type: application/json\n\nHTTP/1.1 201 Created\n\n  amount:  ${accepted.amount} (${amountHuman} USDC)\n  asset:   ${accepted.asset}\n  payTo:   ${accepted.payTo}\n  network: ${accepted.network}\n  method:  ${accepted.extra?.assetTransferMethod ?? 'eip3009'}`,
  }, 'facilitator');

  push('merchant', '→', `402 Payment Required — ${amountHuman} USDC`, {
    http: `HTTP/1.1 402 Payment Required\nContent-Type: application/json\nPAYMENT-REQUIRED: scheme="exact", price="${amountHuman}", currency="USDC", network="${accepted.network}", payTo="${accepted.payTo}"\n\n{\n  "error": "Payment required to access ${endpoint} market data.",\n  "amount": "${amountHuman} USDC",\n  "network": "${accepted.network}"\n}`,
    accepts: quote.accepts,
  }, 'agent');

  push('agent', '→', 'Signing EIP-3009 typed data...', {
    http: `[Local] EIP-712 signTypedData — no HTTP, no gas\n\nfrom:        ${wallet.address}\nto:          ${accepted.payTo}\nvalue:       ${accepted.amount} (${amountHuman} USDC)\nnetwork:     ${accepted.network}\ncontract:    ${accepted.asset}\nprimaryType: TransferWithAuthorization`,
    eip712: {
      domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: CHAIN_ID, verifyingContract: accepted.asset },
      primaryType: 'TransferWithAuthorization',
      message: { from: wallet.address, to: accepted.payTo, value: accepted.amount },
    },
  });

  const signed = await signEip3009(accepted, url);

  push('agent', '✓', 'EIP-3009 typed data signed', {
    http: `[Signed] TransferWithAuthorization\n\nfrom:        ${signed.authorization.from}\nto:          ${signed.authorization.to}\nvalue:       ${signed.authorization.value} (${amountHuman} USDC)\nvalidBefore: ${signed.authorization.validBefore}\nnonce:       ${signed.authorization.nonce}\nsignature:   ${signed.signature}`,
    signature: signed.signature,
    authorization: signed.authorization,
  });

  push('agent', '→', 'Sending signed payment...', {
    http: `GET /${endpoint} HTTP/1.1\nHost: ${new URL(url).host}\nAccept: application/json\npayment-signature: <base64(x402 payload)>\n\n  x402Version: 2\n  resource:    ${url}\n  from:        ${wallet.address}\n  value:       ${accepted.amount} (${amountHuman} USDC)`,
    payload: signed.payload,
  }, 'merchant');

  const second = await fetch(url, { headers: { 'payment-signature': signed.header } });

  const text = await second.text();
  if (second.status !== 200) {
    push('merchant', '✗', 'POST /api/payments/verify — signature rejected', {
      http: `[Facilitator] POST /api/payments/verify\n\nHTTP/1.1 200 OK\n\n{ "isValid": false, "invalidReason": "HTTP ${second.status}" }`,
    }, 'facilitator');
    push('merchant', '✗', `Payment rejected — HTTP ${second.status}: ${text.slice(0, 200)}`, undefined, 'agent');
    return log.text();
  }

  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }

  push('merchant', '✓', 'POST /api/payments/verify — signature valid', {
    http: `[Facilitator] POST /api/payments/verify\nAuthorization: Bearer ***\nContent-Type: application/json\n\n  from:        ${signed.authorization.from}\n  to:          ${signed.authorization.to}\n  value:       ${signed.authorization.value} (${amountHuman} USDC)\n  nonce:       ${signed.authorization.nonce}\n  validBefore: ${signed.authorization.validBefore}\n\nHTTP/1.1 200 OK\n\n{ "isValid": true }`,
  }, 'facilitator');

  const paymentResponse = second.headers.get('payment-response');
  push('merchant', '✓', '200 OK — payment accepted', {
    http: `HTTP/1.1 200 OK\nContent-Type: application/json${paymentResponse ? `\npayment-response: ${paymentResponse}` : ''}\n\n${JSON.stringify(data, null, 2)}`,
  }, 'agent');

  push('merchant', '→', 'POST /api/payments/settle — Fireblocks CONTRACT_CALL submitted', {
    http: `[Facilitator] POST /api/payments/settle (optimistic — background)\nAuthorization: Bearer ***\nContent-Type: application/json\n\n  payer:   ${wallet.address}\n  value:   ${accepted.amount} (${amountHuman} USDC)\n  network: ${accepted.network}\n  method:  ${accepted.extra?.assetTransferMethod ?? 'eip3009'}\n\n→ Fireblocks CONTRACT_CALL submitted\n  Awaiting signing request approval in Fireblocks console/app...`,
  }, 'facilitator');

  // ── Formatted table output ─────────────────────────────────────────
  const tableLines: string[] = [];
  if (data && endpoint === 'premium' && Array.isArray((data as any).assets)) {
    const assets = (data as any).assets as Array<Record<string, unknown>>;
    const ts = (data as any).timestamp as string | undefined;
    tableLines.push('');
    tableLines.push(`Bloomberg Terminal — Premium Analytics${ts ? `  (${ts})` : ''}`);
    tableLines.push('');
    tableLines.push('Symbol | Price      | 24h Chg | Volume 24h | Mkt Cap | High    | Low     | RSI  | Sentiment');
    tableLines.push('-------|------------|---------|------------|---------|---------|---------|------|----------');
    for (const a of assets) {
      const chg = Number(a.change24h);
      tableLines.push(
        `${String(a.symbol).padEnd(6)} | ` +
        `$${Number(a.price).toLocaleString().padEnd(9)} | ` +
        `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2).padStart(5)}% | ` +
        `$${(Number(a.volume24h) / 1e9).toFixed(1).padStart(6)}B   | ` +
        `$${(Number(a.marketCap) / 1e9).toFixed(0).padStart(5)}B  | ` +
        `$${Number(a.high24h).toLocaleString().padEnd(6)} | ` +
        `$${Number(a.low24h).toLocaleString().padEnd(6)} | ` +
        `${String(a.rsi ?? '—').padEnd(4)} | ` +
        `${a.sentiment ?? '—'}`,
      );
    }
  } else if (data) {
    tableLines.push(JSON.stringify(data, null, 2).slice(0, 1200));
  }

  // ── Push final data to dashboard (steps already streamed incrementally) ──
  if (data) {
    try {
      await fetch(`${MERCHANT_BASE}/agent-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: `/${endpoint}`, data, steps: log.steps(), payer: wallet.address }),
      });
    } catch { /* non-fatal */ }
  }

  return tableLines.length > 0
    ? log.text() + '\n' + tableLines.join('\n')
    : log.text();
}

// ── MCP server ─────────────────────────────────────────────────────────
async function main() {
  const server = new McpServer({ name: 'bloomberg-payments', version: '1.0.0' });

  server.tool(
    'purchase_bloomberg',
    'Purchase gated Bloomberg Terminal data using an x402 micropayment (EIP-3009 on Base Sepolia).',
    {
      endpoint: z.enum(['premium', 'spcx']).describe(
        '"premium" = premium crypto analytics ($0.01 USDC), "spcx" = SpaceX stock data ($0.02 USDC)',
      ),
    },
    async ({ endpoint }: { endpoint: 'premium' | 'spcx' }) => {
      try {
        const result = await purchaseEndpoint(endpoint);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Payment failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'bloomberg_balance',
    'Check the USDC and ETH balance of the Bloomberg Terminal payment wallet on Base Sepolia.',
    {},
    async () => {
      try {
        const [usdc, eth] = await Promise.all([
          getUsdcBalance(wallet.address),
          getEthBalance(wallet.address),
        ]);
        return {
          content: [{
            type: 'text' as const,
            text: `Wallet: ${wallet.address}\nUSDC:   ${usdc}\nETH:    ${eth} (Base Sepolia)`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Balance check failed: ${msg}` }], isError: true };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
