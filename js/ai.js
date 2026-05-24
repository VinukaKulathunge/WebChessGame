/**
 * ai.js — Main-thread Stockfish manager for Brutal Chess.
 *
 * Responsibilities:
 *   • Spawns and owns the stockfish.worker.js Web Worker.
 *   • Exposes initAI() to boot the worker once at game-start.
 *   • Exposes triggerAIMove() to request a move for the current position.
 *   • Maps app difficulty levels to Stockfish movetime values.
 *   • Receives 'bestmove' from the worker, passes it to engine.js,
 *     then refreshes the view via render.js.
 *   • Receives 'info' lines and forwards them to the eval bar / engine lines panel.
 *   • Registers itself as window.__stockfishWorker so ui.js can detect
 *     that Stockfish is available and skip the fallback random AI.
 *
 * Worker message protocol:
 *   → { type:'init' }
 *   → { type:'go', fen, movetime, multiPV }
 *   → { type:'stop' }
 *   ← { type:'ready' }
 *   ← { type:'bestmove', move }
 *   ← { type:'info', lines:[{ depth, score, moves[] }] }
 *   ← { type:'error', message }
 */

import { state, isPlayerTurn } from './state.js';
import { makeMove, getFEN }    from './engine.js';
import {
  renderPieces,
  renderHighlights,
  renderMoveLog,
  renderCapturedPieces,
  renderClocks,
  renderStatus,
  renderEvalBar,
  renderEngineLines,
  renderGameResult,
} from './render.js';
import { setGameOver } from './state.js';
import { drawBestMoveArrow } from './arrows.js';

// ── DIFFICULTY → MOVETIME MAP (milliseconds) ──────────
const MOVETIME = {
  easy:   100,
  medium: 500,
  hard:   2000,
};

// ── WORKER INSTANCE ───────────────────────────────────
let _worker  = null;   // the Web Worker
let _ready   = false;  // true after worker emits 'ready'
let _busy    = false;  // true while a search is in progress

// ── PUBLIC API ────────────────────────────────────────

/**
 * initAI()
 * ─────────
 * Spawns the Stockfish Web Worker and waits for it to become ready.
 * Safe to call multiple times — subsequent calls are ignored if the
 * worker is already alive.
 *
 * @returns {Promise<void>} Resolves when Stockfish emits 'readyok'.
 */
export function initAI() {
  return new Promise((resolve, reject) => {
    if (_worker && _ready) { resolve(); return; }

    // Destroy any stale worker before spawning a fresh one
    _destroyWorker();

    try {
      _worker = new Worker('./js/stockfish.worker.js');
    } catch (err) {
      console.warn('[ai] Could not spawn Worker:', err.message);
      reject(err);
      return;
    }

    // ── Handle messages from the worker ────────────────
    _worker.onmessage = _handleWorkerMessage;
    _worker.onerror   = e => {
      console.error('[ai] Worker error:', e.message);
      reject(e);
    };

    // Register globally so ui.js skips the fallback random AI
    window.__stockfishWorker = {
      postMessage: _dispatchToWorker,
    };

    // Boot the engine inside the worker
    _worker.postMessage({ type: 'init' });

    // Wait for 'ready' before resolving
    const _origHandler = _worker.onmessage;
    _worker.onmessage = e => {
      if (e.data?.type === 'ready') resolve();
      _origHandler(e);
    };
  });
}

/**
 * triggerAIMove()
 * ────────────────
 * Asks Stockfish to find the best move for the current position.
 * Called by ui.js after each human move (and on game-start when
 * the player has chosen to play as Black).
 *
 * Internally uses the difficulty setting from state.js to pick
 * the appropriate movetime.
 *
 * @returns {void}
 */
export function triggerAIMove() {
  if (!_worker || !_ready) {
    console.warn('[ai] Stockfish not ready — using fallback AI.');
    return;   // ui.js fallback will have already handled this
  }

  if (_busy) {
    console.warn('[ai] Already searching — ignoring duplicate triggerAIMove().');
    return;
  }

  if (state.gameOverFlag) return;

  _busy = true;
  renderStatus('ENGINE IS THINKING…');

  const movetime = MOVETIME[state.difficulty] ?? MOVETIME.medium;
  const fen      = getFEN();

  _worker.postMessage({
    type:     'go',
    fen,
    movetime,
    multiPV:  3,   // always request top 3 lines for the engine panel
  });
}

/**
 * stopSearch()
 * ─────────────
 * Immediately halts any ongoing Stockfish search.
 * Use when the user resigns, starts a new game, etc.
 */
export function stopSearch() {
  if (_worker) _worker.postMessage({ type: 'stop' });
  _busy = false;
}

/**
 * destroyAI()
 * ────────────
 * Gracefully shuts down the worker. Call on page unload or new-game.
 */
export function destroyAI() {
  _destroyWorker();
  window.__stockfishWorker = null;
}

// ── PRIVATE HELPERS ───────────────────────────────────

/**
 * Central dispatcher used by window.__stockfishWorker.postMessage.
 * This is the hook ui.js calls when it wants to send a search request.
 * We intercept it here to apply movetime from difficulty rather than
 * letting ui.js guess a value.
 *
 * @param {{ type:string, fen?:string, difficulty?:string }} msg
 */
function _dispatchToWorker(msg) {
  if (!_worker) return;

  if (msg.type === 'go') {
    // Override movetime with the difficulty-mapped value
    const movetime = MOVETIME[msg.difficulty ?? state.difficulty] ?? MOVETIME.medium;
    _worker.postMessage({ type: 'go', fen: msg.fen, movetime, multiPV: 3 });
    _busy = true;
    return;
  }

  _worker.postMessage(msg);
}

/**
 * Handles all incoming messages from the Stockfish worker.
 * @param {MessageEvent} event
 */
function _handleWorkerMessage(event) {
  const msg = event.data;

  switch (msg.type) {

    case 'ready':
      _ready = true;
      console.log('[ai] Stockfish ready.');
      break;

    case 'bestmove':
      _busy = false;
      _onBestMove(msg.move);
      break;

    case 'info':
      _onInfoLines(msg.lines);
      break;

    case 'error':
      _busy = false;
      console.error('[ai] Stockfish error:', msg.message);
      break;

    default:
      break;
  }
}

/**
 * Called when Stockfish returns its best move.
 * Commits the move to the chess engine, then re-renders all panels.
 *
 * @param {string} uciMove - e.g. 'e2e4', 'e7e8q'
 */
function _onBestMove(uciMove) {
  if (!uciMove || uciMove === '(none)') {
    renderStatus();
    renderGameResult();
    return;
  }

  if (state.gameOverFlag) return;

  // Draw the bestmove arrow BEFORE committing the move so the user
  // can see Stockfish's recommendation flash on screen.
  // The arrow is automatically cleared by renderPieces() on next move.
  if (uciMove.length >= 4) {
    const from = uciMove.slice(0, 2);
    const to   = uciMove.slice(2, 4);
    drawBestMoveArrow(from, to);
  }

  // Commit the move through the engine (updates state internally)
  const result = makeMove(uciMove);

  if (!result.ok) {
    console.error('[ai] Stockfish returned an illegal move:', uciMove);
    renderStatus('ENGINE ERROR — ILLEGAL MOVE');
    return;
  }

  // Full visual refresh
  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderCapturedPieces();
  renderClocks();
  renderStatus();

  if (state.gameOverFlag) {
    renderGameResult();
  }
}

/**
 * Called when the worker sends MultiPV info lines.
 * Forwards them to the eval bar and engine-lines panel.
 *
 * Stockfish reports scores from its own perspective (the side to move).
 * We normalise so that positive = White advantage for the eval bar.
 *
 * @param {Array<{ depth:number, score:number, moves:string[] }>} lines
 */
function _onInfoLines(lines) {
  if (!lines || !lines.length) return;

  // The top line (MultiPV 1) drives the eval bar
  const topLine = lines[0];

  // Normalise: Stockfish cp is always from side-to-move's perspective.
  // If it's Black's turn, negate to get white-positive value.
  const normalised = state.turn === 'b' ? -topLine.score : topLine.score;
  renderEvalBar(normalised);

  // Convert UCI move lists to SAN for display in the engine panel
  // (We pass UCI strings and let render.js display them as-is;
  //  a full UCI→SAN conversion would require calling engine.js per-move
  //  which is expensive. The panel is readable enough with UCI notation.)
  const displayLines = lines.map(line => ({
    score: state.turn === 'b' ? -line.score : line.score,
    moves: line.moves,
    depth: line.depth,
  }));

  renderEngineLines(displayLines, topLine.depth);
}

/**
 * Terminates and nullifies the worker.
 */
function _destroyWorker() {
  if (_worker) {
    _worker.postMessage({ type: 'quit' });
    _worker.terminate();
    _worker = null;
  }
  _ready = false;
  _busy  = false;
}
