'use strict';
// UFO Arena - tiny authoritative game server (Node.js + ws)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---- Settings ----
const W = 1600, H = 900, R = 20;          // arena size, ufo radius
const MAX_PLAYERS = 10;
const TICK_MS = 33;                        // ~30 updates / second
const BASE_SPEED = 280;
const MAX_HP = 100;
const EFFECT_MS = 7000;                    // bonus duration
const RESPAWN_MS = 5000;
const SPAWN_SHIELD_MS = 2000;
const BULLET_SPEED = 760, BULLET_LIFE = 1100;
const DASH_SPEED = 1100, DASH_MS = 170, DASH_CD = 10000;
const SPECIAL_CD = 40000;
const BONUS_TYPES = ['speed', 'rapid', 'shield', 'triple', 'power', 'heal'];
const TIMED = ['speed', 'rapid', 'shield', 'triple', 'power'];
const MAX_BONUSES = 6, BONUS_EVERY_MS = 3000, BONUS_LIFE_MS = 25000;

// ---- State ----
let nextPlayerId = 1, nextBulletId = 1, nextBonusId = 1;
const players = new Map();
let bullets = [];
let bonuses = [];
let lastBonusSpawn = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---- HTTP (serves index.html so you can host everything in one place) ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 512 });

function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || 'Pilot';
}

function spawnPoint() {
  // pick the random point that is farthest from living players
  let best = { x: W / 2, y: H / 2 }, bestD = -1;
  for (let i = 0; i < 12; i++) {
    const x = rand(80, W - 80), y = rand(80, H - 80);
    let md = 1e9;
    for (const p of players.values()) if (!p.dead) md = Math.min(md, Math.hypot(p.x - x, p.y - y));
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  return best;
}

function createPlayer(ws, name) {
  const sp = spawnPoint();
  const now = Date.now();
  return {
    id: nextPlayerId++, ws, name: cleanName(name),
    x: sp.x, y: sp.y, vx: 0, vy: 0, hp: MAX_HP, ang: 0,
    input: { u: false, d: false, l: false, r: false, s: false },
    lastShot: 0, dead: false, respawnAt: 0, killedBy: '', kills: 0,
    fx: { speed: 0, rapid: 0, shield: 0, triple: 0, power: 0 },
    spawnShield: now + SPAWN_SHIELD_MS,
    dashReady: 0, dashUntil: 0, dashDx: 0, dashDy: 0, wasDashing: false,
    specialReady: 0
  };
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !player) {
      if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      player = createPlayer(ws, m.name);
      players.set(player.id, player);
      send(ws, { t: 'init', id: player.id, w: W, h: H, max: MAX_PLAYERS });
    } else if (m.t === 'in' && player) {
      player.input = { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r, s: !!m.s };
      if (Number.isFinite(m.a)) player.ang = m.a;
    } else if (m.t === 'dash' && player) {
      doDash(player, Date.now());
    } else if (m.t === 'sp' && player) {
      doSpecial(player, Number(m.v), Date.now());
    }
  });

  ws.on('close', () => { if (player) players.delete(player.id); });
  ws.on('error', () => { /* ignore */ });
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

// ---- Game logic ----
function isProtected(p, now) {
  return p.fx.shield > now || p.spawnShield > now;
}

function fire(p, now) {
  const angles = p.fx.triple > now ? [-0.22, 0, 0.22] : [0];
  const dmg = p.fx.power > now ? 45 : 25;
  for (const off of angles) {
    const a = p.ang + off;
    const dx = Math.cos(a), dy = Math.sin(a);
    bullets.push({
      id: nextBulletId++, o: p.id,
      x: p.x + dx * (R + 4), y: p.y + dy * (R + 4),
      px: p.x, py: p.y,
      vx: dx * BULLET_SPEED, vy: dy * BULLET_SPEED,
      dmg, born: now, life: BULLET_LIFE, rad: 4, sp: false
    });
  }
}

// Space: charged shot. v (0..1) comes from the player's charge meter.
function doSpecial(p, v, now) {
  if (p.dead || now < p.specialReady || !Number.isFinite(v)) return;
  v = clamp(v, 0, 1);
  p.specialReady = now + SPECIAL_CD;
  const rad = 8 + 14 * v;
  const speed = 650 + 1050 * v;
  const dmg = Math.round(35 + 65 * v);       // 35 .. 100
  const dx = Math.cos(p.ang), dy = Math.sin(p.ang);
  bullets.push({
    id: nextBulletId++, o: p.id,
    x: p.x + dx * (R + rad + 2), y: p.y + dy * (R + rad + 2),
    px: p.x, py: p.y,
    vx: dx * speed, vy: dy * speed,
    dmg, born: now, life: 1600, rad, sp: true
  });
}

// Shift: short burst of speed
function doDash(p, now) {
  if (p.dead || now < p.dashReady) return;
  let dx = (p.input.r ? 1 : 0) - (p.input.l ? 1 : 0);
  let dy = (p.input.d ? 1 : 0) - (p.input.u ? 1 : 0);
  const len = Math.hypot(dx, dy);
  if (len) { dx /= len; dy /= len; } else { dx = Math.cos(p.ang); dy = Math.sin(p.ang); }
  p.dashReady = now + DASH_CD;
  p.dashUntil = now + DASH_MS;
  p.dashDx = dx; p.dashDy = dy;
  p.wasDashing = true;
}

function kill(victim, killer, now) {
  victim.dead = true;
  victim.hp = 0;
  victim.vx = victim.vy = 0;
  victim.respawnAt = now + RESPAWN_MS;
  victim.killedBy = killer ? killer.name : '';
  victim.fx = { speed: 0, rapid: 0, shield: 0, triple: 0, power: 0 };
  victim.dashUntil = 0; victim.wasDashing = false;
  if (killer) killer.kills++;
}

function respawn(p, now) {
  const sp = spawnPoint();
  p.x = sp.x; p.y = sp.y; p.vx = p.vy = 0;
  p.hp = MAX_HP; p.dead = false;
  p.spawnShield = now + SPAWN_SHIELD_MS;
  p.lastShot = now;
}

function updatePlayer(p, dt, now) {
  if (p.dead) { if (now >= p.respawnAt) respawn(p, now); return; }

  let dx = (p.input.r ? 1 : 0) - (p.input.l ? 1 : 0);
  let dy = (p.input.d ? 1 : 0) - (p.input.u ? 1 : 0);
  const len = Math.hypot(dx, dy);
  if (len) { dx /= len; dy /= len; }

  const speed = BASE_SPEED * (p.fx.speed > now ? 1.6 : 1);

  if (p.dashUntil > now) {
    p.vx = p.dashDx * DASH_SPEED;
    p.vy = p.dashDy * DASH_SPEED;
  } else {
    if (p.wasDashing) { p.vx = dx * speed; p.vy = dy * speed; p.wasDashing = false; }
    const k = 1 - Math.exp(-dt * 9);
    p.vx += (dx * speed - p.vx) * k;
    p.vy += (dy * speed - p.vy) * k;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.x < R) { p.x = R; p.vx = 0; } else if (p.x > W - R) { p.x = W - R; p.vx = 0; }
  if (p.y < R) { p.y = R; p.vy = 0; } else if (p.y > H - R) { p.y = H - R; p.vy = 0; }

  if (p.input.s) {
    const cd = p.fx.rapid > now ? 120 : 320;
    if (now - p.lastShot >= cd) { p.lastShot = now; fire(p, now); }
  }
}

function updateBullets(dt, now) {
  const alive = [];
  for (const b of bullets) {
    const ox = b.x, oy = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H || now - b.born > b.life) continue;

    let hit = false;
    for (const p of players.values()) {
      if (p.dead || p.id === b.o) continue;
      // check the whole path travelled this tick (fast bolts can't skip through)
      if (segDist(p.x, p.y, b.px, b.py, b.x, b.y) < R + b.rad) {
        hit = true;
        if (!isProtected(p, now)) {
          p.hp -= b.dmg;
          if (p.hp <= 0) kill(p, players.get(b.o), now);
        }
        break;
      }
    }
    b.px = ox; b.py = oy;
    if (!hit) alive.push(b);
  }
  bullets = alive;
}

function updateBonuses(now) {
  bonuses = bonuses.filter(b => now - b.born < BONUS_LIFE_MS);

  if (players.size > 0 && bonuses.length < MAX_BONUSES && now - lastBonusSpawn > BONUS_EVERY_MS) {
    lastBonusSpawn = now;
    bonuses.push({
      id: nextBonusId++, x: rand(70, W - 70), y: rand(70, H - 70),
      type: BONUS_TYPES[Math.floor(Math.random() * BONUS_TYPES.length)], born: now
    });
  }

  for (const p of players.values()) {
    if (p.dead) continue;
    // can't pick up a new bonus while one is still active
    if (TIMED.some(k => p.fx[k] > now)) continue;
    for (let i = bonuses.length - 1; i >= 0; i--) {
      const b = bonuses[i];
      if (Math.hypot(p.x - b.x, p.y - b.y) < R + 16) {
        if (b.type === 'heal') p.hp = MAX_HP;
        else p.fx[b.type] = now + EFFECT_MS;
        bonuses.splice(i, 1);
        break;
      }
    }
  }
}

function broadcast(now) {
  if (players.size === 0) return;
  const snap = { t: 's', p: [], b: [], o: [] };

  for (const p of players.values()) {
    const f = {};
    for (const k of TIMED) if (p.fx[k] > now) f[k] = r1((p.fx[k] - now) / 1000);
    snap.p.push({
      i: p.id, n: p.name, x: r1(p.x), y: r1(p.y), a: r2(p.ang),
      h: Math.max(0, Math.round(p.hp)), k: p.kills,
      d: p.dead ? 1 : 0, rs: p.dead ? Math.max(0, p.respawnAt - now) : 0,
      kb: p.dead ? p.killedBy : '', f,
      sc: Math.max(0, p.specialReady - now),
      dc: Math.max(0, p.dashReady - now),
      ds: p.dashUntil > now ? 1 : 0,
      ps: p.spawnShield > now ? 1 : 0
    });
  }
  for (const b of bullets) {
    const o = { i: b.id, o: b.o, x: r1(b.x), y: r1(b.y) };
    if (b.sp) { o.s = r1(b.rad); o.g = r2(Math.atan2(b.vy, b.vx)); }
    snap.b.push(o);
  }
  for (const b of bonuses) snap.o.push({ i: b.id, x: Math.round(b.x), y: Math.round(b.y), k: b.type });

  const msg = JSON.stringify(snap);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) { try { p.ws.send(msg); } catch (e) { /* ignore */ } }
  }
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const p of players.values()) updatePlayer(p, dt, now);
  updateBullets(dt, now);
  updateBonuses(now);
  broadcast(now);
}, TICK_MS);

server.listen(PORT, () => console.log('UFO Arena running on port ' + PORT));
