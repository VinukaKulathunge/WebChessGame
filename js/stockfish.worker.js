/**
 * stockfish.worker.js — UCI bridge between main thread and Stockfish.
 *
 * stockfish.js (v10) is itself a self-contained Worker script:
 *   - It sets its own `onmessage` on `self`
 *   - It calls `postMessage(uciLine)` for output
 *   - It does NOT export any global factory function
 *
 * Therefore we spawn it as a NESTED Worker from this outer worker,
 * then relay messages between the two layers:
 *
 *   Main thread  ←→  this worker (structured JSON)  ←→  stockfish.js (raw UCI)
 *
 * This outer wrapper handles:
 *   - JSON protocol parsing (type/fen/movetime)
 *   - MultiPV info line aggregation
 *   - Posting structured { type:'bestmove'|'info'|'ready' } back to main
 */

// Path to stockfish.js served from the same origin (no CORS issues)
const SF_URL = '/stockfish.js';

let _sf      = null;   // inner Stockfish Worker
let _ready   = false;
let _multiPV = 3;

/** MultiPV info lines collected during search, keyed by multipv slot (1-based). */
const _infoLines = new Map();

// ── BOOT ──────────────────────────────────────────────
function _boot() {
  if (_sf) return;

  _sf = new Worker(SF_URL);

  // Stockfish sends raw UCI strings via postMessage
  _sf.onmessage = evt => _handleLine(
    typeof evt.data === 'string' ? evt.data : String(evt.data ?? '')
  );

  _sf.onerror = evt => {
    postMessage({ type: 'error', message: `Stockfish Worker error: ${evt.message}` });
  };

  // Begin UCI handshake — Stockfish responds with 'uciok'
  _sf.postMessage('uci');
}

// ── UCI OUTPUT HANDLER ────────────────────────────────
function _handleLine(line) {
  line = line.trim();
  if (!line) return;

  // ── UCI handshake ────────────────────────────────────
  if (line === 'uciok') {
    _sf.postMessage(`setoption name MultiPV value ${_multiPV}`);
    _sf.postMessage('setoption name Hash value 64');
    _sf.postMessage('isready');
    return;
  }

  if (line === 'readyok') {
    _ready = true;
    postMessage({ type: 'ready' });
    return;
  }

  // ── Info lines (analysis) ────────────────────────────
  // Only parse lines that carry both a score and a pv move list
  if (line.startsWith('info') && line.includes(' pv ') && line.includes('score')) {
    _parseInfo(line);
    return;
  }

  // ── Best move ────────────────────────────────────────
  if (line.startsWith('bestmove')) {
    const tokens = line.split(' ');
    const move   = tokens[1] ?? '(none)';
    _flushInfo();
    postMessage({ type: 'bestmove', move });
  }
}

// ── INFO PARSER ───────────────────────────────────────
function _parseInfo(line) {
  const tok = line.split(' ');

  // Helper: get the token after `key`
  const val = key => {
    const i = tok.indexOf(key);
    return i !== -1 ? tok[i + 1] : null;
  };

  const depth   = parseInt(val('depth')   ?? '0', 10);
  const mpv     = parseInt(val('multipv') ?? '1', 10);
  const cpStr   = val('cp');
  const mateStr = val('mate');
  const pvIdx   = tok.indexOf('pv');
  if (pvIdx === -1) return;

  const moves = tok.slice(pvIdx + 1).filter(Boolean);

  let score;
  if (mateStr !== null) {
    const n = parseInt(mateStr, 10);
    // Encode mate as ±100000 (well above normal cp range)
    score = n > 0 ? 100000 - n : -100000 - n;
  } else {
    score = parseInt(cpStr ?? '0', 10);
  }

  // Keep the deepest info per multipv slot
  const prev = _infoLines.get(mpv);
  if (!prev || depth >= prev.depth) {
    _infoLines.set(mpv, { depth, score, moves });
  }
}

function _flushInfo() {
  if (!_infoLines.size) return;
  const lines = [..._infoLines.keys()]
    .sort((a, b) => a - b)
    .map(k => _infoLines.get(k));
  postMessage({ type: 'info', lines });
  _infoLines.clear();
}

// ── MAIN THREAD → WORKER ──────────────────────────────
self.onmessage = function (evt) {
  const msg = evt.data;

  switch (msg.type) {

    case 'init':
      _boot();
      break;

    case 'go':
      if (!_sf || !_ready) {
        postMessage({ type: 'error', message: 'Engine not ready — call init first.' });
        return;
      }
      // Update MultiPV if changed
      if (msg.multiPV && msg.multiPV !== _multiPV) {
        _multiPV = msg.multiPV;
        _sf.postMessage(`setoption name MultiPV value ${_multiPV}`);
      }
      _infoLines.clear();
      _sf.postMessage(`position fen ${msg.fen}`);
      _sf.postMessage(`go movetime ${msg.movetime}`);
      break;

    case 'stop':
      _sf?.postMessage('stop');
      break;

    case 'quit':
      _sf?.postMessage('quit');
      _sf?.terminate();
      _sf    = null;
      _ready = false;
      break;

    default:
      postMessage({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
};
