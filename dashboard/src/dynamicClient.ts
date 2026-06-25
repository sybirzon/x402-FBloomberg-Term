import { createDynamicClient, initializeClient } from '@dynamic-labs-sdk/client';
import { addEvmExtension } from '@dynamic-labs-sdk/evm';

export const dynamicClient = createDynamicClient({
  autoInitialize: false,
  environmentId: import.meta.env.VITE_DYNAMIC_ENV_ID as string,
  metadata: {
    name: 'Bloomberg Terminal',
    universalLink: window.location.origin,
  },
});

addEvmExtension();
void initializeClient();
