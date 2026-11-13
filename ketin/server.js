// ketin 서버 — 의존성 없이 Node 22+ 만으로 돈다 (node:http + node:sqlite + SSE).
// 핵심 규칙: 그룹 대화방은 "이번 케틴"에 사진을 올린 멤버에게만 내용을 내려준다. 잠금은 서버에서 강제한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const PHOTOS = path.join(DATA, 'photos');
fs.mkdirSync(PHOTOS, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'ketin.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS members (group_id TEXT, user_id TEXT, joined INTEGER, PRIMARY KEY (group_id, user_id));
CREATE TABLE IF NOT EXISTS opens (id TEXT PRIMARY KEY, name TEXT NOT NULL, descr TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS open_members (open_id TEXT, user_id TEXT, joined INTEGER, PRIMARY KEY (open_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, text TEXT, late INTEGER, t INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room ON messages (room, id);
CREATE TABLE IF NOT EXISTS shots (group_id TEXT, user_id TEXT, cycle TEXT, msg_id INTEGER, t INTEGER, PRIMARY KEY (group_id, user_id, cycle));
CREATE TABLE IF NOT EXISTS ads (id INTEGER PRIMARY KEY AUTOINCREMENT, placement TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, active INTEGER DEFAULT 1, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created INTEGER);
`);

const stmts = new Map();
const prep = (sql) => stmts.get(sql) || (stmts.set(sql, db.prepare(sql)), stmts.get(sql));
const get = (sql, ...a) => prep(sql).get(...a);
const all = (sql, ...a) => prep(sql).all(...a);
const run = (sql, ...a) => prep(sql).run(...a);
const id = () => crypto.randomBytes(8).toString('hex');

function meta(k, make) {
  const row = get('SELECT v FROM meta WHERE k = ?', k);
  if (row) return row.v;
  const v = make();
  run('INSERT INTO meta (k, v) VALUES (?, ?)', k, v);
  return v;
}
const SECRET = meta('secret', () => crypto.randomBytes(24).toString('hex'));
const ADMIN_KEY = process.env.ADMIN_KEY || meta('admin_key', () => crypto.randomBytes(9).toString('base64url'));

// 첫 실행 때 오픈채팅 방과 자리 표시용 광고를 넣어 둔다.
if (!get('SELECT 1 x FROM opens LIMIT 1')) {
  for (const [name, descr] of [['새벽 감성', '잠 안 오는 사람들'], ['필름카메라', '현상 맡기고 기다리는 중'], ['오늘 뭐 먹지', '메뉴 정해주는 방'], ['퇴근길 플레이리스트', '한 곡씩 놓고 가기']])
    run('INSERT INTO opens (id, name, descr, created) VALUES (?, ?, ?, ?)', id(), name, descr, Date.now());
}
if (!get('SELECT 1 x FROM ads LIMIT 1')) {
  for (const p of ['home', 'open', 'chat'])
    run('INSERT INTO ads (placement, title, body, link, created) VALUES (?, ?, ?, ?, ?)', p, '여기에 광고가 들어가요', '관리자 페이지에서 문구와 링크를 바꿀 수 있어요.', '', Date.now());
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
  const tomorrow = shiftDay(d, 1);
  return { id: d, at: ketinAt(d), next: ketinAt(tomorrow) };
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

function addMsg(room, uid, kind, text, late = null) {
  const r = run('INSERT INTO messages (room, user_id, kind, text, late, t) VALUES (?, ?, ?, ?, ?, ?)', room, uid, kind, text, late, Date.now());
  return Number(r.lastInsertRowid);
}
// 그룹 메시지는 사진을 올린 멤버에게만 내용이 간다. 나머지에겐 "무언가 올라왔다"는 신호만.
function castGroup(gid, msg, extra) {
  const c = cycle();
  for (const { user_id } of all('SELECT user_id FROM members WHERE group_id = ?', gid)) {
    if (!streams.has(user_id)) continue;
    const open = hasShot(gid, user_id, c.id);
    push(user_id, open ? { type: 'msg', room: 'g:' + gid, msg, ...extra } : { type: 'hidden', room: 'g:' + gid, ...extra });
  }
}
function castOpen(oid, msg) {
  for (const { user_id } of all('SELECT user_id FROM open_members WHERE open_id = ?', oid)) push(user_id, { type: 'msg', room: 'o:' + oid, msg });
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
  return { me: { id: u.id, name: u.name, streak: streak(u.id) }, cycle: c, groups, opens, ads: { home: adFor('home'), open: adFor('open') } };
}

/* ── HTTP 도우미 ── */
class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
function readJson(req, limit = 3e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Fail(413, '너무 큰 요청이에요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Fail(400, '잘못된 요청이에요')); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function userOf(req) {
  const m = /(?:^|;\s*)kt=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  return m ? get('SELECT * FROM users WHERE token = ?', m[1]) : null;
}
const lastSent = new Map();
function throttle(uid) {
  const now = Date.now();
  if (now - (lastSent.get(uid) || 0) < 250) throw new Fail(429, '조금 천천히 보내 주세요');
  lastSent.set(uid, now);
}
const newCode = () => { for (;;) { const c = Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join(''); if (!get('SELECT 1 x FROM groups WHERE code = ?', c)) return c; } };
const memberGroup = (gid, u) => {
  const g = get('SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id WHERE g.id = ? AND m.user_id = ?', gid, u.id);
  if (!g) throw new Fail(404, '들어가 있지 않은 그룹이에요');
  return g;
};

/* ── API ── */
async function api(req, res, url) {
  const p = url.pathname.slice(4), M = req.method, seg = p.split('/').filter(Boolean);

  if (p === '/signup' && M === 'POST') {
    const name = clean((await readJson(req)).name, 10);
    if (!name) throw new Fail(400, '이름을 적어 주세요');
    const u = { id: id(), name, token: crypto.randomBytes(24).toString('hex') };
    run('INSERT INTO users (id, name, token, created) VALUES (?, ?, ?, ?)', u.id, u.name, u.token, Date.now());
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'set-cookie': `kt=${u.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=63072000${secure}` });
  }

  // 광고 클릭은 로그인 없이도 센다.
  if (seg[0] === 'ads' && seg[2] === 'click' && M === 'POST') { run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', Number(seg[1]) || 0); return send(res, 200, { ok: true }); }

  if (seg[0] === 'admin') {
    const key = String(req.headers['x-admin-key'] || '');
    if (key.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) throw new Fail(401, '관리자 키가 맞지 않아요');
    if (seg[1] === 'overview' && M === 'GET') {
      const c = cycle(), n = (sql, ...a) => get(sql, ...a).n;
      return send(res, 200, {
        stats: { users: n('SELECT COUNT(*) n FROM users'), groups: n('SELECT COUNT(*) n FROM groups'), opens: n('SELECT COUNT(*) n FROM opens'),
          messages: n('SELECT COUNT(*) n FROM messages WHERE kind != ?', 'sys'), shotsToday: n('SELECT COUNT(*) n FROM shots WHERE cycle = ?', c.id) },
        cycle: c, ads: all('SELECT * FROM ads ORDER BY id DESC'),
      });
    }
    if (seg[1] === 'ads' && M === 'POST' && !seg[2]) {
      const b = await readJson(req), placement = ['home', 'open', 'chat'].includes(b.placement) ? b.placement : 'home';
      const title = clean(b.title, 40), link = clean(b.link, 300);
      if (!title) throw new Fail(400, '광고 제목을 적어 주세요');
      if (link && !/^https?:\/\//i.test(link)) throw new Fail(400, '링크는 http:// 또는 https:// 로 시작해야 해요');
      run('INSERT INTO ads (placement, title, body, link, created) VALUES (?, ?, ?, ?, ?)', placement, title, clean(b.body, 80), link, Date.now());
      return send(res, 200, { ok: true });
    }
    if (seg[1] === 'ads' && seg[3] === 'toggle' && M === 'POST') { run('UPDATE ads SET active = 1 - active WHERE id = ?', Number(seg[2]) || 0); return send(res, 200, { ok: true }); }
    if (seg[1] === 'ads' && seg[2] && M === 'DELETE') { run('DELETE FROM ads WHERE id = ?', Number(seg[2]) || 0); return send(res, 200, { ok: true }); }
    throw new Fail(404, '없는 주소예요');
  }

  const u = userOf(req);
  if (!u) throw new Fail(401, '먼저 시작해 주세요');

  if (p === '/home' && M === 'GET') return send(res, 200, homeView(u));
  if (p === '/me' && M === 'POST') {
    const name = clean((await readJson(req)).name, 10);
    if (!name) throw new Fail(400, '이름을 적어 주세요');
    run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/events' && M === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (!streams.has(u.id)) streams.set(u.id, new Set());
    streams.get(u.id).add(res);
    req.on('close', () => { const s = streams.get(u.id); if (s) { s.delete(res); if (!s.size) streams.delete(u.id); } });
    return;
  }

  /* 그룹 */
  if (p === '/groups' && M === 'POST') {
    const name = clean((await readJson(req)).name, 16);
    if (!name) throw new Fail(400, '그룹 이름을 적어 주세요');
    const g = { id: id(), name, code: newCode() };
    run('INSERT INTO groups (id, name, code, created) VALUES (?, ?, ?, ?)', g.id, g.name, g.code, Date.now());
    run('INSERT INTO members (group_id, user_id, joined) VALUES (?, ?, ?)', g.id, u.id, Date.now());
    addMsg('g:' + g.id, null, 'sys', `${u.name} 님이 '${name}' 그룹을 만들었어요`);
    return send(res, 200, { id: g.id });
  }
  if (p === '/groups/join' && M === 'POST') {
    const code = clean((await readJson(req)).code, 6).toUpperCase();
    const g = get('SELECT * FROM groups WHERE code = ?', code);
    if (!g) throw new Fail(404, '그런 초대코드는 없어요');
    if (!get('SELECT 1 x FROM members WHERE group_id = ? AND user_id = ?', g.id, u.id)) {
      if (get('SELECT COUNT(*) n FROM members WHERE group_id = ?', g.id).n >= 30) throw new Fail(400, '그룹이 가득 찼어요');
      run('INSERT INTO members (group_id, user_id, joined) VALUES (?, ?, ?)', g.id, u.id, Date.now());
      const mid = addMsg('g:' + g.id, null, 'sys', `${u.name} 님이 들어왔어요`);
      castGroup(g.id, loadMsg(mid), { members: true });
    }
    return send(res, 200, { id: g.id });
  }
  if (seg[0] === 'groups' && seg[1]) {
    const g = memberGroup(seg[1], u), room = 'g:' + g.id, c = cycle();
    if (!seg[2] && M === 'GET') return send(res, 200, groupView(g, u));
    if (seg[2] === 'shot' && M === 'POST') {
      if (hasShot(g.id, u.id, c.id)) throw new Fail(409, '오늘은 이미 찍었어요');
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((await readJson(req)).image || ''));
      const buf = m && Buffer.from(m[1], 'base64');
      if (!buf || buf.length < 500 || buf.length > 2e6 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Fail(400, '사진을 읽을 수 없어요. 다시 찍어 주세요');
      const mid = addMsg(room, u.id, 'photo', null, Math.max(0, Math.round((Date.now() - c.at) / 60e3)));
      fs.writeFileSync(path.join(PHOTOS, mid + '.jpg'), buf);
      run('INSERT INTO shots (group_id, user_id, cycle, msg_id, t) VALUES (?, ?, ?, ?, ?)', g.id, u.id, c.id, mid, Date.now());
      castGroup(g.id, loadMsg(mid), { shot: u.id });
      return send(res, 200, groupView(g, u));
    }
    if (seg[2] === 'messages' && M === 'POST') {
      if (!hasShot(g.id, u.id, c.id)) throw new Fail(423, '사진을 찍어야 대화방이 열려요');
      throttle(u.id);
      const text = clean((await readJson(req)).text, 1000);
      if (!text) throw new Fail(400, '빈 메시지예요');
      const msg = loadMsg(addMsg(room, u.id, 'text', text));
      castGroup(g.id, msg);
      return send(res, 200, msg);
    }
    if (seg[2] === 'leave' && M === 'POST') {
      run('DELETE FROM members WHERE group_id = ? AND user_id = ?', g.id, u.id);
      const mid = addMsg(room, null, 'sys', `${u.name} 님이 나갔어요`);
      castGroup(g.id, loadMsg(mid), { members: true });
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
    if (!fs.existsSync(file)) throw new Fail(404, '없는 사진이에요');
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  /* 오픈채팅 */
  if (p === '/opens' && M === 'POST') {
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
        castOpen(o.id, loadMsg(addMsg('o:' + o.id, null, 'sys', `${u.name} 님이 들어왔어요`)));
      }
      return send(res, 200, openView(o, u));
    }
    if (seg[2] === 'messages' && M === 'POST') {
      if (!joined) throw new Fail(403, '먼저 방에 참여해 주세요');
      throttle(u.id);
      const text = clean((await readJson(req)).text, 1000);
      if (!text) throw new Fail(400, '빈 메시지예요');
      const msg = loadMsg(addMsg('o:' + o.id, u.id, 'text', text));
      castOpen(o.id, msg);
      return send(res, 200, msg);
    }
  }
  throw new Fail(404, '없는 주소예요');
}

/* ── 정적 파일 ── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (!(e instanceof Fail)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof Fail ? e.message : '서버에서 문제가 생겼어요' });
    else res.end();
  }
}).listen(PORT, () => {
  console.log(`ketin  http://localhost:${PORT}`);
  console.log(`관리자 http://localhost:${PORT}/admin  (키: ${process.env.ADMIN_KEY ? '환경변수 ADMIN_KEY' : ADMIN_KEY})`);
});
