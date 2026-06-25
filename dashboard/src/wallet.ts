import { Wallet, JsonRpcProvider, Contract, formatUnits, Signature } from 'ethers';

const WALLET_STORAGE_KEY = 'x402_wallet_pk';

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

export function generateWallet(): { address: string; privateKey: string } {
  const w = Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

export function importWallet(pk: string): { address: string; privateKey: string } {
  // normalise — accept with or without 0x prefix
  const normalized = pk.startsWith('0x') ? pk : `0x${pk}`;
  const w = new Wallet(normalized);
  return { address: w.address, privateKey: w.privateKey };
}

export function saveWallet(privateKey: string): void {
  localStorage.setItem(WALLET_STORAGE_KEY, privateKey);
}

export function loadWallet(): { address: string; privateKey: string } | null {
  const pk = localStorage.getItem(WALLET_STORAGE_KEY);
  if (!pk) return null;
  try {
    return importWallet(pk);
  } catch {
    return null;
  }
}

export async function getEthBalance(address: string, rpcUrl: string): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl);
  const raw = await provider.getBalance(address);
  return formatUnits(raw, 18);
}

export async function getUsdcBalance(
  address: string,
  tokenAddress: string,
  rpcUrl: string,
): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(tokenAddress, USDC_ABI, provider);
  const raw: bigint = await contract.balanceOf(address) as bigint;
  return formatUnits(raw, 6);
}

export interface Eip3009SignResult {
  signature: string;
  authorization: Record<string, unknown>;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
  r: string;
  s: string;
  v: number;
}

export type Eip3009SignFn = (accepted: unknown) => Promise<Eip3009SignResult>;

export async function signEip3009(
  privateKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accepted: any,
): Promise<Eip3009SignResult> {
  const wallet = new Wallet(privateKey);

  const from = wallet.address;
  const to: string = accepted.payTo;
  const value: string = accepted.amount;
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + Math.max(Number(accepted.maxTimeoutSeconds ?? 0), 300);

  // Generate a cryptographically random 32-byte nonce using Web Crypto API
  const nonceBytes = new Uint8Array(32);
  window.crypto.getRandomValues(nonceBytes);
  const nonce = '0x' + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  const chainId = parseInt(accepted.network.replace('eip155:', ''), 10);

  const domain = {
    name: (accepted.extra?.name ?? 'USD Coin') as string,
    version: (accepted.extra?.version ?? '2') as string,
    chainId,
    verifyingContract: accepted.asset as string,
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
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  };

  const sig = Signature.from(await wallet.signTypedData(domain, types, message));

  const authorization = {
    from,
    to,
    value,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  return {
    signature: sig.serialized,
    authorization,
    domain,
    message,
    r: sig.r,
    s: sig.s,
    v: sig.v,
  };
}
