/**
 * main.js — Application entry point for Brutal Chess.
 * Delegates all logic to ui.js on DOMContentLoaded.
 */

import { initUI } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[BrutalChess] DOM ready — initialising UI.');
  initUI();
});
