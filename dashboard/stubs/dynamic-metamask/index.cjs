'use strict';
// Stub — MetaMask extension connector unused in this project (email/WaaS wallet only)
exports.clearMetaMaskSessionStorage = () => {};
exports.connectWithMetaMaskUri = () => Promise.resolve();
exports.getMetaMaskExtensionWalletProviderKey = () => 'metamask';
exports.MetaMaskDisplayUriMissingError = class MetaMaskDisplayUriMissingError extends Error {};
exports.MetaMaskWalletNotConnectedError = class MetaMaskWalletNotConnectedError extends Error {};
