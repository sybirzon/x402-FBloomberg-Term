export interface FreeAsset {
  symbol: string;
  price: number;
  change24h: number;
}

export interface PremiumAsset extends FreeAsset {
  volume24h: number;
  marketCap: number;
  high24h: number;
  low24h: number;
  rsi: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  dominance?: number;
}

export interface FreeData {
  tier: 'free';
  assets: FreeAsset[];
}

export interface PremiumData {
  tier: 'premium';
  timestamp: string;
  assets: PremiumAsset[];
}

export interface LogEntry {
  time: string;
  message: string;
  status: 'info' | 'success' | 'error';
  source?: 'agent' | 'merchant' | 'facilitator';
  details?: unknown;
}

export interface SpcxData {
  tier: 'spcx';
  timestamp: string;
  stock: {
    ticker: string;
    company: string;
    exchange: string;
    currency: string;
    marketState: string;
    sharePrice: number;
    change: number;
    changePct: number;
    previousClose: number;
    high: number;
    low: number;
    high52w: number;
    low52w: number;
    volume: number;
    marketCap: number | null;
  };
}

export interface PaymentDetails {
  service: string;
  amountHuman: string;
  payTo: string;
  from: string;
  network: string;
  asset: string;
  expiresAt: Date;
}
