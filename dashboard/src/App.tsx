import { useState, useEffect, useRef, useCallback } from 'react';
import type { FreeData, PremiumData, SpcxData, LogEntry, PremiumAsset, PaymentDetails } from './types';
import {
  generateWallet,
  importWallet,
  saveWallet,
  loadWallet,
  getUsdcBalance,
  getEthBalance,
  signEip3009,
} from './wallet';
import type { Eip3009SignFn } from './wallet';
import { purchasePremium, purchaseSpcx } from './x402Client';
import { DynamicWalletSection } from './dynamic-wallet/DynamicWalletSection';

const DYNAMIC_ENV_ID = import.meta.env.VITE_DYNAMIC_ENV_ID as string | undefined;

const MERCHANT_URL = 'http://localhost:3010';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function SentimentBadge({ sentiment }: { sentiment: PremiumAsset['sentiment'] }) {
  const cls =
    sentiment === 'bullish'
      ? 'badge-bullish'
      : sentiment === 'bearish'
        ? 'badge-bearish'
        : 'badge-neutral';
  return <span className={`badge ${cls}`}>{sentiment}</span>;
}

function LogIcon({ status }: { status: LogEntry['status'] }) {
  if (status === 'success') return <span className="log-icon success">✓</span>;
  if (status === 'error') return <span className="log-icon error">✗</span>;
  return <span className="log-icon info">→</span>;
}

export default function App() {
  const [pkWallet, setPkWallet] = useState<{ address: string; privateKey: string } | null>(null);
  const [dynamicAddress, setDynamicAddress] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'private-key' | 'dynamic' | null>(null);

  // Ref so stale closures (e.g. DynamicWalletSection's onDisconnected effect) always
  // see the latest pkWallet without depending on re-running effects.
  const pkWalletRef = useRef(pkWallet);
  pkWalletRef.current = pkWallet;

  // Derived active wallet — used for payments, balance display, and sign fn selection.
  const wallet = activeType === 'private-key' && pkWallet
    ? { type: 'private-key' as const, ...pkWallet }
    : activeType === 'dynamic' && dynamicAddress
    ? { type: 'dynamic' as const, address: dynamicAddress }
    : null;

  const dynamicSignFnRef = useRef<Eip3009SignFn | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [freeData, setFreeData] = useState<FreeData | null>(null);
  const [premiumData, setPremiumData] = useState<PremiumData | null>(null);
  const [spcxData, setSpcxData] = useState<SpcxData | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isSettlingPremium, setIsSettlingPremium] = useState(false);
  const [isPurchasingSpcx, setIsPurchasingSpcx] = useState(false);
  const [isSettlingSpcx, setIsSettlingSpcx] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [importKey, setImportKey] = useState('');
  const [importError, setImportError] = useState('');
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [confirmDetails, setConfirmDetails] = useState<PaymentDetails | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [copiedLog, setCopiedLog] = useState<number | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  function copyAddress(addr: string) {
    void navigator.clipboard.writeText(addr).then(() => {
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 1500);
    });
  }

  function copyLogEntry(entry: LogEntry, i: number) {
    const parts = [entry.time];
    if (entry.source) parts.push(`[${entry.source}]`);
    parts.push(entry.message);
    if (entry.details != null) parts.push(JSON.stringify(entry.details, null, 2));
    void navigator.clipboard.writeText(parts.join(' ')).then(() => {
      setCopiedLog(i);
      setTimeout(() => setCopiedLog(null), 1500);
    });
  }

  const addLog = useCallback((
    message: string,
    status: LogEntry['status'],
    meta?: { source?: LogEntry['source']; details?: unknown },
  ) => {
    setLog((prev) => [...prev, {
      time: formatTime(), message, status,
      source: meta?.source,
      details: meta?.details,
    }]);
  }, []);

  const refreshBalance = useCallback(async (addr: string) => {
    setIsLoadingBalance(true);
    try {
      const [usdc, eth] = await Promise.all([
        getUsdcBalance(addr, USDC_ADDRESS, BASE_SEPOLIA_RPC),
        getEthBalance(addr, BASE_SEPOLIA_RPC),
      ]);
      setUsdcBalance(usdc);
      setEthBalance(eth);
    } catch {
      setUsdcBalance('Error');
      setEthBalance('Error');
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  // Load wallet and free data on mount
  useEffect(() => {
    const saved = loadWallet();
    if (saved) {
      setPkWallet(saved);
      setActiveType('private-key');
      void refreshBalance(saved.address);
    }

    fetch(`${MERCHANT_URL}/hello`)
      .then((r) => r.json())
      .then((data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          'tier' in data &&
          (data as { tier: unknown }).tier === 'free'
        ) {
          setFreeData(data as FreeData);
        } else if (
          data &&
          typeof data === 'object' &&
          'assets' in data
        ) {
          setFreeData({ tier: 'free', assets: (data as { assets: FreeData['assets'] }).assets });
        }
      })
      .catch(() => {});
  }, [refreshBalance]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  // Poll for MCP agent purchases and display them in the dashboard
  useEffect(() => {
    let lastPremiumTs = 0;
    let lastSpcxTs = 0;
    let lastPremiumStepCount = 0;
    let lastSpcxStepCount = 0;
    const id = setInterval(async () => {
      try {
        const [premiumRes, spcxRes] = await Promise.all([
          fetch(`${MERCHANT_URL}/agent-data?endpoint=/premium`),
          fetch(`${MERCHANT_URL}/agent-data?endpoint=/spcx`),
        ]);
        type AgentStep = { message: string; status: 'info' | 'success' | 'error'; source: 'agent' | 'merchant' | 'facilitator'; details?: unknown };
        type AgentEntry = { data: unknown; ts?: number; steps?: AgentStep[]; payer?: string };
        const premium = await premiumRes.json() as AgentEntry;
        if (!premium.data && !(premium.steps?.length)) {
          if (lastPremiumTs !== 0) { lastPremiumTs = 0; lastPremiumStepCount = 0; setPremiumData(null); }
        } else {
          const steps = premium.steps ?? [];
          // Detect new payment (step count reset means a new run started)
          if (steps.length < lastPremiumStepCount) lastPremiumStepCount = 0;
          if (steps.length > lastPremiumStepCount) {
            steps.slice(lastPremiumStepCount).forEach((s) => addLog(s.message, s.status, { source: s.source, details: s.details }));
            lastPremiumStepCount = steps.length;
          }
          if (premium.data && premium.ts && premium.ts !== lastPremiumTs) {
            lastPremiumTs = premium.ts;
            setPremiumData(premium.data as PremiumData);
            if (premium.payer) {
              const bal = await getUsdcBalance(premium.payer, USDC_ADDRESS, BASE_SEPOLIA_RPC).catch(() => null);
              void pollUntilSettled(bal, () => {}, premium.payer, premium.ts);
            }
          }
        }
        const spcx = await spcxRes.json() as AgentEntry;
        if (!spcx.data && !(spcx.steps?.length)) {
          if (lastSpcxTs !== 0) { lastSpcxTs = 0; lastSpcxStepCount = 0; setSpcxData(null); }
        } else {
          const steps = spcx.steps ?? [];
          if (steps.length < lastSpcxStepCount) lastSpcxStepCount = 0;
          if (steps.length > lastSpcxStepCount) {
            steps.slice(lastSpcxStepCount).forEach((s) => addLog(s.message, s.status, { source: s.source, details: s.details }));
            lastSpcxStepCount = steps.length;
          }
          if (spcx.data && spcx.ts && spcx.ts !== lastSpcxTs) {
            lastSpcxTs = spcx.ts;
            setSpcxData(spcx.data as SpcxData);
            if (spcx.payer) {
              const bal = await getUsdcBalance(spcx.payer, USDC_ADDRESS, BASE_SEPOLIA_RPC).catch(() => null);
              void pollUntilSettled(bal, () => {}, spcx.payer, spcx.ts);
            }
          }
        }
      } catch { /* merchant may not be running */ }
    }, 500);
    return () => clearInterval(id);
  }, [addLog]);

  function handleGenerate() {
    const w = generateWallet();
    setPkWallet(w);
    saveWallet(w.privateKey);
    setActiveType('private-key');
    setPremiumData(null);
    void refreshBalance(w.address);
  }

  function handleImportSubmit() {
    setImportError('');
    try {
      const w = importWallet(importKey.trim());
      setPkWallet(w);
      saveWallet(w.privateKey);
      setActiveType('private-key');
      setShowImport(false);
      setImportKey('');
      setPremiumData(null);
      void refreshBalance(w.address);
    } catch {
      setImportError('Invalid private key. Please check and try again.');
    }
  }

  function requestConfirm(details: PaymentDetails): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmDetails(details);
    });
  }

  function handleConfirmApprove() {
    confirmResolveRef.current?.(true);
    confirmResolveRef.current = null;
    setConfirmDetails(null);
  }

  function handleConfirmCancel() {
    confirmResolveRef.current?.(false);
    confirmResolveRef.current = null;
    setConfirmDetails(null);
  }

  async function handleReset() {
    try {
      await fetch(`${MERCHANT_URL}/reset`, { method: 'POST' });
    } catch { /* merchant may be down; still clear local state */ }
    setPremiumData(null);
    setSpcxData(null);
    setLog([]);
    setExpandedLogs(new Set());
  }

  function pollUntilSettled(
    balanceBefore: string | null,
    onSettled: (newBalance: string) => void,
    payerOverride?: string,
    startedAt: number = Date.now(),
  ): Promise<void> {
    const payerAddress = payerOverride ?? wallet!.address;
    return new Promise((resolve) => {
      let attempts = 0;
      let done = false;
      let seenSubmitted = false;
      const finish = () => { done = true; resolve(); };

      const poll = async () => {
        if (done) return;

        try {
          const sr = await fetch(`${MERCHANT_URL}/settlement-status?payer=${payerAddress}`);
          const status = await sr.json() as { status: string; txHash?: string | null; error?: string | null; endpoint?: string; ts?: number };

          if (status.status === 'submitted' && !seenSubmitted) {
            seenSubmitted = true;
            addLog('Settlement pending — Fireblocks signing request sent', 'info', {
              source: 'facilitator',
              details: {
                http: `[Fireblocks] CONTRACT_CALL submitted → PENDING_SIGNATURE\n\nstatus:   awaiting_signature\npayer:    ${payerAddress}\nendpoint: ${status.endpoint ?? '?'}\nAction:   Approve the signing request in your Fireblocks mobile app or console`,
              },
            });
          }

          if (status.status === 'failed' && (status.ts == null || status.ts >= startedAt - 2000)) {
            addLog(`Settlement failed — ${status.error ?? 'rejected'}`, 'error', {
              source: 'facilitator',
              details: {
                http: `[Fireblocks] CONTRACT_CALL rejected\n\nstatus:   failed\nreason:   ${status.error ?? 'rejected'}${status.txHash ? `\ntxHash:   ${status.txHash}` : ''}${status.endpoint ? `\nendpoint: ${status.endpoint}` : ''}\npayer:    ${payerAddress}`,
                ...status,
              },
            });
            finish();
            return;
          }
          if (status.status === 'confirmed' && (status.ts == null || status.ts >= startedAt - 2000)) {
            const bal = await getUsdcBalance(payerAddress, USDC_ADDRESS, BASE_SEPOLIA_RPC);
            if (payerOverride === undefined) setUsdcBalance(bal);
            addLog(`Settlement confirmed — balance: ${Number(bal).toFixed(4)} USDC`, 'success', {
              source: 'facilitator',
              details: {
                http: `[Fireblocks] CONTRACT_CALL confirmed ✓\n\nstatus:      confirmed${status.txHash ? `\ntxHash:      ${status.txHash}` : ''}${status.endpoint ? `\nendpoint:    ${status.endpoint}` : ''}\npayer:       ${payerAddress}\nbalanceBefore: ${balanceBefore}\nbalanceAfter:  ${bal}`,
                ...status,
                balanceBefore,
                balanceAfter: bal,
              },
            });
            onSettled(bal);
            finish();
            return;
          }
        } catch { /* endpoint not available, fall through to balance poll */ }

        let bal: string | null = null;
        try {
          bal = await getUsdcBalance(payerAddress, USDC_ADDRESS, BASE_SEPOLIA_RPC);
          if (payerOverride === undefined) setUsdcBalance(bal);
        } catch { /* RPC unavailable — skip balance check this tick */ }

        if (bal !== null && bal !== balanceBefore) {
          addLog(`Settlement confirmed — balance: ${Number(bal).toFixed(4)} USDC`, 'success', {
            source: 'facilitator',
            details: {
              http: `[On-chain] Balance change detected on Base Sepolia\n\nUSDC.balanceOf(${payerAddress})\n\nbalanceBefore: ${balanceBefore}\nbalanceAfter:  ${bal}\nnetwork:       eip155:84532`,
              balanceBefore,
              balanceAfter: bal,
            },
          });
          onSettled(bal);
          finish();
        } else if (attempts < 600) {
          attempts++;
          setTimeout(() => { void poll(); }, 500);
        } else {
          addLog('Settlement timed out — check Fireblocks for approval status', 'error', {
            source: 'facilitator',
            details: {
              http: `[Fireblocks] CONTRACT_CALL timed out\n\nNo confirmation received after ${Math.round(attempts * 0.5)}s\npayer:   ${payerAddress}\nAction:  Open Fireblocks console and approve the pending CONTRACT_CALL`,
            },
          });
          finish();
        }
      };
      void poll();
    });
  }

  function buildSignFn(): Eip3009SignFn {
    if (!wallet) throw new Error('No wallet connected');
    if (wallet.type === 'private-key') {
      const { privateKey } = wallet;
      return (accepted) => signEip3009(privateKey, accepted);
    }
    const fn = dynamicSignFnRef.current;
    if (!fn) throw new Error('Dynamic wallet not ready');
    return fn;
  }

  async function handlePurchaseSpcx() {
    if (!wallet || isPurchasingSpcx || isSettlingSpcx) return;
    setIsPurchasingSpcx(true);
    const startedAt = Date.now();
    try {
      const balanceBefore = usdcBalance;
      const data = await purchaseSpcx(buildSignFn(), wallet.address, addLog, requestConfirm);
      setSpcxData(data);
      setIsPurchasingSpcx(false);
      setIsSettlingSpcx(true);
      await pollUntilSettled(balanceBefore, () => {}, undefined, startedAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Payment error — ${msg}`, 'error', { source: 'agent' });
    } finally {
      setIsPurchasingSpcx(false);
      setIsSettlingSpcx(false);
    }
  }

  async function handlePurchase() {
    if (!wallet || isPurchasing || isSettlingPremium) return;
    setIsPurchasing(true);
    const startedAt = Date.now();
    try {
      const balanceBefore = usdcBalance;
      const data = await purchasePremium(buildSignFn(), wallet.address, addLog, requestConfirm);
      setPremiumData(data);
      setIsPurchasing(false);
      setIsSettlingPremium(true);
      await pollUntilSettled(balanceBefore, () => {}, undefined, startedAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Payment error — ${msg}`, 'error', { source: 'agent' });
    } finally {
      setIsPurchasing(false);
      setIsSettlingPremium(false);
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-title">
          <svg className="bb-logo" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="44" height="44" rx="4" fill="#F47521"/>
            <path d="M10 9h12.5c4.5 0 7.5 2.2 7.5 6 0 2.2-1.1 3.9-2.8 4.9 2.4.9 3.8 2.8 3.8 5.4 0 4.2-3.2 6.7-8.2 6.7H10V9zm5 9.5h6.8c1.8 0 2.9-.9 2.9-2.4s-1.1-2.4-2.9-2.4H15v4.8zm0 9.8h7.2c2 0 3.2-1 3.2-2.7s-1.2-2.7-3.2-2.7H15v5.4z" fill="white"/>
          </svg>
          <div className="header-text">
            <span className="header-brand">BLOOMBERG</span>
            <span className="header-product">TERMINAL</span>
          </div>
        </div>

        <div className="header-wallet">
          {/* Row 1: active wallet address + balances */}
          <div className="header-wallet-info">
            <div className="network-badge">Base Sepolia</div>
            {wallet ? (
              <>
                <button
                  className="hw-address hw-copy-btn"
                  title={copiedAddress ? 'Copied!' : wallet.address}
                  onClick={() => copyAddress(wallet.address)}
                >
                  {shortAddress(wallet.address)} {copiedAddress ? '✓' : '⧉'}
                </button>
                <span className="hw-sep">|</span>
                <span className="hw-balance">
                  {usdcBalance !== null ? `${Number(usdcBalance).toFixed(4)} USDC` : '—'}
                </span>
                <span className="hw-sep">|</span>
                <span className="hw-balance hw-eth">
                  {ethBalance !== null ? `${Number(ethBalance).toFixed(4)} ETH` : '—'}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void refreshBalance(wallet.address)}
                  disabled={isLoadingBalance}
                  title="Refresh balance"
                >
                  {isLoadingBalance ? '…' : '↻'}
                </button>
              </>
            ) : (
              <span className="hw-no-wallet">No wallet</span>
            )}
          </div>

          {/* Row 2: private key wallet */}
          <div
            className={`wallet-row${activeType === 'private-key' ? ' wallet-row-active' : ''}${pkWallet ? ' wallet-row-clickable' : ''}`}
            onClick={() => { if (pkWallet) setActiveType('private-key'); }}
          >
            <span className="wallet-row-type">Dev</span>
            {pkWallet && (
              <span className="hw-address hw-address-sm">
                {shortAddress(pkWallet.address)}
              </span>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={(e) => { e.stopPropagation(); handleGenerate(); }}
            >
              Generate
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={(e) => { e.stopPropagation(); setShowImport(!showImport); setImportError(''); }}
            >
              Import Key
            </button>
          </div>

          {/* Row 3: Dynamic embedded wallet */}
          {DYNAMIC_ENV_ID && (
            <div
              className={`wallet-row${activeType === 'dynamic' ? ' wallet-row-active' : ''}${dynamicAddress ? ' wallet-row-clickable' : ''}`}
              onClick={() => { if (dynamicAddress) setActiveType('dynamic'); }}
            >
              <span className="wallet-row-type">Dynamic</span>
              <DynamicWalletSection
                onConnected={(address, signFn) => {
                  dynamicSignFnRef.current = signFn;
                  setDynamicAddress(address);
                  setActiveType('dynamic');
                  void refreshBalance(address);
                }}
                onDisconnected={() => {
                  dynamicSignFnRef.current = null;
                  setDynamicAddress(null);
                  setActiveType((prev) =>
                    prev === 'dynamic' ? (pkWalletRef.current ? 'private-key' : null) : prev
                  );
                }}
              />
            </div>
          )}

          {/* Import form */}
          {showImport && (
            <div className="header-import-form">
              <input
                type="password"
                className="import-input"
                placeholder="Private key (0x...)"
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImportSubmit()}
              />
              {importError && <p className="import-error">{importError}</p>}
              <button className="btn btn-primary btn-sm" onClick={handleImportSubmit}>Import</button>
            </div>
          )}
        </div>
      </header>

      {/* Market Data */}
      <section className="panel market-panel">
          <h2 className="panel-title">Market Data</h2>

          {/* Free tier */}
          <div className="tier-section">
            <div className="tier-header">
              <span className="tier-label free">FREE TIER</span>
            </div>
            {freeData ? (
              <table className="asset-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Price</th>
                    <th>24h Change</th>
                  </tr>
                </thead>
                <tbody>
                  {freeData.assets.map((asset) => (
                    <tr key={asset.symbol}>
                      <td className="symbol">{asset.symbol}</td>
                      <td className="price">${asset.price.toLocaleString()}</td>
                      <td className={asset.change24h >= 0 ? 'positive' : 'negative'}>
                        {asset.change24h >= 0 ? '▲' : '▼'}{Math.abs(asset.change24h).toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="loading-text">Loading market data…</p>
            )}
          </div>

          {/* Divider */}
          <div className="tier-divider" />

          {/* Premium tier */}
          <div className="tier-section">
            <div className="tier-header">
              <span className="tier-label premium">PREMIUM ANALYTICS</span>
              {!premiumData && <span className="lock-icon">🔒</span>}
            </div>

            {premiumData ? (
              <div className="premium-data">
                <div className="premium-data-header">
                  <p className="premium-timestamp">
                    Updated: {new Date(premiumData.timestamp).toLocaleString()}
                  </p>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handlePurchase()}
                    disabled={!wallet || isPurchasing || isSettlingPremium}
                  >
                    {isPurchasing
                      ? <><span className="spinner" /> Processing…</>
                      : isSettlingPremium
                        ? <><span className="spinner" /> Settling…</>
                        : '↻ Purchase Again'}
                  </button>
                </div>
                <div className="premium-table-wrapper">
                  <table className="asset-table premium-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Price</th>
                        <th>24h Change</th>
                        <th>Volume 24h</th>
                        <th>Market Cap</th>
                        <th>High 24h</th>
                        <th>Low 24h</th>
                        <th>RSI</th>
                        <th>Sentiment</th>
                        <th>Dominance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {premiumData.assets.map((asset) => (
                        <tr key={asset.symbol}>
                          <td className="symbol">{asset.symbol}</td>
                          <td className="price">${asset.price.toLocaleString()}</td>
                          <td className={asset.change24h >= 0 ? 'positive' : 'negative'}>
                            {asset.change24h >= 0 ? '▲' : '▼'}{Math.abs(asset.change24h).toFixed(2)}%
                          </td>
                          <td>${(asset.volume24h / 1e9).toFixed(2)}B</td>
                          <td>${(asset.marketCap / 1e9).toFixed(0)}B</td>
                          <td>${asset.high24h.toLocaleString()}</td>
                          <td>${asset.low24h.toLocaleString()}</td>
                          <td className={asset.rsi > 70 ? 'positive' : asset.rsi < 30 ? 'negative' : ''}>
                            {asset.rsi.toFixed(1)}
                          </td>
                          <td><SentimentBadge sentiment={asset.sentiment} /></td>
                          <td>{asset.dominance != null ? `${asset.dominance}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="premium-locked">
                <p className="premium-desc">
                  Full OHLCV · Volume · RSI · Sentiment · Market Cap
                </p>
                <button
                  className="btn btn-purchase"
                  onClick={() => void handlePurchase()}
                  disabled={!wallet || isPurchasing || isSettlingPremium}
                >
                  {isPurchasing ? (
                    <><span className="spinner" /> Processing payment…</>
                  ) : isSettlingPremium ? (
                    <><span className="spinner" /> Waiting for settlement…</>
                  ) : (
                    'Purchase Access — $0.01 USDC'
                  )}
                </button>
                {!wallet && (
                  <p className="wallet-required">
                    Generate or import a wallet first
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

      {/* SPCX — SpaceX stock data */}
      <section className="panel spcx-panel">
        <div className="spcx-header">
          <div>
            <h2 className="panel-title" style={{ marginBottom: 2 }}>
              {spcxData ? `${spcxData.stock.ticker} — ${spcxData.stock.company}` : 'SPCX — SpaceX'}
            </h2>
            <p className="premium-desc">
              {spcxData
                ? `${spcxData.stock.exchange} · ${spcxData.stock.currency} · ${spcxData.stock.marketState}`
                : 'Live stock data via Yahoo Finance · gated by x402'}
            </p>
          </div>
          {spcxData && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void handlePurchaseSpcx()}
              disabled={!wallet || isPurchasingSpcx || isSettlingSpcx}
            >
              {isPurchasingSpcx
                ? <><span className="spinner" /> Processing…</>
                : isSettlingSpcx
                  ? <><span className="spinner" /> Settling…</>
                  : '↻ Refresh — $0.02'}
            </button>
          )}
        </div>

        {spcxData ? (
          <div className="spcx-data">
            {/* Price hero row */}
            <div className="spcx-summary">
              <div className="spcx-stat spcx-stat-large">
                <span className="field-label">Price</span>
                <span className="spcx-value">${spcxData.stock.sharePrice.toFixed(2)}</span>
              </div>
              <div className="spcx-stat">
                <span className="field-label">Change</span>
                <span className={`spcx-value ${spcxData.stock.change >= 0 ? 'positive' : 'negative'}`}>
                  {spcxData.stock.change >= 0 ? '+' : ''}{spcxData.stock.change.toFixed(2)}
                  &nbsp;({spcxData.stock.changePct >= 0 ? '+' : ''}{spcxData.stock.changePct.toFixed(2)}%)
                </span>
              </div>
              <div className="spcx-stat">
                <span className="field-label">Prev Close</span>
                <span className="spcx-value">${spcxData.stock.previousClose.toFixed(2)}</span>
              </div>
              <div className="spcx-stat">
                <span className="field-label">Day Range</span>
                <span className="spcx-value">${spcxData.stock.low.toFixed(2)} – ${spcxData.stock.high.toFixed(2)}</span>
              </div>
            </div>

            {/* Secondary stats */}
            <div className="spcx-grid">
              <div className="spcx-section">
                <p className="spcx-section-title">Trading</p>
                <table className="asset-table">
                  <tbody>
                    <tr>
                      <td className="field-label">52w High</td>
                      <td>${spcxData.stock.high52w.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td className="field-label">52w Low</td>
                      <td>${spcxData.stock.low52w.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td className="field-label">Volume</td>
                      <td>{spcxData.stock.volume != null ? spcxData.stock.volume.toLocaleString() : '—'}</td>
                    </tr>
                    <tr>
                      <td className="field-label">Market Cap</td>
                      <td>{spcxData.stock.marketCap != null ? `$${(spcxData.stock.marketCap / 1e9).toFixed(1)}B` : '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="spcx-section">
                <p className="spcx-section-title">Info</p>
                <table className="asset-table">
                  <tbody>
                    <tr><td className="field-label">Ticker</td><td>{spcxData.stock.ticker}</td></tr>
                    <tr><td className="field-label">Exchange</td><td>{spcxData.stock.exchange}</td></tr>
                    <tr><td className="field-label">Currency</td><td>{spcxData.stock.currency}</td></tr>
                    <tr><td className="field-label">Market</td><td>{spcxData.stock.marketState}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p className="premium-timestamp">
              Data fetched: {new Date(spcxData.timestamp).toLocaleString()} · Source: Yahoo Finance
            </p>
          </div>
        ) : (
          <div className="premium-locked">
            <button
              className="btn btn-purchase"
              onClick={() => void handlePurchaseSpcx()}
              disabled={!wallet || isPurchasingSpcx || isSettlingSpcx}
            >
              {isPurchasingSpcx ? (
                <><span className="spinner" /> Processing payment…</>
              ) : isSettlingSpcx ? (
                <><span className="spinner" /> Waiting for settlement…</>
              ) : (
                'Purchase SPCX Data — $0.02 USDC'
              )}
            </button>
            {!wallet && <p className="wallet-required">Generate or import a wallet first</p>}
          </div>
        )}
      </section>

      {/* Confirm payment modal */}
      {confirmDetails && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2 className="modal-title">Confirm Payment</h2>
            <p className="modal-subtitle">
              Authorize an off-chain EIP-3009 transfer. No gas required.
            </p>
            <div className="modal-fields">
              <div className="modal-row">
                <span className="modal-label">Service</span>
                <span className="modal-value modal-service">{confirmDetails.service}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Amount</span>
                <span className="modal-value modal-amount">{confirmDetails.amountHuman} USDC</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">From</span>
                <span className="modal-value mono">{confirmDetails.from}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">To (merchant)</span>
                <span className="modal-value mono">{confirmDetails.payTo}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Network</span>
                <span className="modal-value">{confirmDetails.network}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Asset</span>
                <span className="modal-value mono">{confirmDetails.asset}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Expires</span>
                <span className="modal-value">{confirmDetails.expiresAt.toLocaleTimeString()}</span>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={handleConfirmCancel}>
                Cancel
              </button>
              <button className="btn btn-purchase modal-confirm-btn" onClick={handleConfirmApprove}>
                Sign &amp; Pay
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset button — fixed bottom-right */}
      <button
        className="btn btn-reset-fixed"
        onClick={() => void handleReset()}
        title="Clear all purchased data and activity log"
      >
        Reset
      </button>

      {/* Activity log */}
      <section className="panel log-panel">
        <h2 className="panel-title">Activity</h2>
        <div className="log-scroll">
          {log.length === 0 ? (
            <p className="log-empty">No activity yet</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className={`log-entry log-${entry.status}`}>
                <div
                  className={`log-entry-row${entry.details != null ? ' expandable' : ''}`}
                  onClick={() => {
                    if (entry.details == null) return;
                    setExpandedLogs((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                >
                  <span className="log-time">{entry.time}</span>
                  {entry.source && (
                    <span className={`log-source log-source-${entry.source}`}>{entry.source}</span>
                  )}
                  <LogIcon status={entry.status} />
                  <span className="log-message">{entry.message}</span>
                  <button
                    className="log-copy-btn"
                    title="Copy"
                    onClick={(e) => { e.stopPropagation(); copyLogEntry(entry, i); }}
                  >
                    {copiedLog === i ? '✓' : '⧉'}
                  </button>
                  {entry.details != null && (
                    <span className="log-toggle">{expandedLogs.has(i) ? '▼' : '▶'}</span>
                  )}
                </div>
                {entry.details != null && expandedLogs.has(i) && (() => {
                  const d = entry.details as Record<string, unknown>;
                  const http = typeof d?.http === 'string' ? d.http : null;
                  const rest = http ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'http')) : d;
                  const hasRest = Object.keys(rest as object).length > 0;
                  const combined = [
                    http,
                    hasRest ? JSON.stringify(rest, null, 2) : null,
                  ].filter(Boolean).join('\n\n');
                  return <pre className="log-details">{combined}</pre>;
                })()}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
