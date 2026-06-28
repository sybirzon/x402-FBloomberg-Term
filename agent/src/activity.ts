export type ActivitySource = 'agent' | 'merchant' | 'facilitator';
export type ActivityStatus = 'info' | 'success' | 'error';

export interface ActivityStep {
  message: string;
  status: ActivityStatus;
  source: ActivitySource;
  details?: unknown;
}

type InlineStatus = ActivityStatus | '→' | '✓' | '✗';

function toStatus(s: InlineStatus): ActivityStatus {
  return s === '✓' ? 'success' : s === '✗' ? 'error' : s === '→' ? 'info' : s;
}

function toIcon(s: InlineStatus): string {
  const n = toStatus(s);
  return n === 'success' ? '✓' : n === 'error' ? '✗' : '→';
}

export class ActivityLog {
  private readonly _steps: ActivityStep[] = [];
  private readonly _lines: string[] = [];
  private _streamFn?: (steps: ActivityStep[]) => void;

  streamTo(fn: (steps: ActivityStep[]) => void): this {
    this._streamFn = fn;
    return this;
  }

  push(source: ActivitySource, status: InlineStatus, message: string, details?: unknown): void {
    this._lines.push(`[${source}] ${toIcon(status)} ${message}`);
    this._steps.push({ message, status: toStatus(status), source, details });
    this._streamFn?.(this._steps);
  }

  steps(): ActivityStep[] { return [...this._steps]; }
  lines(): string[] { return [...this._lines]; }
  text(): string { return this._lines.join('\n'); }
}
