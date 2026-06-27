// Stub — MetaMask extension connector unused in this project (email/WaaS wallet only)
export const clearMetaMaskSessionStorage = () => {};
export const connectWithMetaMaskUri = () => Promise.resolve();
export const getMetaMaskExtensionWalletProviderKey = () => 'metamask';
export class MetaMaskDisplayUriMissingError extends Error {}
export class MetaMaskWalletNotConnectedError extends Error {}
