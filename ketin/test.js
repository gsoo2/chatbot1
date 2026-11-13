// 잠금 규칙을 서버 수준에서 확인한다: node test.js  (임시 폴더에 서버를 띄운다)
const { spawn } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ketin-')), PORT = 3999, B = `http://localhost:${PORT}/api`;
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_KEY: 'testkey' }, stdio: 'inherit' });
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(600, 1)]).toString('base64');
function client() {
  let cookie = '';
  return async (p, body, method) => {
    const r = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  };
}
(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const a = client(), b = client(), c = client();
  assert.equal((await a('/home')).status, 401);
  await a('/signup', { name: '지우' }); await b('/signup', { name: '하람' }); await c('/signup', { name: '남' });
  const gid = (await a('/groups', { name: '테스트' })).body.id;
  let g = (await a('/groups/' + gid)).body;
  assert.equal(g.unlocked, false); assert.equal(g.msgs, undefined, '잠긴 방은 메시지를 내려주지 않는다');
  assert.equal((await a(`/groups/${gid}/messages`, { text: 'hi' })).status, 423, '잠긴 채로는 글도 못 쓴다');
  assert.equal((await b('/groups/join', { code: 'ZZZZZZ' })).status, 404);
  assert.equal((await b('/groups/join', { code: g.code })).status, 200);
  assert.equal((await c('/groups/' + gid)).status, 404, '멤버가 아니면 방이 없다');
  assert.equal((await a(`/groups/${gid}/shot`, { image: 'data:image/jpeg;base64,AAAA' })).status, 400);
  g = (await a(`/groups/${gid}/shot`, { image: JPEG })).body;
  assert.equal(g.unlocked, true); const photo = g.msgs.find((m) => m.kind === 'photo'); assert.ok(photo);
  assert.equal((await a(`/groups/${gid}/shot`, { image: JPEG })).status, 409, '한 회차에 한 장');
  assert.equal((await a(`/groups/${gid}/messages`, { text: '비밀 얘기' })).status, 200);
  const locked = (await b('/groups/' + gid)).body;
  assert.equal(locked.unlocked, false); assert.equal(locked.msgs, undefined); assert.deepEqual(locked.hidden, { msgs: 1, photos: 1 });
  assert.equal((await b('/photo/' + photo.id)).status, 423, '잠긴 멤버는 사진 파일도 못 받는다');
  assert.equal((await c('/photo/' + photo.id)).status, 404);
  const home = (await b('/home')).body;
  assert.equal(home.groups[0].preview, null, '잠긴 방은 미리보기도 없다'); assert.ok(home.ads.home);
  g = (await b(`/groups/${gid}/shot`, { image: JPEG })).body;
  assert.ok(g.msgs.some((m) => m.text === '비밀 얘기')); assert.equal((await b('/photo/' + photo.id)).status, 200);
  assert.equal((await b('/home')).body.me.streak, 1);
  const oid = (await a('/home')).body.opens[0].id;
  assert.equal((await a(`/opens/${oid}/messages`, { text: 'x' })).status, 403);
  await a(`/opens/${oid}/join`, {}); await new Promise((r) => setTimeout(r, 300)); assert.equal((await a(`/opens/${oid}/messages`, { text: '안녕' })).status, 200);
  assert.equal((await fetch(B + '/admin/overview', { headers: { 'x-admin-key': 'nope' } })).status, 401);
  const ov = await (await fetch(B + '/admin/overview', { headers: { 'x-admin-key': 'testkey' } })).json();
  assert.equal(ov.stats.users, 3); assert.ok(ov.ads.find((x) => x.placement === 'home').impressions >= 2);
  assert.equal((await fetch(`http://localhost:${PORT}/../server.js`)).status, 404);
  console.log('모든 확인 통과');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
