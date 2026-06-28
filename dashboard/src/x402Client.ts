import type { Eip3009SignFn } from './wallet';
import type { ActivityStep, PremiumData, SpcxData, PaymentDetails } from './types';

const MERCHANT_URL = 'http://localhost:3010';

export type StepStatus = ActivityStep['status'];
export type StepMeta = { source?: ActivityStep['source']; dest?: ActivityStep['dest']; details?: unknown };
export type StepCallback = (step: string, status: StepStatus, meta?: StepMeta) => void;
export type ConfirmCallback = (details: PaymentDetails) => Promise<boolean>;

async function purchaseEndpoint<T>(
  endpoint: string,
  service: string,
  sign: Eip3009SignFn,
  walletAddress: string,
  onStep: StepCallback,
  onConfirm: ConfirmCallback,
): Promise<T> {
  onStep(`GET ${endpoint}`, 'info', {
    source: 'agent', dest: 'merchant',
    details: { http: `GET ${endpoint} HTTP/1.1\nHost: localhost:3010\nAccept: application/json` },
  });

  const firstRes = await fetch(`${MERCHANT_URL}${endpoint}`);

  if (firstRes.status !== 402) {
    if (firstRes.ok) {
      const data = await firstRes.json() as T;
      onStep('200 OK — access granted (no payment needed)', 'success', {
        source: 'merchant', dest: 'agent',
        details: { http: `HTTP/1.1 200 OK\nContent-Type: application/json\n\n${JSON.stringify(data, null, 2)}` },
      });
      return data;
    }
    const errText = await firstRes.text();
    onStep(`Unexpected status ${firstRes.status}: ${errText}`, 'error', { source: 'merchant' });
    throw new Error(`Unexpected status ${firstRes.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body402: any = await firstRes.json();
  const accepted = body402?.accepts?.[0];

  if (!accepted) {
    onStep('Payment failed: malformed 402 response (no accepts)', 'error', { source: 'merchant', details: body402 });
    throw new Error('Malformed 402 response');
  }

  const amountRaw: string = accepted.amount ?? '0';
  const amountHuman = (Number(amountRaw) / 1_000_000).toFixed(2);
  const network: string = accepted.network ?? '?';
  onStep('POST /api/payments/create — quote issued', 'success', {
    source: 'merchant', dest: 'facilitator',
    details: {
      http: `[Facilitator] POST /api/payments/create\nAuthorization: Bearer ***\nContent-Type: application/json\n\nHTTP/1.1 201 Created\n\n  amount:  ${amountRaw} (${amountHuman} USDC)\n  asset:   ${accepted.asset ?? '?'}\n  payTo:   ${accepted.payTo ?? '?'}\n  network: ${network}\n  method:  ${accepted.extra?.assetTransferMethod ?? 'eip3009'}`,
    },
  });

  onStep(`402 Payment Required — ${amountHuman} USDC`, 'info', {
    source: 'merchant', dest: 'agent',
    details: {
      http: `HTTP/1.1 402 Payment Required\nContent-Type: application/json\nPAYMENT-REQUIRED: scheme="exact", price="${amountHuman}", currency="USDC", network="${network}", payTo="${accepted.payTo ?? '?'}"\n\n${JSON.stringify(body402, null, 2)}`,
      accepts: body402.accepts,
    },
  });

  const expiresAt = new Date(Date.now() + Math.max(Number(accepted.maxTimeoutSeconds ?? 0), 300) * 1000);
  const confirmed = await onConfirm({
    service,
    amountHuman,
    payTo: accepted.payTo ?? '?',
    from: walletAddress,
    network,
    asset: accepted.asset ?? '?',
    expiresAt,
  });

  if (!confirmed) {
    onStep('Payment cancelled by user', 'error', { source: 'agent' });
    throw new Error('Cancelled');
  }

  onStep('Signing EIP-3009 typed data...', 'info', {
    source: 'agent', // local — no dest
    details: {
      http: `[Local] EIP-712 signTypedData — no HTTP, no gas\n\nto:          ${accepted.payTo ?? '?'}\nvalue:       ${accepted.amount} (${amountHuman} USDC)\nnetwork:     ${network}\ncontract:    ${accepted.asset ?? '?'}\nprimaryType: TransferWithAuthorization`,
      eip712: {
        domain: { name: accepted.extra?.name, version: accepted.extra?.version, chainId: Number(network.split(':')[1] ?? 84532), verifyingContract: accepted.asset },
        primaryType: 'TransferWithAuthorization',
        message: { to: accepted.payTo, value: accepted.amount },
      },
    },
  });

  let signature: string;
  let authorization: Record<string, unknown>;
  let domain: Record<string, unknown>;
  let message: Record<string, unknown>;
  let r: string, s: string, v: number;
  try {
    const result = await sign(accepted);
    ({ signature, authorization, domain, message, r, s, v } = result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    onStep(`Signing error — ${reason}`, 'error', { source: 'agent' });
    throw err;
  }

  onStep('EIP-3009 typed data signed', 'success', {
    source: 'agent', // local — no dest
    details: {
      http: `[Signed] TransferWithAuthorization\n\nto:          ${authorization.to}\nvalue:       ${authorization.value} (${amountHuman} USDC)\nsignature:   ${signature}`,
      domain,
      message,
      signature: { r, s, v, serialized: signature },
    },
  });

  onStep('Sending signed payment...', 'info', {
    source: 'agent', dest: 'merchant',
    details: {
      http: `GET ${endpoint} HTTP/1.1\nHost: localhost:3010\nAccept: application/json\npayment-signature: <base64(x402 payload)>\n\n  x402Version: 2\n  resource:    ${MERCHANT_URL}${endpoint}\n  value:       ${accepted.amount} (${amountHuman} USDC)`,
      authorization,
      signature,
      x402Version: 2,
    },
  });

  const payload = {
    x402Version: 2,
    resource: { url: `${MERCHANT_URL}${endpoint}` },
    accepted,
    payload: { signature, authorization },
  };

  const secondRes = await fetch(`${MERCHANT_URL}${endpoint}`, {
    headers: { 'payment-signature': btoa(JSON.stringify(payload)) },
  });

  if (!secondRes.ok) {
    let reason = `HTTP ${secondRes.status}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errBody: any = await secondRes.json();
      reason = errBody?.error ?? errBody?.message ?? reason;
    } catch { /* ignore */ }
    onStep('POST /api/payments/verify — signature rejected', 'error', {
      source: 'merchant', dest: 'facilitator',
      details: { http: `[Facilitator] POST /api/payments/verify\n\nHTTP/1.1 200 OK\n\n{ "isValid": false, "invalidReason": "${reason}" }` },
    });
    onStep(`Payment rejected — ${reason}`, 'error', { source: 'merchant', dest: 'agent' });
    throw new Error(`Payment failed: ${reason}`);
  }

  const data = await secondRes.json() as T;
  const paymentResponse = secondRes.headers.get('payment-response');
  onStep('POST /api/payments/verify — signature valid', 'success', {
    source: 'merchant', dest: 'facilitator',
    details: {
      http: `[Facilitator] POST /api/payments/verify\nAuthorization: Bearer ***\nContent-Type: application/json\n\n  to:      ${accepted.payTo ?? '?'}\n  value:   ${amountRaw} (${amountHuman} USDC)\n  network: ${network}\n\nHTTP/1.1 200 OK\n\n{ "isValid": true }`,
    },
  });
  onStep('200 OK — payment accepted', 'success', {
    source: 'merchant', dest: 'agent',
    details: {
      http: `HTTP/1.1 200 OK\nContent-Type: application/json${paymentResponse ? `\npayment-response: ${paymentResponse}` : ''}\n\n${JSON.stringify(data, null, 2)}`,
    },
  });
  onStep('POST /api/payments/settle — Fireblocks CONTRACT_CALL submitted', 'info', {
    source: 'merchant', dest: 'facilitator',
    details: {
      http: `[Facilitator] POST /api/payments/settle (optimistic — background)\nAuthorization: Bearer ***\nContent-Type: application/json\n\n  value:   ${amountRaw} (${amountHuman} USDC)\n  network: ${network}\n  method:  ${accepted.extra?.assetTransferMethod ?? 'eip3009'}\n\n→ Fireblocks CONTRACT_CALL submitted\n  Awaiting signing request approval in Fireblocks console/app...`,
    },
  });
  return data;
}

export function purchasePremium(
  sign: Eip3009SignFn,
  walletAddress: string,
  onStep: StepCallback,
  onConfirm: ConfirmCallback,
): Promise<PremiumData> {
  return purchaseEndpoint<PremiumData>('/premium', 'Premium Market Analytics', sign, walletAddress, onStep, onConfirm);
}

export function purchaseSpcx(
  sign: Eip3009SignFn,
  walletAddress: string,
  onStep: StepCallback,
  onConfirm: ConfirmCallback,
): Promise<SpcxData> {
  return purchaseEndpoint<SpcxData>('/spcx', 'SpaceX Private Market Data', sign, walletAddress, onStep, onConfirm);
}
