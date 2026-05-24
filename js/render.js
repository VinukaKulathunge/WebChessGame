/**
 * render.js — DOM rendering layer for Brutal Chess.
 *
 * Reads from state.js, engine.js, and arrows.js; writes ONLY to the DOM.
 * Contains zero game logic. Every public function is a pure
 * "state → DOM" projection that can be called at any time.
 *
 * Public API:
 *   renderBoard()          – Full board rebuild (call on game-start / flip)
 *   renderPieces()         – Redraw piece elements only
 *   renderHighlights()     – Selected sq, legal moves, last move, check
 *   renderMoveLog()        – Algebraic move log in the right sidebar
 *   renderCapturedPieces() – Captured-piece trays under each player bar
 *   renderClocks()         – Clock displays (static render; ticking in timer.js)
 *   renderStatus(text)     – Status bar message
 *   renderEvalBar(cp, isMate, mateIn) – Smooth gradient eval bar
 *   renderEngineLines(arr) – Top-3 MultiPV engine line rows
 *   renderGameResult()     – Shows the result overlay panel
 *   renderPlayerNames()    – Sets player name labels from state
 */

import { state } from './state.js';
import { getKingSquare, getStatus } from './engine.js';
import { clearArrows, resizeCanvas } from './arrows.js';

// ── PIECE UNICODE MAP ─────────────────────────────────
// Keyed as state.board tokens: 'wP', 'bK', etc.
// Using the filled Unicode chess set for maximum clarity at small sizes.
const PIECE_UNICODE = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

// Piece display order for captured-piece tray (least → most valuable)
const CAPTURE_ORDER = ['P','N','B','R','Q'];

// ── DOM ELEMENT CACHE ─────────────────────────────────
const $ = id => document.getElementById(id);
const board       = () => $('chess-board');
const evalFill    = () => $('eval-bar-fill');
const evalScore   = () => $('eval-score');
const statusText  = () => $('status-text');
const moveLog     = () => $('move-log-scroll');
const engineList  = () => $('engine-lines-list');
const depthBadge  = () => $('engine-depth-badge');
const resultPanel = () => $('result-panel');
const resultTitle = () => $('result-title');
const resultDetail= () => $('result-detail');
const clockW      = () => $('clock-white');
const clockB      = () => $('clock-black');
const capW        = () => $('captured-by-white');
const capB        = () => $('captured-by-black');

// ════════════════════════════════════════════════════════
// BOARD & PIECES
// ════════════════════════════════════════════════════════

/**
 * renderBoard()
 * ─────────────
 * Clears and fully rebuilds the 8×8 square grid inside #chess-board.
 * Respects state.boardFlipped: when true the board is drawn with rank 1
 * at the top so Black plays from the bottom.
 *
 * Each square gets:
 *   • id="sq-{file}{rank}"  e.g. sq-e4
 *   • data-square="{file}{rank}"
 *   • classes: square light|dark
 *   • a child .piece span if a piece occupies the square
 *
 * Also re-renders coordinates and applies all highlights.
 */
export function renderBoard() {
  const el = board();
  if (!el) return;
  el.innerHTML = '';

  clearArrows();   // wipe bestmove arrow on board rebuild / flip

  const flipped = state.boardFlipped;

  // Ranks: top of screen → bottom of screen
  const ranks = flipped
    ? [1, 2, 3, 4, 5, 6, 7, 8]          // flipped: rank 1 at top
    : [8, 7, 6, 5, 4, 3, 2, 1];          // normal:  rank 8 at top

  // Files: left → right
  const files = flipped
    ? ['h','g','f','e','d','c','b','a']   // flipped: h on left
    : ['a','b','c','d','e','f','g','h'];  // normal:  a on left

  for (const rank of ranks) {
    for (const file of files) {
      const sq = document.createElement('div');
      const squareName = `${file}${rank}`;

      // Light square when file+rank parity matches (a1 is dark)
      const fileIdx = file.charCodeAt(0) - 97; // 0–7
      const isLight = (fileIdx + rank) % 2 !== 0;

      sq.className  = `square ${isLight ? 'light' : 'dark'}`;
      sq.id         = `sq-${squareName}`;
      sq.dataset.square = squareName;
      sq.setAttribute('role', 'gridcell');
      sq.setAttribute('aria-label', squareName);

      // Place piece if present
      const piece = _pieceAt(file, rank);
      if (piece) {
        sq.appendChild(_makePieceEl(piece));
        sq.dataset.piece = piece;
      }

      el.appendChild(sq);
    }
  }

  _renderCoordinates(files, ranks);
  renderHighlights();

  // Re-sync canvas size after board DOM is rebuilt
  requestAnimationFrame(resizeCanvas);
}

/**
 * renderPieces()
 * ──────────────
 * Refreshes only the piece elements without rebuilding squares.
 * Faster than a full renderBoard() — use after a move is made.
 */
export function renderPieces() {
  const el = board();
  if (!el) return;

  clearArrows();   // clear bestmove arrow whenever pieces move

  el.querySelectorAll('.square').forEach(sq => {
    const squareName = sq.dataset.square;
    const existing = sq.querySelector('.piece');
    if (existing) existing.remove();
    delete sq.dataset.piece;

    const [file, rank] = [squareName[0], Number(squareName[1])];
    const piece = _pieceAt(file, rank);
    if (piece) {
      sq.appendChild(_makePieceEl(piece));
      sq.dataset.piece = piece;
    }
  });
}

// ════════════════════════════════════════════════════════
// HIGHLIGHTS
// ════════════════════════════════════════════════════════

/**
 * renderHighlights()
 * ───────────────────
 * Clears all highlight classes then re-applies:
 *   • .highlighted   — the currently selected square
 *   • .legal-move    — squares where the selected piece can legally go
 *   • .has-piece     — added to legal-move squares that contain an enemy piece
 *   • .last-move     — from/to squares of the most recent move
 *   • .in-check      — the king's square when that king is in check
 */
export function renderHighlights() {
  // Clear all highlight classes from every square
  document.querySelectorAll('.square').forEach(sq => {
    sq.classList.remove('highlighted', 'legal-move', 'has-piece', 'last-move', 'in-check', 'selected');
  });

  // Last move (applied first so it sits beneath selection)
  if (state.lastMove) {
    _addClassToSquare(state.lastMove.from, 'last-move');
    _addClassToSquare(state.lastMove.to,   'last-move');
  }

  // Selected square + legal moves for that piece
  if (state.selectedSquare) {
    _addClassToSquare(state.selectedSquare, 'highlighted', 'selected');

    for (const target of state.legalMovesForSelected) {
      const sq = _squareEl(target);
      if (!sq) continue;
      sq.classList.add('legal-move');
      if (sq.dataset.piece) sq.classList.add('has-piece');
    }
  }

  // In-check highlight
  _applyCheckHighlight();
}

// ════════════════════════════════════════════════════════
// MOVE LOG
// ════════════════════════════════════════════════════════

/**
 * renderMoveLog()
 * ────────────────
 * Rebuilds the scrollable algebraic move log from state.sanHistory.
 * Moves are grouped in pairs (White / Black per row).
 * The move at state.currentReviewIndex is highlighted as current.
 */
export function renderMoveLog() {
  const container = moveLog();
  if (!container) return;
  container.innerHTML = '';

  const sans = state.sanHistory;
  if (!sans.length) {
    container.innerHTML = '<div class="move-log-empty">No moves yet.</div>';
    return;
  }

  // currentReviewIndex: -1 = live end, else index into sanHistory (0-based)
  const liveIndex = state.analysisMode ? state.currentReviewIndex : sans.length - 1;

  for (let i = 0; i < sans.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'move-log-row';

    // Move number label
    const numEl = document.createElement('span');
    numEl.className = 'move-log-num';
    numEl.textContent = `${Math.floor(i / 2) + 1}.`;
    row.appendChild(numEl);

    // White's move (half-move index i)
    row.appendChild(_makeMoveCell(sans[i], i, liveIndex));

    // Black's move (half-move index i+1), may not exist on last move
    if (i + 1 < sans.length) {
      row.appendChild(_makeMoveCell(sans[i + 1], i + 1, liveIndex));
    } else {
      // Empty placeholder so columns stay aligned
      const empty = document.createElement('div');
      empty.className = 'move-log-cell';
      row.appendChild(empty);
    }

    container.appendChild(row);
  }

  // Auto-scroll to bottom (or to current review move)
  _scrollMoveLogToCurrent(container, liveIndex);
}

// ════════════════════════════════════════════════════════
// CAPTURED PIECES
// ════════════════════════════════════════════════════════

/**
 * renderCapturedPieces()
 * ───────────────────────
 * Fills the captured-piece trays below each player bar.
 * state.capturedPieces.w = pieces captured BY white (so displayed under white).
 * Pieces are sorted by value order and rendered as Unicode glyphs.
 */
export function renderCapturedPieces() {
  _renderCapturedTray(capW(), state.capturedPieces.w, 'b'); // white captured black pieces
  _renderCapturedTray(capB(), state.capturedPieces.b, 'w'); // black captured white pieces
}

// ════════════════════════════════════════════════════════
// CLOCKS
// ════════════════════════════════════════════════════════

/**
 * renderClocks()
 * ──────────────
 * Static render of the clock display. The ticking countdown is driven
 * externally (timer.js); this just writes the formatted time and toggles
 * the active-clock / low-time CSS classes.
 */
export function renderClocks() {
  const wEl = clockW();
  const bEl = clockB();
  if (!wEl || !bEl) return;

  const isUnlimited = state.timeControl === 'unlimited';

  wEl.textContent = isUnlimited ? '∞' : _formatTime(state.remainingTimeWhite);
  bEl.textContent = isUnlimited ? '∞' : _formatTime(state.remainingTimeBlack);

  // Active clock highlight
  wEl.classList.toggle('active-clock', state.turn === 'w' && !state.gameOverFlag);
  bEl.classList.toggle('active-clock', state.turn === 'b' && !state.gameOverFlag);

  // Low-time warning (under 30 seconds)
  if (!isUnlimited) {
    wEl.classList.toggle('low-time', state.remainingTimeWhite !== null && state.remainingTimeWhite <= 30);
    bEl.classList.toggle('low-time', state.remainingTimeBlack !== null && state.remainingTimeBlack <= 30);
  }
}

// ════════════════════════════════════════════════════════
// STATUS BAR
// ════════════════════════════════════════════════════════

/**
 * renderStatus(text)
 * ───────────────────
 * Sets the status bar message. Passing no argument auto-computes a
 * context-aware message from state (e.g. "WHITE TO MOVE", "CHECK!").
 *
 * @param {string} [text]
 */
export function renderStatus(text) {
  const el = statusText();
  if (!el) return;

  if (text !== undefined) {
    el.textContent = text;
    return;
  }

  // Auto-compute from state
  if (state.gameOverFlag) {
    el.textContent = _gameOverStatusText();
    return;
  }

  if (state.analysisMode) {
    const idx = state.currentReviewIndex;
    el.textContent = idx < 0 ? 'ANALYSIS MODE' : `MOVE ${idx + 1} OF ${state.sanHistory.length}`;
    return;
  }

  // Live game
  const turnLabel = state.turn === 'w' ? 'WHITE' : 'BLACK';
  const status    = getStatus();
  if (status.isCheck) {
    el.textContent = `${turnLabel} IS IN CHECK!`;
  } else {
    el.textContent = `${turnLabel} TO MOVE`;
  }
}

// ════════════════════════════════════════════════════════
// EVALUATION BAR
// ════════════════════════════════════════════════════════

/**
 * renderEvalBar(cp, isMate, mateIn)
 * ───────────────────────────────────
 * Updates the evaluation bar with a smooth gradient fill.
 *   cp     — centipawn score (positive = White better)
 *   isMate — if true, show mate indicator instead of cp
 *   mateIn — number of moves to mate (sign indicates who mates)
 *
 * Special values:
 *   cp ≥ 100000  treated as mate for White
 *   cp ≤ -100000 treated as mate for Black
 *
 * @param {number}  cp
 * @param {boolean} [isMate=false]
 * @param {number}  [mateIn=0]
 */
export function renderEvalBar(cp, isMate = false, mateIn = 0) {
  const fill  = evalFill();
  const score = evalScore();
  const track = fill?.parentElement;
  if (!fill || !score) return;

  // ── Detect mate from large cp values (Stockfish convention) ──
  if (Math.abs(cp) >= 99000) {
    isMate = true;
    mateIn = cp > 0 ? 1 : -1;   // sign tells us who wins
  }

  let pct;
  let label;

  if (isMate) {
    // Push bar to extreme end
    pct   = mateIn > 0 ? 97 : 3;
    const m = Math.abs(mateIn);
    label = mateIn > 0 ? `M${m}` : `-M${m}`;
  } else {
    // Sigmoid-like compression so small advantages look proportional
    // but huge advantages don't just slam to 100%
    const clamped = Math.max(-1200, Math.min(1200, cp));
    // Map ±600 cp to ±40% around centre, then compress beyond that
    const raw = clamped / 600;
    const compressed = raw / (1 + Math.abs(raw) * 0.6);   // soft sigmoid
    pct   = 50 + compressed * 40;
    pct   = Math.max(4, Math.min(96, pct));
    const abs = (Math.abs(cp) / 100).toFixed(2);
    label = cp >= 0 ? `+${abs}` : `-${abs}`;
  }

  fill.style.height = `${pct}%`;

  // Dynamic gradient: cool blue (Black) → warm gold (White)
  track.style.background = [
    'linear-gradient(to bottom,',
    '#0a0a0a 0%,',
    '#1a1a2e 30%,',
    '#2d2d44 50%,',
    '#3d3820 70%,',
    '#f5c842 100%)',
  ].join(' ');

  score.textContent = label;
  score.style.color = cp >= 0 ? '#f5c842' : '#8888cc';
}

// ════════════════════════════════════════════════════════
// ENGINE LINES
// ════════════════════════════════════════════════════════

/**
 * renderEngineLines(lines, depth)
 * ────────────────────────────────
 * Renders top-3 MultiPV engine lines in the right sidebar.
 * Each row shows a coloured score badge and the UCI move sequence.
 *
 * @param {Array<{ score:number, moves:string[], depth:number }>} lines
 * @param {number} [depth] - Search depth to display in badge
 */
export function renderEngineLines(lines, depth) {
  const list  = engineList();
  const badge = depthBadge();
  if (!list) return;

  if (badge && depth !== undefined) {
    badge.textContent = `DEPTH ${depth}`;
  }

  list.innerHTML = '';

  if (!lines || !lines.length) {
    list.innerHTML = '<div class="engine-line-placeholder">Calculating…</div>';
    return;
  }

  lines.forEach((line, idx) => {
    const row = document.createElement('div');
    row.className = 'engine-line';
    row.dataset.lineIndex = idx;
    if (idx === 0) row.classList.add('engine-line-top');

    // ── Rank badge (1 / 2 / 3) ───────────────────────
    const rankEl = document.createElement('span');
    rankEl.className = 'engine-line-rank';
    rankEl.textContent = idx + 1;

    // ── Score chip ───────────────────────────────────
    const scoreEl = document.createElement('span');
    scoreEl.className = 'engine-line-score';
    const isMate = Math.abs(line.score) >= 99000;
    let scoreText;
    if (isMate) {
      const m = Math.ceil((100000 - Math.abs(line.score)) / 1);
      scoreText = line.score > 0 ? `M${m}` : `-M${m}`;
    } else {
      const abs = (Math.abs(line.score) / 100).toFixed(2);
      scoreText = line.score >= 0 ? `+${abs}` : `-${abs}`;
    }
    scoreEl.textContent = scoreText;
    // Colour-code: positive=gold, negative=purple-ish
    scoreEl.style.color = line.score >= 0 ? '#f5c842' : '#9b8abf';

    // ── Move sequence ────────────────────────────────
    const movesEl = document.createElement('span');
    movesEl.className = 'engine-line-moves';
    // Show first 5 UCI moves; trim to keep layout tight
    movesEl.textContent = line.moves.slice(0, 5).join(' ');
    movesEl.title       = line.moves.join(' ');

    row.appendChild(rankEl);
    row.appendChild(scoreEl);
    row.appendChild(movesEl);
    list.appendChild(row);
  });
}

// ════════════════════════════════════════════════════════
// GAME RESULT
// ════════════════════════════════════════════════════════

/**
 * renderGameResult()
 * ───────────────────
 * Shows the result panel with the game outcome when state.gameOverFlag is true.
 */
export function renderGameResult() {
  const panel  = resultPanel();
  const title  = resultTitle();
  const detail = resultDetail();
  if (!panel || !title || !detail) return;

  if (!state.gameOverFlag) {
    panel.classList.add('hidden');
    return;
  }

  const { headline, sub } = _buildResultStrings();
  title.textContent  = headline;
  detail.textContent = sub;
  panel.classList.remove('hidden');
}

// ════════════════════════════════════════════════════════
// PLAYER NAMES
// ════════════════════════════════════════════════════════

/**
 * renderPlayerNames()
 * ────────────────────
 * Sets the name labels above/below the board based on who is playing which color.
 */
export function renderPlayerNames() {
  const nameW = $('player-name-white');
  const nameB = $('player-name-black');
  if (!nameW || !nameB) return;

  if (state.playerColor === 'white') {
    nameW.textContent = 'YOU';
    nameB.textContent = `ENGINE (${state.difficulty.toUpperCase()})`;
  } else {
    nameW.textContent = `ENGINE (${state.difficulty.toUpperCase()})`;
    nameB.textContent = 'YOU';
  }
}

// ════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════

/**
 * Returns the piece token from state.board for a given file/rank.
 * state.board[0] = rank 8, state.board[7] = rank 1.
 * @param {string} file - 'a'..'h'
 * @param {number} rank - 1..8
 * @returns {string} e.g. 'wP' or '' for empty
 */
function _pieceAt(file, rank) {
  const row = 8 - rank;                         // rank 8 → row 0
  const col = file.charCodeAt(0) - 97;          // 'a' → 0
  return (state.board[row] && state.board[row][col]) || '';
}

// ─────────────────────────────────────────────────────

/**
 * Creates a .piece span element for the given piece token.
 * @param {string} piece - e.g. 'wN'
 * @returns {HTMLSpanElement}
 */
function _makePieceEl(piece) {
  const span = document.createElement('span');
  span.className = `piece piece-${piece}`;
  span.textContent = PIECE_UNICODE[piece] || '';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

// ─────────────────────────────────────────────────────

/**
 * Returns the DOM square element for a given algebraic square name.
 * @param {string} sq - e.g. 'e4'
 * @returns {HTMLElement|null}
 */
function _squareEl(sq) {
  return document.getElementById(`sq-${sq}`);
}

// ─────────────────────────────────────────────────────

/**
 * Adds one or more CSS classes to the square element for a given algebraic square.
 * @param {string}    square
 * @param {...string} classes
 */
function _addClassToSquare(square, ...classes) {
  const el = _squareEl(square);
  if (el) el.classList.add(...classes);
}

// ─────────────────────────────────────────────────────

/**
 * Applies the in-check highlight to the king's square if the current
 * side to move is in check.
 */
function _applyCheckHighlight() {
  try {
    const status = getStatus();
    if (status.isCheck) {
      const kingSq = getKingSquare(state.turn);
      if (kingSq) _addClassToSquare(kingSq, 'in-check');
    }
  } catch (_) {
    // engine not yet initialised — skip silently
  }
}

// ─────────────────────────────────────────────────────

/**
 * Renders board coordinate labels (files a–h, ranks 1–8) into their
 * container divs, respecting the current board orientation.
 * @param {string[]} files - ordered left to right
 * @param {number[]} ranks - ordered top to bottom
 */
function _renderCoordinates(files, ranks) {
  const coordsFilesBottom = $('coords-files-bottom');
  const coordsFilesTop    = $('coords-files-top');
  const coordsRanksLeft   = $('coords-ranks-left');
  const coordsRanksRight  = $('coords-ranks-right');

  if (coordsFilesBottom) {
    coordsFilesBottom.innerHTML = files.map(f => `<span>${f}</span>`).join('');
  }
  if (coordsFilesTop) {
    coordsFilesTop.innerHTML = '';   // top coordinates not shown by default
  }
  if (coordsRanksLeft) {
    coordsRanksLeft.innerHTML = ranks.map(r => `<span>${r}</span>`).join('');
  }
  if (coordsRanksRight) {
    coordsRanksRight.innerHTML = '';  // right ranks not shown by default
  }
}

// ─────────────────────────────────────────────────────

/**
 * Creates a single move-log cell element.
 * @param {string} san        - The SAN move string
 * @param {number} index      - Half-move index (0-based)
 * @param {number} liveIndex  - The currently highlighted half-move index
 * @returns {HTMLDivElement}
 */
function _makeMoveCell(san, index, liveIndex) {
  const cell = document.createElement('div');
  cell.className = 'move-log-cell';
  cell.textContent = san;
  cell.dataset.moveIndex = index;
  if (index === liveIndex) cell.classList.add('current-move');
  return cell;
}

// ─────────────────────────────────────────────────────

/**
 * Scrolls the move log so the current move is visible.
 * @param {HTMLElement} container
 * @param {number}      liveIndex
 */
function _scrollMoveLogToCurrent(container, liveIndex) {
  if (liveIndex < 0) {
    container.scrollTop = container.scrollHeight;
    return;
  }
  const currentCell = container.querySelector('.current-move');
  if (currentCell) {
    currentCell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ─────────────────────────────────────────────────────

/**
 * Renders the captured-piece tray for one side.
 * @param {HTMLElement} container  - The tray DOM element
 * @param {string[]}    captures   - Array of piece type chars ('p','n','b','r','q')
 * @param {'w'|'b'}     color      - Color of the CAPTURED pieces
 */
function _renderCapturedTray(container, captures, color) {
  if (!container) return;
  container.innerHTML = '';

  // Sort by value order
  const sorted = [...captures].sort((a, b) =>
    CAPTURE_ORDER.indexOf(a.toUpperCase()) - CAPTURE_ORDER.indexOf(b.toUpperCase())
  );

  sorted.forEach(type => {
    const token = color + type.toUpperCase();  // e.g. 'bP'
    const span  = document.createElement('span');
    span.textContent = PIECE_UNICODE[token] || '';
    span.className   = 'captured-piece';
    container.appendChild(span);
  });
}

// ─────────────────────────────────────────────────────

/**
 * Formats seconds into a MM:SS string.
 * @param {number|null} seconds
 * @returns {string}
 */
function _formatTime(seconds) {
  if (seconds === null || seconds === undefined) return '∞';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────────────

/**
 * Returns the status-bar text for a game-over state.
 * @returns {string}
 */
function _gameOverStatusText() {
  switch (state.gameOverReason) {
    case 'checkmate':             return state.gameWinner === 'w' ? 'CHECKMATE — WHITE WINS' : 'CHECKMATE — BLACK WINS';
    case 'stalemate':             return 'STALEMATE — DRAW';
    case 'insufficient_material': return 'INSUFFICIENT MATERIAL — DRAW';
    case 'threefold_repetition':  return 'THREEFOLD REPETITION — DRAW';
    case 'fifty_move_rule':       return '50-MOVE RULE — DRAW';
    case 'timeout':               return state.gameWinner === 'w' ? 'TIME — WHITE WINS' : 'TIME — BLACK WINS';
    case 'resign':                return state.gameWinner === 'w' ? 'RESIGNED — WHITE WINS' : 'RESIGNED — BLACK WINS';
    case 'draw_agreed':           return 'DRAW AGREED';
    default:                      return 'GAME OVER';
  }
}

// ─────────────────────────────────────────────────────

/**
 * Builds the headline and sub-text strings for the result overlay panel.
 * @returns {{ headline: string, sub: string }}
 */
function _buildResultStrings() {
  const reason = state.gameOverReason;
  const winner = state.gameWinner;

  const DRAW_REASONS = {
    stalemate:             'by Stalemate',
    insufficient_material: 'by Insufficient Material',
    threefold_repetition:  'by Threefold Repetition',
    fifty_move_rule:       'by 50-Move Rule',
    draw_agreed:           'by Agreement',
  };

  if (reason === 'checkmate' || reason === 'timeout' || reason === 'resign') {
    const winnerName = winner === 'w' ? 'White' : 'Black';
    const reasonLabel = reason === 'checkmate' ? 'by Checkmate'
                      : reason === 'timeout'   ? 'on Time'
                      :                          'by Resignation';
    return { headline: `${winnerName.toUpperCase()} WINS`, sub: reasonLabel };
  }

  if (DRAW_REASONS[reason]) {
    return { headline: 'DRAW', sub: DRAW_REASONS[reason] };
  }

  return { headline: 'GAME OVER', sub: '' };
}
