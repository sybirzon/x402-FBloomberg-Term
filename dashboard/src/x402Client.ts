import type { Eip3009SignFn } from './wallet';
import type { PremiumData, SpcxData, PaymentDetails } from './types';

const MERCHANT_URL = 'http://localhost:3010';

export type StepStatus = 'info' | 'success' | 'error';
export type StepMeta = { source?: 'agent' | 'merchant' | 'facilitator'; details?: unknown };
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
  onStep(`GET ${endpoint}`, 'info', { source: 'agent' });

  const firstRes = await fetch(`${MERCHANT_URL}${endpoint}`);

  if (firstRes.status !== 402) {
    if (firstRes.ok) {
      const data = await firstRes.json() as T;
      onStep('200 OK — access granted (no payment needed)', 'success', { source: 'merchant', details: data });
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
  onStep(`402 Payment Required — ${amountHuman} USDC`, 'info', { source: 'merchant', details: body402 });

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

  onStep('Signing EIP-3009 typed data...', 'info', { source: 'agent' });

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
    source: 'agent',
    details: {
      domain,
      message,
      signature: { r, s, v, serialized: signature },
    },
  });

  onStep('Sending signed payment...', 'info', {
    source: 'agent',
    details: {
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
    onStep(`Payment rejected — ${reason}`, 'error', { source: 'merchant' });
    throw new Error(`Payment failed: ${reason}`);
  }

  const data = await secondRes.json() as T;
  onStep('200 OK — payment accepted', 'success', { source: 'merchant', details: data });
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
