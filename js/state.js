/**
 * state.js — Central single-source-of-truth for Brutal Chess.
 * No rendering or UI logic lives here.
 */

// ── DEFAULT TIME BANKS (seconds) ────────────────────
const TIME_PRESETS = {
  unlimited: null,
  1:  60,
  3:  180,
  5:  300,
  10: 600,
};

// ── RAW STATE OBJECT ─────────────────────────────────
/**
 * @typedef {Object} GameState
 * @property {string[][]} board            - 8x8 array of piece strings (e.g. 'wP','bK') or '' for empty
 * @property {'w'|'b'} turn               - Whose turn it is
 * @property {{ w: {k:boolean,q:boolean}, b: {k:boolean,q:boolean} }} castlingRights
 * @property {string|null} enPassantSquare - Algebraic square (e.g. 'e3') or null
 * @property {string[]} moveHistory        - Array of FEN strings after each half-move
 * @property {string[]} sanHistory         - Array of SAN move strings (e.g. 'e4', 'Nf3')
 * @property {{ w: string[], b: string[] }} capturedPieces - Piece chars grouped by capturing side
 * @property {boolean} gameOverFlag
 * @property {string|null} gameOverReason  - e.g. 'checkmate', 'stalemate', 'timeout', etc.
 * @property {string|null} gameWinner      - 'w', 'b', or null for draw
 * @property {'easy'|'medium'|'hard'} difficulty
 * @property {'white'|'black'|'random'} playerColor
 * @property {'unlimited'|1|3|5|10} timeControl
 * @property {number|null} remainingTimeWhite - seconds remaining, or null if unlimited
 * @property {number|null} remainingTimeBlack - seconds remaining, or null if unlimited
 * @property {boolean} analysisMode        - If true, player can navigate history freely
 * @property {number} currentReviewIndex   - Index into moveHistory when reviewing; -1 = live
 * @property {string|null} selectedSquare  - Currently selected square in algebraic notation
 * @property {string[]} legalMovesForSelected - SAN/UCI move targets for the selected piece
 * @property {{ from: string, to: string }|null} lastMove - Most recent move squares
 * @property {boolean} boardFlipped        - Whether the board is displayed flipped
 * @property {{ score: string, depth: number, lines: string[][] }|null} engineAnalysis
 */

/** @type {GameState} */
export const state = {
  board:                [],
  turn:                 'w',
  castlingRights: {
    w: { k: true, q: true },
    b: { k: true, q: true },
  },
  enPassantSquare:      null,
  moveHistory:          [],   // FEN strings
  sanHistory:           [],   // SAN strings
  capturedPieces:       { w: [], b: [] },
  gameOverFlag:         false,
  gameOverReason:       null,
  gameWinner:           null,
  difficulty:           'medium',
  playerColor:          'white',
  timeControl:          'unlimited',
  remainingTimeWhite:   null,
  remainingTimeBlack:   null,
  analysisMode:         false,
  currentReviewIndex:   -1,
  selectedSquare:       null,
  legalMovesForSelected:[],
  lastMove:             null,
  boardFlipped:         false,
  engineAnalysis:       null,
};

// ── INIT / RESET ─────────────────────────────────────
/**
 * Resets the game state to defaults, then applies user config.
 * Does NOT interact with the UI or chess engine — that is the
 * caller's responsibility after invoking this function.
 *
 * @param {Object} config
 * @param {'white'|'black'|'random'} config.playerColor
 * @param {'easy'|'medium'|'hard'}  config.difficulty
 * @param {'unlimited'|1|3|5|10}    config.timeControl
 */
export function initState(config = {}) {
  const { playerColor = 'white', difficulty = 'medium', timeControl = 'unlimited' } = config;

  // Resolve 'random' color
  const resolvedColor = playerColor === 'random'
    ? (Math.random() < 0.5 ? 'white' : 'black')
    : playerColor;

  // Resolve time banks
  const timeSeconds = TIME_PRESETS[timeControl] ?? null;

  // Reset all fields
  state.board                = [];
  state.turn                 = 'w';
  state.castlingRights       = { w: { k: true, q: true }, b: { k: true, q: true } };
  state.enPassantSquare      = null;
  state.moveHistory          = [];
  state.sanHistory           = [];
  state.capturedPieces       = { w: [], b: [] };
  state.gameOverFlag         = false;
  state.gameOverReason       = null;
  state.gameWinner           = null;
  state.difficulty           = difficulty;
  state.playerColor          = resolvedColor;
  state.timeControl          = timeControl;
  state.remainingTimeWhite   = timeSeconds;
  state.remainingTimeBlack   = timeSeconds;
  state.analysisMode         = false;
  state.currentReviewIndex   = -1;
  state.selectedSquare       = null;
  state.legalMovesForSelected= [];
  state.lastMove             = null;
  state.boardFlipped         = resolvedColor === 'black';
  state.engineAnalysis       = null;
}

// ── HELPERS ──────────────────────────────────────────

/**
 * Returns the color whose turn it currently is.
 * @returns {'white'|'black'}
 */
export function currentTurnFull() {
  return state.turn === 'w' ? 'white' : 'black';
}

/**
 * Returns true if it is currently the human player's turn.
 * @returns {boolean}
 */
export function isPlayerTurn() {
  return currentTurnFull() === state.playerColor;
}

/**
 * Pushes a FEN to moveHistory and records SAN.
 * @param {string} fen
 * @param {string} san
 */
export function recordMove(fen, san) {
  state.moveHistory.push(fen);
  state.sanHistory.push(san);
}

/**
 * Updates remaining time for the given color.
 * @param {'w'|'b'} color
 * @param {number}  seconds
 */
export function setRemainingTime(color, seconds) {
  if (color === 'w') state.remainingTimeWhite = seconds;
  else               state.remainingTimeBlack = seconds;
}

/**
 * Marks game as over with a reason and optional winner.
 * @param {string}      reason  - e.g. 'checkmate'
 * @param {'w'|'b'|null} winner
 */
export function setGameOver(reason, winner = null) {
  state.gameOverFlag   = true;
  state.gameOverReason = reason;
  state.gameWinner     = winner;
}

/**
 * Enters or exits analysis/review mode.
 * @param {boolean} active
 */
export function setAnalysisMode(active) {
  state.analysisMode      = active;
  state.currentReviewIndex = active ? state.moveHistory.length - 1 : -1;
}

/**
 * Returns true if the game is using a timed time control.
 * @returns {boolean}
 */
export function isTimed() {
  return state.timeControl !== 'unlimited';
}
