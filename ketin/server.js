// ketin 서버 — node:http + node:sqlite + SSE. 외부 패키지는 영구 저장용 pg 하나뿐이다.
// 핵심 규칙: 그룹 대화방은 "이번 케틴"에 사진을 올린 멤버에게만 내용을 내려준다. 잠금은 서버에서 강제한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const PHOTOS = path.join(DATA, 'photos');
const ORIGIN = (process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const HTTPS = ORIGIN.startsWith('https://');
const TRUST_PROXY = !!(process.env.TRUST_PROXY || process.env.RENDER);
const GOOGLE = { id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '', tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token' };
const GOOGLE_ON = !!(GOOGLE.id && GOOGLE.secret);
const SESSION_DAYS = 180;

let db, SECRET, GM_CODE;
const stmts = new Map();
const prep = (sql) => stmts.get(sql) || (stmts.set(sql, db.prepare(sql)), stmts.get(sql));
const get = (sql, ...a) => prep(sql).get(...a);
const all = (sql, ...a) => prep(sql).all(...a);
const run = (sql, ...a) => { const r = prep(sql).run(...a); store.touch(); return r; };
const id = () => crypto.randomBytes(8).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b))); return crypto.timingSafeEqual(x, y); };

function openDb() {
  db = new DatabaseSync(path.join(DATA, 'ketin.db'));
  store.attach(db);
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS members (group_id TEXT, user_id TEXT, joined INTEGER, PRIMARY KEY (group_id, user_id));
CREATE TABLE IF NOT EXISTS opens (id TEXT PRIMARY KEY, name TEXT NOT NULL, descr TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS open_members (open_id TEXT, user_id TEXT, joined INTEGER, PRIMARY KEY (open_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, text TEXT, late INTEGER, t INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room ON messages (room, id);
CREATE TABLE IF NOT EXISTS shots (group_id TEXT, user_id TEXT, cycle TEXT, msg_id INTEGER, t INTEGER, PRIMARY KEY (group_id, user_id, cycle));
CREATE TABLE IF NOT EXISTS ads (id INTEGER PRIMARY KEY AUTOINCREMENT, placement TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, active INTEGER DEFAULT 1, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL, reply TEXT, created INTEGER NOT NULL, replied INTEGER);
`);
  // users: 예전 버전은 토큰을 그대로 저장했다. 세션 해시 방식으로 옮긴다.
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (cols.includes('token')) {
    db.exec('BEGIN');
    for (const u of db.prepare('SELECT id, token FROM users').all()) db.prepare('INSERT OR IGNORE INTO sessions (hash, user_id, created) VALUES (?, ?, ?)').run(sha(u.token), u.id, Date.now());
    db.exec(`CREATE TABLE users_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, google_sub TEXT UNIQUE, email TEXT, gm INTEGER DEFAULT 0, created INTEGER);
      INSERT INTO users_new (id, name, created) SELECT id, name, created FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT`);
  } else db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, google_sub TEXT UNIQUE, email TEXT, gm INTEGER DEFAULT 0, created INTEGER)');

  const meta = (k, make) => { const row = get('SELECT v FROM meta WHERE k = ?', k); if (row) return row.v; const v = make(); run('INSERT INTO meta (k, v) VALUES (?, ?)', k, v); return v; };
  SECRET = meta('secret', () => crypto.randomBytes(24).toString('hex'));
  GM_CODE = process.env.GM_CODE || process.env.ADMIN_KEY || meta('admin_key', () => crypto.randomBytes(12).toString('base64url'));

  if (!get('SELECT 1 x FROM opens LIMIT 1'))
    for (const [name, descr] of [['새벽 감성', '잠 안 오는 사람들'], ['필름카메라', '현상 맡기고 기다리는 중'], ['오늘 뭐 먹지', '메뉴 정해주는 방'], ['퇴근길 플레이리스트', '한 곡씩 놓고 가기']])
      run('INSERT INTO opens (id, name, descr, created) VALUES (?, ?, ?, ?)', id(), name, descr, Date.now());
  if (!get('SELECT 1 x FROM ads LIMIT 1'))
    for (const p of ['home', 'open', 'chat'])
      run('INSERT INTO ads (placement, title, body, link, created) VALUES (?, ?, ?, ?, ?)', p, '여기에 광고가 들어가요', '광고 문의는 프로필의 문의하기로 보내 주세요.', '', Date.now());
  run('DELETE FROM sessions WHERE created < ?', Date.now() - SESSION_DAYS * 864e5);
}

/* ── 케틴 시각: 하루 한 번, 한국 시간 10:00~22:00 사이의 예측 못 할 시각 ── */
const KST = 9 * 3600e3;
const dayStr = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const shiftDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function ketinAt(day) {
  const h = crypto.createHmac('sha256', SECRET).update(day).digest().readUInt32BE(0);
  return Date.parse(day + 'T00:00:00Z') - KST + (10 * 60 + (h % (12 * 60))) * 60e3;
}
// 지금 속한 회차. 오늘 케틴이 아직 안 울렸으면 어제 회차가 계속된다.
function cycle(now = Date.now()) {
  let d = dayStr(now);
  if (now < ketinAt(d)) d = shiftDay(d, -1);
  return { id: d, at: ketinAt(d), next: ketinAt(shiftDay(d, 1)) };
}
function streak(uid) {
  const days = all('SELECT DISTINCT cycle FROM shots WHERE user_id = ? ORDER BY cycle DESC LIMIT 400', uid).map((r) => r.cycle);
  let d = cycle().id, n = 0;
  if (days[0] !== d) d = shiftDay(d, -1);
  for (const x of days) { if (x !== d) break; n++; d = shiftDay(d, -1); }
  return n;
}

/* ── 실시간: SSE ── */
const streams = new Map(); // user id → Set<res>
function push(uid, ev) {
  const set = streams.get(uid);
  if (set) for (const r of set) r.write(`data: ${JSON.stringify(ev)}\n\n`);
}
setInterval(() => { for (const set of streams.values()) for (const r of set) r.write(':\n\n'); }, 25e3).unref();

const hasShot = (gid, uid, cyc) => !!get('SELECT 1 x FROM shots WHERE group_id = ? AND user_id = ? AND cycle = ?', gid, uid, cyc);
const msgOut = (m) => ({ id: m.id, from: m.user_id, name: m.name || null, kind: m.kind, text: m.text, late: m.late, t: m.t });
const loadMsg = (mid) => msgOut(get('SELECT m.*, u.name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', mid));
const addMsg = (room, uid, kind, text, late = null) => Number(run('INSERT INTO messages (room, user_id, kind, text, late, t) VALUES (?, ?, ?, ?, ?, ?)', room, uid, kind, text, late, Date.now()).lastInsertRowid);

// 그룹 메시지는 사진을 올린 멤버에게만 내용이 간다. 나머지에겐 "무언가 올라왔다"는 신호만.
function castGroup(gid, msg, extra) {
  const c = cycle();
  for (const { user_id } of all('SELECT user_id FROM members WHERE group_id = ?', gid)) {
    if (!streams.has(user_id)) continue;
    const open = hasShot(gid, user_id, c.id);
    push(user_id, open ? { type: 'msg', room: 'g:' + gid, msg, ...extra } : { type: 'hidden', room: 'g:' + gid, ...extra });
  }
}
function castOpen(oid, ev) {
  for (const { user_id } of all('SELECT user_id FROM open_members WHERE open_id = ?', oid)) push(user_id, { room: 'o:' + oid, ...ev });
}

/* ── 화면용 데이터 ── */
function groupView(g, u) {
  const c = cycle();
  const members = all(
    `SELECT u.id, u.name, EXISTS (SELECT 1 FROM shots s WHERE s.group_id = m.group_id AND s.user_id = u.id AND s.cycle = ?) done
     FROM members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined`, c.id, g.id);
  const unlocked = members.some((m) => m.id === u.id && m.done);
  const base = { id: g.id, name: g.name, code: g.code, cycle: c, unlocked, members: members.map((m) => ({ id: m.id, name: m.name, done: !!m.done })) };
  if (!unlocked) {
    const h = get(`SELECT COUNT(*) n, COALESCE(SUM(kind = 'photo'), 0) p FROM messages WHERE room = ? AND t >= ? AND kind != 'sys'`, 'g:' + g.id, c.at);
    return { ...base, hidden: { msgs: h.n - h.p, photos: h.p } };
  }
  const msgs = all('SELECT m.*, u.name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.room = ? ORDER BY m.id DESC LIMIT 200', 'g:' + g.id).reverse().map(msgOut);
  return { ...base, msgs };
}
function openView(o, u) {
  const joined = !!get('SELECT 1 x FROM open_members WHERE open_id = ? AND user_id = ?', o.id, u.id);
  const n = get('SELECT COUNT(*) n FROM open_members WHERE open_id = ?', o.id).n;
  const msgs = all('SELECT m.*, u.name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.room = ? ORDER BY m.id DESC LIMIT 200', 'o:' + o.id).reverse().map(msgOut);
  return { id: o.id, name: o.name, desc: o.descr, n, joined, msgs, ad: adFor('chat') };
}
function adFor(placement) {
  const ad = get('SELECT id, title, body, link FROM ads WHERE placement = ? AND active = 1 ORDER BY RANDOM() LIMIT 1', placement);
  if (ad) run('UPDATE ads SET impressions = impressions + 1 WHERE id = ?', ad.id);
  return ad || null;
}
function homeView(u) {
  const c = cycle();
  const groups = all('SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY m.joined DESC', u.id).map((g) => {
    const names = all('SELECT u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined', g.id).map((r) => r.name);
    const done = get('SELECT COUNT(*) n FROM shots WHERE group_id = ? AND cycle = ?', g.id, c.id).n;
    const posted = hasShot(g.id, u.id, c.id);
    const last = get('SELECT m.kind, m.text, m.t, u.name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.room = ? ORDER BY m.id DESC LIMIT 1', 'g:' + g.id);
    // 잠긴 방은 미리보기도 내려주지 않는다.
    const preview = !last ? null : !posted ? null : last.kind === 'photo' ? `${last.name}: 사진` : last.kind === 'sys' ? last.text : `${last.name}: ${last.text}`;
    return { id: g.id, name: g.name, initials: names.slice(0, 2).map((n) => n[0]), members: names.length, done, posted, preview, lastT: last ? last.t : g.created };
  });
  const opens = all(
    `SELECT o.id, o.name, o.descr, (SELECT COUNT(*) FROM open_members x WHERE x.open_id = o.id) n,
     EXISTS (SELECT 1 FROM open_members x WHERE x.open_id = o.id AND x.user_id = ?) joined FROM opens o ORDER BY joined DESC, n DESC, o.created DESC LIMIT 100`, u.id)
    .map((o) => ({ id: o.id, name: o.name, desc: o.descr, n: o.n, joined: !!o.joined }));
  return { me: { id: u.id, name: u.name, streak: streak(u.id), gm: !!u.gm, google: !!u.google_sub, email: u.email || null }, config: { google: GOOGLE_ON },
    cycle: c, groups, opens, ads: { home: adFor('home'), open: adFor('open') } };
}

/* ── HTTP 도우미와 방어 ── */
class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
function readJson(req, limit = 3e6) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new Fail(415, '잘못된 요청이에요'));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Fail(413, '너무 큰 요청이에요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString()); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new Fail(400, '잘못된 요청이에요')); } });
    req.on('error', reject);
  });
}
// 제어 문자와 보이지 않는 방향 전환 문자를 지운다.
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e]', 'g');
const clean = (s, max) => String(s ?? '').replace(UNSAFE, ' ').trim().slice(0, max);
const cookieOf = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9_-]+)').exec(req.headers.cookie || ''); return m ? m[1] : null; };
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${HTTPS ? '; Secure' : ''}`;
function ipOf(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip']; if (cf) return String(cf);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}
// 횟수 제한: key 별로 window 동안 max 번까지.
const buckets = new Map();
function limit(key, max, windowMs, msg) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (++b.n > max) throw new Fail(429, msg || '요청이 너무 많아요. 잠시 후에 다시 해 주세요');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60e3).unref();

function userOf(req) {
  const t = cookieOf(req, 'kt'); if (!t) return null;
  const s = get('SELECT user_id, created FROM sessions WHERE hash = ?', sha(t));
  if (!s || s.created < Date.now() - SESSION_DAYS * 864e5) return null;
  return get('SELECT * FROM users WHERE id = ?', s.user_id) || null;
}
function newSession(uid) {
  const t = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (hash, user_id, created) VALUES (?, ?, ?)', sha(t), uid, Date.now());
  return cookie('kt', t, SESSION_DAYS * 86400);
}
const newCode = () => { for (;;) { const c = Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join(''); if (!get('SELECT 1 x FROM groups WHERE code = ?', c)) return c; } };
const memberGroup = (gid, u) => {
  const g = get('SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id WHERE g.id = ? AND m.user_id = ?', gid, u.id);
  if (!g) throw new Fail(404, '들어가 있지 않은 그룹이에요');
  return g;
};

/* ── 구글 로그인 (서버가 직접 코드를 토큰으로 바꾼다) ── */
const originOf = (req) => ORIGIN || `http://${req.headers.host}`;
async function googleAuth(req, res, url) {
  if (!GOOGLE_ON) throw new Fail(404, '구글 로그인이 아직 설정되지 않았어요');
  const redirect = originOf(req) + '/auth/google/callback';
  if (url.pathname === '/auth/google') {
    limit('oauth:' + ipOf(req), 20, 600e3);
    const state = crypto.randomBytes(18).toString('base64url');
    const q = new URLSearchParams({ client_id: GOOGLE.id, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, 'set-cookie': cookie('kt_state', state, 600) });
    return res.end();
  }
  const done = (headers = {}) => { res.writeHead(302, { location: '/', ...headers }); res.end(); };
  const state = cookieOf(req, 'kt_state'), code = url.searchParams.get('code');
  if (!state || !code || !safeEq(state, url.searchParams.get('state') || '')) return done();
  const r = await fetch(GOOGLE.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: GOOGLE.id, client_secret: GOOGLE.secret, redirect_uri: redirect, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10e3) });
  const tok = await r.json().catch(() => ({}));
  let p = null;
  try { p = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()); } catch {}
  // 토큰은 구글 서버에서 TLS로 직접 받았다. 발급자, 대상 앱, 만료를 확인한다.
  if (!r.ok || !p || !p.sub || p.aud !== GOOGLE.id || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) || p.exp * 1000 < Date.now()) return done();
  const sub = String(p.sub), email = p.email_verified ? clean(p.email, 120) : null;
  let u = get('SELECT * FROM users WHERE google_sub = ?', sub);
  const now = userOf(req);
  if (!u && now && !now.google_sub) { run('UPDATE users SET google_sub = ?, email = ? WHERE id = ?', sub, email, now.id); u = now; } // 게스트 계정을 구글에 연결
  if (!u) { u = { id: id() }; run('INSERT INTO users (id, name, google_sub, email, created) VALUES (?, ?, ?, ?, ?)', u.id, clean(p.given_name || p.name, 10) || '친구', sub, email, Date.now()); }
  done({ 'set-cookie': [newSession(u.id), cookie('kt_state', '', 0)] });
}

/* ── API ── */
async function api(req, res, url) {
  const p = url.pathname.slice(4), M = req.method, seg = p.split('/').filter(Boolean), ip = ipOf(req);
  limit('ip:' + ip, 600, 60e3);
  // 다른 사이트에서 보낸 변경 요청은 받지 않는다.
  if (M !== 'GET') {
    const o = req.headers.origin;
    if (o) { let h = ''; try { h = new URL(o).host; } catch {} if (h !== req.headers.host) throw new Fail(403, '허용되지 않은 요청이에요'); }
  }

  if (p === '/config' && M === 'GET') return send(res, 200, { google: GOOGLE_ON });
  if (p === '/signup' && M === 'POST') {
    limit('signup:' + ip, 10, 3600e3, '계정을 너무 많이 만들었어요. 나중에 다시 해 주세요');
    const name = clean((await readJson(req)).name, 10);
    if (!name) throw new Fail(400, '이름을 적어 주세요');
    const uid = id();
    run('INSERT INTO users (id, name, created) VALUES (?, ?, ?)', uid, name, Date.now());
    return send(res, 200, { ok: true }, { 'set-cookie': newSession(uid) });
  }
  // 광고 클릭은 로그인 없이도 센다.
  if (seg[0] === 'ads' && seg[2] === 'click' && M === 'POST') { limit('click:' + ip, 30, 60e3); run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', Number(seg[1]) || 0); return send(res, 200, { ok: true }); }

  const u = userOf(req);

  /* 관리자: GM 코드로 로그인한 계정이거나, 요청에 GM 코드를 직접 실은 경우 */
  if (seg[0] === 'admin') {
    const key = req.headers['x-admin-key'];
    if (key !== undefined) { limit('gm:' + ip, 8, 900e3, '시도가 너무 많아요. 15분 뒤에 다시 해 주세요'); if (!safeEq(key, GM_CODE)) throw new Fail(401, 'GM 코드가 맞지 않아요'); }
    else if (!u || !u.gm) throw new Fail(401, 'GM 코드로 로그인해 주세요');
    if (seg[1] === 'overview' && M === 'GET') {
      const c = cycle(), n = (sql, ...a) => get(sql, ...a).n;
      return send(res, 200, {
        stats: { users: n('SELECT COUNT(*) n FROM users'), google: n('SELECT COUNT(*) n FROM users WHERE google_sub IS NOT NULL'), groups: n('SELECT COUNT(*) n FROM groups'), opens: n('SELECT COUNT(*) n FROM opens'),
          messages: n('SELECT COUNT(*) n FROM messages WHERE kind != ?', 'sys'), shotsToday: n('SELECT COUNT(*) n FROM shots WHERE cycle = ?', c.id), online: streams.size },
        cycle: c, saved: { remote: store.remote(), ok: store.healthy() }, ads: all('SELECT * FROM ads ORDER BY id DESC'),
        inquiries: all('SELECT q.*, u.name, u.email FROM inquiries q LEFT JOIN users u ON u.id = q.user_id ORDER BY q.replied IS NOT NULL, q.id DESC LIMIT 200'),
      });
    }
    if (seg[1] === 'ads' && M === 'POST' && !seg[2]) {
      const b = await readJson(req), placement = ['home', 'open', 'chat'].includes(b.placement) ? b.placement : 'home';
      const title = clean(b.title, 40), link = clean(b.link, 300);
      if (!title) throw new Fail(400, '광고 제목을 적어 주세요');
      if (link && !/^https?:\/\/[^\s"'<>]+$/i.test(link)) throw new Fail(400, '링크는 http:// 또는 https:// 로 시작해야 해요');
      run('INSERT INTO ads (placement, title, body, link, created) VALUES (?, ?, ?, ?, ?)', placement, title, clean(b.body, 80), link, Date.now());
      return send(res, 200, { ok: true });
    }
    if (seg[1] === 'ads' && seg[3] === 'toggle' && M === 'POST') { run('UPDATE ads SET active = 1 - active WHERE id = ?', Number(seg[2]) || 0); return send(res, 200, { ok: true }); }
    if (seg[1] === 'ads' && seg[2] && M === 'DELETE') { run('DELETE FROM ads WHERE id = ?', Number(seg[2]) || 0); return send(res, 200, { ok: true }); }
    if (seg[1] === 'inquiries' && seg[3] === 'reply' && M === 'POST') {
      const reply = clean((await readJson(req)).reply, 1000), q = get('SELECT * FROM inquiries WHERE id = ?', Number(seg[2]) || 0);
      if (!q) throw new Fail(404, '없는 문의예요'); if (!reply) throw new Fail(400, '답변을 적어 주세요');
      run('UPDATE inquiries SET reply = ?, replied = ? WHERE id = ?', reply, Date.now(), q.id);
      push(q.user_id, { type: 'inquiry' });
      return send(res, 200, { ok: true });
    }
    throw new Fail(404, '없는 주소예요');
  }

  if (!u) throw new Fail(401, '먼저 시작해 주세요');
  if (M !== 'GET') limit('write:' + u.id, 120, 60e3);

  if (p === '/home' && M === 'GET') return send(res, 200, homeView(u));
  if (p === '/me' && M === 'POST') {
    const name = clean((await readJson(req)).name, 10);
    if (!name) throw new Fail(400, '이름을 적어 주세요');
    run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/logout' && M === 'POST') {
    run('DELETE FROM sessions WHERE hash = ?', sha(cookieOf(req, 'kt')));
    for (const r of streams.get(u.id) || []) r.end();
    return send(res, 200, { ok: true }, { 'set-cookie': cookie('kt', '', 0) });
  }
  if (p === '/gm' && M === 'POST') {
    limit('gm:' + ip, 8, 900e3, '시도가 너무 많아요. 15분 뒤에 다시 해 주세요');
    limit('gm:' + u.id, 8, 900e3, '시도가 너무 많아요. 15분 뒤에 다시 해 주세요');
    if (!safeEq((await readJson(req)).code ?? '', GM_CODE)) throw new Fail(401, 'GM 코드가 맞지 않아요');
    run('UPDATE users SET gm = 1 WHERE id = ?', u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/events' && M === 'GET') {
    if ((streams.get(u.id)?.size || 0) >= 6) throw new Fail(429, '열린 연결이 너무 많아요');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (!streams.has(u.id)) streams.set(u.id, new Set());
    streams.get(u.id).add(res);
    req.on('close', () => { const s = streams.get(u.id); if (s) { s.delete(res); if (!s.size) streams.delete(u.id); } });
    return;
  }

  /* 문의 */
  if (p === '/inquiries' && M === 'GET') return send(res, 200, { list: all('SELECT id, text, reply, created, replied FROM inquiries WHERE user_id = ? ORDER BY id DESC LIMIT 30', u.id) });
  if (p === '/inquiries' && M === 'POST') {
    limit('inq:' + u.id, 5, 3600e3, '문의는 한 시간에 다섯 번까지 보낼 수 있어요');
    const text = clean((await readJson(req)).text, 1000);
    if (text.length < 5) throw new Fail(400, '내용을 조금 더 적어 주세요');
    run('INSERT INTO inquiries (user_id, text, created) VALUES (?, ?, ?)', u.id, text, Date.now());
    return send(res, 200, { ok: true });
  }
  // 운영자는 오픈채팅 메시지를 지울 수 있다. 그룹 대화는 운영자도 볼 수 없다.
  if (seg[0] === 'messages' && seg[2] === 'delete' && M === 'POST') {
    if (!u.gm) throw new Fail(403, '운영자만 할 수 있어요');
    const m = get(`SELECT * FROM messages WHERE id = ? AND room LIKE 'o:%' AND kind = 'text'`, Number(seg[1]) || 0);
    if (!m) throw new Fail(404, '없는 메시지예요');
    run(`UPDATE messages SET kind = 'sys', user_id = NULL, text = '운영자가 삭제한 메시지예요' WHERE id = ?`, m.id);
    castOpen(m.room.slice(2), { type: 'del', msg: loadMsg(m.id) });
    return send(res, 200, { ok: true });
  }

  /* 그룹 */
  if (p === '/groups' && M === 'POST') {
    limit('mkgroup:' + u.id, 10, 3600e3);
    const name = clean((await readJson(req)).name, 16);
    if (!name) throw new Fail(400, '그룹 이름을 적어 주세요');
    const g = { id: id(), name, code: newCode() };
    run('INSERT INTO groups (id, name, code, created) VALUES (?, ?, ?, ?)', g.id, g.name, g.code, Date.now());
    run('INSERT INTO members (group_id, user_id, joined) VALUES (?, ?, ?)', g.id, u.id, Date.now());
    addMsg('g:' + g.id, null, 'sys', `${u.name} 님이 '${name}' 그룹을 만들었어요`);
    return send(res, 200, { id: g.id });
  }
  if (p === '/groups/join' && M === 'POST') {
    // 초대코드를 마구 넣어 보는 것을 막는다.
    limit('join:' + u.id, 12, 600e3, '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요');
    limit('join:' + ip, 30, 600e3, '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요');
    const code = clean((await readJson(req)).code, 6).toUpperCase();
    const g = get('SELECT * FROM groups WHERE code = ?', code);
    if (!g) throw new Fail(404, '그런 초대코드는 없어요');
    if (!get('SELECT 1 x FROM members WHERE group_id = ? AND user_id = ?', g.id, u.id)) {
      if (get('SELECT COUNT(*) n FROM members WHERE group_id = ?', g.id).n >= 30) throw new Fail(400, '그룹이 가득 찼어요');
      run('INSERT INTO members (group_id, user_id, joined) VALUES (?, ?, ?)', g.id, u.id, Date.now());
      castGroup(g.id, loadMsg(addMsg('g:' + g.id, null, 'sys', `${u.name} 님이 들어왔어요`)), { members: true });
    }
    return send(res, 200, { id: g.id });
  }
  if (seg[0] === 'groups' && seg[1]) {
    const g = memberGroup(seg[1], u), room = 'g:' + g.id, c = cycle();
    if (!seg[2] && M === 'GET') return send(res, 200, groupView(g, u));
    if (seg[2] === 'shot' && M === 'POST') {
      limit('shot:' + u.id, 20, 3600e3);
      if (hasShot(g.id, u.id, c.id)) throw new Fail(409, '오늘은 이미 찍었어요');
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((await readJson(req)).image || ''));
      const buf = m && Buffer.from(m[1], 'base64');
      if (!buf || buf.length < 500 || buf.length > 2e6 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new Fail(400, '사진을 읽을 수 없어요. 다시 찍어 주세요');
      if (hasShot(g.id, u.id, c.id)) throw new Fail(409, '오늘은 이미 찍었어요');
      const mid = addMsg(room, u.id, 'photo', null, Math.max(0, Math.round((Date.now() - c.at) / 60e3)));
      run('INSERT INTO shots (group_id, user_id, cycle, msg_id, t) VALUES (?, ?, ?, ?, ?)', g.id, u.id, c.id, mid, Date.now());
      fs.writeFileSync(path.join(PHOTOS, mid + '.jpg'), buf);
      await store.putPhoto(mid, buf).catch((e) => console.error('사진 저장 실패', e.message));
      castGroup(g.id, loadMsg(mid), { shot: u.id });
      return send(res, 200, groupView(g, u));
    }
    if (seg[2] === 'messages' && M === 'POST') {
      if (!hasShot(g.id, u.id, c.id)) throw new Fail(423, '사진을 찍어야 대화방이 열려요');
      limit('msg:' + u.id, 40, 20e3, '조금 천천히 보내 주세요');
      const text = clean((await readJson(req)).text, 1000);
      if (!text) throw new Fail(400, '빈 메시지예요');
      const msg = loadMsg(addMsg(room, u.id, 'text', text));
      castGroup(g.id, msg);
      return send(res, 200, msg);
    }
    if (seg[2] === 'leave' && M === 'POST') {
      run('DELETE FROM members WHERE group_id = ? AND user_id = ?', g.id, u.id);
      castGroup(g.id, loadMsg(addMsg(room, null, 'sys', `${u.name} 님이 나갔어요`)), { members: true });
      return send(res, 200, { ok: true });
    }
  }
  // 사진 파일도 같은 잠금을 거친다.
  if (seg[0] === 'photo' && M === 'GET') {
    const m = get(`SELECT * FROM messages WHERE id = ? AND kind = 'photo'`, Number(seg[1]) || 0);
    if (!m) throw new Fail(404, '없는 사진이에요');
    const g = memberGroup(m.room.slice(2), u);
    if (!hasShot(g.id, u.id, cycle().id)) throw new Fail(423, '사진을 찍어야 볼 수 있어요');
    const file = path.join(PHOTOS, m.id + '.jpg');
    if (!fs.existsSync(file)) { const buf = await store.getPhoto(m.id); if (!buf) throw new Fail(404, '없는 사진이에요'); fs.writeFileSync(file, buf); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  /* 오픈채팅 */
  if (p === '/opens' && M === 'POST') {
    limit('mkopen:' + u.id, 5, 3600e3, '방은 한 시간에 다섯 개까지 만들 수 있어요');
    const b = await readJson(req), name = clean(b.name, 18);
    if (!name) throw new Fail(400, '방 이름을 적어 주세요');
    const o = { id: id() };
    run('INSERT INTO opens (id, name, descr, created) VALUES (?, ?, ?, ?)', o.id, name, clean(b.desc, 30) || '방금 열린 방', Date.now());
    run('INSERT INTO open_members (open_id, user_id, joined) VALUES (?, ?, ?)', o.id, u.id, Date.now());
    addMsg('o:' + o.id, null, 'sys', '방이 열렸어요');
    return send(res, 200, { id: o.id });
  }
  if (seg[0] === 'opens' && seg[1]) {
    const o = get('SELECT * FROM opens WHERE id = ?', seg[1]);
    if (!o) throw new Fail(404, '없는 방이에요');
    const joined = !!get('SELECT 1 x FROM open_members WHERE open_id = ? AND user_id = ?', o.id, u.id);
    if (!seg[2] && M === 'GET') return send(res, 200, openView(o, u));
    if (seg[2] === 'join' && M === 'POST') {
      if (!joined) {
        run('INSERT INTO open_members (open_id, user_id, joined) VALUES (?, ?, ?)', o.id, u.id, Date.now());
        castOpen(o.id, { type: 'msg', msg: loadMsg(addMsg('o:' + o.id, null, 'sys', `${u.name} 님이 들어왔어요`)) });
      }
      return send(res, 200, openView(o, u));
    }
    if (seg[2] === 'messages' && M === 'POST') {
      if (!joined) throw new Fail(403, '먼저 방에 참여해 주세요');
      limit('msg:' + u.id, 40, 20e3, '조금 천천히 보내 주세요');
      const text = clean((await readJson(req)).text, 1000);
      if (!text) throw new Fail(400, '빈 메시지예요');
      const msg = loadMsg(addMsg('o:' + o.id, u.id, 'text', text));
      castOpen(o.id, { type: 'msg', msg });
      return send(res, 200, msg);
    }
  }
  throw new Fail(404, '없는 주소예요');
}

/* ── 정적 파일 ── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/privacy': 'privacy.html' };
function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, PAGES[pathname] || pathname.slice(1));
  if (pathname.includes('\0') || !file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function handle(req, res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), payment=()');
  if (HTTPS) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  try {
    const url = new URL(req.url, 'http://x');
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw new Fail(405, '허용되지 않은 요청이에요');
    if (url.pathname === '/health') return send(res, 200, { ok: true, saved: store.healthy() });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/auth/google')) return await googleAuth(req, res, url);
    if (req.method !== 'GET') throw new Fail(405, '허용되지 않은 요청이에요');
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw new Fail(400, '잘못된 주소예요'); }
    serveStatic(res, pathname);
  } catch (e) {
    if (!(e instanceof Fail)) console.error(e);
    if (!res.headersSent) send(res, e instanceof Fail ? e.status : 500, { error: e instanceof Fail ? e.message : '서버에서 문제가 생겼어요' });
    else res.end();
  }
}

(async () => {
  fs.mkdirSync(PHOTOS, { recursive: true });
  const remote = await store.init(DATA);
  openDb();
  const server = http.createServer(handle);
  server.requestTimeout = 30e3; server.headersTimeout = 15e3; server.maxHeadersCount = 60;
  server.listen(PORT, () => {
    console.log(`ketin  ${ORIGIN || 'http://localhost:' + PORT}`);
    console.log(`저장: ${remote ? 'Postgres에 보관' : '이 서버의 디스크 (' + DATA + ')'} · 구글 로그인: ${GOOGLE_ON ? '켜짐' : '꺼짐'}`);
    if (!process.env.GM_CODE && !process.env.ADMIN_KEY) console.log(`GM 코드: ${GM_CODE}  (환경변수 GM_CODE 로 직접 정할 수 있어요)`);
  });
  // 서버가 내려가기 전에 마지막 변경을 저장한다.
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
    if (closing) return; closing = true;
    for (const set of streams.values()) for (const r of set) r.end();
    server.close();
    await store.flush().catch(() => {});
    process.exit(0);
  });
})().catch((e) => { console.error('시작 실패', e); process.exit(1); });
