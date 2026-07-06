// FOR SECURITY RESEARCH ONLY — NOT FOR PRODUCTION USE
// No-op stub for @dynamic-labs-sdk/metamask. The FBloomberg x402 demo uses
// Dynamic embedded wallets, not MetaMask. The published metamask package
// (max 1.8.2) peer-conflicts with @dynamic-labs-sdk/client@1.14.x, so we
// stub out the import surface @dynamic-labs-sdk/evm requires.

export class MetaMaskDisplayUriMissingError extends Error {
  constructor(message = "MetaMask display URI missing (stubbed in FBloomberg demo)") {
    super(message);
    this.name = "MetaMaskDisplayUriMissingError";
  }
}

export class MetaMaskWalletNotConnectedError extends Error {
  constructor(message = "MetaMask wallet not connected (stubbed in FBloomberg demo)") {
    super(message);
    this.name = "MetaMaskWalletNotConnectedError";
  }
}

export function clearMetaMaskSessionStorage() {
  // no-op
}

export async function connectWithMetaMaskUri() {
  throw new MetaMaskWalletNotConnectedError(
    "MetaMask connector is stubbed in this build."
  );
}

export function getMetaMaskExtensionWalletProviderKey() {
  return "metamask-extension-stubbed";
}
