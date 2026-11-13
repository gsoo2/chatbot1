// 잠금 규칙을 서버 수준에서 확인한다: node test.js  (임시 폴더에 서버를 띄운다)
const { spawn } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ketin-')), PORT = 3999, B = `http://localhost:${PORT}/api`;
let srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, GM_CODE: 'testkey', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_TOKEN_URL: 'http://localhost:3998/token', ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) }, stdio: 'inherit' });
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600, 1)]).toString('base64');
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

  // 보안 머리말, 다른 사이트에서 온 요청, 잘못된 본문 형식
  const page = await fetch(`http://localhost:${PORT}/`);
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'")); assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(B + '/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"name":"x"}' })).status, 403, '다른 사이트의 요청은 거절');
  assert.equal((await fetch(B + '/signup', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' })).status, 415);

  // 문의와 답변
  assert.equal((await a('/inquiries', { text: '광고 문의드립니다' })).status, 200);
  const qid = (await (await fetch(B + '/admin/overview', { headers: { 'x-admin-key': 'testkey' } })).json()).inquiries[0].id;
  assert.equal((await b(`/admin/inquiries/${qid}/reply`, { reply: 'x' })).status, 401, '일반 사용자는 관리자 기능을 못 쓴다');
  // GM 코드 로그인
  assert.equal((await b('/gm', { code: 'wrong' })).status, 401);
  assert.equal((await b('/gm', { code: 'testkey' })).status, 200);
  assert.equal((await b('/home')).body.me.gm, true);
  assert.equal((await b(`/admin/inquiries/${qid}/reply`, { reply: '메일로 안내드릴게요' })).status, 200);
  assert.equal((await a('/inquiries')).body.list[0].reply, '메일로 안내드릴게요');
  assert.equal((await c('/inquiries')).body.list.length, 0, '남의 문의는 안 보인다');
  // 운영자의 오픈채팅 메시지 삭제. 그룹 메시지는 지울 수 없다.
  const om = (await a('/opens/' + oid)).body.msgs.find((m) => m.text === '안녕');
  assert.equal((await a(`/messages/${om.id}/delete`, {})).status, 403);
  assert.equal((await b(`/messages/${om.id}/delete`, {})).status, 200);
  assert.ok(!(await a('/opens/' + oid)).body.msgs.some((m) => m.text === '안녕'));
  const gm = g.msgs.find((m) => m.text === '비밀 얘기');
  assert.equal((await b(`/messages/${gm.id}/delete`, {})).status, 404);
  // GM 코드 대입 공격은 막힌다
  let st = 0; for (let i = 0; i < 9; i++) st = (await c('/gm', { code: 'guess' + i })).status;
  assert.equal(st, 429, '여러 번 틀리면 잠긴다');

  // 구글 로그인: 가짜 토큰 서버로 흐름을 확인한다
  const idTok = (aud) => 'x.' + Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud, sub: 'g-123', email: 'a@example.com', email_verified: true, given_name: '구글친구', exp: Date.now() / 1000 + 600 })).toString('base64url') + '.y';
  let aud = 'cid';
  const fake = require('node:http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ id_token: idTok(aud) })); }).listen(3998);
  const oauth = async (cookie) => {
    const r1 = await fetch(`http://localhost:${PORT}/auth/google`, { redirect: 'manual' });
    const state = new URL(r1.headers.get('location')).searchParams.get('state'), sc = r1.headers.get('set-cookie').split(';')[0];
    assert.ok(r1.headers.get('location').startsWith('https://accounts.google.com/'));
    return (s2) => fetch(`http://localhost:${PORT}/auth/google/callback?code=abc&state=${s2 ?? state}`, { redirect: 'manual', headers: { cookie: sc + (cookie ? '; ' + cookie : '') } });
  };
  assert.equal((await (await oauth())('forged')).headers.get('set-cookie'), null, 'state가 다르면 로그인되지 않는다');
  aud = 'other-app'; assert.equal((await (await oauth())()).headers.get('set-cookie'), null, '다른 앱용 토큰은 거절');
  aud = 'cid';
  const sess = (await (await oauth())()).headers.getSetCookie().find((x) => x.startsWith('kt=')).split(';')[0];
  const me1 = await (await fetch(B + '/home', { headers: { cookie: sess } })).json();
  assert.equal(me1.me.google, true); assert.equal(me1.me.name, '구글친구');
  const sess2 = (await (await oauth())()).headers.getSetCookie().find((x) => x.startsWith('kt=')).split(';')[0];
  assert.equal((await (await fetch(B + '/home', { headers: { cookie: sess2 } })).json()).me.id, me1.me.id, '다시 로그인하면 같은 계정');
  assert.equal((await fetch(B + '/logout', { method: 'POST', headers: { cookie: sess } })).status, 200);
  assert.equal((await fetch(B + '/home', { headers: { cookie: sess } })).status, 401, '로그아웃한 세션은 죽는다');
  fake.close();

  // 영구 저장: 서버를 끄고 디스크를 지운 뒤 다시 켜도 데이터와 사진이 돌아온다
  if (process.env.TEST_DATABASE_URL) {
    srv.kill('SIGTERM'); await new Promise((r) => srv.on('exit', r));
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, GM_CODE: 'testkey', DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: 'inherit' });
    await new Promise((r) => setTimeout(r, 1200));
    const back = (await b('/groups/' + gid)).body;
    assert.ok(back.msgs.some((m) => m.text === '비밀 얘기'), '재시작 뒤에도 대화가 남아 있다');
    const ph = await fetch(B + '/photo/' + photo.id, { headers: { cookie: sess2 } }); assert.equal(ph.status, 404);
    assert.equal((await b('/photo/' + photo.id)).status, 200, '재시작 뒤에도 사진이 남아 있다');
    console.log('영구 저장 확인 통과');
  } else console.log('(TEST_DATABASE_URL 이 없어 영구 저장 확인은 건너뜀)');
  console.log('모든 확인 통과');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { srv.on('exit', () => fs.rmSync(dir, { recursive: true, force: true })); srv.kill(); });
