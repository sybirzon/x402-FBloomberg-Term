import type { ReactNode } from 'react';
import { DynamicProvider as DynamicSdkProvider } from '@dynamic-labs-sdk/react-hooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dynamicClient } from '../dynamicClient';

const ENV_ID = import.meta.env.VITE_DYNAMIC_ENV_ID as string | undefined;
const queryClient = new QueryClient();

export function DynamicProvider({ children }: { children: ReactNode }) {
  if (!ENV_ID) return <>{children}</>;
  return (
    <QueryClientProvider client={queryClient}>
      <DynamicSdkProvider client={dynamicClient}>
        {children}
      </DynamicSdkProvider>
    </QueryClientProvider>
  );
}
