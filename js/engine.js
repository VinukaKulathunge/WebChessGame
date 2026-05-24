/**
 * engine.js — Chess rule engine for Brutal Chess.
 *
 * This module wraps the chess.js library (loaded globally via CDN as `window.Chess`)
 * and acts as the single interface for all chess-rule operations:
 *   - Game initialisation / FEN loading
 *   - Move validation & execution
 *   - Legal move enumeration
 *   - Game-status queries (check, checkmate, stalemate, draw variants)
 *   - State synchronisation back to state.js
 *
 * NO rendering or UI code belongs here.
 */

import {
  state,
  recordMove,
  setGameOver,
  isTimed,
} from './state.js';

// ── INTERNAL CHESS.JS INSTANCE ────────────────────────
// chess.js 0.10.x is loaded as a UMD global `Chess` by the CDN <script> tag
// in index.html before any ES6 modules are evaluated.

/** @type {Chess} — the authoritative chess.js game object */
let _chess = null;

// ── PIECE MAP ─────────────────────────────────────────
// chess.js uses lowercase type chars ('p','n','b','r','q','k') and
// color chars ('w','b').  We encode board cells as e.g. 'wP', 'bK'
// for use in state.board so the renderer has a simple, consistent token.

const TYPE_TO_UPPER = { p:'P', n:'N', b:'B', r:'R', q:'Q', k:'K' };

// ════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════

/**
 * initEngine()
 * ─────────────
 * Creates a fresh chess.js instance from the starting position (or an
 * optional FEN) and synchronises the full board snapshot into state.
 *
 * Call this once after initState() at game-start, and again after any
 * load/reset operation.
 *
 * @param {string} [fen] - Optional FEN string to load. Defaults to start position.
 * @returns {void}
 */
export function initEngine(fen) {
  if (typeof Chess === 'undefined') {
    throw new Error('[engine] chess.js not found. Ensure the CDN <script> tag is loaded before main.js.');
  }

  _chess = fen ? new Chess(fen) : new Chess();

  // Hydrate state.board from the freshly created chess instance
  _syncBoardToState();

  // Capture turn, castling rights, en-passant from the chess.js instance
  _syncMetaToState();
}

// ─────────────────────────────────────────────────────

/**
 * makeMove()
 * ──────────
 * Validates and executes a move. Accepts:
 *   • SAN strings        → 'e4', 'Nf3', 'O-O', 'e8=Q'
 *   • UCI strings        → 'e2e4', 'g1f3', 'e7e8q'
 *   • chess.js move obj  → { from:'e2', to:'e4', promotion:'q' }
 *
 * If the move is legal:
 *   1. chess.js applies it internally.
 *   2. state.board, state.turn, etc. are updated.
 *   3. The resulting FEN and SAN are pushed to state.moveHistory / sanHistory.
 *   4. Captured pieces are recorded.
 *   5. Game-over conditions are checked and state.gameOverFlag is set if needed.
 *
 * @param {string|Object} move - The move to attempt.
 * @returns {{ ok: boolean, san: string|null, captured: string|null, flags: string|null }}
 *   ok      — whether the move was legal and applied
 *   san     — the SAN string for the applied move (e.g. 'Nxf7+')
 *   captured— the piece type captured ('p','n','b','r','q') or null
 *   flags   — chess.js flags string (e.g. 'n' normal, 'c' capture, 'e' en-passant, etc.)
 */
export function makeMove(move) {
  _assertReady();

  // ── Normalise UCI string → chess.js move object ──────
  // chess.js 0.10 accepts { from, to, promotion } objects but NOT raw UCI strings.
  const moveArg = _normaliseMove(move);

  // ── Attempt the move ─────────────────────────────────
  const result = _chess.move(moveArg);

  if (!result) {
    // Illegal move — chess.js returns null
    return { ok: false, san: null, captured: null, flags: null };
  }

  // ── Record captured piece in state ───────────────────
  if (result.captured) {
    // The side that moved captured an enemy piece.
    // result.color is the moving side ('w'|'b').
    state.capturedPieces[result.color].push(result.captured);
  }

  // ── Update state.lastMove ────────────────────────────
  state.lastMove = { from: result.from, to: result.to };

  // ── Sync board snapshot & meta fields ────────────────
  _syncBoardToState();
  _syncMetaToState();

  // ── Record FEN + SAN in history arrays ───────────────
  recordMove(_chess.fen(), result.san);

  // ── Check for game-over conditions ───────────────────
  _checkAndSetGameOver();

  return {
    ok:       true,
    san:      result.san,
    captured: result.captured || null,
    flags:    result.flags,
  };
}

// ─────────────────────────────────────────────────────

/**
 * getLegalMovesForSquare()
 * ─────────────────────────
 * Returns all legal destination squares for the piece on a given square.
 * Used by the renderer to highlight valid targets when a piece is selected.
 *
 * @param {string} square - Algebraic square, e.g. 'e2'.
 * @returns {string[]} Array of destination squares, e.g. ['e3','e4'].
 */
export function getLegalMovesForSquare(square) {
  _assertReady();
  // chess.js returns full move objects; we extract only the 'to' field.
  return _chess.moves({ square, verbose: true }).map(m => m.to);
}

// ─────────────────────────────────────────────────────

/**
 * getAllLegalMoves()
 * ──────────────────
 * Returns every legal move available in the current position as verbose
 * chess.js move objects.  Useful for the AI to enumerate candidates.
 *
 * @returns {Object[]} Array of chess.js verbose move objects.
 */
export function getAllLegalMoves() {
  _assertReady();
  return _chess.moves({ verbose: true });
}

// ─────────────────────────────────────────────────────

/**
 * getLegalMovesVerboseForSquare()
 * ────────────────────────────────
 * Like getLegalMovesForSquare() but returns the full chess.js verbose
 * move objects (includes flags, promotion, captured piece type, etc.).
 *
 * @param {string} square
 * @returns {Object[]}
 */
export function getLegalMovesVerboseForSquare(square) {
  _assertReady();
  return _chess.moves({ square, verbose: true });
}

// ─────────────────────────────────────────────────────

/**
 * getStatus()
 * ───────────
 * Returns a snapshot of the current game-status booleans.
 * All values are derived live from the chess.js instance so they are
 * always accurate, regardless of state.js fields.
 *
 * @returns {{
 *   isCheck:         boolean,
 *   isCheckmate:     boolean,
 *   isStalemate:     boolean,
 *   isDraw:          boolean,
 *   isInsufficientMaterial: boolean,
 *   isThreefoldRepetition:  boolean,
 *   isFiftyMoveRule:        boolean,
 *   isGameOver:      boolean,
 * }}
 */
export function getStatus() {
  _assertReady();
  const isCheckmate            = _chess.in_checkmate();
  const isStalemate            = _chess.in_stalemate();
  const isInsufficientMaterial = _chess.insufficient_material();
  const isThreefoldRepetition  = _chess.in_threefold_repetition();
  const isFiftyMoveRule        = _chess.in_draw() &&
                                  !isStalemate &&
                                  !isInsufficientMaterial &&
                                  !isThreefoldRepetition;
  const isDraw = isStalemate || isInsufficientMaterial || isThreefoldRepetition || isFiftyMoveRule;
  const isGameOver = isCheckmate || isDraw;

  return {
    isCheck:                _chess.in_check(),
    isCheckmate,
    isStalemate,
    isDraw,
    isInsufficientMaterial,
    isThreefoldRepetition,
    isFiftyMoveRule,
    isGameOver,
  };
}

// ─────────────────────────────────────────────────────

/**
 * getFEN()
 * ─────────
 * Returns the FEN string representing the current board position.
 *
 * @returns {string}
 */
export function getFEN() {
  _assertReady();
  return _chess.fen();
}

// ─────────────────────────────────────────────────────

/**
 * loadFEN()
 * ─────────
 * Loads a specific FEN into the engine and syncs state.
 * Used by analysis / review mode when navigating move history.
 *
 * @param {string} fen
 * @returns {boolean} true if FEN was valid and loaded successfully.
 */
export function loadFEN(fen) {
  _assertReady();
  const ok = _chess.load(fen);
  if (ok) {
    _syncBoardToState();
    _syncMetaToState();
  }
  return ok;
}

// ─────────────────────────────────────────────────────

/**
 * undoLastMove()
 * ──────────────
 * Undoes the most recent half-move in the chess.js instance and syncs
 * state accordingly.  Returns the undone move object, or null if there
 * was nothing to undo.
 *
 * @returns {Object|null}
 */
export function undoLastMove() {
  _assertReady();
  const undone = _chess.undo();
  if (undone) {
    _syncBoardToState();
    _syncMetaToState();
  }
  return undone || null;
}

// ─────────────────────────────────────────────────────

/**
 * getPieceAt()
 * ─────────────
 * Returns the piece object at a square, or null if empty.
 * Returns chess.js format: { type: 'p', color: 'w' } etc.
 *
 * @param {string} square - e.g. 'e4'
 * @returns {{ type: string, color: string }|null}
 */
export function getPieceAt(square) {
  _assertReady();
  return _chess.get(square);
}

// ─────────────────────────────────────────────────────

/**
 * isSquareAttacked()
 * ───────────────────
 * Returns true if the given square is attacked by any piece of the
 * given color.  Useful for UI highlighting of threatened squares.
 *
 * @param {string}   square
 * @param {'w'|'b'} byColor
 * @returns {boolean}
 */
export function isSquareAttacked(square, byColor) {
  _assertReady();
  return _chess.attacks(square, byColor) ?? false;
}

// ─────────────────────────────────────────────────────

/**
 * getKingSquare()
 * ───────────────
 * Finds and returns the square of the king of the given color.
 * Used for rendering the in-check highlight.
 *
 * @param {'w'|'b'} color
 * @returns {string|null} Algebraic square or null (should never be null in a legal position).
 */
export function getKingSquare(color) {
  _assertReady();
  // chess.js 0.10 doesn't expose a direct kingSquare() API,
  // so we iterate the board to find it.
  const board = _chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell && cell.type === 'k' && cell.color === color) {
        // chess.js board() is rank-8-first; convert back to algebraic.
        const file = String.fromCharCode(97 + c); // 'a'..'h'
        const rank = 8 - r;                        // 8..1
        return `${file}${rank}`;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════

/**
 * Throws if the chess.js instance has not been initialised yet.
 */
function _assertReady() {
  if (!_chess) {
    throw new Error('[engine] Engine not initialised. Call initEngine() first.');
  }
}

// ─────────────────────────────────────────────────────

/**
 * _normaliseMove()
 * ─────────────────
 * Converts any accepted move format into the object shape that
 * chess.js 0.10's .move() method understands.
 *
 * chess.js .move() accepts:
 *   • A SAN string  →  'e4', 'Nxf7+', 'O-O-O'
 *   • An object     →  { from: 'e2', to: 'e4', promotion: 'q' }
 *
 * UCI strings ('e2e4', 'e7e8q') are NOT natively supported, so we
 * parse them here.
 *
 * @param {string|Object} move
 * @returns {string|Object}
 */
function _normaliseMove(move) {
  if (typeof move === 'object') return move; // already a move object

  // Detect UCI format: 4 chars (e.g. 'e2e4') or 5 chars with promotion (e.g. 'e7e8q')
  const uciRegex = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN]?)$/;
  const match = move.match(uciRegex);

  if (match) {
    const obj = { from: match[1], to: match[2] };
    if (match[3]) obj.promotion = match[3].toLowerCase();
    return obj;
  }

  // Assume SAN string (e.g. 'e4', 'Nf3', 'O-O')
  return move;
}

// ─────────────────────────────────────────────────────

/**
 * _syncBoardToState()
 * ────────────────────
 * Reads the chess.js internal board and writes a clean 8×8 snapshot
 * into state.board.  Each cell is either an empty string '' or a
 * two-character token like 'wP', 'bN', 'wK', etc.
 *
 * chess.js .board() returns an 8-element array of 8-element arrays,
 * starting from rank 8 (index 0) down to rank 1 (index 7).
 */
function _syncBoardToState() {
  const raw = _chess.board(); // rank-8-first 2D array

  state.board = raw.map(rank =>
    rank.map(cell => {
      if (!cell) return '';
      return cell.color + TYPE_TO_UPPER[cell.type]; // e.g. 'wP', 'bK'
    })
  );
}

// ─────────────────────────────────────────────────────

/**
 * _syncMetaToState()
 * ───────────────────
 * Syncs turn, castling rights, and en-passant square from the chess.js
 * instance into state.  We parse these from the FEN for reliability
 * since chess.js 0.10 doesn't expose direct accessors for all of them.
 */
function _syncMetaToState() {
  const fenParts = _chess.fen().split(' ');

  // Active color — field index 1
  state.turn = fenParts[1]; // 'w' or 'b'

  // Castling rights — field index 2, e.g. 'KQkq', '-'
  const castling = fenParts[2];
  state.castlingRights = {
    w: { k: castling.includes('K'), q: castling.includes('Q') },
    b: { k: castling.includes('k'), q: castling.includes('q') },
  };

  // En-passant square — field index 3, e.g. 'e3' or '-'
  const ep = fenParts[3];
  state.enPassantSquare = ep === '-' ? null : ep;
}

// ─────────────────────────────────────────────────────

/**
 * _checkAndSetGameOver()
 * ───────────────────────
 * Inspects the current position for any terminal condition and, if found,
 * calls setGameOver() to update state.gameOverFlag, reason, and winner.
 *
 * Called automatically at the end of every successful makeMove().
 */
function _checkAndSetGameOver() {
  if (_chess.in_checkmate()) {
    // The side that just moved wins; the current state.turn is the loser.
    const winner = state.turn === 'w' ? 'b' : 'w';
    setGameOver('checkmate', winner);
    return;
  }

  if (_chess.in_stalemate()) {
    setGameOver('stalemate', null);
    return;
  }

  if (_chess.insufficient_material()) {
    setGameOver('insufficient_material', null);
    return;
  }

  if (_chess.in_threefold_repetition()) {
    setGameOver('threefold_repetition', null);
    return;
  }

  // 50-move rule — chess.js in_draw() covers this when the above are false
  if (_chess.in_draw()) {
    setGameOver('fifty_move_rule', null);
  }
}
