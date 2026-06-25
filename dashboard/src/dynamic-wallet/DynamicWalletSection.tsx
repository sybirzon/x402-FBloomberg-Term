import { useState, useEffect } from 'react';
import { sendEmailOTP, verifyOTP, logout } from '@dynamic-labs-sdk/client';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';
import { useUser, useWalletAccounts, useInitStatus } from '@dynamic-labs-sdk/react-hooks';
import type { EvmWalletAccount } from '@dynamic-labs-sdk/evm';
import { signEip3009WithDynamic } from './signing';
import type { Eip3009SignFn } from '../wallet';

interface Props {
  onConnected: (address: string, signFn: Eip3009SignFn) => void;
  onDisconnected: () => void;
}

type AuthStep = 'idle' | 'email' | 'otp';

export function DynamicWalletSection({ onConnected, onDisconnected }: Props) {
  const initStatus = useInitStatus();
  const { data: user } = useUser();
  const accounts = useWalletAccounts();
  const primaryAccount = accounts.data?.[0] as EvmWalletAccount | undefined;
  const initialized = initStatus.data === 'finished';

  const [step, setStep] = useState<AuthStep>('idle');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pending, setPending] = useState<any>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [copied, setCopied] = useState(false);

  function copyAddress(addr: string) {
    void navigator.clipboard.writeText(addr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Trigger wallet creation whenever a user is present and has no wallet yet.
  // useEvent('userChanged') misses sessions restored on init, so useEffect is the right hook.
  useEffect(() => {
    if (!initialized || !user || primaryAccount) return;
    setWalletError('');
    const missingChains = getChainsMissingWaasWalletAccounts();
    if (missingChains.length === 0) return;
    void createWaasWalletAccounts({ chains: missingChains }).catch((err: unknown) => {
      setWalletError(err instanceof Error ? err.message : 'Wallet creation failed');
    });
  }, [initialized, user, primaryAccount]);

  // Notify parent on wallet connect / disconnect
  useEffect(() => {
    if (user && primaryAccount) {
      const signFn: Eip3009SignFn = (accepted) => signEip3009WithDynamic(primaryAccount, accepted);
      onConnected(primaryAccount.address, signFn);
    } else if (!user) {
      onDisconnected();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, primaryAccount?.address]);

  async function handleSendOtp() {
    if (!email.trim()) return;
    setError('');
    setIsLoading(true);
    try {
      const pendingVerification = await sendEmailOTP({ email: email.trim() });
      setPending(pendingVerification);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleVerifyOtp() {
    if (!otp.trim() || !pending) return;
    setError('');
    setIsLoading(true);
    try {
      await verifyOTP({ otpVerification: pending, verificationToken: otp.trim() });
      setStep('idle');
      setOtp('');
      setEmail('');
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setIsLoading(false);
    }
  }

  // Still initializing — show nothing until SDK has a definitive auth state
  if (!initialized) return null;

  // Logged in with wallet ready
  if (user && primaryAccount) {
    const addr = primaryAccount.address;
    return (
      <div className="dynamic-wallet">
        <span className="dynamic-badge">EMAIL</span>
        <button
          className="hw-address hw-copy-btn"
          title={copied ? 'Copied!' : addr}
          onClick={() => copyAddress(addr)}
        >
          {addr.slice(0, 6)}…{addr.slice(-4)} {copied ? '✓' : '⧉'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => void logout()}>
          Logout
        </button>
      </div>
    );
  }

  // Logged in but wallet still being provisioned (or failed)
  if (user && !primaryAccount) {
    return (
      <div className="dynamic-wallet">
        <span className="dynamic-badge">AUTH</span>
        {walletError ? (
          <span className="dynamic-no-wallet" title={walletError}>Wallet error</span>
        ) : (
          <span className="dynamic-no-wallet">Creating wallet…</span>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => void logout()}>
          Logout
        </button>
      </div>
    );
  }

  // OTP entry
  if (step === 'otp') {
    return (
      <div className="dynamic-wallet">
        <input
          className="import-input"
          placeholder="Enter code"
          value={otp}
          maxLength={6}
          onChange={(e) => setOtp(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleVerifyOtp()}
          autoFocus
        />
        {error && <p className="import-error">{error}</p>}
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void handleVerifyOtp()}
          disabled={isLoading}
        >
          {isLoading ? '…' : 'Verify'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => { setStep('idle'); setError(''); }}
        >
          Back
        </button>
      </div>
    );
  }

  // Email entry
  if (step === 'email') {
    return (
      <div className="dynamic-wallet">
        <input
          className="import-input"
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleSendOtp()}
          autoFocus
        />
        {error && <p className="import-error">{error}</p>}
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void handleSendOtp()}
          disabled={isLoading}
        >
          {isLoading ? '…' : 'Send Code'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => { setStep('idle'); setError(''); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // Not logged in
  return (
    <button className="btn btn-secondary btn-sm" onClick={() => setStep('email')}>
      Login with Email
    </button>
  );
}
