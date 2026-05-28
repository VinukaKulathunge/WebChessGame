# WEB CHESS

A fully-featured, modular AI Chess Web App built with **vanilla JavaScript ES6 modules** and a **dark brutalist** aesthetic. Powered by Stockfish 10 for engine analysis.

![Setup Screen](https://img.shields.io/badge/status-playable-brightgreen) ![Stockfish](https://img.shields.io/badge/engine-Stockfish%2010-blue) ![Vanilla JS](https://img.shields.io/badge/stack-Vanilla%20JS-yellow)

---

## Features

| Feature | Details |
|---|---|
| **AI Opponent** | Stockfish 10 via Web Worker — UI never freezes |
| **Difficulty** | Easy (100ms) · Medium (500ms) · Hard (2000ms) think time |
| **Time Controls** | Unlimited · 1 · 3 · 5 · 10 minute clocks (RAF-based, no drift) |
| **Color Choice** | Play as White, Black, or Random |
| **Eval Bar** | Live centipawn evaluation with sigmoid compression & mate display |
| **Engine Lines** | Top 3 MultiPV lines with depth badge |
| **Best Move Arrow** | Canvas overlay showing Stockfish's recommended move |
| **Move Log** | Scrollable algebraic notation log with current-move highlight |
| **Analysis Mode** | Scrub through game history with ←→ arrow keys or log clicks |
| **Move Classification** | Brilliant · Great · Good · Book · Inaccuracy · Mistake · Blunder |
| **Full Chess Rules** | Castling · En passant · Promotion dialog · Threefold repetition · 50-move rule |
| **Responsive** | Works on mobile, tablet, and desktop |

---

## Getting Started

### Prerequisites
- **Node.js** (any recent version — only used to run the dev server)
- A modern browser (Chrome, Firefox, Edge, Safari)

### Run Locally

```bash
# Clone or download the project
cd AIChessGame

# Start the local server (required for ES6 modules + Web Workers)
npx -y serve . --listen 3000

# Open in your browser
# → http://localhost:3000
```

> **You must use a local HTTP server.** Opening `index.html` directly (`file://`) will NOT work because browsers block ES6 `import` statements and `new Worker()` on the `file://` protocol.

---

## Project Structure

```
AIChessGame/
├── index.html              # App shell — setup modal + game layout
├── style.css               # Dark brutalist stylesheet
├── stockfish.js            # Stockfish 10 engine (served locally)
│
└── js/
    ├── main.js             # Entry point — boots initUI()
    ├── state.js            # Central single-source-of-truth game state
    ├── engine.js           # chess.js wrapper — all chess rule logic
    ├── render.js           # Pure DOM renderer — state → HTML
    ├── ui.js               # All user interaction & event wiring
    ├── ai.js               # Main-thread Stockfish manager
    ├── stockfish.worker.js # Web Worker — UCI bridge to stockfish.js
    ├── arrows.js           # Canvas arrow overlay (bestmove visualisation)
    ├── clock.js            # RAF-based precision chess clock
    └── analysis.js         # Analysis mode, history scrubbing & move classification
```

---

## Architecture

```
main.js
  └── ui.js ──────────────────────────────────────────────────────┐
        ├── state.js          (game state, no UI logic)           │
        ├── engine.js         (chess.js CDN wrapper)              │
        ├── render.js         (DOM projection, reads state)       │
        │     └── arrows.js   (canvas bestmove arrow)             │
        ├── ai.js             (Stockfish main-thread manager)     │
        │     └── stockfish.worker.js  (nested Worker UCI relay)  │
        │           └── stockfish.js   (Stockfish engine binary)  │
        ├── clock.js          (RAF delta-timed countdown)         │
        └── analysis.js       (mode toggle, classification,       │
                               game-over overlay)                  │
```

**Key design principles:**
- **state.js** is the single source of truth — no module holds its own game state
- **render.js** is a pure function: `state → DOM`. It never reads from the DOM
- **engine.js** never touches the DOM — only chess.js and state.js
- **ui.js** is the only module that wires events — all others are called, never caller

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `←` | Previous move (analysis mode) |
| `→` | Next move (analysis mode) |
| `↑` | Jump to start (analysis mode) |
| `↓` | Jump to end (analysis mode) |
| `F` | Flip board |
| `Esc` | Deselect piece / close promotion dialog |

---

## Move Classification

After each game, moves are classified by centipawn loss vs. Stockfish's best:

| Badge | Name | CP Loss |
|---|---|---|
| ✦ | Brilliant | ≤ 10cp (exceptional find) |
| ★ | Great | ≤ 10cp |
| ✓ | Good | ≤ 30cp |
| ⊕ | Book | Opening theory |
| ? | Inaccuracy | > 50cp |
| ?! | Mistake | > 100cp |
| ?? | Blunder | > 200cp |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (ES6 modules, no bundler) |
| Chess Rules | [chess.js 0.10.3](https://github.com/jhlywa/chess.js) via CDN |
| AI Engine | [Stockfish 10](https://stockfishchess.org/) (served locally) |
| Threading | Web Workers (Stockfish runs off the main thread) |
| Styling | Vanilla CSS — Space Grotesk + Space Mono (Google Fonts) |
| Canvas | HTML5 Canvas API (bestmove arrow overlay) |

---

## License

MIT — free to use, modify, and distribute.
