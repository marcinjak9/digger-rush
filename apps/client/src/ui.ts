import { T, UPGRADE_KINDS, maxHpOf, TILES, upgradeCost, radarCooldownTicksOf, type UpgradeKind } from '@digger/shared';
import type { GameSession } from './session.js';
import type { DebugStats } from './renderer.js';

const LABELS: Record<UpgradeKind, [string, string]> = {
    drill: ['Drill speed', `-${Math.round((1 - T.upgrade.drillMult) * 100)}% dig time per level (compounding)`],
  maxHp: ['Max HP', `+${T.upgrade.hpPerLevel} HP per level`],
  moveSpeed: ['Move speed', `+${T.upgrade.movePct}% per level (max x${T.upgrade.maxMoveMult})`],
  armor: ['Armor', `-${Math.round((1 - T.upgrade.armorMult) * 100)}% damage per level (compounding)`],
  radar: ['Radar cooldown', `-${Math.round((1 - T.upgrade.radarCdMult) * 100)}% per level (min ${T.radarMinCooldownSeconds}s)`],
};

// Constants that the shared sim reads live from T on every tick, so they can be tweaked at runtime.
// (Module-level cached values such as podHalf / DT / QUANT are deliberately not listed.)
const TUNEABLE: Array<{ key: string; step: number }> = [
  { key: 'gravity', step: 1 },
  { key: 'thrust', step: 1 },
  { key: 'moveSpeed', step: 0.5 },
  { key: 'moveAccel', step: 2 },
  { key: 'moveDecel', step: 5 },
  { key: 'vyMax', step: 1 },
  { key: 'hardLandSpeed', step: 1 },
  { key: 'lavaDps', step: 5 },
  { key: 'sandHitDamage', step: 2 },
];
const DEFAULTS: Record<string, number> = {};
for (const t of TUNEABLE) DEFAULTS[t.key] = (T as unknown as Record<string, number>)[t.key];

function fmtMoney(n: number): string {
  return n >= 1e9 ? '$' + n.toExponential(2) : '$' + n;
}

function setText(el: HTMLElement, s: string): void {
  if (el.textContent !== s) el.textContent = s;
}

export interface UiCallbacks {
  onBuy(kind: UpgradeKind): void;
  onToggleShop(): void;
}

export interface LeaderRow {
  name: string;
  score: number;
  me: boolean;
}

export class Ui {
  private readonly el: Record<string, HTMLElement> = {};
  private readonly buy = new Map<UpgradeKind, HTMLButtonElement>();
  private readonly shopRows = new Map<UpgradeKind, { lvl: HTMLElement; cost: HTMLElement }>();
  private readonly tuneVals = new Map<string, HTMLElement>();
  shopOpen = false;
  debugOpen = false;

  constructor(private readonly root: HTMLElement, private readonly cb: UiCallbacks) {
    root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="hud-left">
          <div class="hpbar"><div id="hpfill"></div><span id="hptext"></span></div>
          <div class="stats"><span>Wallet <b id="wallet"></b></span><span>Score <b id="score"></b></span><span>Best <b id="high"></b></span><span>Depth <b id="depth"></b></span></div>
        <div class="radar" id="radar"><div id="radarfill"></div><span id="radartext"></span></div>
        </div>
        <div class="hud-right"><span id="net">local</span> <span id="fps"></span> <button id="shopbtn">Shop (B)</button></div>
        <div id="board"><h4>Leaderboard</h4><ol id="boardlist"></ol><div id="boardme"></div></div>
      </div>
      <div id="shop" class="overlay hidden"><div class="panel">
        <h2>Upgrades</h2><div id="shoprows"></div>
        <div class="hint">Wallet: <b id="shopwallet"></b> &middot; keys 1-5 buy &middot; B / Esc closes</div>
        <button id="shopclose">Close</button></div></div>
      <div id="death" class="overlay hidden"><div class="panel">
        <h1>You died</h1><div>Score <b id="dscore"></b></div><div>Best <b id="dhigh"></b></div>
        <div class="hint" id="drespawn"></div></div></div>
      <div id="debug" class="hidden"><pre id="dbgtext"></pre><div id="dbgtune"></div></div>`;
    for (const id of ['hud', 'hpfill', 'hptext', 'radar', 'radarfill', 'radartext', 'wallet', 'score', 'high', 'depth', 'net', 'fps', 'shopbtn', 'board', 'boardlist', 'boardme',
      'shop', 'shoprows', 'shopwallet', 'shopclose', 'death', 'dscore', 'dhigh', 'drespawn', 'debug', 'dbgtext', 'dbgtune']) {
      this.el[id] = root.querySelector('#' + id) as HTMLElement;
    }
    this.el.shopbtn.addEventListener('click', () => cb.onToggleShop());
    this.el.shopclose.addEventListener('click', () => cb.onToggleShop());
    for (const kind of UPGRADE_KINDS) {
      const row = document.createElement('div');
      row.className = 'shoprow';
      const [name, desc] = LABELS[kind];
      row.innerHTML = `<div class="shopname">${name}<small>${desc}</small></div><div class="shoplvl"></div><div class="shopcost"></div>`;
      const b = document.createElement('button');
      b.textContent = 'Buy';
      b.addEventListener('click', () => cb.onBuy(kind));
      row.appendChild(b);
      this.el.shoprows.appendChild(row);
      this.buy.set(kind, b);
      this.shopRows.set(kind, { lvl: row.children[1] as HTMLElement, cost: row.children[2] as HTMLElement });
    }
    for (const t of TUNEABLE) {
      const row = document.createElement('div');
      row.className = 'tune';
      const val = document.createElement('span');
      const mk = (txt: string, d: number): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.addEventListener('click', () => {
          const rec = T as unknown as Record<string, number>;
          rec[t.key] = Math.round((rec[t.key] + d * t.step) * 1000) / 1000;
        });
        return b;
      };
      row.append(t.key + ' ', mk('-', -1), val, mk('+', 1));
      this.tuneVals.set(t.key, val);
      this.el.dbgtune.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.textContent = 'reset';
    reset.addEventListener('click', () => {
      for (const k of Object.keys(DEFAULTS)) (T as unknown as Record<string, number>)[k] = DEFAULTS[k];
    });
    this.el.dbgtune.appendChild(reset);
  }

  show(on: boolean): void {
    this.el.hud.classList.toggle('hidden', !on);
  }

  setShop(open: boolean): void {
    this.shopOpen = open;
    this.el.shop.classList.toggle('hidden', !open);
  }

  setDebug(open: boolean): void {
    this.debugOpen = open;
    this.el.debug.classList.toggle('hidden', !open);
  }

  setLeaderboard(rows: LeaderRow[], rank: number, s: GameSession): void {
    const list = this.el.boardlist;
    list.textContent = '';
    for (const r of rows.slice(0, 3)) {
      const li = document.createElement('li');
      li.className = r.me ? 'me' : '';
      li.textContent = `${r.name} - ${r.score}`;
      list.appendChild(li);
    }
    const st = s.player.stats;
    setText(this.el.boardme, `You: #${rank} | best ${st.highScore} | now ${st.score}`);
  }

  update(s: GameSession, fps: number, dbg: DebugStats): void {
    const st = s.player.stats;
    const max = maxHpOf(st.lvl);
    const hp = Math.max(0, st.hull > max ? max : st.hull);
    this.el.hpfill.style.width = (max > 0 ? (hp / max) * 100 : 0).toFixed(1) + '%';
    setText(this.el.hptext, `${Math.ceil(hp)} / ${max}`);
    setText(this.el.wallet, '$' + st.wallet);
    setText(this.el.score, String(st.score));
    setText(this.el.high, String(st.highScore));
    setText(this.el.depth, Math.max(0, Math.floor(s.player.pod.y)) + ' tiles');
    setText(this.el.net, s.latencyLabel);
    setText(this.el.fps, Math.round(fps) + ' fps');
    setText(this.el.shopwallet, '$' + st.wallet);

    if (this.shopOpen) {
      for (const kind of UPGRADE_KINDS) {
        const lv = st.lvl[kind];
        const r = this.shopRows.get(kind) as { lvl: HTMLElement; cost: HTMLElement };
        const b = this.buy.get(kind) as HTMLButtonElement;
        const capped = lv >= T.upgrade.levelCap;
        const cost = upgradeCost(lv);
        setText(r.lvl, `Lv ${lv}`);
        setText(r.cost, capped ? 'MAX' : fmtMoney(cost));
        b.disabled = capped || s.dead || st.wallet < cost;
      }
    }

    const total = radarCooldownTicksOf(st.lvl.radar);
    const ready = st.radarTicks <= 0;
    this.el.radarfill.style.width = (ready ? 100 : (1 - st.radarTicks / total) * 100).toFixed(1) + '%';
    this.el.radar.classList.toggle('cooling', !ready);
    setText(this.el.radartext, ready ? 'SPACE  RADAR' : `SPACE  ${(st.radarTicks / T.TICK_HZ).toFixed(1)}s`);

    this.el.death.classList.toggle('hidden', !s.dead);
    if (s.dead) {
      setText(this.el.dscore, String(s.finalScore));
      setText(this.el.dhigh, String(st.highScore));
      setText(this.el.drespawn, `Respawning in ${Math.ceil(s.respawnLeftSec)}...`);
    }

    if (this.debugOpen) {
      const p = s.player.pod;
      const state = p.drill ? `drill ${p.drill.tx},${p.drill.ty} ${p.drill.ticksLeft}/${p.drill.total}` : p.glide ? 'glide' : p.grounded ? 'ground' : 'air';
      const aim = TILES[s.world.get(Math.floor(p.x), Math.floor(p.y))].name;
      setText(this.el.dbgtext,
        `fps ${fps.toFixed(1)}   tick ${s.tick}\n` +
        `tiles changed/s ${dbg.tilesPerSec.toFixed(1)}\n` +
        `chunks loaded ${dbg.chunksLoaded} (canvases ${dbg.chunkCanvases})\n` +
        `pod ${p.x.toFixed(3)}, ${p.y.toFixed(3)}  v ${p.vx.toFixed(2)}, ${p.vy.toFixed(2)}\n` +
        `state ${state}  facing ${p.fx},${p.fy}  in-tile ${aim}\n` +
        `sand blocks ${s.sand.blocks.length}  invuln ${s.invulnerable}\n` +
        `hash ${dbg.podHash.toString(16)}`);
      const rec = T as unknown as Record<string, number>;
      for (const [k, el] of this.tuneVals) setText(el, ' ' + rec[k] + ' ');
    }
  }
}
