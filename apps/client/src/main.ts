import './style.css';
import { UPGRADE_KINDS } from '@digger/shared';
import { Keyboard } from './input.js';
import { loadNickname, sanitizeNickname, saveNickname } from './nickname.js';
import { Renderer } from './renderer.js';
import { LocalSession, type GameSession } from './session.js';
import { NetSession } from './net/NetSession.js';
import { Ui } from './ui.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

// `onPlay` resolves with an error message to show on the start screen, or null when the game started.
function showStart(onPlay: (name: string) => Promise<string | null>): void {
  const box = document.createElement('div');
  box.id = 'start';
  box.innerHTML = `<h1>DIGGER RUSH</h1>
    <form><input id="nick" maxlength="40" autocomplete="off" placeholder="Nickname (2-16 chars)" /><button type="submit">Play</button></form>
    <div id="starterr"></div>
    <div class="keys">A/D move + side drill &middot; S drill down &middot; W thrust &middot; SPACE radar &middot; B shop &middot; F3 debug</div>`;
  document.body.appendChild(box);
  const input = box.querySelector('#nick') as HTMLInputElement;
  const err = box.querySelector('#starterr') as HTMLElement;
  input.value = loadNickname();
  input.focus();
  const button = box.querySelector('button') as HTMLButtonElement;
  let busy = false;
  box.querySelector('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const r = sanitizeNickname(input.value);
    if (!r.ok) { err.textContent = r.error; return; }
    saveNickname(r.name);
    busy = true;
    button.disabled = true;
    err.style.color = '#cfe8ff';
    err.textContent = 'Connecting...';
    void onPlay(r.name).then((error) => {
      busy = false;
      button.disabled = false;
      if (error === null) { box.remove(); return; }
      err.style.color = '';
      err.textContent = error;
    });
  });
}

function startGame(session: GameSession): void {
  const statusEl = document.createElement('div');
  statusEl.id = 'netstatus';
  statusEl.className = 'hidden';
  document.body.appendChild(statusEl);
  const ui = new Ui(uiRoot, {
    onBuy: (kind) => { session.buy(kind); },
    onToggleShop: () => ui.setShop(!ui.shopOpen),
  });
  const renderer = new Renderer(canvas, session);
  const keys = new Keyboard({
    toggleShop: () => ui.setShop(!ui.shopOpen),
    closeShop: () => ui.setShop(false),
    toggleDebug: () => ui.setDebug(!ui.debugOpen),
    radar: () => { session.useRadar(); },
    buyIndex: (i) => { if (ui.shopOpen && i >= 0 && i < UPGRADE_KINDS.length) session.buy(UPGRADE_KINDS[i]); },
  });
  ui.show(true);

  let last = performance.now();
  let fps = 60;
  let boardTimer = 1; // forces an immediate update
  const frame = (now: number): void => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;

    // sim: fixed 60 Hz stepping inside the session; rendering never steps it
    session.advance(dt, keys.state);
    renderer.consume(session.fx);
    renderer.render(dt, keys.state);

    boardTimer += dt;
    if (boardTimer >= 1) {
      boardTimer = 0;
      const b = session.getBoard();
      ui.setLeaderboard(b.rows, b.rank, session);
    }
    const bad = session.status === 'reconnecting' || session.status === 'lost';
    statusEl.classList.toggle('hidden', !bad);
    if (bad && statusEl.textContent !== session.statusText) statusEl.textContent = session.statusText;
    ui.update(session, fps, renderer.stats);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const LOCAL = new URLSearchParams(location.search).get('local') === '1';

showStart(async (name) => {
  if (LOCAL) {
    startGame(new LocalSession(name));
    return null;
  }
  try {
    startGame(await NetSession.connect(name));
    return null;
  } catch (e) {
    const msg = e instanceof Error && e.message !== '' ? e.message : 'Could not reach the server.';
    return /fetch|network|ECONN|failed|closed|WebSocket/i.test(msg) ? 'Could not reach the server. Is it running? (add ?local=1 to play offline)' : msg;
  }
});
