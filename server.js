// Voxel Combat 3 - multiplayer + accounts server
// Needs Node 18+. Accounts are stored in a free Upstash Redis database
// (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN). Without them the
// server still runs, but accounts are kept in memory and vanish on restart.
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 8080;
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_PER_ROOM = 16;
const WEAPONS = ['rifle','pistol','shotgun','smg','burst','revolver','sniper','plasma','minigun','rocket'];

// ---------- storage ----------
const mem = new Map(), memSets = new Map();
if (!REDIS_URL) console.warn('WARNING: no database configured - accounts will be lost when the server restarts.');
async function db(a) {
  if (!REDIS_URL) {
    const [c, k, v] = a;
    if (c === 'GET') return mem.has(k) ? mem.get(k) : null;
    if (c === 'SET') { mem.set(k, v); return 'OK'; }
    if (c === 'DEL') { mem.delete(k); return 1; }
    if (c === 'SADD') { if (!memSets.has(k)) memSets.set(k, new Set()); memSets.get(k).add(v); return 1; }
    if (c === 'SMEMBERS') return [...(memSets.get(k) || [])];
    if (c === 'MGET') return a.slice(1).map(x => mem.has(x) ? mem.get(x) : null);
    throw new Error('bad cmd');
  }
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(a) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// ---------- helpers ----------
const nameOk = n => typeof n === 'string' && /^[A-Za-z0-9_]{3,14}$/.test(n);
const pwOk = p => typeof p === 'string' && p.length >= 6 && p.length <= 64;
const roomOk = r => typeof r === 'string' && /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(r) && (r.startsWith('r-') || r.startsWith('pub-'));
const int = (v, max = 1e9) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
function cleanProfile(p, base) {
  p = p && typeof p === 'object' ? p : {};
  const out = Object.assign({ icon: '🦊', title: 'Rookie', coins: 100, owned: ['rifle', 'pistol'], st: { k: 0, d: 0, m: 0, hs: 0, bs: 0, lb: 0 } }, base || {});
  if (typeof p.icon === 'string' && p.icon.length <= 8) out.icon = p.icon;
  if (typeof p.title === 'string' && /^[A-Za-z ]{1,20}$/.test(p.title)) out.title = p.title;
  if (p.coins !== undefined) out.coins = int(p.coins);
  if (Array.isArray(p.owned)) out.owned = [...new Set(['rifle', 'pistol', ...p.owned.filter(x => WEAPONS.includes(x))])];
  if (p.st && typeof p.st === 'object') for (const k of ['k', 'd', 'm', 'hs', 'bs', 'lb']) if (p.st[k] !== undefined) out.st[k] = int(p.st[k]);
  return out;
}
const pub = rec => ({ name: rec.name, icon: rec.icon, title: rec.title, coins: rec.coins, owned: rec.owned, st: rec.st });
async function hashPw(pw, salt) { return (await scrypt(pw, salt, 32)).toString('hex'); }
async function getUser(lc) { const r = await db(['GET', 'u:' + lc]); return r ? JSON.parse(r) : null; }
const putUser = rec => db(['SET', 'u:' + rec.name.toLowerCase(), JSON.stringify(rec)]);
async function newToken(lc) { const t = crypto.randomBytes(24).toString('hex'); await db(['SET', 't:' + t, lc, 'EX', 60 * 60 * 24 * 30]); return t; }

// ---------- rate limits ----------
const fails = new Map(), regs = new Map();
function blocked(ip) { const f = fails.get(ip); return f && f.until > Date.now(); }
function failed(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; if (++f.n >= 8) { f.until = Date.now() + 60000; f.n = 0; } fails.set(ip, f); }
setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (v.until < n && v.n === 0) fails.delete(k); for (const [k, v] of regs) if (v.t < n) regs.delete(k); }, 600000);

// ---------- server ----------
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Voxel Combat server is running'); });
const wss = new WebSocketServer({
  server, maxPayload: 8192,
  verifyClient: info => !ORIGINS.length || ORIGINS.includes((info.origin || '').replace(/\/$/, ''))
});
const clients = new Set(), rooms = new Map(), online = new Map(); // online: lc -> client
const send = (c, o) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
function leaveRoom(c) {
  if (!c.room) return;
  const set = rooms.get(c.room);
  if (set) { set.delete(c); if (!set.size) rooms.delete(c.room); else set.forEach(o => send(o, { t: 'left', id: c.id })); }
  c.room = ''; c.pr = null;
}
function login(c, rec, token) {
  const lc = rec.name.toLowerCase();
  const old = online.get(lc);
  if (old && old !== c) { send(old, { t: 'kicked' }); leaveRoom(old); old.lc = ''; old.ws.close(); }
  c.lc = lc; c.rec = rec; online.set(lc, c);
  send(c, { t: 'auth', ok: 1, token, profile: pub(rec) });
}

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { ws, ip, id: crypto.randomBytes(4).toString('hex'), lc: '', rec: null, room: '', map: '', pr: null, n: 0 };
  clients.add(c);
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async raw => {
    if (++c.n > 80) return ws.close();            // flood protection (resets every second)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      switch (m.t) {
        case 'register': {
          if (blocked(ip)) return send(c, { t: 'auth', ok: 0, err: 'Too many tries. Wait a minute.' });
          const r = regs.get(ip) || { n: 0, t: Date.now() + 3600000 };
          if (r.n >= 5) return send(c, { t: 'auth', ok: 0, err: 'Too many accounts from your network. Try later.' });
          if (!nameOk(m.name)) return send(c, { t: 'auth', ok: 0, err: 'Username must be 3-14 letters, numbers or _' });
          if (!pwOk(m.pw)) return send(c, { t: 'auth', ok: 0, err: 'Password must be 6-64 characters' });
          const lc = m.name.toLowerCase();
          if (await getUser(lc)) return send(c, { t: 'auth', ok: 0, err: '"' + m.name + '" is already taken' });
          const salt = crypto.randomBytes(16).toString('hex');
          const rec = Object.assign({ name: m.name, salt, hash: await hashPw(m.pw, salt), created: Date.now() }, cleanProfile(m.profile));
          await putUser(rec); await db(['SADD', 'users', lc]);
          r.n++; regs.set(ip, r);
          login(c, rec, await newToken(lc));
          break;
        }
        case 'login': {
          if (blocked(ip)) return send(c, { t: 'auth', ok: 0, err: 'Too many tries. Wait a minute.' });
          const rec = nameOk(m.name) && pwOk(m.pw) ? await getUser(m.name.toLowerCase()) : null;
          const good = rec && crypto.timingSafeEqual(Buffer.from(await hashPw(m.pw, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
          if (!good) { failed(ip); return send(c, { t: 'auth', ok: 0, err: 'Wrong username or password' }); }
          login(c, rec, await newToken(rec.name.toLowerCase()));
          break;
        }
        case 'resume': {
          const lc = typeof m.token === 'string' && /^[a-f0-9]{48}$/.test(m.token) ? await db(['GET', 't:' + m.token]) : null;
          const rec = lc ? await getUser(lc) : null;
          if (!rec) return send(c, { t: 'auth', ok: 0, err: 'session' });
          login(c, rec, m.token);
          break;
        }
        case 'logout':
          if (typeof m.token === 'string' && /^[a-f0-9]{48}$/.test(m.token)) await db(['DEL', 't:' + m.token]);
          leaveRoom(c); if (c.lc && online.get(c.lc) === c) online.delete(c.lc); c.lc = ''; c.rec = null;
          break;
        case 'save':
          if (!c.rec) return;
          Object.assign(c.rec, cleanProfile(m.profile, c.rec));
          await putUser(c.rec);
          break;
        case 'search': {
          if (!c.rec) return;
          const q = String(m.q || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14);
          if (!q) return send(c, { t: 'results', rows: [] });
          const all = (await db(['SMEMBERS', 'users'])).filter(n => n.includes(q) && n !== c.lc);
          all.sort((a, b) => (online.has(b) ? 1 : 0) - (online.has(a) ? 1 : 0) || a.length - b.length);
          const top = all.slice(0, 10);
          const recs = top.length ? await db(['MGET', ...top.map(n => 'u:' + n)]) : [];
          const rows = recs.filter(Boolean).map(JSON.parse).map(r => {
            const o = online.get(r.name.toLowerCase());
            return { name: r.name, icon: r.icon, title: r.title, online: !!o, room: o ? o.room : '', map: o ? o.map : '' };
          });
          send(c, { t: 'results', rows });
          break;
        }
        case 'join': {
          if (!c.rec) return send(c, { t: 'joined', ok: 0, err: 'Log in first' });
          if (!roomOk(m.room)) return send(c, { t: 'joined', ok: 0, err: 'Bad lobby name' });
          const set = rooms.get(m.room) || new Set();
          if (set.size >= MAX_PER_ROOM && !set.has(c)) return send(c, { t: 'joined', ok: 0, err: 'Lobby is full' });
          if (c.room !== m.room) leaveRoom(c);
          set.add(c); rooms.set(m.room, set);
          c.room = m.room; c.map = typeof m.map === 'string' ? m.map.slice(0, 12) : '';
          send(c, { t: 'joined', ok: 1, id: c.id });
          send(c, { t: 'snap', id: c.id, peers: [...set].map(o => ({ id: o.id, pr: o.pr || {} })) });
          break;
        }
        case 'leave': leaveRoom(c); break;
        case 'pres': {
          if (!c.room || !c.rec || !m.p || typeof m.p !== 'object' || JSON.stringify(m.p).length > 1500) return;
          const pr = Object.assign({}, m.p, { name: c.rec.name, icon: c.rec.icon, title: c.rec.title });
          c.pr = pr;
          rooms.get(c.room).forEach(o => { if (o !== c) send(o, { t: 'u', id: c.id, pr }); });
          break;
        }
      }
    } catch (e) { console.error('handler error', e.message); send(c, { t: 'auth', ok: 0, err: 'Server error, try again' }); }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c); if (c.lc && online.get(c.lc) === c) online.delete(c.lc); });
  ws.on('error', () => {});
});
setInterval(() => clients.forEach(c => c.n = 0), 1000);
setInterval(() => wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }), 30000);
server.listen(PORT, () => console.log('Voxel Combat server listening on port ' + PORT));
