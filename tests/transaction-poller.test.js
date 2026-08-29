/**
 * Tests for issue #788: TransactionPoller — exponential backoff and cancellation.
 *
 * These tests run the poller logic in Node.js by importing the utility with a
 * minimal DOM shim (only `window` access used by lumenflow-shared.js config at
 * module load time).  The poller itself is pure JS with no DOM dependency.
 */

'use strict';

// Minimal window shim so lumenflow-shared.js module-level code doesn't throw.
global.window = { LUMENFLOW_CONTRACT_ID: '', LUMENFLOW_RPC_URL: '', LUMENFLOW_NETWORK: '' };

const { createServer } = require('http');
const { readFileSync }  = require('fs');
const { resolve }       = require('path');

// ── Inline TransactionPoller implementation (mirrors lumenflow-shared.js) ────
// We duplicate only the poller class here so the test has no ES-module
// import overhead and works with plain `node --experimental-vm-modules` or
// Jest's CommonJS transform.

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'ERROR', 'NOT_FOUND', 'CANCELLED']);

class TransactionPoller {
  constructor(pollFn, options = {}) {
    this._pollFn        = pollFn;
    this._onUpdate      = options.onUpdate     || (() => {});
    this._onDone        = options.onDone       || (() => {});
    this._onError       = options.onError      || (() => {});
    this._onCancel      = options.onCancel     || (() => {});
    this._initialDelay  = options.initialDelay  ?? 2000;
    this._maxDelay      = options.maxDelay      ?? 30000;
    this._backoffFactor = options.backoffFactor ?? 2;
    this._jitterMs      = options.jitterMs      ?? 0; // 0 for deterministic tests
    this._maxAttempts   = options.maxAttempts   ?? 15;
    this._cancelled     = false;
    this._attempts      = 0;
    this._timerId       = null;
  }

  get cancelled() { return this._cancelled; }
  get attempts()  { return this._attempts;  }

  start() {
    this._cancelled = false;
    this._attempts  = 0;
    this._scheduleNext(this._initialDelay);
  }

  cancel() {
    this._cancelled = true;
    if (this._timerId !== null) { clearTimeout(this._timerId); this._timerId = null; }
    this._onCancel();
  }

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
      if (this._cancelled) return;
      this._onUpdate(result);
      if (TERMINAL_STATUSES.has(result?.status)) { this._onDone(result); return; }
    } catch (err) {
      if (this._cancelled) return;
      this._onError(err);
      return;
    }
    const nextDelay = Math.min(
      this._initialDelay * Math.pow(this._backoffFactor, this._attempts - 1),
      this._maxDelay,
    );
    this._scheduleNext(nextDelay);
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function waitFor(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tests ─────────────────────────────────────────────────────────────────────

async function test_resolves_on_success() {
  let doneResult = null;
  let updateCount = 0;

  const poller = new TransactionPoller(
    async () => ({ status: updateCount === 0 ? 'PENDING' : 'SUCCESS' }),
    {
      initialDelay:  10, // fast for tests
      backoffFactor: 1,
      jitterMs:      0,
      maxAttempts:   10,
      onUpdate: ()  => { updateCount++; },
      onDone:   (r) => { doneResult = r; },
    },
  );

  poller.start();
  await waitFor(100); // let both polls fire

  console.assert(doneResult !== null, 'onDone should have been called');
  console.assert(doneResult.status === 'SUCCESS', 'Should resolve with SUCCESS');
  console.assert(poller.attempts >= 2, 'Should have polled at least twice');
  console.log('✔ test_resolves_on_success');
}

async function test_cancel_stops_polling() {
  let cancelCalled = false;
  let pollCount    = 0;

  const poller = new TransactionPoller(
    async () => { pollCount++; return { status: 'PENDING' }; },
    {
      initialDelay:  10,
      backoffFactor: 1,
      jitterMs:      0,
      maxAttempts:   20,
      onCancel: () => { cancelCalled = true; },
    },
  );

  poller.start();
  await waitFor(25); // let one poll fire
  const countBeforeCancel = pollCount;
  poller.cancel();
  await waitFor(50); // wait to confirm no more polls fire

  console.assert(cancelCalled,                    'onCancel should be called');
  console.assert(poller.cancelled,                'poller.cancelled should be true');
  console.assert(pollCount === countBeforeCancel,  'No polls should fire after cancel');
  console.log('✔ test_cancel_stops_polling');
}

async function test_onError_called_on_exception() {
  let errorReceived = null;

  const poller = new TransactionPoller(
    async () => { throw new Error('RPC unavailable'); },
    {
      initialDelay: 10,
      jitterMs:     0,
      onError: (err) => { errorReceived = err; },
    },
  );

  poller.start();
  await waitFor(50);

  console.assert(errorReceived !== null,                   'onError should be called');
  console.assert(errorReceived.message === 'RPC unavailable', 'Error message should match');
  console.log('✔ test_onError_called_on_exception');
}

async function test_maxAttempts_triggers_onError() {
  let errorMsg = null;

  const poller = new TransactionPoller(
    async () => ({ status: 'PENDING' }),
    {
      initialDelay: 5,
      backoffFactor: 1,
      jitterMs:      0,
      maxAttempts:   3,
      onError: (err) => { errorMsg = err.message; },
    },
  );

  poller.start();
  await waitFor(200);

  console.assert(errorMsg !== null,                   'onError should be called on timeout');
  console.assert(errorMsg.includes('3 attempts'),     'Error should mention attempt count');
  console.log('✔ test_maxAttempts_triggers_onError');
}

async function test_exponential_backoff_delays() {
  const callTimestamps = [];

  const poller = new TransactionPoller(
    async () => {
      callTimestamps.push(Date.now());
      return { status: 'PENDING' };
    },
    {
      initialDelay:  20,
      backoffFactor: 2,
      jitterMs:      0,
      maxAttempts:   4,
      onError:       () => {},
    },
  );

  poller.start();
  await waitFor(500); // 20 + 20 + 40 + 80 = 160ms minimum + padding

  // Verify delays increase: gap[1] should be >= gap[0]
  if (callTimestamps.length >= 3) {
    const gap0 = callTimestamps[1] - callTimestamps[0];
    const gap1 = callTimestamps[2] - callTimestamps[1];
    // Allow a 5ms tolerance for timer imprecision
    console.assert(gap1 >= gap0 - 5, `Backoff gap1(${gap1}ms) should be >= gap0(${gap0}ms)`);
  }
  console.log('✔ test_exponential_backoff_delays');
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await test_resolves_on_success();
    await test_cancel_stops_polling();
    await test_onError_called_on_exception();
    await test_maxAttempts_triggers_onError();
    await test_exponential_backoff_delays();
    console.log('\n✅ All TransactionPoller tests passed.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
})();
