import { Signature } from 'ethers';
import type { Eip3009SignResult } from '../wallet';
import type { EvmWalletAccount } from '@dynamic-labs-sdk/evm';
import { createWalletClientForWalletAccount } from '@dynamic-labs-sdk/evm/viem';
import { switchActiveNetwork } from '@dynamic-labs-sdk/client';
import { dynamicClient } from '../dynamicClient';

// createViemWalletClientForWaas calls getActiveNetworkData which looks up
// projectSettings.networks by networkId. Dynamic environments configured only
// with mainnet won't have Base Sepolia, causing "No network data found". We
// inject it directly into the live projectSettings object (same reference read
// by getNetworksData) so the lookup succeeds without a dashboard config change.
function ensureNetworkInProjectSettings(networkId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = dynamicClient.projectSettings as any;
  if (!ps?.networks) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evmGroup = (ps.networks as any[]).find((g: any) => g.chainName === 'evm');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (evmGroup?.networks?.some((n: any) => String(n.networkId) === networkId)) return;

  const chainIdNum = parseInt(networkId, 10);
  // Minimal network configuration — only the fields getNetworksData reads.
  const networkEntry = {
    name: `Chain ${chainIdNum}`,
    vanityName: `Chain ${chainIdNum}`,
    networkId,
    blockExplorerUrls: [] as string[],
    cluster: null,
    genesisHash: null,
    iconUrls: [''],
    isTestnet: true,
    nativeCurrency: { decimals: 18, iconUrl: '', name: 'Ether', symbol: 'ETH' },
    privateCustomerRpcUrls: [] as string[],
    rpcUrls: ['https://sepolia.base.org'],
  };

  if (evmGroup) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (evmGroup.networks as any[]).push(networkEntry);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ps.networks as any[]).push({ chainName: 'evm', networks: [networkEntry] });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function signEip3009WithDynamic(primaryWallet: EvmWalletAccount, accepted: any): Promise<Eip3009SignResult> {
  const chainId = parseInt((accepted.network as string).replace('eip155:', ''), 10);

  // Inject the signing network into projectSettings so getActiveNetworkData can
  // find it, then switch the WaaS wallet provider to that network.
  ensureNetworkInProjectSettings(String(chainId));
  await switchActiveNetwork({ networkId: String(chainId), walletAccount: primaryWallet });

  const walletClient = await createWalletClientForWalletAccount({ walletAccount: primaryWallet });
  const from = primaryWallet.address as `0x${string}`;

  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + Math.max(Number(accepted.maxTimeoutSeconds ?? 0), 300);

  const nonceBytes = new Uint8Array(32);
  window.crypto.getRandomValues(nonceBytes);
  const nonce = ('0x' + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

  const domain = {
    name: (accepted.extra?.name ?? 'USD Coin') as string,
    version: (accepted.extra?.version ?? '2') as string,
    chainId,
    verifyingContract: accepted.asset as `0x${string}`,
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
  } as const;

  // Do NOT pass account here — the wallet client has the WaaS custom account
  // configured via toAccount(). Passing account: address (string) would cause
  // viem to fall back to JSON-RPC mode and send eth_signTypedData_v4 to the
  // transport instead of calling the local WaaS signing function.
  const rawSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: accepted.payTo as `0x${string}`,
      value: BigInt(accepted.amount as string),
      validAfter: BigInt(0),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const sig = Signature.from(rawSig);

  const authorization = {
    from,
    to: accepted.payTo as string,
    value: accepted.amount as string,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  const messageForLog = {
    from,
    to: accepted.payTo as string,
    value: accepted.amount as string,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };

  return {
    signature: sig.serialized,
    authorization,
    domain: domain as Record<string, unknown>,
    message: messageForLog,
    r: sig.r,
    s: sig.s,
    v: sig.v,
  };
}
