// FOR SECURITY RESEARCH ONLY — NOT FOR PRODUCTION USE
// CJS variant of the @dynamic-labs-sdk/metamask stub. See ./index.js.

class MetaMaskDisplayUriMissingError extends Error {
  constructor(message = "MetaMask display URI missing (stubbed in FBloomberg demo)") {
    super(message);
    this.name = "MetaMaskDisplayUriMissingError";
  }
}

class MetaMaskWalletNotConnectedError extends Error {
  constructor(message = "MetaMask wallet not connected (stubbed in FBloomberg demo)") {
    super(message);
    this.name = "MetaMaskWalletNotConnectedError";
  }
}

function clearMetaMaskSessionStorage() {
  // no-op
}

async function connectWithMetaMaskUri() {
  throw new MetaMaskWalletNotConnectedError(
    "MetaMask connector is stubbed in this build."
  );
}

function getMetaMaskExtensionWalletProviderKey() {
  return "metamask-extension-stubbed";
}

module.exports = {
  MetaMaskDisplayUriMissingError,
  MetaMaskWalletNotConnectedError,
  clearMetaMaskSessionStorage,
  connectWithMetaMaskUri,
  getMetaMaskExtensionWalletProviderKey,
};
