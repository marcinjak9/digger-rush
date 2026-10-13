import { Room, ServerError, type Client } from '@colyseus/core';
import {
  BUY_BAD, BUY_COOLDOWN, BUY_DEAD, BUY_FUNDS, BUY_MAX, BUY_OK, EV_BUY, EV_DEATH, EV_DIG, EV_HEAL, EV_RESPAWN, MSG, OF_DEAD, OF_DRILLING, OF_FACE_DOWN, OF_FACE_RIGHT, OF_INVULN, OF_THRUSTING,
  OTHER_STRIDE, SAND_CALM, SAND_FALL, SAND_HIT, SAND_LAND, SAND_WOBBLE, SIM_VERSION, SandSim, T, UPGRADE_KINDS, World,
  buyUpgrade, chunkKeyOfTile, clampTicks, clearSimEvents, createPlayer, encodePod, inPodInterest,
  inputFromMask, isNewerSeq, isSolid, maxHpOf, newPlayer, newSimEvents, sanitizeNickname, spawnPod, stepPlayerTick,
  stepWorldAfter, tryRadar, u32, writeStats, Tile,
  type BuyMsg, type InMsg, type JoinOptions, type PingMsg, type PodState, type SimEvents, type SimPlayer, type SnapMsg,
  type UpgradeKind, type WelcomeMsg, type SandEvent,
} from '@digger/shared';
import { serverConfig } from './config.js';
import { HealSpawner } from './healSpawner.js';
import { InterestIndex, chunkDiffFlat, dropSubscription, evictFarChunks, updateSubscription, type InterestState } from './interest.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const Q = T.QUANT;
const POLL_MS = 8;
const MAX_CATCHUP_TICKS = 3;

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h | 0;
}

export interface RoomStats {
  rejected: number; // malformed messages
  staleSeq: number; // replayed / old input seq
  clamped: number; // commands whose ticks were clamped
  overflow: number; // commands dropped because the queue was full
  rateLimited: number;
  inputTicks: number; // sim ticks consumed from commands, all players
}

// Everything the server knows about one player. Survives a disconnect for the reconnect window.
export class PlayerRec implements InterestState {
  readonly subs = new Set<number>();
  cx = NaN;
  cy = NaN;
  client: Client | null = null;
  ready = false;
  everReady = false;
  disconnectedAt = 0;
  readonly known = new Set<number>(); // other pod ids the client has been told about
  readonly visible: PlayerRec[] = [];

  // input queue (ring of fixed capacity)
  readonly qSeq = new Int32Array(T.net.inputQueueMax);
  readonly qTicks = new Uint8Array(T.net.inputQueueMax);
  readonly qMask = new Uint8Array(T.net.inputQueueMax);
  qHead = 0;
  qLen = 0;
  lastSeq = 0; // last accepted seq
  ackSeq = 0; // last consumed seq
  allowance = 0;
  lastMask = 0;

  // outgoing buffers, reused every tick
  readonly tilesBuf: number[] = [];
  readonly sandBuf: number[] = [];
  readonly evBuf: number[] = [];
  readonly podBuf: number[] = [];
  readonly stBuf: number[] = [];
  readonly snap: SnapMsg = { t: 0, a: 0, p: [], s: [], o: [] };
  readonly tilesMsg = { d: this.tilesBuf };
  readonly sandMsg = { d: this.sandBuf };
  readonly evMsg = { d: this.evBuf };

  // rate limits (per second window)
  rateWindow = 0;
  buys = 0;
  radars = 0;
  pings = 0;
  violations = 0;
  lastBuyTick = -1000;

  constructor(readonly id: number, readonly token: string, readonly nick: string, readonly sim: SimPlayer) {}

  get connected(): boolean {
    return this.client !== null;
  }
}

export class DigRoom extends Room {
  readonly world = new World(T.SEED);
  readonly sand = new SandSim();
  readonly heal = new HealSpawner(this.world);
  readonly stats: RoomStats = { rejected: 0, staleSeq: 0, clamped: 0, overflow: 0, rateLimited: 0, inputTicks: 0 };
  serverTick = 0;
  worldTick = 0;
  readonly players = new Map<number, PlayerRec>(); // by id, ascending insertion order
  private readonly byToken = new Map<string, PlayerRec>();
  private readonly bySession = new Map<string, PlayerRec>();
  private readonly interest = new InterestIndex<PlayerRec>();
  private readonly out: SimEvents = newSimEvents();
  private active: SimPlayer[] = [];
  private activeDirty = true;
  private nextId = 1;
  private idleSince = 0;
  private lastPollAt = 0;
  private tickDebtMs = 0;
  private lbRecs: PlayerRec[] = [];
  private readonly podScratch: PodState[] = [];

  override onCreate(): void {
    this.autoDispose = false; // we dispose ourselves after roomIdleMs without players
    this.maxClients = serverConfig.maxClients;
    this.setPatchRate(null as unknown as number);
    this.idleSince = Date.now();
    this.lastPollAt = performance.now();
    this.onMessage(MSG.READY, (c) => this.onReady(c));
    this.onMessage(MSG.IN, (c, m: unknown) => this.onInput(c, m));
    this.onMessage(MSG.BUY, (c, m: unknown) => this.onBuy(c, m));
    this.onMessage(MSG.RADAR, (c) => this.onRadar(c));
    this.onMessage(MSG.PING, (c, m: unknown) => this.onPing(c, m));
    this.onMessage('*', (c) => {
      this.stats.rejected++;
      const rec = this.bySession.get(c.sessionId);
      if (rec !== undefined) this.violate(rec);
    });
    // Fixed 30 Hz timestep driven by a fast poll: coarse OS timers (Windows rounds a 33 ms interval up to
    // ~47 ms) would otherwise slow the whole game down. Late ticks are made up for, a few at a time.
    this.setSimulationInterval(() => this.poll(), POLL_MS);
  }

  // ------------------------------------------------------------------ join / leave

  override onAuth(_client: Client, options: Partial<JoinOptions> | undefined): { nick: string; token: string } {
    const o = options ?? {};
    if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) throw new ServerError(4400, 'Invalid session token.');
    const nick = sanitizeNickname(o.nickname);
    if (!nick.ok) throw new ServerError(4401, nick.error);
    if (o.simVersion !== undefined && o.simVersion !== SIM_VERSION) {
      throw new ServerError(4402, 'Your game version is out of date. Please reload the page.');
    }
    return { nick: nick.name, token: o.token };
  }

  override onJoin(client: Client, _options: unknown, auth: { nick: string; token: string }): void {
    let rec = this.byToken.get(auth.token);
    if (rec !== undefined) {
      // Reattach to the surviving player (reconnect, or the same token opened twice).
      const old = rec.client;
      if (old !== null) {
        this.bySession.delete(old.sessionId);
        rec.client = null;
        old.leave(4403, 'Opened elsewhere.');
        dropSubscription(this.interest, rec);
      }
    } else {
      const id = this.nextId++;
      const salt = u32(T.SEED, id, hashString(auth.token), 91) & 0x3fffffff;
      const sim = createPlayer(id, newPlayer(0), this.world, salt);
      rec = new PlayerRec(id, auth.token, auth.nick, sim);
      this.players.set(id, rec);
      this.byToken.set(auth.token, rec);
    }
    rec.client = client;
    rec.ready = false;
    rec.disconnectedAt = 0;
    this.bySession.set(client.sessionId, rec);
    this.activeDirty = true;
    this.idleSince = 0;
  }

  override onLeave(client: Client, consented: boolean): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined) return;
    this.bySession.delete(client.sessionId);
    if (rec.client !== client) return; // replaced by a newer connection
    rec.client = null;
    rec.ready = false;
    dropSubscription(this.interest, rec);
    this.activeDirty = true;
    if (consented) this.removePlayer(rec);
    else rec.disconnectedAt = Date.now();
  }

  override onDispose(): void {
    this.players.clear();
    this.byToken.clear();
    this.bySession.clear();
  }

  private removePlayer(rec: PlayerRec): void {
    dropSubscription(this.interest, rec);
    this.players.delete(rec.id);
    this.byToken.delete(rec.token);
    this.activeDirty = true;
  }

  private onReady(client: Client): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined || rec.ready) return;
    const sim = rec.sim;
    const resumed = rec.everReady;
    if (resumed && sim.deadTicks <= 0 && this.podBuried(sim)) {
      // Sand landed on the frozen pod while it was away: put it back on the surface, protected.
      sim.spawnSalt = (sim.spawnSalt + 1) | 0;
      sim.pod = spawnPod(this.world, sim.id, sim.spawnSalt);
      sim.invulnTicks = T.invulnTicks;
    }
    rec.ready = true;
    rec.everReady = true;
    rec.disconnectedAt = 0;
    rec.lastSeq = 0;
    rec.ackSeq = 0;
    rec.qHead = 0;
    rec.qLen = 0;
    rec.allowance = 0;
    rec.known.clear();
    rec.tilesBuf.length = 0;
    rec.sandBuf.length = 0;
    rec.evBuf.length = 0;
    const msg: WelcomeMsg = {
      id: rec.id,
      nick: rec.nick,
      seed: this.world.seed,
      simVersion: SIM_VERSION,
      tickHz: T.TICK_HZ,
      serverHz: serverConfig.serverHz,
      roomId: this.roomId,
      resumed,
      tick: this.serverTick,
      pod: encodePod(sim.pod),
      st: writeStats(sim.stats, sim.deadTicks, sim.invulnTicks, sim.finalScore),
    };
    client.send(MSG.WELCOME, msg);
    this.syncInterest(rec, true);
  }

  private podBuried(sim: SimPlayer): boolean {
    const p = sim.pod;
    const h = T.podHalf;
    const x0 = Math.floor(p.x - h + T.collideEps);
    const x1 = Math.floor(p.x + h - T.collideEps);
    const y0 = Math.floor(p.y - h + T.collideEps);
    const y1 = Math.floor(p.y + h - T.collideEps);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isSolid(this.world.get(x, y))) return true;
    return false;
  }

  // ------------------------------------------------------------------ messages

  private violate(rec: PlayerRec): void {
    if (++rec.violations > T.net.maxViolations && rec.client !== null) rec.client.leave(4404, 'Too many invalid messages.');
  }

  private window(rec: PlayerRec): void {
    const w = Math.floor(Date.now() / 1000);
    if (w !== rec.rateWindow) {
      rec.rateWindow = w;
      rec.buys = 0;
      rec.radars = 0;
      rec.pings = 0;
    }
  }

  private onInput(client: Client, m: unknown): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined || !rec.ready) return;
    const msg = m as Partial<InMsg> | null;
    if (msg === null || typeof msg !== 'object') { this.stats.rejected++; this.violate(rec); return; }
    const { seq, ticks, mask } = msg;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 0x7fffffff ||
      typeof ticks !== 'number' || !Number.isFinite(ticks) ||
      typeof mask !== 'number' || !Number.isInteger(mask) || mask < 0 || mask > 15) {
      this.stats.rejected++;
      this.violate(rec);
      return;
    }
    if (!isNewerSeq(seq, rec.lastSeq)) { this.stats.staleSeq++; return; }
    const t = clampTicks(ticks);
    if (t !== ticks) this.stats.clamped++;
    if (rec.qLen >= T.net.inputQueueMax) { this.stats.overflow++; return; }
    const i = (rec.qHead + rec.qLen) % T.net.inputQueueMax;
    rec.qSeq[i] = seq;
    rec.qTicks[i] = t;
    rec.qMask[i] = mask;
    rec.qLen++;
    rec.lastSeq = seq;
  }

  private onBuy(client: Client, m: unknown): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined || !rec.ready) return;
    this.window(rec);
    if (++rec.buys > T.net.maxBuyPerSec) { this.stats.rateLimited++; return; }
    const kind = (m as Partial<BuyMsg> | null)?.kind;
    const ki = typeof kind === 'string' ? UPGRADE_KINDS.indexOf(kind as UpgradeKind) : -1;
    if (ki < 0) {
      this.stats.rejected++;
      this.violate(rec);
      rec.evBuf.push(EV_BUY, -1, BUY_BAD);
      return;
    }
    // Everything below is decided from server state only: alive, cooldown, funds. Wallet is the only thing spent.
    let code: number;
    if (rec.sim.deadTicks > 0) code = BUY_DEAD;
    else if (this.serverTick - rec.lastBuyTick < T.net.buyCooldownTicks) { code = BUY_COOLDOWN; this.stats.rateLimited++; }
    else {
      rec.lastBuyTick = this.serverTick;
      const r = buyUpgrade(rec.sim.stats, kind as UpgradeKind);
      code = r === 'ok' ? BUY_OK : r === 'funds' ? BUY_FUNDS : BUY_MAX;
    }
    rec.evBuf.push(EV_BUY, ki, code);
  }

  private onRadar(client: Client): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined || !rec.ready) return;
    this.window(rec);
    if (++rec.radars > T.net.maxRadarPerSec) { this.stats.rateLimited++; return; }
    if (rec.sim.deadTicks > 0) return;
    tryRadar(rec.sim.stats);
  }

  private onPing(client: Client, m: unknown): void {
    const rec = this.bySession.get(client.sessionId);
    if (rec === undefined) return;
    this.window(rec);
    if (++rec.pings > T.net.maxPingPerSec) { this.stats.rateLimited++; return; }
    const t = (m as Partial<PingMsg> | null)?.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) { this.stats.rejected++; this.violate(rec); return; }
    client.send(MSG.PONG, { t });
  }

  // ------------------------------------------------------------------ simulation tick

  private activePlayers(): SimPlayer[] {
    if (this.activeDirty) {
      this.active = [];
      for (const rec of this.players.values()) if (rec.client !== null) this.active.push(rec.sim);
      this.activeDirty = false;
    }
    return this.active;
  }

  private poll(): void {
    const t = performance.now();
    const stepMs = 1000 / serverConfig.serverHz;
    this.tickDebtMs += t - this.lastPollAt;
    this.lastPollAt = t;
    if (this.tickDebtMs > stepMs * MAX_CATCHUP_TICKS) this.tickDebtMs = stepMs * MAX_CATCHUP_TICKS;
    while (this.tickDebtMs >= stepMs) {
      this.tickDebtMs -= stepMs;
      this.tick();
    }
  }

  private tick(): void {
    const now = Date.now();
    this.serverTick++;
    const out = this.out;
    const simTicks = T.net.simTicksPerServerTick;

    // 1. player pods: consume queued commands within the tick allowance
    for (const rec of this.players.values()) {
      if (rec.client === null) continue;
      rec.allowance += simTicks;
      if (rec.allowance > T.net.burstTicks) rec.allowance = T.net.burstTicks;
      this.consumeInputs(rec);
    }

    // 2. the world: sand, hits, deaths, respawn timers
    const active = this.activePlayers();
    for (let i = 0; i < simTicks; i++) {
      this.worldTick++;
      stepWorldAfter(this.world, this.sand, active, this.worldTick, out);
      this.routeOut();
    }

    // 2b. heal ore respawn: one chunk of the active ring per attempt, through the normal tile delta path
    const hr = T.healRespawn;
    if (this.serverTick % hr.ringRebuildTicks === 1) this.heal.rebuild(this.interest.keys());
    if (this.serverTick % hr.attemptEveryTicks === 0) {
      const pods = this.podScratch;
      pods.length = 0;
      for (const rec of this.players.values()) pods.push(rec.sim.pod);
      this.heal.attempt(pods);
    }

    // 3. interest: new/left chunks, then bucket this tick's tile changes to subscribers
    for (const rec of this.players.values()) if (rec.ready) this.syncInterest(rec, false);
    const changes = this.world.drainChanges();
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      const subs = this.interest.get(chunkKeyOfTile(ch.x, ch.y));
      if (subs === undefined) continue;
      const v = ch.tile | (ch.aux << 8);
      for (let k = 0; k < subs.length; k++) subs[k].tilesBuf.push(ch.x, ch.y, v);
    }

    // 4. send
    if (this.serverTick % T.net.snapEveryTicks === 0) {
      for (const rec of this.players.values()) if (rec.ready && rec.client !== null) this.sendFrame(rec);
    }
    if (this.serverTick % T.net.leaderboardEveryTicks === 0) this.sendLeaderboard();
    if (this.serverTick % T.net.evictEveryTicks === 0) evictFarChunks(this.world, this.interest);

    // 5. housekeeping: reconnect window and idle room
    for (const rec of this.players.values()) {
      if (rec.client === null && rec.disconnectedAt > 0 && now - rec.disconnectedAt >= serverConfig.reconnectWindowMs) {
        this.removePlayer(rec);
      }
    }
    if (this.players.size === 0 && this.clients.length === 0) {
      if (this.idleSince === 0) this.idleSince = now;
      else if (now - this.idleSince >= serverConfig.roomIdleMs) void this.disconnect();
    } else {
      this.idleSince = 0;
    }
  }

  private consumeInputs(rec: PlayerRec): void {
    const sim = rec.sim;
    const cap = T.net.inputQueueMax;
    while (rec.qLen > 0) {
      const h = rec.qHead;
      const ticks = rec.qTicks[h];
      if (sim.deadTicks > 0) {
        rec.ackSeq = rec.qSeq[h]; // inputs sent while dead are discarded
      } else {
        if (rec.allowance < ticks) break; // consumed atomically, only with enough allowance
        rec.allowance -= ticks;
        const input = inputFromMask(rec.qMask[h]);
        rec.lastMask = rec.qMask[h];
        for (let i = 0; i < ticks; i++) {
          stepPlayerTick(this.world, sim, input, this.out);
          this.routeOut(rec);
        }
        this.stats.inputTicks += ticks;
        rec.ackSeq = rec.qSeq[h];
      }
      rec.qHead = (h + 1) % cap;
      rec.qLen--;
    }
  }

  // Turns the events of the last sim step into personal events and routed sand events, then clears them.
  private routeOut(stepper?: PlayerRec): void {
    const out = this.out;
    if (out.dug.length > 0 && stepper !== undefined) {
      for (const d of out.dug) {
        stepper.evBuf.push(EV_DIG, d.x, d.y, d.tile | (d.aux << 8));
        if (d.tile === Tile.HEAL) stepper.evBuf.push(EV_HEAL); // shared onDug already healed 50% max hp, no money/score
      }
    }
    for (const id of out.deaths) {
      const r = this.players.get(id);
      if (r !== undefined) r.evBuf.push(EV_DEATH, r.sim.finalScore);
    }
    for (const id of out.respawns) {
      const r = this.players.get(id);
      if (r !== undefined) r.evBuf.push(EV_RESPAWN);
    }
    for (const e of out.sand) this.routeSand(e);
    clearSimEvents(out);
  }

  private routeSand(e: SandEvent): void {
    const subs = this.interest.get(chunkKeyOfTile(Math.floor(e.x), Math.floor(e.y)));
    if (subs === undefined) return;
    const kind = e.kind === 'wobble' ? SAND_WOBBLE : e.kind === 'fall' ? SAND_FALL : e.kind === 'land' ? SAND_LAND
      : e.kind === 'hit' ? SAND_HIT : SAND_CALM;
    for (let k = 0; k < subs.length; k++) subs[k].sandBuf.push(kind, e.x, e.y);
  }

  // ------------------------------------------------------------------ interest + frames

  private syncInterest(rec: PlayerRec, force: boolean): void {
    const client = rec.client;
    if (client === null) return;
    const pod = rec.sim.pod;
    let added: Array<[number, number[]]> | null = null;
    let removed: number[] | null = null;
    updateSubscription(this.interest, rec, pod.x, pod.y, force, (key) => {
      const diff = chunkDiffFlat(this.world, key);
      if (diff.length === 0) return;
      (added ??= []).push([key, diff]);
    }, (key) => {
      (removed ??= []).push(key);
    });
    if (removed !== null) client.send(MSG.UNSUB, { k: removed });
    if (added !== null) client.send(MSG.CHUNKS, { c: added });
  }

  private sendFrame(rec: PlayerRec): void {
    const client = rec.client as Client;
    const sim = rec.sim;
    const pod = sim.pod;

    // other pods in range (connected, ready); roster changes first so the client knows names
    const vis = rec.visible;
    vis.length = 0;
    for (const o of this.players.values()) {
      if (o === rec || o.client === null || !o.ready) continue;
      if (inPodInterest(pod.x, pod.y, o.sim.pod.x, o.sim.pod.y)) vis.push(o);
    }
    for (const o of vis) {
      if (!rec.known.has(o.id)) {
        rec.known.add(o.id);
        client.send(MSG.JOINED, { id: o.id, nick: o.nick });
      }
    }
    if (rec.known.size > vis.length) {
      for (const id of rec.known) {
        let still = false;
        for (const o of vis) if (o.id === id) { still = true; break; }
        if (!still) {
          rec.known.delete(id);
          client.send(MSG.LEFT, { id });
        }
      }
    }

    if (rec.tilesBuf.length > 0) { client.send(MSG.TILES, rec.tilesMsg); rec.tilesBuf.length = 0; }
    if (rec.sandBuf.length > 0) { client.send(MSG.SAND, rec.sandMsg); rec.sandBuf.length = 0; }
    if (rec.evBuf.length > 0) { client.send(MSG.EV, rec.evMsg); rec.evBuf.length = 0; }

    const s = rec.snap;
    s.t = this.serverTick;
    s.a = rec.ackSeq;
    s.p = encodePod(pod, rec.podBuf);
    s.s = writeStats(sim.stats, sim.deadTicks, sim.invulnTicks, sim.finalScore, rec.stBuf);
    const o = s.o;
    o.length = 0;
    for (const r of vis) {
      const rp = r.sim.pod;
      const dead = r.sim.deadTicks > 0;
      const drilling = rp.drill !== null || rp.glide !== null;
      let flags = 0;
      if (rp.fx >= 0 && rp.fy === 0) flags |= OF_FACE_RIGHT;
      if (rp.fy !== 0) flags |= OF_FACE_DOWN;
      if (drilling) flags |= OF_DRILLING;
      else if ((r.lastMask & 4) !== 0 && !rp.grounded) flags |= OF_THRUSTING;
      if (dead) flags |= OF_DEAD;
      if (r.sim.invulnTicks > 0) flags |= OF_INVULN;
      const max = maxHpOf(r.sim.stats.lvl);
      const hf = Math.max(0, Math.min(255, Math.round((r.sim.stats.hull / max) * 255)));
      o.push(r.id, Math.round(rp.x * Q), Math.round(rp.y * Q), flags, hf);
    }
    client.send(MSG.SNAP, s);
  }

  // Top 3 by highScore (ties by id) plus each player's own rank / highScore / score. Disconnected players
  // inside their reconnect window are still listed. highScore already includes the live score.
  private sendLeaderboard(): void {
    const recs = this.lbRecs;
    recs.length = 0;
    for (const r of this.players.values()) recs.push(r);
    recs.sort((a, b) => b.sim.stats.highScore - a.sim.stats.highScore || a.id - b.id);
    const top: Array<[string, number, number]> = [];
    for (let i = 0; i < recs.length && i < 3; i++) top.push([recs[i].nick, recs[i].sim.stats.highScore, recs[i].id]);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.client === null || !r.ready) continue;
      r.client.send(MSG.LB, { top, rank: i + 1, n: recs.length, hi: r.sim.stats.highScore, sc: r.sim.stats.score });
    }
  }

  // ------------------------------------------------------------------ test / ops helpers

  playerByToken(token: string): PlayerRec | undefined {
    return this.byToken.get(token);
  }
}
