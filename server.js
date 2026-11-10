'use strict';
// UFO Arena - tiny authoritative game server (Node.js + ws)
// Two rooms, 10 players each:  "pvp" (players vs players)  and  "boss" (co-op vs a boss)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---- Settings ----
const W = 1600, H = 900, R = 20;          // arena size, ufo radius
const MAX_PLAYERS = 10;                    // per room
const TICK_MS = 33;                        // ~30 updates / second
const BASE_SPEED = 280;
const MAX_HP = 100;
const EFFECT_MS = 7000;                    // bonus duration
const RESPAWN_MS = 5000;
const SPAWN_SHIELD_MS = 2000;
const BULLET_SPEED = 760, BULLET_LIFE = 1100;
const DASH_SPEED = 1100, DASH_MS = 170, DASH_CD = 5000;
const SPECIAL_CD = 20000;
const BONUS_TYPES = ['speed', 'rapid', 'shield', 'triple', 'power', 'heal'];
const TIMED = ['speed', 'rapid', 'shield', 'triple', 'power'];
const MAX_BONUSES = 6, BONUS_EVERY_MS = 3000, BONUS_LIFE_MS = 25000;

// Boss tuning (easy to tweak)
const BOSS_BASE_HP = 3500, BOSS_HP_PER_PLAYER = 2500;   // max HP = base + perPlayer * players
const BOSS_R = 70;
const BOSS_IFRAMES_MS = 450;               // player is immune this long after a boss hit
const BOSS_VICTORY_MS = 9000;
const BOSS_CONTACT_DMG = 30;
const MAX_ENEMY_BULLETS = 320;

// ---- State ----
let nextPlayerId = 1, nextBulletId = 1, nextBonusId = 1, nextEid = 1;

function makeRoom(mode) {
  return {
    mode, now: Date.now(),
    players: new Map(), bullets: [], bonuses: [], lastBonusSpawn: 0,
    eb: [], lz: [], zn: [], sw: [], mn: [], nv: null, gw: null,   // boss: bullets, lasers, zones, shockwaves, drones, nova, gravity well               // boss: enemy bullets, lasers, danger zones
    boss: {
      x: W / 2, y: 150, r: BOSS_R, ratio: 1, maxHp: BOSS_BASE_HP + BOSS_HP_PER_PLAYER,
      state: 'fight', vUntil: 0, next: 0, cur: null, last: '', wins: 0, m: 1, mvp: '', hitAt: 0,
      ovr: false, contact: BOSS_CONTACT_DMG, phase: 0, banner: '', bannerUntil: 0, shakeUntil: 0, hx: W / 2, hy: 150
    }
  };
}
const rooms = { pvp: makeRoom('pvp'), boss: makeRoom('boss') };

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
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function alivePlayers(room) {
  const a = [];
  for (const p of room.players.values()) if (!p.dead) a.push(p);
  return a;
}
function randomAlive(room) {
  const a = alivePlayers(room);
  return a.length ? a[Math.floor(Math.random() * a.length)] : null;
}
function nearestAlive(room, x, y) {
  let best = null, bd = 1e9;
  for (const p of room.players.values()) {
    if (p.dead) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
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

function spawnPoint(room) {
  // pick the random point that is farthest from living players
  let best = { x: W / 2, y: H / 2 }, bestD = -1;
  for (let i = 0; i < 12; i++) {
    const x = rand(80, W - 80), y = rand(room.mode === 'boss' ? 400 : 80, H - 80);
    let md = 1e9;
    for (const p of room.players.values()) if (!p.dead) md = Math.min(md, Math.hypot(p.x - x, p.y - y));
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  return best;
}

function createPlayer(ws, name, room) {
  const sp = spawnPoint(room);
  const now = Date.now();
  return {
    id: nextPlayerId++, ws, name: cleanName(name),
    x: sp.x, y: sp.y, vx: 0, vy: 0, hp: MAX_HP, ang: 0,
    input: { u: false, d: false, l: false, r: false, s: false },
    lastShot: 0, dead: false, respawnAt: 0, killedBy: '', kills: 0, dmg: 0, confUntil: 0,
    iUntil: 0,
    fx: { speed: 0, rapid: 0, shield: 0, triple: 0, power: 0 },
    spawnShield: now + SPAWN_SHIELD_MS,
    dashReady: 0, dashUntil: 0, dashDx: 0, dashDy: 0, wasDashing: false,
    specialReady: 0
  };
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null, room = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !player) {
      const r = m.mode === 'boss' ? rooms.boss : rooms.pvp;
      if (r.players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      room = r;
      player = createPlayer(ws, m.name, room);
      room.players.set(player.id, player);
      send(ws, { t: 'init', id: player.id, w: W, h: H, max: MAX_PLAYERS, mode: room.mode });
    } else if (m.t === 'in' && player) {
      player.input = { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r, s: !!m.s };
      if (Number.isFinite(m.a)) player.ang = m.a;
    } else if (m.t === 'dash' && player) {
      doDash(player, Date.now());
    } else if (m.t === 'sp' && player) {
      doSpecial(room, player, Number(m.v), Date.now());
    }
  });

  ws.on('close', () => { if (player && room) room.players.delete(player.id); });
  ws.on('error', () => { /* ignore */ });
});

// ---- Game logic: players ----
function isProtected(p, now) {
  return p.fx.shield > now || p.spawnShield > now;
}

function fire(room, p, now) {
  const angles = p.fx.triple > now ? [-0.22, 0, 0.22] : [0];
  const dmg = p.fx.power > now ? 45 : 25;
  for (const off of angles) {
    const a = p.ang + off;
    const dx = Math.cos(a), dy = Math.sin(a);
    room.bullets.push({
      id: nextBulletId++, o: p.id,
      x: p.x + dx * (R + 4), y: p.y + dy * (R + 4),
      px: p.x, py: p.y,
      vx: dx * BULLET_SPEED, vy: dy * BULLET_SPEED,
      dmg, born: now, life: BULLET_LIFE, rad: 4, sp: false
    });
  }
}

// Space: charged shot. v (0..1) comes from the player's charge meter.
function doSpecial(room, p, v, now) {
  if (p.dead || now < p.specialReady || !Number.isFinite(v)) return;
  v = clamp(v, 0, 1);
  p.specialReady = now + SPECIAL_CD;
  const rad = 8 + 14 * v;
  const speed = 650 + 1050 * v;
  const dmg = Math.round(35 + 65 * v);       // 35 .. 100
  const dx = Math.cos(p.ang), dy = Math.sin(p.ang);
  room.bullets.push({
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
  if (len) { dx /= len; dy /= len; if (p.confUntil > now) { dx = -dx; dy = -dy; } } else { dx = Math.cos(p.ang); dy = Math.sin(p.ang); }
  p.dashReady = now + DASH_CD;
  p.dashUntil = now + DASH_MS;
  p.dashDx = dx; p.dashDy = dy;
  p.wasDashing = true;
}

function kill(room, victim, killer, now) {
  victim.dead = true;
  victim.hp = 0;
  victim.vx = victim.vy = 0;
  victim.respawnAt = now + RESPAWN_MS;
  victim.killedBy = killer ? killer.name : (room.mode === 'boss' ? 'the Boss' : '');
  victim.fx = { speed: 0, rapid: 0, shield: 0, triple: 0, power: 0 };
  victim.dashUntil = 0; victim.wasDashing = false;
  victim.iUntil = 0;
  victim.confUntil = 0;
  if (killer) killer.kills++;
}

function respawn(room, p, now) {
  const sp = spawnPoint(room);
  p.x = sp.x; p.y = sp.y; p.vx = p.vy = 0;
  p.hp = MAX_HP; p.dead = false;
  p.spawnShield = now + SPAWN_SHIELD_MS;
  p.lastShot = now;
}

// damage from the boss side (bullets, lasers, zones, contact)
function hurt(room, p, dmg, now) {
  if (p.dead || now < p.iUntil || p.dashUntil > now || isProtected(p, now)) return false;   // dashing = brief immunity
  p.hp -= dmg;
  p.iUntil = now + BOSS_IFRAMES_MS;
  if (p.hp <= 0) kill(room, p, null, now);
  return true;
}

function updatePlayer(room, p, dt, now) {
  if (p.dead) { if (now >= p.respawnAt) respawn(room, p, now); return; }

  let dx = (p.input.r ? 1 : 0) - (p.input.l ? 1 : 0);
  let dy = (p.input.d ? 1 : 0) - (p.input.u ? 1 : 0);
  const len = Math.hypot(dx, dy);
  if (len) { dx /= len; dy /= len; }

  if (p.confUntil > now) { dx = -dx; dy = -dy; }          // Mind Warp: inverted controls
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
    if (now - p.lastShot >= cd) { p.lastShot = now; fire(room, p, now); }
  }
}

function updateBullets(room, dt, now) {
  const boss = room.boss;
  const alive = [];
  for (const b of room.bullets) {
    const ox = b.x, oy = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H || now - b.born > b.life) continue;

    let hit = false;
    if (room.mode === 'boss') {
      // co-op: player bullets only hurt the boss
      for (const d of room.mn) {
        if (segDist(d.x, d.y, b.px, b.py, b.x, b.y) < d.r + b.rad) {
          hit = true; d.hp -= b.dmg; if (d.hp <= 0) d.dead = true;
          break;
        }
      }
      if (!hit && boss.state === 'fight' && segDist(boss.x, boss.y, b.px, b.py, b.x, b.y) < boss.r + b.rad) {
        hit = true;
        boss.ratio = Math.max(0, boss.ratio - b.dmg / boss.maxHp);
        boss.hitAt = now;
        const owner = room.players.get(b.o);
        if (owner) owner.dmg += b.dmg;
        if (boss.ratio <= 0) startVictory(room, now);
      }
    } else {
      for (const p of room.players.values()) {
        if (p.dead || p.id === b.o) continue;
        // check the whole path travelled this tick (fast bolts can't skip through)
        if (segDist(p.x, p.y, b.px, b.py, b.x, b.y) < R + b.rad) {
          hit = true;
          if (!isProtected(p, now)) {
            p.hp -= b.dmg;
            if (p.hp <= 0) kill(room, p, room.players.get(b.o), now);
          }
          break;
        }
      }
    }
    b.px = ox; b.py = oy;
    if (!hit) alive.push(b);
  }
  room.bullets = alive;
}

function updateBonuses(room, now) {
  room.bonuses = room.bonuses.filter(b => now - b.born < BONUS_LIFE_MS);

  if (room.players.size > 0 && room.bonuses.length < MAX_BONUSES && now - room.lastBonusSpawn > BONUS_EVERY_MS) {
    room.lastBonusSpawn = now;
    room.bonuses.push({
      id: nextBonusId++, x: rand(70, W - 70), y: rand(room.mode === 'boss' ? 300 : 70, H - 70),
      type: BONUS_TYPES[Math.floor(Math.random() * BONUS_TYPES.length)], born: now
    });
  }

  for (const p of room.players.values()) {
    if (p.dead) continue;
    // can't pick up a new bonus while one is still active
    if (TIMED.some(k => p.fx[k] > now)) continue;
    for (let i = room.bonuses.length - 1; i >= 0; i--) {
      const b = room.bonuses[i];
      if (Math.hypot(p.x - b.x, p.y - b.y) < R + 16) {
        if (b.type === 'heal') p.hp = MAX_HP;
        else p.fx[b.type] = now + EFFECT_MS;
        room.bonuses.splice(i, 1);
        break;
      }
    }
  }
}

// ---- Game logic: boss ----
function shootXY(room, x, y, vx, vy, r, dmg, extra) {
  if (room.eb.length >= MAX_ENEMY_BULLETS) return;
  const e = { id: nextEid++, x, y, vx, vy, r, dmg, born: room.now, life: 7000, k: 0 };
  if (extra) Object.assign(e, extra);
  room.eb.push(e);
}
function shoot(room, x, y, ang, speed, r, dmg, extra) {
  shootXY(room, x, y, Math.cos(ang) * speed, Math.sin(ang) * speed, r, dmg, extra);
}
function addLaser(room, x1, y1, x2, y2, w, warnUntil, fireUntil, dmg, once, upd) {
  const L = { id: nextEid++, x1, y1, x2, y2, w, warnUntil, fireUntil, dmg, once, hit: new Set(), upd: upd || null };
  room.lz.push(L);
  return L;
}
function addZone(room, x, y, r, warnMs, boomMs, dmg, fireMs, fireDmg) {
  const now = room.now;
  if (room.zn.length >= 45) return;
  room.zn.push({ id: nextEid++, x, y, r, born: now, warnUntil: now + warnMs, boomUntil: now + warnMs + boomMs, dmg, hit: new Set(),
    fireUntil: now + warnMs + boomMs + (fireMs || 0), fireDmg: fireDmg || 0 });
}

function addShockwave(room, x, y, speed, maxRad, w, dmg, delayMs) {
  room.sw.push({ id: nextEid++, x, y, rad: 0, speed, maxRad, w, dmg, hit: new Set(), startAt: room.now + (delayMs || 0) });
}
function spawnDrone(room, x, y, m) {
  if (room.mn.length >= 14) return;
  room.mn.push({ id: nextEid++, x, y, r: 16, hp: 55, maxhp: 55, sp: 125 * m, born: room.now,
    nextShot: room.now + 1200 + Math.random() * 1200, dead: false });
}
function cancelAttack(room) {
  const b = room.boss;
  b.cur = null; b.ovr = false; b.contact = BOSS_CONTACT_DMG;
  room.gw = null; room.nv = null;
}

// 14 different attacks. Each factory returns { name, update(now) -> true when finished }
const ATTACKS = {
  // 1) aimed fan of fast bullets
  volley(room, now) {
    const b = room.boss, m = b.m, k = m > 1 ? 3 : 2;
    let n = 0, next = now, end = 0;
    return { name: 'Bullet Volley', update(now) {
      if (n < 4 && now >= next) {
        const t = randomAlive(room);
        if (t) {
          const base = Math.atan2(t.y - b.y, t.x - b.x);
          for (let i = -k; i <= k; i++) shoot(room, b.x, b.y, base + i * 0.2, 430 * m, 7, 14);
        }
        n++; next = now + 650;
        if (n === 4) end = now + 900;
      }
      return n >= 4 && now >= end;
    } };
  },

  // 2) rotating spray
  spiral(room, now) {
    const b = room.boss, m = b.m, arms = m > 1 ? 3 : 2;
    const until = now + 4500, dir = Math.random() < 0.5 ? 1 : -1;
    let a = Math.random() * 6.283, next = now;
    return { name: 'Spiral', update(now) {
      if (now >= until) return true;
      let guard = 0;
      while (next <= now && guard++ < 4) {
        for (let i = 0; i < arms; i++) shoot(room, b.x, b.y, a + i * 6.283 / arms, 300 * m, 6, 12);
        a += dir * 0.27; next += 75;
      }
      return false;
    } };
  },

  // 3) expanding rings
  rings(room, now) {
    const b = room.boss, m = b.m, cnt = m > 1 ? 28 : 22;
    let n = 0, next = now, off = 0;
    return { name: 'Ring Pulses', update(now) {
      if (n < 6 && now >= next) {
        for (let i = 0; i < cnt; i++) shoot(room, b.x, b.y, off + i * 6.283 / cnt, 250 * m, 7, 12);
        off += 0.17; n++; next = now + 600;
      }
      return n >= 6 && now >= next;
    } };
  },

  // 4) laser grid: beams are locked on where players stand, then fire
  lasers(room, now) {
    const b = room.boss, m = b.m;
    const warn = m > 1 ? 950 : 1100;
    let n = 0, next = now;
    return { name: 'Laser Grid', update(now) {
      if (n < 3 && now >= next) {
        const picks = shuffle(alivePlayers(room)).slice(0, 4);
        const beams = picks.map(p => Math.random() < 0.5 ? { h: true, v: p.y } : { h: false, v: p.x });
        beams.push(Math.random() < 0.5 ? { h: true, v: rand(60, H - 60) } : { h: false, v: rand(60, W - 60) });
        for (const bm of beams) {
          if (bm.h) addLaser(room, 0, bm.v, W, bm.v, 34, now + warn, now + warn + 500, 35, true);
          else addLaser(room, bm.v, 0, bm.v, H, 34, now + warn, now + warn + 500, 35, true);
        }
        n++; next = now + 1500;
      }
      return n >= 3 && now >= next + 300;
    } };
  },

  // 5) giant rotating beam from the boss
  sweep(room, now) {
    const b = room.boss, m = b.m;
    const warn = 1000, dur = 3400, speed = 0.7;
    const t = randomAlive(room);
    const a0 = t ? Math.atan2(t.y - b.y, t.x - b.x) : Math.PI / 2;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const start = now + warn;
    const count = m > 1 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const L = addLaser(room, b.x, b.y, b.x, b.y, 30, start, start + dur, 30, false, (nw) => {
        const ang = a0 + k * Math.PI + dir * speed * Math.max(0, (nw - start) / 1000);
        L.x1 = b.x; L.y1 = b.y;
        L.x2 = b.x + Math.cos(ang) * 2400; L.y2 = b.y + Math.sin(ang) * 2400;
      });
      L.upd(now);
    }
    return { name: 'Sweeping Beam', update(now) { return now >= start + dur; } };
  },

  // 6) walls of bullets with a gap to slip through
  wall(room, now) {
    const m = room.boss.m, sp = 210 * m, gapN = 3;
    const waves = ['down', 'right', 'down', 'left'];
    let n = 0, next = now;
    return { name: 'Star Wall', update(now) {
      if (n < waves.length && now >= next) {
        const dir = waves[n];
        const len = dir === 'down' ? W : H;
        const slots = Math.floor(len / 56);
        const gap = 1 + Math.floor(Math.random() * (slots - gapN - 1));
        for (let i = 0; i < slots; i++) {
          if (i >= gap && i < gap + gapN) continue;
          const c = 28 + i * 56;
          if (dir === 'down') shootXY(room, c, 10, 0, sp, 9, 16);
          else if (dir === 'right') shootXY(room, 10, c, sp * 1.1, 0, 9, 16);
          else shootXY(room, W - 10, c, -sp * 1.1, 0, 9, 16);
        }
        n++; next = now + 1500;
      }
      return n >= waves.length && now >= next + 2200;
    } };
  },

  // 7) slow orbs that chase the nearest player
  homing(room, now) {
    const b = room.boss, m = b.m, count = m > 1 ? 7 : 5;
    const sp = 170 * m;
    for (let i = 0; i < count; i++) {
      const a = i * 6.283 / count + Math.random() * 0.3;
      shoot(room, b.x + Math.cos(a) * b.r, b.y + Math.sin(a) * b.r, a, sp, 12, 18,
        { k: 1, hom: true, homUntil: now + 4200, rate: 1.5, sp, life: 8000 });
    }
    return { name: 'Seeker Orbs', update(nw) { return nw >= now + 800; } };
  },

  // 9) black hole: drags everyone in, then implodes in a double shockwave (dash through it!)
  gravity(room, now) {
    const b = room.boss;
    const g = { x: rand(450, W - 450), y: rand(420, 720), range: 560, core: 38, st: 0 };
    room.gw = g;
    const pullStart = now + 1000, pullEnd = pullStart + 3200;
    let boomAt = 0;
    return { name: 'Gravity Well', update(nw) {
      if (nw < pullStart) return false;
      if (nw < pullEnd) {
        g.st = 1;
        const dt = room.dt || 0.033;
        for (const p of room.players.values()) {
          if (p.dead) continue;
          const dx = g.x - p.x, dy = g.y - p.y, d = Math.hypot(dx, dy);
          if (d > 1 && d < g.range) {
            const sp = 140 + 160 * (1 - d / g.range);
            p.x = clamp(p.x + dx / d * sp * dt, R, W - R);
            p.y = clamp(p.y + dy / d * sp * dt, R, H - R);
          }
          if (d < g.core + R - 6) hurt(room, p, 25, nw);
        }
        return false;
      }
      if (!boomAt) {
        boomAt = nw; room.gw = null;
        addShockwave(room, g.x, g.y, 700, 1000, 38, 40, 0);
        addShockwave(room, g.x, g.y, 700, 1000, 38, 40, 450);
        b.shakeUntil = nw + 800;
      }
      return nw >= boomAt + 500;
    } };
  },

  // 10) boss telegraphs a lane, charges across the arena, slams down in shockwaves, then flies home
  charge(room, now) {
    const b = room.boss, m = b.m;
    const t = randomAlive(room);
    const tx = t ? clamp(t.x, 90, W - 90) : W / 2, ty = t ? clamp(t.y, 160, H - 90) : 600;
    const tel = 900;
    addLaser(room, b.x, b.y, tx, ty, 140, now + 1e9, now + tel, 0, true);   // telegraph only, never fires
    let ph = 0, slamAt = 0;
    return { name: 'Titan Charge', update(nw) {
      const dt = room.dt || 0.033;
      if (ph === 0) {
        if (nw >= now + tel) { ph = 1; b.ovr = true; b.contact = 45; }
        return false;
      }
      if (ph === 1) {
        const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy), step = 1900 * dt;
        if (d <= step) {
          b.x = tx; b.y = ty; ph = 2; slamAt = nw;
          const waves = m > 1.3 ? 3 : 2;
          for (let i = 0; i < waves; i++) addShockwave(room, tx, ty, 560, 950, 34, 35, i * 380);
          b.shakeUntil = nw + 800;
        } else { b.x += dx / d * step; b.y += dy / d * step; }
        return false;
      }
      if (ph === 2) { if (nw >= slamAt + 900) ph = 3; return false; }
      const dx = b.hx - b.x, dy = b.hy - b.y, d = Math.hypot(dx, dy), step = 800 * dt;
      if (d <= step) { b.ovr = false; b.contact = BOSS_CONTACT_DMG; return true; }
      b.x += dx / d * step; b.y += dy / d * step;
      return false;
    } };
  },

  // 11) summons chasing drones - shoot them down (sometimes they drop a heal)
  drones(room, now) {
    const b = room.boss, m = b.m;
    const count = Math.min(4 + Math.ceil(room.players.size / 2), 9);
    for (let i = 0; i < count; i++) {
      const a = i * 6.283 / count;
      spawnDrone(room, b.x + Math.cos(a) * (b.r + 25), b.y + Math.sin(a) * (b.r + 25), m);
    }
    return { name: 'Summon Drones', update(nw) { return nw >= now + 700; } };
  },

  // 12) meteors crash down and leave burning ground
  meteors(room, now) {
    const m = room.boss.m, total = m > 1.3 ? 12 : 9;
    let n = 0, next = now;
    return { name: 'Meteor Rain', update(nw) {
      if (n < total && nw >= next) {
        const t = Math.random() < 0.6 ? randomAlive(room) : null;
        let x, y;
        if (t) { x = clamp(t.x + rand(-60, 60), 90, W - 90); y = clamp(t.y + rand(-60, 60), 90, H - 90); }
        else { x = rand(90, W - 90); y = rand(250, H - 90); }
        addZone(room, x, y, 85, 950, 250, 35, 5000, 12);
        n++; next = nw + (m > 1.3 ? 330 : 430);
      }
      return n >= total && nw >= next + 1200;
    } };
  },

  // 13) everyone must stand inside the safe lights when the nova fires (a well-timed dash also works)
  nova(room, now) {
    const b = room.boss, m = b.m;
    const cnt = clamp(Math.ceil(alivePlayers(room).length / 3), 2, 4);
    const safes = [];
    for (let tries = 0; safes.length < cnt && tries < 200; tries++) {
      const x = rand(160, W - 160), y = rand(380, H - 130);
      if (safes.every(q => Math.hypot(q.x - x, q.y - y) > 330)) safes.push({ x, y, r: 115 });
    }
    if (!safes.length) safes.push({ x: W / 2, y: 600, r: 115 });
    const nv = { safes, fireAt: now + (m > 1.3 ? 2600 : 3200), fired: false, flashUntil: 0 };
    room.nv = nv;
    return { name: 'Nova Protocol', update(nw) {
      if (!nv.fired && nw >= nv.fireAt) {
        nv.fired = true; nv.flashUntil = nw + 700; b.shakeUntil = nw + 800;
        for (const p of room.players.values()) {
          if (p.dead) continue;
          if (!nv.safes.some(q => Math.hypot(p.x - q.x, p.y - q.y) < q.r - 8)) hurt(room, p, 70, nw);
        }
      }
      if (nv.fired && nw >= nv.flashUntil) { room.nv = null; return true; }
      return false;
    } };
  },

  // 14) inverts everyone's movement while rings of bullets roll out
  warp(room, now) {
    const b = room.boss, m = b.m;
    const until = now + 4500;
    for (const p of room.players.values()) if (!p.dead) p.confUntil = until;
    let n = 0, next = now + 500, off = 0;
    return { name: 'Mind Warp', update(nw) {
      if (n < 5 && nw >= next) {
        const cnt = 18;
        for (let i = 0; i < cnt; i++) shoot(room, b.x, b.y, off + i * 6.283 / cnt, 215 * m, 7, 12);
        off += 0.2; n++; next = nw + 850;
      }
      return n >= 5 && nw >= until;
    } };
  },

  // 8) danger circles dropped on top of players
  zones(room, now) {
    const m = room.boss.m;
    const warn = m > 1 ? 850 : 1000;
    let n = 0, next = now;
    return { name: 'Blast Zones', update(now) {
      if (n < 4 && now >= next) {
        for (const p of shuffle(alivePlayers(room)).slice(0, 6)) addZone(room, p.x, p.y, 95, warn, 350, 40);
        addZone(room, rand(100, W - 100), rand(350, H - 100), 95, warn, 350, 40);
        n++; next = now + 1300;
      }
      return n >= 4 && now >= next + 300;
    } };
  }
};

function clearBossStuff(room) {
  room.eb = []; room.lz = []; room.zn = []; room.sw = []; room.mn = []; room.nv = null; room.gw = null;
  room.boss.ovr = false; room.boss.contact = BOSS_CONTACT_DMG;
}

function startVictory(room, now) {
  const b = room.boss;
  b.state = 'victory'; b.vUntil = now + BOSS_VICTORY_MS; b.ratio = 0; b.cur = null; b.wins++;
  let best = null;
  for (const p of room.players.values()) if (!best || p.dmg > best.dmg) best = p;
  b.mvp = best ? best.name : '';
  clearBossStuff(room);
}

function newFight(room, now) {
  const b = room.boss;
  b.ratio = 1; b.state = 'fight'; b.cur = null; b.last = ''; b.next = now + 3000;
  b.phase = 0; b.banner = ''; b.bannerUntil = 0; b.shakeUntil = 0;
  clearBossStuff(room);
  for (const p of room.players.values()) { p.dmg = 0; p.confUntil = 0; if (!p.dead) p.hp = MAX_HP; }
}

function resetBoss(room) {
  const b = room.boss;
  b.ratio = 1; b.state = 'fight'; b.cur = null; b.last = ''; b.next = 0;
  b.phase = 0; b.banner = ''; b.bannerUntil = 0; b.shakeUntil = 0;
  clearBossStuff(room);
}

function updateEnemyBullets(room, dt, now) {
  const keep = [];
  for (const e of room.eb) {
    if (e.hom && now < e.homUntil) {
      const t = nearestAlive(room, e.x, e.y);
      if (t) {
        const cur = Math.atan2(e.vy, e.vx), want = Math.atan2(t.y - e.y, t.x - e.x);
        let d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        d = clamp(d, -e.rate * dt, e.rate * dt);
        const na = cur + d;
        e.vx = Math.cos(na) * e.sp; e.vy = Math.sin(na) * e.sp;
      }
    }
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.x < -60 || e.x > W + 60 || e.y < -60 || e.y > H + 60 || now - e.born > e.life) continue;

    let used = false;
    for (const p of room.players.values()) {
      if (p.dead) continue;
      if (Math.hypot(p.x - e.x, p.y - e.y) < R - 4 + e.r) {
        if (hurt(room, p, e.dmg, now)) { used = true; break; }   // passes through during i-frames / shield
      }
    }
    if (!used) keep.push(e);
  }
  room.eb = keep;
}

function updateLasers(room, now) {
  const keep = [];
  for (const L of room.lz) {
    if (now >= L.fireUntil) continue;
    if (L.upd) L.upd(now);
    if (now >= L.warnUntil) {
      for (const p of room.players.values()) {
        if (p.dead || (L.once && L.hit.has(p.id))) continue;
        if (segDist(p.x, p.y, L.x1, L.y1, L.x2, L.y2) < L.w / 2 + R - 5) {
          if (hurt(room, p, L.dmg, now) && L.once) L.hit.add(p.id);
        }
      }
    }
    keep.push(L);
  }
  room.lz = keep;
}

function updateZones(room, now) {
  const keep = [];
  for (const z of room.zn) {
    if (now >= Math.max(z.boomUntil, z.fireUntil)) continue;
    for (const p of room.players.values()) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (now >= z.warnUntil && now < z.boomUntil) {
        if (!z.hit.has(p.id) && d < z.r + R - 6 && hurt(room, p, z.dmg, now)) z.hit.add(p.id);
      } else if (now >= z.boomUntil && z.fireDmg && d < z.r * 0.85 + R - 6) {
        hurt(room, p, z.fireDmg, now);                // burning ground
      }
    }
    keep.push(z);
  }
  room.zn = keep;
}

function updateShockwaves(room, dt, now) {
  const keep = [];
  for (const s of room.sw) {
    if (now < s.startAt) { keep.push(s); continue; }
    s.rad += s.speed * dt;
    if (s.rad > s.maxRad + s.w) continue;
    for (const p of room.players.values()) {
      if (p.dead || s.hit.has(p.id)) continue;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (Math.abs(d - s.rad) < s.w / 2 + R - 8) { if (hurt(room, p, s.dmg, now)) s.hit.add(p.id); }
    }
    keep.push(s);
  }
  room.sw = keep;
}

function updateMinions(room, dt, now) {
  const keep = [];
  for (const d of room.mn) {
    if (d.dead || now - d.born > 16000) {
      if (d.dead && Math.random() < 0.25 && room.bonuses.length < 9) {
        room.bonuses.push({ id: nextBonusId++, x: d.x, y: d.y, type: 'heal', born: now });
      }
      continue;
    }
    const t = nearestAlive(room, d.x, d.y);
    if (t) {
      const a = Math.atan2(t.y - d.y, t.x - d.x);
      d.x += Math.cos(a) * d.sp * dt;
      d.y += Math.sin(a) * d.sp * dt;
      if (now >= d.nextShot) { d.nextShot = now + 2400; shoot(room, d.x, d.y, a, 260, 6, 10); }
    }
    for (const o of room.mn) {                        // don't stack on each other
      if (o === d || o.dead) continue;
      const dx = d.x - o.x, dy = d.y - o.y, dist = Math.hypot(dx, dy);
      if (dist > 0 && dist < d.r * 2) { const push = (d.r * 2 - dist) * 0.5; d.x += dx / dist * push; d.y += dy / dist * push; }
    }
    d.x = clamp(d.x, d.r, W - d.r); d.y = clamp(d.y, d.r, H - d.r);
    for (const p of room.players.values()) {
      if (!p.dead && Math.hypot(p.x - d.x, p.y - d.y) < d.r + R - 6) hurt(room, p, 20, now);
    }
    keep.push(d);
  }
  room.mn = keep;
}

function updateBoss(room, dt, now) {
  const b = room.boss, n = room.players.size;
  if (n === 0) {
    if (b.ratio !== 1 || b.state !== 'fight' || b.cur || b.phase || room.eb.length || room.lz.length ||
        room.zn.length || room.sw.length || room.mn.length) resetBoss(room);
    b.next = 0;
    return;
  }
  b.maxHp = BOSS_BASE_HP + BOSS_HP_PER_PLAYER * n;
  b.hx = W / 2 + 380 * Math.sin(now / 5000);
  b.hy = 150 + 18 * Math.sin(now / 1300);
  if (!b.ovr) { b.x = b.hx; b.y = b.hy; }

  if (b.state === 'victory') { if (now >= b.vUntil) newFight(room, now); return; }
  if (!b.next) b.next = now + 3000;

  // phases: 0 normal, 1 enraged (<50%), 2 final form (<20%)
  const phase = b.ratio < 0.2 ? 2 : b.ratio < 0.5 ? 1 : 0;
  if (phase > b.phase) {
    b.phase = phase;
    cancelAttack(room);
    room.eb = []; room.lz = []; room.zn = []; room.sw = [];
    b.banner = phase === 1 ? 'THE WARDEN IS ENRAGED' : 'FINAL FORM';
    b.bannerUntil = now + 2800;
    b.shakeUntil = now + 1300;
    b.next = now + 2500;
  }
  b.m = [1, 1.25, 1.45][b.phase];

  if (b.cur) {
    if (b.cur.update(now)) {
      b.cur = null;
      b.next = now + [1900, 1100, 750][b.phase];
      if (b.phase > 0 && Math.random() < 0.3) b.next = now + 200;      // sometimes chains attacks
    }
  } else if (now >= b.next && alivePlayers(room).length) {
    const names = Object.keys(ATTACKS).filter(k => k !== b.last);
    const name = names[Math.floor(Math.random() * names.length)];
    b.last = name;
    b.cur = ATTACKS[name](room, now);
  }

  for (const p of room.players.values()) {
    if (!p.dead && Math.hypot(p.x - b.x, p.y - b.y) < b.r + R - 8) hurt(room, p, b.contact, now);
  }

  updateEnemyBullets(room, dt, now);
  updateLasers(room, now);
  updateZones(room, now);
  updateShockwaves(room, dt, now);
  updateMinions(room, dt, now);
}

// ---- Snapshots ----
function broadcast(room, now) {
  if (room.players.size === 0) return;
  const snap = { t: 's', p: [], b: [], o: [] };
  const bossMode = room.mode === 'boss';

  for (const p of room.players.values()) {
    const f = {};
    for (const k of TIMED) if (p.fx[k] > now) f[k] = r1((p.fx[k] - now) / 1000);
    snap.p.push({
      i: p.id, n: p.name, x: r1(p.x), y: r1(p.y), a: r2(p.ang),
      h: Math.max(0, Math.round(p.hp)), k: bossMode ? Math.round(p.dmg) : p.kills,
      d: p.dead ? 1 : 0, rs: p.dead ? Math.max(0, p.respawnAt - now) : 0,
      kb: p.dead ? p.killedBy : '', f,
      sc: Math.max(0, p.specialReady - now),
      dc: Math.max(0, p.dashReady - now),
      ds: p.dashUntil > now ? 1 : 0,
      ps: p.spawnShield > now ? 1 : 0,
      iv: p.iUntil > now ? 1 : 0,
      cf: p.confUntil > now ? 1 : 0
    });
  }
  for (const b of room.bullets) {
    const o = { i: b.id, o: b.o, x: r1(b.x), y: r1(b.y) };
    if (b.sp) { o.s = r1(b.rad); o.g = r2(Math.atan2(b.vy, b.vx)); }
    snap.b.push(o);
  }
  for (const b of room.bonuses) snap.o.push({ i: b.id, x: Math.round(b.x), y: Math.round(b.y), k: b.type });

  if (bossMode) {
    const b = room.boss;
    const victory = b.state === 'victory';
    snap.bs = {
      x: Math.round(b.x), y: Math.round(b.y), r: b.r,
      h: Math.round(b.ratio * 1000) / 1000, mh: Math.round(b.maxHp),
      s: victory ? 1 : 0, vl: victory ? Math.max(0, b.vUntil - now) : 0,
      at: b.cur ? b.cur.name : '', mv: b.mvp, w: b.wins,
      hf: now - b.hitAt < 90 ? 1 : 0, ph: b.phase,
      bn: now < b.bannerUntil ? b.banner : '', bl: Math.max(0, b.bannerUntil - now),
      sk: Math.max(0, b.shakeUntil - now)
    };
    snap.eb = room.eb.map(e => [e.id, Math.round(e.x), Math.round(e.y), e.r, e.k]);
    snap.lz = room.lz.map(L => [L.id, Math.round(L.x1), Math.round(L.y1), Math.round(L.x2), Math.round(L.y2), L.w, now >= L.warnUntil ? 1 : 0]);
    snap.zn = room.zn.map(z => {
      let ph, prog;
      if (now < z.warnUntil) { ph = 0; prog = (now - z.born) / (z.warnUntil - z.born); }
      else if (now < z.boomUntil) { ph = 1; prog = (now - z.warnUntil) / (z.boomUntil - z.warnUntil); }
      else { ph = 2; prog = (z.fireUntil - now) / Math.max(1, z.fireUntil - z.boomUntil); }
      return [z.id, Math.round(z.x), Math.round(z.y), z.r, ph, r2(clamp(prog, 0, 1))];
    });
    snap.sw = room.sw.filter(s => now >= s.startAt).map(s => [s.id, Math.round(s.x), Math.round(s.y), Math.round(s.rad), s.w]);
    snap.mn = room.mn.map(d => [d.id, Math.round(d.x), Math.round(d.y), r2(clamp(d.hp / d.maxhp, 0, 1))]);
    snap.gw = room.gw ? [Math.round(room.gw.x), Math.round(room.gw.y), room.gw.range, room.gw.core, room.gw.st] : null;
    snap.nv = room.nv ? {
      s: room.nv.safes.map(q => [Math.round(q.x), Math.round(q.y), q.r]),
      f: room.nv.fired ? 0 : Math.max(0, room.nv.fireAt - now),
      fl: room.nv.fired ? Math.max(0, room.nv.flashUntil - now) : 0
    } : null;
  }

  const msg = JSON.stringify(snap);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) { try { p.ws.send(msg); } catch (e) { /* ignore */ } }
  }
}

function updateRoom(room, dt, now) {
  room.now = now; room.dt = dt;
  for (const p of room.players.values()) updatePlayer(room, p, dt, now);
  updateBullets(room, dt, now);
  if (room.mode === 'boss') updateBoss(room, dt, now);
  updateBonuses(room, now);
  broadcast(room, now);
}

if (require.main === module) {
  // drop dead connections
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, 30000);

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const room of Object.values(rooms)) updateRoom(room, dt, now);
  }, TICK_MS);

  server.listen(PORT, () => console.log('UFO Arena running on port ' + PORT));
}

module.exports = { rooms, ATTACKS, createPlayer, updateRoom };
