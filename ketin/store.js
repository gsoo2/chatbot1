// 영구 저장. 무료 서버는 디스크가 재시작 때 지워지므로, DATABASE_URL(Postgres)이 있으면
// SQLite 파일 전체와 사진을 Postgres에 보관하고 시작할 때 되살린다. 없으면 로컬 디스크만 쓴다.
const fs = require('node:fs');
const path = require('node:path');

let pool = null, db = null, dir = null, timer = null, busy = false, again = false, lastOk = true;

async function init(dataDir) {
  dir = dataDir;
  if (!process.env.DATABASE_URL) return false;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  pool.on('error', (e) => console.error('pg', e.message));
  await pool.query('CREATE TABLE IF NOT EXISTS ketin_snapshot (id int PRIMARY KEY, data bytea NOT NULL, at timestamptz NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS ketin_photos (id bigint PRIMARY KEY, data bytea NOT NULL)');
  const r = await pool.query('SELECT data FROM ketin_snapshot WHERE id = 1');
  if (r.rows[0]) {
    const file = path.join(dir, 'ketin.db');
    for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
    fs.writeFileSync(file, r.rows[0].data);
  }
  return true;
}
const attach = (database) => { db = database; };

async function snapshot() {
  if (!pool || !db) return;
  if (busy) { again = true; return; }
  busy = true;
  try {
    const tmp = path.join(dir, 'snapshot.tmp');
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    await pool.query('INSERT INTO ketin_snapshot (id, data, at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, at = now()', [buf]);
    lastOk = true;
  } catch (e) { lastOk = false; console.error('저장 실패', e.message); }
  busy = false;
  if (again) { again = false; touch(); }
}
// 바뀐 게 있으면 몇 초 뒤 한 번에 저장한다.
function touch() {
  if (!pool || timer) return;
  timer = setTimeout(() => { timer = null; snapshot(); }, 4000);
}
async function flush() {
  if (!pool) return;
  clearTimeout(timer); timer = null;
  while (busy) await new Promise((r) => setTimeout(r, 50));
  await snapshot();
}
async function putPhoto(id, buf) {
  if (pool) await pool.query('INSERT INTO ketin_photos (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, buf]);
}
async function getPhoto(id) {
  if (!pool) return null;
  const r = await pool.query('SELECT data FROM ketin_photos WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].data : null;
}
module.exports = { init, attach, touch, flush, putPhoto, getPhoto, remote: () => !!pool, healthy: () => lastOk };
