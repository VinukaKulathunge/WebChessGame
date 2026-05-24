/**
 * ui.js — User interaction layer for Brutal Chess.
 *
 * Handles all DOM events and orchestrates the game loop:
 * Integrates with ai.js for Stockfish, which replaces the fallback
 * random AI once the worker is ready.
 *   1. Setup screen → initState + initEngine + first render
 *   2. Board clicks → piece selection + move execution
 *   3. Header controls → flip, new game, resign, draw, analysis nav
 *   4. Promotion dialog
 *   5. Move log click-to-review in analysis mode
 *
 * Depends on: state.js · engine.js · render.js · ai.js
 * Does NOT contain chess rules or rendering code.
 */

import {
  state,
  initState,
  setGameOver,
  setAnalysisMode,
  isPlayerTurn,
  isTimed,
} from './state.js';

import {
  initEngine,
  makeMove,
  getAllLegalMoves,
  getLegalMovesForSquare,
  getFEN,
  loadFEN,
  getPieceAt,
} from './engine.js';

import {
  renderBoard,
  renderPieces,
  renderHighlights,
  renderMoveLog,
  renderCapturedPieces,
  renderClocks,
  renderStatus,
  renderEvalBar,
  renderEngineLines,
  renderGameResult,
  renderPlayerNames,
} from './render.js';

import { initAI, triggerAIMove as _sfTrigger, stopSearch, destroyAI } from './ai.js';
import { initArrowCanvas, clearArrows, resizeCanvas } from './arrows.js';
import { startClock, stopClock, switchClock, resetClocks } from './clock.js';
import { initAnalysis, showGameOverOverlay, classifyGame } from './analysis.js';

// ── INTERNAL REFS ─────────────────────────────────────
const $ = id => document.getElementById(id);

/** Pending promotion: stored while we wait for user to pick a piece */
let _pendingPromotion = null;  // { from, to } | null

// ════════════════════════════════════════════════════════
// BOOTSTRAP — called once from main.js
// ════════════════════════════════════════════════════════

/**
 * initUI()
 * ─────────
 * Attaches every event listener in the application.
 * Must be called once after the DOM is ready.
 */
export function initUI() {
  _bindSetupModal();
  _bindHeaderControls();
  _bindBoardClicks();
  _bindPromotionModal();
  _bindKeyboard();
  initAnalysis();   // wire analysis mode, nav buttons, game-over overlay
}

// ════════════════════════════════════════════════════════
// SETUP MODAL
// ════════════════════════════════════════════════════════

function _bindSetupModal() {
  // Option button toggle (color / difficulty / time)
  document.querySelectorAll('.config-options').forEach(group => {
    group.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.option-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      });
    });
  });

  $('start-game-btn').addEventListener('click', _handleStartGame);
  $('btn-rematch')?.addEventListener('click', () => {
    // Re-open setup modal for new config
    $('result-panel')?.classList.add('hidden');
    $('app').classList.add('hidden');
    $('setup-modal').classList.remove('hidden');
  });
}

function _handleStartGame() {
  const playerColor = document.querySelector('#config-color .option-btn.active')?.dataset.value ?? 'white';
  const difficulty  = document.querySelector('#config-difficulty .option-btn.active')?.dataset.value ?? 'medium';
  const rawTime     = document.querySelector('#config-time .option-btn.active')?.dataset.value ?? 'unlimited';
  const timeControl = rawTime === 'unlimited' ? 'unlimited' : Number(rawTime);

  // 1. Reset central state
  initState({ playerColor, difficulty, timeControl });

  // 2. Boot chess.js engine from scratch
  initEngine();

  // 3. Transition to game screen
  $('setup-modal').classList.add('hidden');
  $('app').classList.remove('hidden');

  // 4. Full initial render
  renderPlayerNames();
  renderBoard();
  initArrowCanvas();      // mount canvas overlay on top of the board
  renderCapturedPieces();
  renderMoveLog();
  renderClocks();
  renderEvalBar(0);
  renderStatus();

  // 5. Start clock if timed
  resetClocks();   // set display to initial time banks
  startClock();    // begin countdown for White (first to move)

  // 6. Boot Stockfish worker, then fire engine's opening move if needed
  initAI()
    .then(() => {
      console.log('[ui] Stockfish ready.');
      if (state.playerColor === 'black') {
        _triggerAIMove();
      }
    })
    .catch(() => {
      console.warn('[ui] Stockfish unavailable — using fallback AI.');
      if (state.playerColor === 'black') {
        _triggerAIMove();
      }
    });
}

// ════════════════════════════════════════════════════════
// HEADER CONTROLS
// ════════════════════════════════════════════════════════

function _bindHeaderControls() {
  $('btn-new-game')?.addEventListener('click', () => {
    stopClock();
    stopSearch();
    $('app').classList.add('hidden');
    $('setup-modal').classList.remove('hidden');
    document.querySelectorAll('.option-btn').forEach(b => b.disabled = false);
  });

  $('btn-flip-board')?.addEventListener('click', () => {
    state.boardFlipped = !state.boardFlipped;
    renderBoard();
  });

  $('btn-offer-draw')?.addEventListener('click', () => {
    if (state.gameOverFlag) return;
    if (confirm('Offer draw? (Accept on behalf of engine)')) {
      stopClock();
      setGameOver('draw_agreed', null);
      _onGameOver();
    }
  });

  $('btn-resign')?.addEventListener('click', () => {
    if (state.gameOverFlag) return;
    // Removed confirm() for testing / fix if it was blocking
    stopClock();
    stopSearch();
    const winner = state.playerColor === 'white' ? 'b' : 'w';
    setGameOver('resign', winner);
    _onGameOver();
  });

  // Move log navigation — handled by analysis.js initAnalysis()
  // (buttons are wired there to avoid duplicate listeners)
}

// ════════════════════════════════════════════════════════
// BOARD CLICK HANDLING
// ════════════════════════════════════════════════════════

function _bindBoardClicks() {
  const boardEl = $('chess-board');
  if (!boardEl) return;

  boardEl.addEventListener('click', e => {
    // In analysis/review mode, clicks do nothing on the board
    if (state.analysisMode) return;
    // Game already over — ignore
    if (state.gameOverFlag) return;
    // Not player's turn (AI is thinking) — ignore
    if (!isPlayerTurn()) return;

    const sqEl = e.target.closest('.square');
    if (!sqEl) return;

    const clickedSquare = sqEl.dataset.square;
    _handleSquareClick(clickedSquare);
  });
}

/**
 * _handleSquareClick()
 * ─────────────────────
 * Two-click interaction model:
 *   • First click  → select a piece (if it belongs to the player)
 *   • Second click → attempt a move to the clicked square,
 *                    OR re-select if another friendly piece was clicked
 */
function _handleSquareClick(square) {
  const { selectedSquare } = state;

  // ── Case 1: No piece currently selected ──────────────
  if (!selectedSquare) {
    _trySelectSquare(square);
    return;
  }

  // ── Case 2: Clicked the same square → deselect ──────
  if (square === selectedSquare) {
    _clearSelection();
    return;
  }

  // ── Case 3: Clicked a legal target square → move ─────
  if (state.legalMovesForSelected.includes(square)) {
    _attemptMove(selectedSquare, square);
    return;
  }

  // ── Case 4: Clicked another friendly piece → re-select
  const piece = getPieceAt(square);
  const playerColorChar = state.playerColor === 'white' ? 'w' : 'b';
  if (piece && piece.color === playerColorChar) {
    _trySelectSquare(square);
    return;
  }

  // ── Case 5: Clicked empty / enemy non-target → deselect
  _clearSelection();
}

/**
 * Selects a square if it has a piece belonging to the current player.
 */
function _trySelectSquare(square) {
  const piece = getPieceAt(square);
  const playerColorChar = state.playerColor === 'white' ? 'w' : 'b';

  if (!piece || piece.color !== playerColorChar) {
    _clearSelection();
    return;
  }

  // Must also be the current turn
  if (state.turn !== playerColorChar) {
    _clearSelection();
    return;
  }

  const legalTargets = getLegalMovesForSquare(square);
  state.selectedSquare        = square;
  state.legalMovesForSelected = legalTargets;
  renderHighlights();
}

/**
 * Clears the current piece selection.
 */
function _clearSelection() {
  state.selectedSquare        = null;
  state.legalMovesForSelected = [];
  renderHighlights();
}

// ════════════════════════════════════════════════════════
// MOVE EXECUTION
// ════════════════════════════════════════════════════════

/**
 * _attemptMove()
 * ──────────────
 * Called when the player clicks a legal destination square.
 * Handles pawn promotion detection before committing.
 *
 * @param {string} from - e.g. 'e2'
 * @param {string} to   - e.g. 'e4'
 */
function _attemptMove(from, to) {
  _clearSelection();

  // ── Pawn promotion detection ─────────────────────────
  if (_isPromotion(from, to)) {
    _pendingPromotion = { from, to };
    _showPromotionModal();
    return;
  }

  _commitMove({ from, to });
}

/**
 * _commitMove()
 * ─────────────
 * Passes the move to engine.js, then updates all visual layers.
 * After the human move, triggers the AI response.
 *
 * @param {{ from:string, to:string, promotion?:string }} moveObj
 */
function _commitMove(moveObj) {
  const result = makeMove(moveObj);

  if (!result.ok) {
    renderStatus('ILLEGAL MOVE — TRY AGAIN');
    return;
  }

  // Switch the clock to the opponent's side
  switchClock();

  // Re-render board visuals
  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderCapturedPieces();
  renderClocks();
  renderStatus();

  // Check for game over after human move
  if (state.gameOverFlag) {
    stopClock();
    _onGameOver();
    return;
  }

  // Hand off to AI
  _triggerAIMove();
}

// ════════════════════════════════════════════════════════
// AI MOVE TRIGGER
// ════════════════════════════════════════════════════════

/**
 * _triggerAIMove()
 * ─────────────────
 * Asks the AI to find the best move. Prefers the Stockfish worker
 * (via ai.js) when available; falls back to the weighted random AI
 * while Stockfish is still loading.
 */
function _triggerAIMove() {
  if (state.gameOverFlag) return;

  // ai.js registers window.__stockfishWorker once the worker is ready.
  // _sfTrigger() handles movetime mapping internally.
  if (window.__stockfishWorker) {
    _sfTrigger();
    return;
  }

  // ── Fallback: difficulty-weighted random AI ──────────
  renderStatus('ENGINE IS THINKING…');
  setTimeout(() => {
    const move = _fallbackAI();
    if (move) {
      makeMove(move);
      renderPieces();
      renderHighlights();
      renderMoveLog();
      renderCapturedPieces();
      renderClocks();
      renderStatus();
      if (state.gameOverFlag) { _stopClock(); _onGameOver(); }
    }
  }, _thinkDelay());
}

/**
 * Called by the Stockfish worker (Step 5) with the chosen move.
 * Exposed on window so the worker callback can reach it.
 * @param {string} uciMove - e.g. 'e2e4'
 */
export function onAIMove(uciMove) {
  if (state.gameOverFlag) return;

  makeMove(uciMove);

  // Switch clock back to the player's side
  switchClock();

  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderCapturedPieces();
  renderClocks();
  renderStatus();

  if (state.gameOverFlag) {
    stopClock();
    _onGameOver();
  }
}

// Make accessible globally for worker callback
window.onAIMove = onAIMove;

// ── Fallback difficulty-weighted AI ──────────────────
/**
 * Picks a move using a simple heuristic weighted by difficulty:
 *   Easy   → pure random
 *   Medium → prefer captures over random moves
 *   Hard   → prefer checking moves, then captures, then random
 * @returns {Object} chess.js verbose move object
 */
function _fallbackAI() {
  const moves = getAllLegalMoves();  // imported from engine.js
  if (!moves.length) return null;

  if (state.difficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const captures = moves.filter(m => m.flags.includes('c') || m.flags.includes('e'));
  const checks   = moves.filter(m => m.san.includes('+'));

  if (state.difficulty === 'hard' && checks.length) {
    return checks[Math.floor(Math.random() * checks.length)];
  }
  if (captures.length) {
    return captures[Math.floor(Math.random() * captures.length)];
  }
  return moves[Math.floor(Math.random() * moves.length)];
}

/** Returns a simulated think delay (ms) based on difficulty. */
function _thinkDelay() {
  return { easy: 300, medium: 600, hard: 900 }[state.difficulty] ?? 600;
}

// ════════════════════════════════════════════════════════
// PAWN PROMOTION
// ════════════════════════════════════════════════════════

function _isPromotion(from, to) {
  const piece = getPieceAt(from);
  if (!piece || piece.type !== 'p') return false;
  const toRank = Number(to[1]);
  return (piece.color === 'w' && toRank === 8) ||
         (piece.color === 'b' && toRank === 1);
}

function _showPromotionModal() {
  const modal = $('promotion-modal');
  if (!modal) return;

  // Tint promotion pieces to match player color
  const isWhite = state.playerColor === 'white';
  $('promo-queen').textContent  = isWhite ? '♕' : '♛';
  $('promo-rook').textContent   = isWhite ? '♖' : '♜';
  $('promo-bishop').textContent = isWhite ? '♗' : '♝';
  $('promo-knight').textContent = isWhite ? '♘' : '♞';

  modal.classList.remove('hidden');
}

function _bindPromotionModal() {
  $('promotion-choices')?.addEventListener('click', e => {
    const btn = e.target.closest('.promo-btn');
    if (!btn || !_pendingPromotion) return;

    const promotion = btn.dataset.piece;  // 'q','r','b','n'
    $('promotion-modal').classList.add('hidden');

    _commitMove({ ..._pendingPromotion, promotion });
    _pendingPromotion = null;
  });
}

// ════════════════════════════════════════════════════════
// MOVE LOG — ANALYSIS NAVIGATION
// ════════════════════════════════════════════════════════

function _bindMoveLogClicks() {
  $('move-log-scroll')?.addEventListener('click', e => {
    if (!state.analysisMode) return;
    const cell = e.target.closest('.move-log-cell');
    if (!cell || cell.dataset.moveIndex === undefined) return;

    const idx = Number(cell.dataset.moveIndex);
    _loadReviewPosition(idx);
  });
}

function _navigateReview(direction) {
  if (!state.analysisMode) {
    // Enter analysis mode first
    setAnalysisMode(true);
    $('btn-analysis-mode')?.classList.add('active');
  }

  const len = state.moveHistory.length;
  if (!len) return;

  let idx = state.currentReviewIndex;

  switch (direction) {
    case 'start': idx = 0;       break;
    case 'prev':  idx = Math.max(0, idx - 1); break;
    case 'next':  idx = Math.min(len - 1, idx + 1); break;
    case 'end':   idx = len - 1; break;
  }

  _loadReviewPosition(idx);
}

/**
 * Loads a historical FEN from moveHistory and re-renders without
 * changing the authoritative game state.
 * @param {number} idx - Index into state.moveHistory
 */
function _loadReviewPosition(idx) {
  const fen = state.moveHistory[idx];
  if (!fen) return;

  state.currentReviewIndex = idx;
  loadFEN(fen);

  // Reconstruct lastMove from sanHistory for highlight
  if (idx >= 0 && state.sanHistory[idx]) {
    // We don't store from/to in sanHistory, so clear lastMove in review
    state.lastMove = null;
  }

  state.selectedSquare        = null;
  state.legalMovesForSelected = [];

  renderPieces();
  renderHighlights();
  renderMoveLog();
  renderStatus();
}

// ════════════════════════════════════════════════════════
// CLOCK
// ════════════════════════════════════════════════════════

function _startClock() {
  _stopClock();
  if (!isTimed()) return;

  _clockInterval = setInterval(() => {
    if (state.gameOverFlag) { _stopClock(); return; }

    const key = state.turn === 'w' ? 'remainingTimeWhite' : 'remainingTimeBlack';
    state[key] = Math.max(0, state[key] - 1);

    renderClocks();

    if (state[key] === 0) {
      _stopClock();
      const winner = state.turn === 'w' ? 'b' : 'w';
      setGameOver('timeout', winner);
      _onGameOver();
    }
  }, 1000);
}

function _stopClock() {
  if (_clockInterval) {
    clearInterval(_clockInterval);
    _clockInterval = null;
  }
}

// ════════════════════════════════════════════════════════
// GAME OVER
// ════════════════════════════════════════════════════════

function _onGameOver() {
  stopClock();
  stopSearch();
  state.selectedSquare        = null;
  state.legalMovesForSelected = [];
  clearArrows();
  renderHighlights();
  renderStatus();
  renderGameResult();
  renderClocks();
  // Show the full-screen game-over overlay
  showGameOverOverlay();
}

// ════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════

function _bindKeyboard() {
  document.addEventListener('keydown', e => {
    // Escape → deselect / close promotion modal
    if (e.key === 'Escape') {
      if (!$('promotion-modal').classList.contains('hidden')) {
        $('promotion-modal').classList.add('hidden');
        _pendingPromotion = null;
      } else {
        _clearSelection();
      }
    }
    // F → flip board
    if (e.key === 'f' || e.key === 'F') {
      state.boardFlipped = !state.boardFlipped;
      renderBoard();
    }
    // Arrow-key navigation is handled by analysis.js
  });
}
