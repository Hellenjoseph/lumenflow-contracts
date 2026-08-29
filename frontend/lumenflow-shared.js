/**
 * lumenflow-shared.js
 * Shared utilities for LumenFlow frontend pages.
 * Import via: <script type="module" src="lumenflow-shared.js"></script>
 */

// ── Config ────────────────────────────────────────────────────────────────────
// Pages can override these by setting window.LUMENFLOW_CONTRACT_ID etc. before
// loading this module, or by injecting them at build/serve time.

export const CONTRACT_ID = window.LUMENFLOW_CONTRACT_ID || '';
export const RPC_URL     = window.LUMENFLOW_RPC_URL     || 'https://soroban-testnet.stellar.org';
export const NETWORK     = window.LUMENFLOW_NETWORK     || 'testnet';

/** True when no live contract is configured; pages render with mock data. */
export const DEMO_MODE = !CONTRACT_ID;

// ── Status helpers ────────────────────────────────────────────────────────────

/** Maps contract PaymentStatus enum values to UI labels and CSS class suffixes. */
export const STATUS_MAP = {
  Completed:         { label: '✔ Completed',          cls: 'status-completed'         },
  PartiallyRefunded: { label: '↩ Partially Refunded', cls: 'status-partiallyrefunded' },
  FullyRefunded:     { label: '↩ Fully Refunded',     cls: 'status-fullyrefunded'     },
};

/**
 * Returns an HTML string for a status badge.
 * @param {string} status - Contract PaymentStatus value.
 * @returns {string}
 */
export function statusBadgeHtml(status) {
  const entry = STATUS_MAP[status] || { label: status || 'Unknown', cls: 'status-unknown' };
  return `<span class="status-badge ${entry.cls}">${entry.label}</span>`;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Formats a stroop amount into a human-readable XLM string.
 * @param {bigint|number|string} amount - Amount in stroops.
 * @param {number} decimals - Decimal places for the asset (default 7 for XLM).
 * @returns {string}
 */
export function formatAmount(amount, decimals = 7) {
  return (Number(amount) / Math.pow(10, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

/**
 * Formats a Unix timestamp (seconds) into a locale date/time string.
 * @param {bigint|number|string} timestamp
 * @returns {string}
 */
export function formatDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

// ── Mode banner ───────────────────────────────────────────────────────────────

/**
 * Injects a sticky demo/live mode banner at the top of <body>.
 * Call once per page after DOMContentLoaded.
 */
export function renderModeBanner() {
  const banner = document.createElement('div');
  banner.id = 'lf-mode-banner';
  banner.setAttribute('role', 'status');
  banner.style.cssText = [
    'position:sticky', 'top:0', 'z-index:1000',
    'padding:0.4rem 1rem', 'font-size:0.8rem', 'font-weight:600',
    'text-align:center',
    DEMO_MODE
      ? 'background:#fff3cd;color:#856404;'
      : 'background:#d1f3e0;color:#1a5e37;',
  ].join(';');
  banner.textContent = DEMO_MODE
    ? '⚠ Demo mode – displaying mock data. Set LUMENFLOW_CONTRACT_ID to connect to a live contract.'
    : `✔ Live mode – connected to contract ${CONTRACT_ID.slice(0, 8)}… on ${NETWORK}.`;
  document.body.prepend(banner);
}

// ── Transaction Poller (issue #788) ───────────────────────────────────────────

/**
 * TransactionPoller — polls a transaction status with exponential backoff and
 * supports explicit cancellation.
 *
 * Usage:
 *   const poller = new TransactionPoller(pollFn, { onUpdate, onDone, onError });
 *   poller.start();
 *   // later, if the user navigates away or cancels:
 *   poller.cancel();
 *
 * @param {function(): Promise<{status: string, [key: string]: any}>} pollFn
 *   Called on each interval. Must resolve to an object with at minimum a
 *   `status` field. The poller stops when status is 'SUCCESS' or 'FAILED'.
 *
 * @param {object} options
 * @param {function(result): void}  [options.onUpdate]  - Called after each poll with the result.
 * @param {function(result): void}  [options.onDone]    - Called when status reaches a terminal state.
 * @param {function(error):  void}  [options.onError]   - Called when the poll function throws.
 * @param {function():       void}  [options.onCancel]  - Called when cancel() is invoked.
 * @param {number} [options.initialDelay=2000]   - First poll delay in ms.
 * @param {number} [options.maxDelay=30000]       - Maximum back-off ceiling in ms.
 * @param {number} [options.backoffFactor=2]      - Multiplier applied after each attempt.
 * @param {number} [options.jitterMs=500]         - Random jitter added to each delay (ms).
 * @param {number} [options.maxAttempts=15]       - Stop after this many attempts regardless of status.
 */
export class TransactionPoller {
  constructor(pollFn, options = {}) {
    this._pollFn       = pollFn;
    this._onUpdate     = options.onUpdate     || (() => {});
    this._onDone       = options.onDone       || (() => {});
    this._onError      = options.onError      || (() => {});
    this._onCancel     = options.onCancel     || (() => {});
    this._initialDelay = options.initialDelay  ?? 2000;
    this._maxDelay     = options.maxDelay      ?? 30000;
    this._backoffFactor= options.backoffFactor ?? 2;
    this._jitterMs     = options.jitterMs      ?? 500;
    this._maxAttempts  = options.maxAttempts   ?? 15;

    this._cancelled  = false;
    this._attempts   = 0;
    this._timerId    = null;
  }

  /** Terminal statuses that cause the poller to stop. */
  static TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'ERROR', 'NOT_FOUND', 'CANCELLED']);

  /** Start polling. Safe to call only once; create a new instance to restart. */
  start() {
    this._cancelled = false;
    this._attempts  = 0;
    this._scheduleNext(this._initialDelay);
  }

  /**
   * Cancel polling. The in-flight poll (if any) will be ignored once it resolves.
   * `onCancel` is called synchronously.
   */
  cancel() {
    this._cancelled = true;
    if (this._timerId !== null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._onCancel();
  }

  /** True if cancel() has been called. */
  get cancelled() { return this._cancelled; }

  /** Number of completed poll attempts. */
  get attempts() { return this._attempts; }

  // ── Private ──────────────────────────────────────────────────────────────

  _scheduleNext(delay) {
    if (this._cancelled) return;
    if (this._attempts >= this._maxAttempts) {
      this._onError(new Error(`Polling timed out after ${this._maxAttempts} attempts.`));
      return;
    }
    const jitter = Math.floor(Math.random() * this._jitterMs);
    this._timerId = setTimeout(() => this._poll(), delay + jitter);
  }

  async _poll() {
    if (this._cancelled) return;
    this._timerId = null;
    this._attempts++;

    try {
      const result = await this._pollFn();
      if (this._cancelled) return; // cancelled while the async call was in-flight

      this._onUpdate(result);

      if (TransactionPoller.TERMINAL_STATUSES.has(result?.status)) {
        this._onDone(result);
        return;
      }
    } catch (err) {
      if (this._cancelled) return;
      this._onError(err);
      return; // do not schedule next poll on error — caller can start a new poller
    }

    // Exponential back-off with ceiling
    const nextDelay = Math.min(
      this._initialDelay * Math.pow(this._backoffFactor, this._attempts - 1),
      this._maxDelay,
    );
    this._scheduleNext(nextDelay);
  }
}
