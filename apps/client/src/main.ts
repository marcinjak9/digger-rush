import './style.css';
import { UPGRADE_KINDS } from '@digger/shared';
import { Keyboard } from './input.js';
import { loadNickname, sanitizeNickname, saveNickname } from './nickname.js';
import { Renderer } from './renderer.js';
import { LocalSession, type GameSession } from './session.js';
import { Ui } from './ui.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

function showStart(onPlay: (name: string) => void): void {
  const box = document.createElement('div');
  box.id = 'start';
  box.innerHTML = `<h1>DIGGER RUSH</h1>
    <form><input id="nick" maxlength="40" autocomplete="off" placeholder="Nickname (2-16 chars)" /><button type="submit">Play</button></form>
    <div id="starterr"></div>
    <div class="keys">A/D move + side drill &middot; S drill down &middot; W thrust &middot; B shop &middot; F3 debug</div>`;
  document.body.appendChild(box);
  const input = box.querySelector('#nick') as HTMLInputElement;
  const err = box.querySelector('#starterr') as HTMLElement;
  input.value = loadNickname();
  input.focus();
  box.querySelector('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = sanitizeNickname(input.value);
    if (!r.ok) { err.textContent = r.error; return; }
    saveNickname(r.name);
    box.remove();
    onPlay(r.name);
  });
}

function startGame(nickname: string): void {
  const session: GameSession = new LocalSession(nickname);
  const ui = new Ui(uiRoot, {
    onBuy: (kind) => { session.buy(kind); },
    onToggleShop: () => ui.setShop(!ui.shopOpen),
  });
  const renderer = new Renderer(canvas, session);
  const keys = new Keyboard({
    toggleShop: () => ui.setShop(!ui.shopOpen),
    closeShop: () => ui.setShop(false),
    toggleDebug: () => ui.setDebug(!ui.debugOpen),
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
      const st = session.player.stats;
      ui.setLeaderboard([{ name: session.nickname, score: Math.max(st.score, st.highScore), me: true }], 1, session);
    }
    ui.update(session, fps, renderer.stats);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

showStart(startGame);
