/**
 * analysis.js — Analysis Mode, Move Classification & Post-Game Review.
 *
 * Responsibilities:
 *   1. Analysis Mode toggle — free-move both sides, no AI, clock paused.
 *   2. History scrubbing — navigate state.moveHistory via buttons / arrow keys.
 *   3. Post-Game Classification — evaluate centipawn loss per move after game ends,
 *      classify as Brilliant / Good / Inaccuracy / Mistake / Blunder.
 *   4. Badge injection — decorate the move-log cells with classification icons.
 *   5. Game-Over overlay — sharp brutalist screen with result + "New Game" button.
 *
 * Public API:
 *   initAnalysis()          – Wire all buttons and keyboard shortcuts.
 *   enterAnalysisMode()     – Switch to analysis/review mode.
 *   exitAnalysisMode()      – Return to live game mode.
 *   classifyGame()          – Run post-game centipawn-loss loop and badge moves.
 *   showGameOverOverlay()   – Render the full-screen result overlay.
 */

import { state, setAnalysisMode } from './state.js';
import { loadFEN, getAllLegalMoves, makeMove, getFEN } from './engine.js';
import {
  renderPieces,
  renderHighlights,
  renderMoveLog,
  renderStatus,
  renderClocks,
  renderEvalBar,
} from './render.js';
import { stopClock, startClock } from './clock.js';
import { clearArrows } from './arrows.js';

// ── CLASSIFICATION THRESHOLDS (centipawns) ────────────
const THRESHOLDS = {
  brilliant:   10,   // cp loss ≤ 10 AND a great positional find (heuristic)
  good:        30,   // cp loss ≤ 30
  inaccuracy:  50,   // cp loss > 50
  mistake:    100,   // cp loss > 100
  blunder:    200,   // cp loss > 200
};

// Classification metadata: { label, icon, color }
const CLASSIFICATION = {
  brilliant:  { label: 'Brilliant',  icon: '✦', color: '#4ae4c3' },
  great:      { label: 'Great',      icon: '★', color: '#7ec8e3' },
  good:       { label: 'Good',       icon: '✓', color: '#3dba6e' },
  book:       { label: 'Book',       icon: '⊕', color: '#8888cc' },
  inaccuracy: { label: 'Inaccuracy', icon: '?', color: '#f5c842' },
  mistake:    { label: 'Mistake',    icon: '?!', color: '#e08a3a' },
  blunder:    { label: 'Blunder',    icon: '??', color: '#e03a3a' },
};

// Stored classifications indexed by half-move (sanHistory index)
/** @type {string[]} */
let _classifications = [];

// ════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════

/**
 * initAnalysis()
 * ───────────────
 * Wire up analysis-mode UI controls.
 * Call once from ui.js after DOM is ready.
 */
export function initAnalysis() {
  const $ = id => document.getElementById(id);

  // Analysis mode toggle button
  $('btn-analysis-mode')?.addEventListener('click', () => {
    if (state.analysisMode) {
      exitAnalysisMode();
    } else {
      enterAnalysisMode();
    }
  });

  // Move log navigation
  $('btn-move-start')?.addEventListener('click', () => _navigate('start'));
  $('btn-move-prev')?.addEventListener('click',  () => _navigate('prev'));
  $('btn-move-next')?.addEventListener('click',  () => _navigate('next'));
  $('btn-move-end')?.addEventListener('click',   () => _navigate('end'));

  // Move log cell click-to-jump
  $('move-log-scroll')?.addEventListener('click', e => {
    if (!state.analysisMode) return;
    const cell = e.target.closest('.move-log-cell');
    if (!cell || cell.dataset.moveIndex === undefined) return;
    _loadPosition(Number(cell.dataset.moveIndex));
  });

  // Keyboard shortcuts (arrow keys) — added to document
  document.addEventListener('keydown', _handleKey);

  // Game-Over overlay "New Game" button
  $('overlay-new-game-btn')?.addEventListener('click', _overlayNewGame);
}

// ─────────────────────────────────────────────────────

/**
 * enterAnalysisMode()
 * ────────────────────
 * Pauses the clock, disables AI, and loads the latest position.
 */
export function enterAnalysisMode() {
  if (state.analysisMode) return;

  setAnalysisMode(true);
  stopClock();
  clearArrows();

  document.getElementById('btn-analysis-mode')?.classList.add('active');

  // Load the final position in history (or current live position)
  const targetIdx = state.moveHistory.length - 1;
  if (targetIdx >= 0) {
    _loadPosition(targetIdx);
  } else {
    renderStatus('ANALYSIS MODE — No moves yet.');
  }
}

// ─────────────────────────────────────────────────────

/**
 * exitAnalysisMode()
 * ───────────────────
 * Restores the live game position and re-enables the clock.
 */
export function exitAnalysisMode() {
  if (!state.analysisMode) return;

  setAnalysisMode(false);
  document.getElementById('btn-analysis-mode')?.classList.remove('active');

  // Reload the authoritative live FEN (last entry in history, or start)
  const liveFEN = state.moveHistory.length
    ? state.moveHistory[state.moveHistory.length - 1]
    : null;

  if (liveFEN) loadFEN(liveFEN);

  state.selectedSquare        = null;
  state.legalMovesForSelected = [];

  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderStatus();
  renderClocks();

  // Resume clock if game still in progress
  if (!state.gameOverFlag) startClock();
}

// ════════════════════════════════════════════════════════
// POST-GAME CLASSIFICATION
// ════════════════════════════════════════════════════════

/**
 * classifyGame(evalsByMove)
 * ──────────────────────────
 * Runs post-game move classification.
 * Called by ai.js after game ends with the collected engine evaluations.
 *
 * Algorithm:
 *   For each move by the player, compute centipawn loss vs the engine's
 *   best continuation at that point, then bucket into a classification.
 *
 * @param {number[]} evalsByMove
 *   Array of centipawn evals (white-positive) AFTER each half-move
 *   (aligned to state.sanHistory). Length equals sanHistory.length.
 */
export function classifyGame(evalsByMove) {
  _classifications = [];
  if (!evalsByMove || !evalsByMove.length) return;

  const playerColor = state.playerColor === 'white' ? 'w' : 'b';

  for (let i = 0; i < state.sanHistory.length; i++) {
    // Who made this half-move? (move 0 = white, 1 = black, …)
    const movedBy = i % 2 === 0 ? 'w' : 'b';

    // Only classify the human player's moves (skip engine moves)
    if (movedBy !== playerColor) {
      _classifications.push(null);
      continue;
    }

    // Centipawn eval before and after this move (white-positive)
    const evalBefore = i === 0 ? 0 : evalsByMove[i - 1];
    const evalAfter  = evalsByMove[i];

    // For white: positive swing = good. For black: negative swing = good.
    const cpLoss = movedBy === 'w'
      ? Math.max(0, evalBefore - evalAfter)   // White lost how much advantage?
      : Math.max(0, evalAfter  - evalBefore); // Black lost how much advantage?

    _classifications.push(_bucketLoss(cpLoss, i));
  }

  // Inject badges into the rendered move log
  _injectBadges();
}

// ════════════════════════════════════════════════════════
// GAME-OVER OVERLAY
// ════════════════════════════════════════════════════════

/**
 * showGameOverOverlay()
 * ──────────────────────
 * Renders the full-screen brutalist game-over overlay.
 * Reads state.gameOverReason and state.gameWinner for content.
 */
export function showGameOverOverlay() {
  let overlay = document.getElementById('gameover-overlay');
  if (!overlay) overlay = _createOverlay();

  const { headline, sub, icon } = _buildOverlayContent();

  overlay.querySelector('.go-icon').textContent    = icon;
  overlay.querySelector('.go-headline').textContent = headline;
  overlay.querySelector('.go-sub').textContent      = sub;

  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('go-visible'));
}

// ════════════════════════════════════════════════════════
// PRIVATE — NAVIGATION
// ════════════════════════════════════════════════════════

function _navigate(dir) {
  // Auto-enter analysis mode on first navigation
  if (!state.analysisMode) enterAnalysisMode();

  const len = state.moveHistory.length;
  if (!len) return;

  let idx = state.currentReviewIndex;

  switch (dir) {
    case 'start': idx = 0;                       break;
    case 'prev':  idx = Math.max(0, idx - 1);    break;
    case 'next':  idx = Math.min(len - 1, idx + 1); break;
    case 'end':   idx = len - 1;                 break;
  }

  _loadPosition(idx);
}

/**
 * Loads a historical board position by half-move index.
 * @param {number} idx - Index into state.moveHistory
 */
function _loadPosition(idx) {
  const fen = state.moveHistory[idx];
  if (!fen) return;

  state.currentReviewIndex    = idx;
  state.selectedSquare        = null;
  state.legalMovesForSelected = [];
  state.lastMove              = null;  // clear last-move highlight in review

  loadFEN(fen);
  clearArrows();

  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderStatus();

  // Update eval bar if we have stored evaluations
  // (evals stored by ai.js per half-move)
  if (window.__evalHistory && window.__evalHistory[idx] !== undefined) {
    renderEvalBar(window.__evalHistory[idx]);
  }
}

function _handleKey(e) {
  // Don't hijack when user is typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); _navigate('prev');  break;
    case 'ArrowRight': e.preventDefault(); _navigate('next');  break;
    case 'ArrowUp':    e.preventDefault(); _navigate('start'); break;
    case 'ArrowDown':  e.preventDefault(); _navigate('end');   break;
  }
}

// ════════════════════════════════════════════════════════
// PRIVATE — CLASSIFICATION HELPERS
// ════════════════════════════════════════════════════════

/**
 * Maps centipawn loss to a classification key.
 * @param {number} cpLoss  - Non-negative centipawn loss
 * @param {number} moveIdx - Half-move index (0-based)
 * @returns {string}
 */
function _bucketLoss(cpLoss, moveIdx) {
  // Opening moves (first 5 per side) are "book" if loss is tiny
  if (moveIdx < 10 && cpLoss < 10) return 'book';

  if (cpLoss <= THRESHOLDS.brilliant) {
    // Heuristic for "brilliant": low loss on a move with few legal alternatives
    // (sacrifice pattern). We use a simplistic random flavor here;
    // a full implementation would re-run Stockfish on the position.
    return cpLoss === 0 ? 'great' : 'good';
  }
  if (cpLoss <= THRESHOLDS.good)       return 'good';
  if (cpLoss <= THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (cpLoss <= THRESHOLDS.mistake)    return 'mistake';
  return 'blunder';
}

/**
 * Injects classification badge spans next to each move-log cell.
 * Must be called after renderMoveLog() has built the DOM.
 */
function _injectBadges() {
  const cells = document.querySelectorAll('.move-log-cell[data-move-index]');
  cells.forEach(cell => {
    const idx = Number(cell.dataset.moveIndex);
    const cls = _classifications[idx];
    if (!cls) return;

    // Remove any existing badge
    cell.querySelector('.move-badge')?.remove();

    const meta = CLASSIFICATION[cls];
    if (!meta) return;

    const badge = document.createElement('span');
    badge.className   = 'move-badge';
    badge.textContent = meta.icon;
    badge.title       = meta.label;
    badge.style.color = meta.color;
    cell.appendChild(badge);
  });
}

// ════════════════════════════════════════════════════════
// PRIVATE — GAME-OVER OVERLAY DOM
// ════════════════════════════════════════════════════════

/**
 * Lazily creates the game-over overlay DOM element and appends it to body.
 * @returns {HTMLElement}
 */
function _createOverlay() {
  const el = document.createElement('div');
  el.id        = 'gameover-overlay';
  el.className = 'gameover-overlay hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="go-panel">
      <div class="go-icon" aria-hidden="true">♟</div>
      <h2 class="go-headline">GAME OVER</h2>
      <p  class="go-sub"></p>
      <div class="go-actions">
        <button id="overlay-new-game-btn" class="start-btn">NEW GAME</button>
        <button id="overlay-review-btn"   class="start-btn go-secondary-btn">REVIEW GAME</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  // Wire buttons on the freshly created DOM
  el.querySelector('#overlay-new-game-btn').addEventListener('click', _overlayNewGame);
  el.querySelector('#overlay-review-btn').addEventListener('click', () => {
    el.classList.add('hidden');
    el.classList.remove('go-visible');
    enterAnalysisMode();
  });

  return el;
}

function _overlayNewGame() {
  const el = document.getElementById('gameover-overlay');
  if (el) {
    el.classList.remove('go-visible');
    el.classList.add('hidden');
  }

  stopClock();
  document.getElementById('app')?.classList.add('hidden');
  document.getElementById('setup-modal')?.classList.remove('hidden');
}

/** Build headline, sub-text, and icon for the overlay from state. */
function _buildOverlayContent() {
  const r = state.gameOverReason;
  const w = state.gameWinner;

  const ICONS = { checkmate: '♟', timeout: '⏱', resign: '⚑',
                  stalemate: '=', draw_agreed: '=',
                  insufficient_material: '=', threefold_repetition: '=',
                  fifty_move_rule: '=' };

  const icon = ICONS[r] ?? '♟';

  if (r === 'checkmate') {
    const winner = w === 'w' ? 'WHITE' : 'BLACK';
    return { icon, headline: `${winner} WINS`, sub: 'by Checkmate' };
  }
  if (r === 'timeout') {
    const winner = w === 'w' ? 'WHITE' : 'BLACK';
    return { icon, headline: `${winner} WINS`, sub: 'on Time' };
  }
  if (r === 'resign') {
    const winner = w === 'w' ? 'WHITE' : 'BLACK';
    return { icon, headline: `${winner} WINS`, sub: 'by Resignation' };
  }
  if (r === 'stalemate')             return { icon, headline: 'DRAW', sub: 'by Stalemate' };
  if (r === 'insufficient_material') return { icon, headline: 'DRAW', sub: 'by Insufficient Material' };
  if (r === 'threefold_repetition')  return { icon, headline: 'DRAW', sub: 'by Threefold Repetition' };
  if (r === 'fifty_move_rule')       return { icon, headline: 'DRAW', sub: 'by 50-Move Rule' };
  if (r === 'draw_agreed')           return { icon, headline: 'DRAW', sub: 'by Agreement' };

  return { icon: '♟', headline: 'GAME OVER', sub: '' };
}
