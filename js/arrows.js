/**
 * arrows.js — Canvas arrow overlay for Brutal Chess.
 *
 * Draws styled vector arrows directly over the chess board to visualise:
 *   • Stockfish bestmove (gold arrow)
 *   • Right-click user annotations (blue arrows) — foundation only
 *
 * The canvas sits as an absolutely-positioned sibling of #chess-board,
 * so it is transparent to mouse events (pointer-events: none in CSS).
 *
 * Public API:
 *   initArrowCanvas()           – Creates / finds the canvas and sets it up.
 *   drawBestMoveArrow(from, to) – Renders a gold bestmove arrow.
 *   clearArrows()               – Wipes all arrows from the canvas.
 *   resizeCanvas()              – Re-syncs canvas size to board dimensions.
 */

import { state } from './state.js';

// ── CANVAS REF ────────────────────────────────────────
let _canvas  = null;   // HTMLCanvasElement
let _ctx     = null;   // CanvasRenderingContext2D

// ── ARROW STYLE TOKENS ────────────────────────────────
const ARROW = {
  bestmove: {
    body:  'rgba(245, 200, 66, 0.82)',   // gold
    head:  'rgba(245, 200, 66, 0.95)',
    glow:  'rgba(245, 200, 66, 0.25)',
    width: 0.11,    // fraction of square size for shaft width
    headW: 0.32,    // fraction of square size for arrowhead width
    headL: 0.38,    // fraction of square size for arrowhead length
  },
  user: {
    body:  'rgba(74, 142, 245, 0.78)',   // blue
    head:  'rgba(74, 142, 245, 0.95)',
    glow:  'rgba(74, 142, 245, 0.20)',
    width: 0.09,
    headW: 0.28,
    headL: 0.34,
  },
};

// ── PENDING ARROWS ────────────────────────────────────
/** @type {Array<{ from:string, to:string, style:string }>} */
let _arrows = [];

// ════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════

/**
 * initArrowCanvas()
 * ─────────────────
 * Creates the canvas element and inserts it as an overlay inside
 * #board-wrapper, positioned absolutely to cover #chess-board exactly.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initArrowCanvas() {
  if (_canvas) return;

  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) { console.warn('[arrows] #board-wrapper not found.'); return; }

  _canvas = document.createElement('canvas');
  _canvas.id = 'arrow-canvas';
  _canvas.setAttribute('aria-hidden', 'true');

  // Position over the board — CSS handles absolute positioning
  _canvas.style.cssText = [
    'position: absolute',
    'top: 0', 'left: 0',
    'width: 100%', 'height: 100%',
    'pointer-events: none',   // clicks pass through to the board below
    'z-index: 10',
  ].join(';');

  // The wrapper must be relatively positioned for this to work
  wrapper.style.position = 'relative';

  wrapper.appendChild(_canvas);
  _ctx = _canvas.getContext('2d');

  resizeCanvas();

  // Keep canvas pixel-perfect on resize / zoom
  window.addEventListener('resize', resizeCanvas);
}

// ─────────────────────────────────────────────────────

/**
 * drawBestMoveArrow(from, to)
 * ────────────────────────────
 * Clears existing arrows and draws a single gold bestmove arrow.
 *
 * @param {string} from - Algebraic square, e.g. 'e2'
 * @param {string} to   - Algebraic square, e.g. 'e4'
 */
export function drawBestMoveArrow(from, to) {
  if (!_canvas || !_ctx) return;
  _arrows = [{ from, to, style: 'bestmove' }];
  _render();
}

// ─────────────────────────────────────────────────────

/**
 * clearArrows()
 * ──────────────
 * Removes all arrows from the canvas.
 * Call whenever a piece is moved or the board is rebuilt.
 */
export function clearArrows() {
  _arrows = [];
  if (_ctx && _canvas) {
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  }
}

// ─────────────────────────────────────────────────────

/**
 * resizeCanvas()
 * ───────────────
 * Syncs the canvas pixel dimensions to the actual rendered board size.
 * Must be called after the board DOM element has its final layout size.
 */
export function resizeCanvas() {
  if (!_canvas) return;

  const board = document.getElementById('chess-board');
  if (!board) return;

  const rect = board.getBoundingClientRect();
  if (rect.width === 0) return;

  // Set physical pixel size (accounts for devicePixelRatio for sharp rendering)
  const dpr = window.devicePixelRatio || 1;
  _canvas.width  = rect.width  * dpr;
  _canvas.height = rect.height * dpr;
  _canvas.style.width  = `${rect.width}px`;
  _canvas.style.height = `${rect.height}px`;

  if (_ctx) {
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Redraw existing arrows at the new size
  _render();
}

// ════════════════════════════════════════════════════════
// PRIVATE — RENDERING
// ════════════════════════════════════════════════════════

/**
 * _render()
 * ─────────
 * Clears the canvas and redraws all arrows in _arrows.
 */
function _render() {
  if (!_ctx || !_canvas) return;

  const W = _canvas.width  / (window.devicePixelRatio || 1);
  const H = _canvas.height / (window.devicePixelRatio || 1);

  _ctx.clearRect(0, 0, W, H);

  for (const arrow of _arrows) {
    _drawArrow(arrow.from, arrow.to, ARROW[arrow.style] ?? ARROW.bestmove);
  }
}

// ─────────────────────────────────────────────────────

/**
 * _drawArrow(from, to, style)
 * ────────────────────────────
 * Draws a single smooth vector arrow from the centre of `from` to the
 * centre of `to`.  The arrowhead is clipped so it fits inside the
 * destination square without overshooting.
 *
 * @param {string} from
 * @param {string} to
 * @param {Object} style  - Token object from ARROW map
 */
function _drawArrow(from, to, style) {
  const board   = document.getElementById('chess-board');
  if (!board) return;

  const rect    = board.getBoundingClientRect();
  const sqSize  = rect.width / 8;

  const [fx, fy] = _squareCenter(from, sqSize);
  const [tx, ty] = _squareCenter(to,   sqSize);

  const dx     = tx - fx;
  const dy     = ty - fy;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) return;

  // Unit vector along arrow direction
  const ux = dx / length;
  const uy = dy / length;

  // Perpendicular unit vector
  const px = -uy;
  const py =  ux;

  const shaftW = sqSize * style.width;
  const headW  = sqSize * style.headW;
  const headL  = sqSize * style.headL;

  // Shorten the shaft so the arrowhead doesn't overshoot
  const shaftEnd = length - headL;

  // ── Glow pass ────────────────────────────────────────
  _ctx.save();
  _ctx.shadowColor = style.glow;
  _ctx.shadowBlur  = sqSize * 0.35;

  // ── Draw shaft ───────────────────────────────────────
  _ctx.beginPath();
  _ctx.moveTo(fx + px * shaftW, fy + py * shaftW);
  _ctx.lineTo(fx + ux * shaftEnd + px * shaftW, fy + uy * shaftEnd + py * shaftW);
  _ctx.lineTo(fx + ux * shaftEnd - px * shaftW, fy + uy * shaftEnd - py * shaftW);
  _ctx.lineTo(fx - px * shaftW, fy - py * shaftW);
  _ctx.closePath();
  _ctx.fillStyle = style.body;
  _ctx.fill();

  // ── Draw arrowhead ───────────────────────────────────
  _ctx.beginPath();
  // Base-left of triangle
  _ctx.moveTo(
    fx + ux * shaftEnd + px * headW,
    fy + uy * shaftEnd + py * headW,
  );
  // Tip of triangle
  _ctx.lineTo(tx, ty);
  // Base-right of triangle
  _ctx.lineTo(
    fx + ux * shaftEnd - px * headW,
    fy + uy * shaftEnd - py * headW,
  );
  _ctx.closePath();
  _ctx.fillStyle = style.head;
  _ctx.fill();

  _ctx.restore();
}

// ─────────────────────────────────────────────────────

/**
 * Returns the pixel centre [x, y] of a square on the board,
 * taking the current board flip state into account.
 *
 * The coordinate system origin is the top-left of the board element.
 *
 * @param {string} square  - Algebraic square, e.g. 'e4'
 * @param {number} sqSize  - Pixel size of one square
 * @returns {[number, number]}
 */
function _squareCenter(square, sqSize) {
  const file = square.charCodeAt(0) - 97;   // 'a'=0 … 'h'=7
  const rank = parseInt(square[1], 10);      // 1–8

  let col, row;

  if (state.boardFlipped) {
    // Flipped: h-file is on the left, rank 1 at the top
    col = 7 - file;
    row = rank - 1;
  } else {
    // Normal: a-file on the left, rank 8 at the top
    col = file;
    row = 8 - rank;
  }

  return [
    col * sqSize + sqSize / 2,
    row * sqSize + sqSize / 2,
  ];
}
