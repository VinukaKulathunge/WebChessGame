/**
 * clock.js — Precision chess clock for Brutal Chess.
 *
 * Uses performance.now() delta-based ticking (not setInterval drift)
 * for accurate countdown even under CPU load.
 *
 * Public API:
 *   startClock()   – Begin countdown for the current side to move.
 *   stopClock()    – Pause the clock (e.g. on game-over / analysis).
 *   switchClock()  – Called after each move to swap active side.
 *   resetClocks()  – Re-initialise from state (call after initState).
 */

import { state, setRemainingTime, setGameOver, isTimed } from './state.js';
import { renderClocks, renderStatus, renderGameResult } from './render.js';

// ── INTERNAL REFS ─────────────────────────────────────
let _rafId      = null;     // requestAnimationFrame handle
let _lastTick   = null;     // performance.now() at the last frame
let _running    = false;    // whether the clock is active

// ════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════

/**
 * startClock()
 * ─────────────
 * Begins the RAF-based ticker for whichever side state.turn indicates.
 * Safe to call when timeControl is 'unlimited' — it is a no-op in that case.
 */
export function startClock() {
  if (!isTimed() || _running) return;
  _running   = true;
  _lastTick  = performance.now();
  _rafId     = requestAnimationFrame(_tick);
}

/**
 * stopClock()
 * ────────────
 * Pauses the clock without resetting it.
 * Use on: game-over, entering analysis mode, modal open.
 */
export function stopClock() {
  _running = false;
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId    = null;
    _lastTick = null;
  }
}

/**
 * switchClock()
 * ─────────────
 * Pauses then restarts the clock — call this immediately after
 * a move is committed so the opposite side's clock starts ticking.
 * state.turn must already reflect the new side before calling.
 */
export function switchClock() {
  if (!isTimed()) return;
  stopClock();
  startClock();
}

/**
 * resetClocks()
 * ─────────────
 * Stops any running ticker and re-renders the clock display.
 * Call after initState() so the clocks show the fresh time banks.
 */
export function resetClocks() {
  stopClock();
  renderClocks();
}

// ════════════════════════════════════════════════════════
// PRIVATE — RAF TICKER
// ════════════════════════════════════════════════════════

/**
 * _tick(now)
 * ──────────
 * Called every animation frame while the clock is running.
 * Computes the elapsed real time since the last frame and subtracts
 * it from the active player's bank.  Renders clocks every ~100ms
 * to avoid excessive DOM writes without losing visual accuracy.
 *
 * @param {number} now - DOMHighResTimeStamp from requestAnimationFrame
 */
function _tick(now) {
  if (!_running) return;

  const elapsed = (now - _lastTick) / 1000;  // seconds elapsed this frame
  _lastTick = now;

  // Decrement the active side's time bank
  const key    = state.turn === 'w' ? 'remainingTimeWhite' : 'remainingTimeBlack';
  const newVal = Math.max(0, state[key] - elapsed);
  setRemainingTime(state.turn, newVal);

  // Re-render the clock display (~10 times per second is plenty)
  renderClocks();

  // ── Timeout check ────────────────────────────────────
  if (newVal <= 0) {
    stopClock();
    const winner = state.turn === 'w' ? 'b' : 'w';
    setGameOver('timeout', winner);

    // Lazy-import ui to avoid circular deps at module load time
    renderStatus();
    renderGameResult();
    return;
  }

  // Schedule next frame
  _rafId = requestAnimationFrame(_tick);
}
