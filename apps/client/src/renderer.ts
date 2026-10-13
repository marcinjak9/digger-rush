import { T, Tile, TILES, oreValueAt, scanOre, lightRadius, RADAR_STRIDE, podHash, type PodInput, type TileChange } from '@digger/shared';
import type { FrameFx, GameSession } from './session.js';

const TS = T.TILE_PX;
const CH = T.CHUNK;
const CHPX = CH * TS;
const VIEW_W = 24;
const VIEW_H = 14;
const HALF = T.podHalf * TS;

const css = (c: number): string => '#' + c.toString(16).padStart(6, '0');
const COLOR = TILES.map((t) => css(t.color));
const FLECK = TILES.map((t) => css(t.fleck));
const FLECK_N = [3, 5, 6, 6, 5, 5, 5, 6, 0, 4];
const ORE_FLECK_N = [0, 0, 0, 0, 7, 5, 4, 0, 0, 0];

function hash(x: number, y: number, k: number): number {
  let h = Math.imul((x * 73856093) ^ (y * 19349663) ^ (k * 83492791), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function drawTile(ctx: CanvasRenderingContext2D, tile: number, x: number, y: number, px: number, py: number): void {
  ctx.fillStyle = COLOR[tile];
  ctx.fillRect(px, py, TS, TS);
  if (tile === Tile.BEDROCK) return;
  const n = FLECK_N[tile];
  ctx.fillStyle = FLECK[tile];
  const small = tile === Tile.DIRT || tile === Tile.EMPTY || tile === Tile.SAND;
  for (let i = 0; i < n; i++) {
    const s = small ? 3 + Math.floor(hash(x, y, i * 4 + 3) * 4) : 4 + Math.floor(hash(x, y, i * 4 + 3) * 7);
    ctx.fillRect(px + Math.floor(hash(x, y, i * 4 + 1) * (TS - s)), py + Math.floor(hash(x, y, i * 4 + 2) * (TS - s)), s, s);
  }
  const on = ORE_FLECK_N[tile];
  for (let i = 0; i < on; i++) {
    const s = 6 + Math.floor(hash(x, y, i * 4 + 103) * 9);
    ctx.fillRect(px + 4 + Math.floor(hash(x, y, i * 4 + 101) * (TS - s - 8)), py + 4 + Math.floor(hash(x, y, i * 4 + 102) * (TS - s - 8)), s, s);
  }
  if (tile === Tile.HEAL) {
    ctx.fillStyle = '#c9ffd9';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(px + 8 + Math.floor(hash(x, y, 201 + i) * 28), py + 8 + Math.floor(hash(x, y, 211 + i) * 28), 4, 4);
    }
  }
  if (tile !== Tile.EMPTY && tile !== Tile.LAVA) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(px, py + TS - 2, TS, 2);
    ctx.fillRect(px + TS - 2, py, 2, TS - 2);
  }
}

function makeGlow(r: number, g: number, b: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = x.createRadialGradient(80, 80, 6, 80, 80, 80);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.fillRect(0, 0, 160, 160);
  return c;
}

// ---- particle pool (no per-frame allocation)
const NP = 600;
const px_ = new Float32Array(NP), py_ = new Float32Array(NP), pvx = new Float32Array(NP), pvy = new Float32Array(NP);
const plife = new Float32Array(NP), pmax = new Float32Array(NP), psize = new Float32Array(NP), pgrav = new Float32Array(NP);
const pcol: string[] = new Array<string>(NP).fill('#fff');
let pcount = 0;

function emit(x: number, y: number, vx: number, vy: number, life: number, size: number, grav: number, color: string): void {
  const i = pcount < NP ? pcount++ : Math.floor(Math.random() * NP);
  px_[i] = x; py_[i] = y; pvx[i] = vx; pvy[i] = vy; plife[i] = life; pmax[i] = life; psize[i] = size; pgrav[i] = grav; pcol[i] = color;
}

function burst(x: number, y: number, n: number, color: string, speed: number, life: number, up = 0): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.7);
    emit(x, y, Math.cos(a) * s, Math.sin(a) * s - up, life * (0.6 + Math.random() * 0.4), 3 + Math.random() * 4, 500, color);
  }
}

// ---- floating text pool
const NF = 24;
const ftx = new Float32Array(NF), fty = new Float32Array(NF), ftl = new Float32Array(NF);
const ftt: string[] = new Array<string>(NF).fill('');
const ftc: string[] = new Array<string>(NF).fill('#fff');
let ftn = 0;

function floatText(x: number, y: number, text: string, color: string): void {
  const i = ftn++ % NF;
  ftx[i] = x; fty[i] = y; ftl[i] = 1.1; ftt[i] = text; ftc[i] = color;
}

// radar highlight colours by ore tile id
const RADAR_RGB: Record<number, [number, number, number]> = {
  [Tile.COPPER]: [235, 130, 50],
  [Tile.GOLD]: [255, 217, 38],
  [Tile.GEM]: [64, 235, 247],
  [Tile.HEAL]: [62, 224, 106],
};
const RADAR_CSS: Record<number, string> = {};
for (const k of Object.keys(RADAR_RGB)) {
  const c = RADAR_RGB[Number(k)];
  RADAR_CSS[Number(k)] = `rgb(${c[0]},${c[1]},${c[2]})`;
}
const RADAR_MAX = 512;

const CRACK_A = [0.3, 1.4, 2.5, 3.6, 4.7, 5.6, 0.9, 3.0];

export interface DebugStats {
  tilesPerSec: number;
  chunksLoaded: number;
  chunkCanvases: number;
  podHash: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly chunks = new Map<number, HTMLCanvasElement>();
  private readonly lavaGlow = makeGlow(255, 110, 30);
  private readonly healGlow = makeGlow(70, 255, 120);
  private sky: CanvasGradient;
  private readonly radarGlow: Record<number, HTMLCanvasElement> = {};
  private readonly radarBuf = new Int32Array(RADAR_MAX * RADAR_STRIDE);
  private radarCount = 0;
  private radarX = 0;
  private radarY = 0;
  private radarStart = -1e9;
  private radarSeen = 0;
  private dark: CanvasGradient | null = null;
  private darkKey = [0, 0, 0, 0];
  private scale = 1;
  private w = 1;
  private h = 1;
  private camX: number;
  private camY: number;
  private shake = 0;
  private flash = 0;
  private time = 0;
  private changesWindow = 0;
  private changesSecond = 0;
  private winTime = 0;
  readonly stats: DebugStats = { tilesPerSec: 0, chunksLoaded: 0, chunkCanvases: 0, podHash: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly s: GameSession) {
    this.ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    this.sky = this.ctx.createLinearGradient(0, T.yMin * TS, 0, 0);
    for (const k of Object.keys(RADAR_RGB)) {
      const c = RADAR_RGB[Number(k)];
      this.radarGlow[Number(k)] = makeGlow(c[0], c[1], c[2]);
    }
    this.radarSeen = s.radarPings;
    this.camX = s.player.pod.x;
    this.camY = s.player.pod.y;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    this.w = this.canvas.width = Math.max(1, Math.floor(cw * dpr));
    this.h = this.canvas.height = Math.max(1, Math.floor(ch * dpr));
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.scale = Math.min(this.w / (VIEW_W * TS), this.h / (VIEW_H * TS));
    this.sky = this.ctx.createLinearGradient(0, T.yMin * TS, 0, 0);
    this.sky.addColorStop(0, '#0b1a3a');
    this.sky.addColorStop(1, '#6fb7e8');
  }

  // ---- effects from sim events
  consume(fx: FrameFx): void {
    const s = this.s;
    for (const ch of fx.changes) this.retile(ch);
    this.changesWindow += fx.changes.length;
    for (const d of fx.dug) {
      const cx = (d.x + 0.5) * TS;
      const cy = (d.y + 0.5) * TS;
      burst(cx, cy, 12, FLECK[d.tile], 220, 0.6);
      burst(cx, cy, 6, COLOR[d.tile === Tile.SAND ? Tile.SAND : Tile.DIRT], 160, 0.5);
      if (d.tile === Tile.HEAL) {
        floatText(cx, cy - 10, '+HP', '#6dff9a');
        burst(cx, cy, 14, '#6dff9a', 200, 0.8, 120);
      } else {
        const base = TILES[d.tile].value > 0 ? TILES[d.tile].value : TILES[d.aux].value;
        if (base > 0) floatText(cx, cy - 10, '+$' + oreValueAt(base, d.y), '#ffe14d');
      }
    }
    for (const e of fx.sand) {
      const x = (e.x + 0.5) * TS;
      if (e.kind === 'wobble') burst(x, (e.y + 0.9) * TS, 2, '#ccb366', 40, 0.4);
      else if (e.kind === 'land') { burst(x, (e.y + 1) * TS, 8, '#edd987', 120, 0.5, 40); this.shake = Math.max(this.shake, 2); }
      else if (e.kind === 'hit') { burst(e.x * TS, e.y * TS, 12, '#ff6a4d', 220, 0.5); this.shake = Math.max(this.shake, 6); }
    }
    const pod = s.player.pod;
    if (fx.hardLandVy > 0) {
      this.shake = Math.max(this.shake, 9);
      burst(pod.x * TS, (pod.y + T.podHalf) * TS, 16, '#b09070', 240, 0.6, 60);
    } else if (fx.softLandVy > 0) {
      burst(pod.x * TS, (pod.y + T.podHalf) * TS, 6, '#b09070', 90, 0.4, 30);
    }
    if (s.radarPings !== this.radarSeen) {
      this.radarSeen = s.radarPings;
      this.radarCount = scanOre(s.world, Math.floor(pod.x), Math.floor(pod.y), T.radarRadius, this.radarBuf);
      this.radarX = pod.x * TS;
      this.radarY = pod.y * TS;
      this.radarStart = this.time;
    }
    if (fx.damage > 0) this.flash = Math.min(0.6, this.flash + 0.25);
    if (fx.died) {
      this.radarStart = -1e9;
      this.shake = 14;
      this.flash = 0.6;
    }
  }

  // Rewrite a single tile into its chunk canvas, if that canvas exists.
  private retile(ch: TileChange): void {
    const c = this.chunks.get(this.s.world.chunkKey(ch.x >> 4, ch.y >> 4));
    if (c === undefined) return;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    drawTile(g, ch.tile, ch.x, ch.y, (ch.x & 15) * TS, (ch.y & 15) * TS);
  }

  private chunkCanvas(cx: number, cy: number): HTMLCanvasElement {
    const key = this.s.world.chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (c !== undefined) return c;
    c = document.createElement('canvas');
    c.width = c.height = CHPX;
    const g = c.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    const tiles = this.s.world.getChunk(cx, cy).tiles;
    for (let ly = 0; ly < CH; ly++) {
      for (let lx = 0; lx < CH; lx++) {
        drawTile(g, tiles[ly * CH + lx], cx * CH + lx, cy * CH + ly, lx * TS, ly * TS);
      }
    }
    this.chunks.set(key, c);
    return c;
  }

  // ---- frame
  render(dt: number, input: PodInput): void {
    const s = this.s;
    const ctx = this.ctx;
    const pod = s.player.pod;
    this.time += dt;
    this.winTime += dt;
    if (this.winTime >= 1) {
      this.changesSecond = this.changesWindow / this.winTime;
      this.changesWindow = 0;
      this.winTime = 0;
    }
    const a = s.alpha > 1 ? 1 : s.alpha;
    const ix = s.prev.x + (pod.x - s.prev.x) * a;
    const iy = s.prev.y + (pod.y - s.prev.y) * a;

    // camera: dead zone + vertical look-ahead, exponential smoothing
    const lookY = Math.max(-1.5, Math.min(3, pod.vy * 0.25));
    const targetY = iy + lookY;
    const dzx = 1.2;
    const dzy = 0.8;
    let tx = this.camX;
    let ty = this.camY;
    if (ix - this.camX > dzx) tx = ix - dzx;
    else if (ix - this.camX < -dzx) tx = ix + dzx;
    if (targetY - this.camY > dzy) ty = targetY - dzy;
    else if (targetY - this.camY < -dzy) ty = targetY + dzy;
    const k = 1 - Math.exp(-dt * 7);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    const halfTilesW = this.w / this.scale / TS / 2;
    const minX = Math.min(halfTilesW - 0.5, T.WORLD_W / 2);
    const maxX = Math.max(T.WORLD_W - halfTilesW + 0.5, T.WORLD_W / 2);
    if (this.camX < minX) this.camX = minX;
    if (this.camX > maxX) this.camX = maxX;

    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.05) this.shake = 0;
    const sx = this.shake > 0 ? (Math.random() - 0.5) * 2 * this.shake : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * 2 * this.shake : 0;

    const sc = this.scale;
    const ox = Math.round(this.w / 2 - this.camX * TS * sc + sx * sc);
    const oy = Math.round(this.h / 2 - this.camY * TS * sc + sy * sc);
    ctx.setTransform(sc, 0, 0, sc, ox, oy);

    const vx0 = -ox / sc;
    const vy0 = -oy / sc;
    const vx1 = vx0 + this.w / sc;
    const vy1 = vy0 + this.h / sc;

    // background: sky, walls
    ctx.fillStyle = '#2b1f17';
    ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    if (vy0 < 0) {
      ctx.fillStyle = this.sky;
      ctx.fillRect(vx0, vy0, vx1 - vx0, Math.min(0, vy1) - vy0);
    }
    ctx.fillStyle = COLOR[Tile.BEDROCK];
    if (vx0 < 0) ctx.fillRect(vx0, vy0, -vx0, vy1 - vy0);
    if (vx1 > T.WORLD_W * TS) ctx.fillRect(T.WORLD_W * TS, vy0, vx1 - T.WORLD_W * TS, vy1 - vy0);

    // chunks
    const tx0 = Math.max(0, Math.floor(vx0 / TS));
    const tx1 = Math.min(T.WORLD_W - 1, Math.floor(vx1 / TS));
    const ty0 = Math.max(0, Math.floor(vy0 / TS));
    const ty1 = Math.floor(vy1 / TS);
    const cx0 = tx0 >> 4, cx1 = tx1 >> 4, cy0 = ty0 >> 4, cy1 = ty1 >> 4;
    if (vy1 > 0) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          ctx.drawImage(this.chunkCanvas(cx, cy), 0, 0, CHPX, CHPX, cx * CHPX, cy * CHPX, CHPX + 0.6, CHPX + 0.6);
        }
      }
    }
    // drop far canvases (memory)
    if (this.chunks.size > 30) {
      for (const key of this.chunks.keys()) {
        const ccy = Math.floor(key / T.CHUNKS_X);
        if (ccy < cy0 - 2 || ccy > cy1 + 2) this.chunks.delete(key);
      }
    }

    // glows for lava / heal
    const world = s.world;
    ctx.globalCompositeOperation = 'lighter';
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        const t = world.get(x, y);
        if (t === Tile.LAVA) {
          ctx.globalAlpha = 0.45 + 0.15 * Math.sin(this.time * 3 + x * 1.7 + y);
          ctx.drawImage(this.lavaGlow, (x - 1.2) * TS, (y - 1.2) * TS, TS * 3.4, TS * 3.4);
        } else if (t === Tile.HEAL) {
          ctx.globalAlpha = 0.5 + 0.25 * Math.sin(this.time * 4 + x);
          ctx.drawImage(this.healGlow, (x - 0.8) * TS, (y - 0.8) * TS, TS * 2.6, TS * 2.6);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // sand blocks from sim state
    const blocks = s.sand.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.falling) {
        drawTile(ctx, b.tile, b.x, b.y, b.x * TS, (b.y + b.acc / T.fallStepDeci) * TS);
      } else {
        ctx.fillStyle = COLOR[Tile.EMPTY];
        ctx.fillRect(b.x * TS, b.y * TS, TS, TS);
        const wob = Math.sin(b.t * 1.7) * (1.5 + b.t * 0.12);
        drawTile(ctx, b.tile, b.x, b.y, b.x * TS + wob, b.y * TS + Math.abs(wob) * 0.4);
        if (b.t % 5 === 0 && Math.random() < 0.4) emit((b.x + Math.random()) * TS, (b.y + 1) * TS, 0, 30, 0.4, 3, 300, '#ccb366');
      }
    }

    // drill crack overlay
    const dr = pod.drill;
    if (dr !== null && !s.dead) {
      const prog = 1 - dr.ticksLeft / dr.total;
      const cx = (dr.tx + 0.5) * TS;
      const cy = (dr.ty + 0.5) * TS;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const n = Math.max(1, Math.ceil(prog * CRACK_A.length));
      const len = (0.25 + prog * 0.75) * TS * 0.5;
      for (let i = 0; i < n; i++) {
        const ang = CRACK_A[i];
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * len * 0.55 + Math.sin(ang * 3) * 4, cy + Math.sin(ang) * len * 0.55);
        ctx.lineTo(cx + Math.cos(ang + 0.25) * len, cy + Math.sin(ang + 0.25) * len);
      }
      ctx.stroke();
      if ((s.tick & 3) === 0) {
        emit(cx + (Math.random() - 0.5) * 20, cy + (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 120, -40 - Math.random() * 60, 0.4, 3, 400, FLECK[world.get(dr.tx, dr.ty)]);
      }
    }

    // pod
    if (!s.dead) this.drawPod(ctx, ix * TS, iy * TS, input);

    // particles + floating text
    for (let i = 0; i < pcount; i++) {
      if (plife[i] <= 0) continue;
      plife[i] -= dt;
      pvy[i] += pgrav[i] * dt;
      px_[i] += pvx[i] * dt;
      py_[i] += pvy[i] * dt;
      ctx.globalAlpha = Math.max(0, plife[i] / pmax[i]);
      ctx.fillStyle = pcol[i];
      ctx.fillRect(px_[i], py_[i], psize[i], psize[i]);
    }
    ctx.globalAlpha = 1;

    this.drawDarkness(ctx, ox + ix * TS * sc, oy + iy * TS * sc, iy);
    ctx.setTransform(sc, 0, 0, sc, ox, oy);
    this.drawRadar(ctx);

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    for (let i = 0; i < NF; i++) {
      if (ftl[i] <= 0) continue;
      ftl[i] -= dt;
      fty[i] -= 50 * dt;
      ctx.globalAlpha = Math.min(1, ftl[i] * 2);
      ctx.strokeText(ftt[i], ftx[i], fty[i]);
      ctx.fillStyle = ftc[i];
      ctx.fillText(ftt[i], ftx[i], fty[i]);
    }
    ctx.globalAlpha = 1;

    // damage flash (screen space)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,30,30,${this.flash})`;
      ctx.fillRect(0, 0, this.w, this.h);
      this.flash *= Math.exp(-dt * 6);
    }

    const st = this.stats;
    st.tilesPerSec = this.changesSecond;
    st.chunksLoaded = world.chunks.size;
    st.chunkCanvases = this.chunks.size;
    st.podHash = podHash(pod);
  }

  // One radial-gradient fill over the whole screen: clear near the pod, ~96% dark outside.
  // Screen space; the gradient is only rebuilt when its centre or radii change.
  private drawDarkness(ctx: CanvasRenderingContext2D, cx: number, cy: number, row: number): void {
    const L = T.light;
    const rTiles = lightRadius(row < 0 ? 0 : row);
    const px = TS * this.scale;
    const rOut = rTiles * px;
    const rIn = Math.max(0, (rTiles - L.edge) * px);
    const far = Math.max(cx, this.w - cx) ** 2 + Math.max(cy, this.h - cy) ** 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rIn * rIn > far) return; // light covers the whole screen
    const k = this.darkKey;
    if (this.dark === null || k[0] !== cx || k[1] !== cy || k[2] !== rIn || k[3] !== rOut) {
      const g = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${L.darkAlpha})`);
      this.dark = g;
      k[0] = cx; k[1] = cy; k[2] = rIn; k[3] = rOut;
    }
    ctx.fillStyle = this.dark;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  // Radar ring and ore highlights, drawn after the darkness so they show through it.
  private drawRadar(ctx: CanvasRenderingContext2D): void {
    const t = this.time - this.radarStart;
    if (t < 0 || t > T.radarShowSeconds) return;
    const R = T.radarRadius;
    if (t < T.radarRingSeconds) {
      const f = t / T.radarRingSeconds;
      ctx.strokeStyle = `rgba(120,230,255,${(1 - f) * 0.9})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(this.radarX, this.radarY, f * R * TS, 0, Math.PI * 2);
      ctx.stroke();
    }
    const fade = Math.min(1, (T.radarShowSeconds - t) / 0.6);
    const pulse = 0.65 + 0.35 * Math.sin(this.time * 6);
    const world = this.s.world;
    const buf = this.radarBuf;
    for (let i = 0; i < this.radarCount; i++) {
      const x = buf[i * RADAR_STRIDE];
      const y = buf[i * RADAR_STRIDE + 1];
      const kind = buf[i * RADAR_STRIDE + 2];
      const dx = (x + 0.5) * TS - this.radarX;
      const dy = (y + 0.5) * TS - this.radarY;
      if (t < (Math.sqrt(dx * dx + dy * dy) / (R * TS)) * T.radarRingSeconds) continue; // ring has not reached it yet
      if (world.get(x, y) === Tile.EMPTY) continue; // already mined
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fade * pulse * 0.8;
      ctx.drawImage(this.radarGlow[kind], (x - 0.9) * TS, (y - 0.9) * TS, TS * 2.8, TS * 2.8);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = fade * (0.5 + 0.5 * pulse);
      ctx.strokeStyle = RADAR_CSS[kind];
      ctx.lineWidth = 3;
      ctx.strokeRect(x * TS + 2, y * TS + 2, TS - 4, TS - 4);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPod(ctx: CanvasRenderingContext2D, cx: number, cy: number, input: PodInput): void {
    const s = this.s;
    const pod = s.player.pod;
    if (s.invulnerable && Math.floor(this.time * 10) % 2 === 0) ctx.globalAlpha = 0.35;
    const fx = pod.fx;
    const fy = pod.fy;
    const drilling = pod.drill !== null || pod.glide !== null;

    // thrust flame
    if (input.up && !drilling) {
      const fl = 14 + Math.random() * 10;
      ctx.fillStyle = '#ffb02e';
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + HALF);
      ctx.lineTo(cx + 9, cy + HALF);
      ctx.lineTo(cx, cy + HALF + fl);
      ctx.fill();
      ctx.fillStyle = '#fff3a0';
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy + HALF);
      ctx.lineTo(cx + 4, cy + HALF);
      ctx.lineTo(cx, cy + HALF + fl * 0.55);
      ctx.fill();
      if (Math.random() < 0.6) emit(cx + (Math.random() - 0.5) * 8, cy + HALF + 6, (Math.random() - 0.5) * 30, 120, 0.35, 3, 0, '#ffa040');
    }

    // drill bit
    const jitter = drilling ? (Math.floor(this.time * 40) % 2) * 2 - 1 : 0;
    const dxn = fy !== 0 ? 0 : fx >= 0 ? 1 : -1;
    const dyn = fy !== 0 ? 1 : 0;
    const bx = cx + dxn * HALF;
    const by = cy + dyn * HALF;
    ctx.fillStyle = '#9aa0a8';
    ctx.beginPath();
    if (dyn !== 0) {
      ctx.moveTo(bx - 11, by);
      ctx.lineTo(bx + 11, by);
      ctx.lineTo(bx + jitter, by + 17);
    } else {
      ctx.moveTo(bx, by - 11);
      ctx.lineTo(bx, by + 11);
      ctx.lineTo(bx + dxn * 17, by + jitter);
    }
    ctx.fill();
    ctx.strokeStyle = '#5d636b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // body
    ctx.fillStyle = '#f08a24';
    ctx.fillRect(cx - HALF, cy - HALF, HALF * 2, HALF * 2);
    ctx.strokeStyle = '#8a4a0c';
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - HALF + 1.5, cy - HALF + 1.5, HALF * 2 - 3, HALF * 2 - 3);
    // visor
    ctx.fillStyle = '#9fe3ff';
    const vx = cx - 9 + dxn * 4;
    ctx.fillRect(vx, cy - 11, 18, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(vx + 2, cy - 10, 6, 3);
    // tracks
    ctx.fillStyle = '#4b3a2a';
    ctx.fillRect(cx - HALF + 2, cy + HALF - 6, HALF * 2 - 4, 5);
    ctx.globalAlpha = 1;

    // nickname
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(s.nickname, cx, cy - HALF - 12);
    ctx.fillStyle = '#fff';
    ctx.fillText(s.nickname, cx, cy - HALF - 12);
  }
}
