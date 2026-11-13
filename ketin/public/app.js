/* ketin 클라이언트 — 서버(/api)와 SSE(/api/events)로 이야기한다. */
const $ = (s, r = document) => r.querySelector(s), app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const lateText = (m) => (m < 2 ? '제시간' : m < 60 ? m + '분 늦음' : Math.floor(m / 60) + '시간 늦음');
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };
const I = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  cam: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  lock: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  heart: '<svg width="74" height="74" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.6a4.3 4.3 0 017.5 2.9c0 5.4-7.5 10-7.5 10z"/></svg>',
};

async function api(path, body, method) {
  const r = await fetch('/api' + path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || '연결이 불안정해요. 다시 해 주세요'), { status: r.status });
  return j;
}

let H = null;   // 홈 데이터
let cur = null; // 열려 있는 방 {type:'g'|'o', id, key, d, el}

/* ── toast / sheet ── */
let toastEl, toastT;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; app.appendChild(toastEl); }
  toastEl.textContent = msg; clearTimeout(toastT); requestAnimationFrame(() => toastEl.classList.add('open'));
  toastT = setTimeout(() => toastEl.classList.remove('open'), 2400);
}
function sheet(html, mount) {
  const v = document.createElement('div'); v.className = 'veil';
  const s = document.createElement('div'); s.className = 'sheet'; s.innerHTML = '<div class="grab"></div>' + html;
  app.append(v, s);
  const close = () => { v.classList.remove('open'); s.classList.remove('open'); s.style.transform = ''; setTimeout(() => { v.remove(); s.remove(); }, 560); };
  requestAnimationFrame(() => requestAnimationFrame(() => { v.classList.add('open'); s.classList.add('open'); }));
  v.onclick = close;
  let y0 = null, dy = 0; const gr = $('.grab', s);
  gr.onpointerdown = (e) => { y0 = e.clientY; dy = 0; gr.setPointerCapture(e.pointerId); s.style.transition = 'none'; };
  gr.onpointermove = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); s.style.transform = `translateY(${dy}px)`; };
  gr.onpointerup = gr.onpointercancel = () => { if (y0 === null) return; y0 = null; s.style.transition = ''; if (dy > 80) close(); else s.style.transform = ''; };
  mount && mount(s, close); return close;
}
// 버튼을 누른 동안 중복 요청을 막고, 실패하면 이유를 알려 준다.
async function act(btn, fn) {
  if (btn) btn.classList.add('busy');
  try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) btn.classList.remove('busy'); }
}

/* ── 시작하기 ── */
function onboard() {
  const el = document.createElement('div'); el.className = 'screen onboard pad';
  el.innerHTML = `<div class="word">ketin</div>
    <p>하루에 한 번, 사진을 찍어야<br>친구들의 대화방이 열려요.</p>
    <form style="display:flex;flex-direction:column;gap:18px"><input class="field" id="obName" maxlength="10" placeholder="이름" autocomplete="off">
    <button class="btn solid wide press">시작하기</button></form>`;
  app.insertBefore(el, $('#splash'));
  $('form', el).onsubmit = (e) => {
    e.preventDefault();
    const name = $('#obName', el).value.trim(); if (!name) return toast('이름을 적어 주세요');
    act($('button', el), async () => { await api('/signup', { name }); await start(); el.classList.add('enter'); setTimeout(() => el.remove(), 540); });
  };
}

/* ── 홈 ── */
const pager = $('#pager'), seg = $('#seg'), bar = $('i', seg), tabs = [...seg.querySelectorAll('button')];
function syncSeg() {
  const p = pager.clientWidth ? pager.scrollLeft / pager.clientWidth : 0, a = tabs[0], b = tabs[1];
  bar.style.left = a.offsetLeft + (b.offsetLeft - a.offsetLeft) * p + 'px';
  bar.style.width = a.offsetWidth + (b.offsetWidth - a.offsetWidth) * p + 'px';
  a.classList.toggle('on', p < 0.5); b.classList.toggle('on', p >= 0.5);
}
pager.addEventListener('scroll', syncSeg, { passive: true }); addEventListener('resize', syncSeg);
tabs.forEach((t) => (t.onclick = () => pager.scrollTo({ left: pager.clientWidth * t.dataset.p, behavior: 'smooth' })));

function adHTML(ad, slim) {
  if (!ad) return '';
  const inner = `<small>광고</small><b>${esc(ad.title)}</b>${ad.body ? `<span>${esc(ad.body)}</span>` : ''}`;
  const cls = 'ad' + (slim ? ' slim pad' : ' press');
  return ad.link ? `<a class="${cls}" href="${esc(ad.link)}" target="_blank" rel="noopener sponsored" data-ad="${ad.id}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ad]');
  if (a) { try { navigator.sendBeacon('/api/ads/' + a.dataset.ad + '/click'); } catch (_) {} }
});

function renderHome() {
  $('#meBtn').textContent = H.me.name.slice(0, 1);
  const wait = H.groups.filter((g) => !g.posted);
  $('#pGroups').innerHTML = `
    <button class="today press" id="todayBtn">
      <small>오늘의 케틴</small>
      <div class="clock">${hm(H.cycle.at)}</div>
      <p>${!H.groups.length ? '그룹을 만들거나 초대코드로 들어가 보세요.' : wait.length ? `그룹 ${wait.length}곳이 잠겨 있어요. 사진을 찍어야 대화방이 열려요.` : '오늘은 다 찍었어요. 다음 케틴에 또 만나요.'}</p>
      ${wait.length ? '<span class="go">지금 찍으러 가기</span>' : ''}
    </button>
    ${adHTML(H.ads.home)}
    <div>
      <div class="label"><span>내 그룹</span><span>${H.groups.length}</span></div>
      <div class="list">${H.groups.map((g) => `
        <button class="item press" data-g="${g.id}">
          <div class="stack"><div class="av">${esc(g.initials[0] || g.name[0])}</div><div class="av">${esc(g.initials[1] || '+')}</div></div>
          <div class="body"><b>${esc(g.name)}</b><span>${g.posted ? esc(g.preview || '아직 대화가 없어요') : `잠겨 있어요 · ${g.members}명 중 ${g.done}명이 찍었어요`}</span></div>
          <div class="side">${hm(g.lastT)}<span class="pill ${g.posted ? 'fill' : ''}">${g.posted ? '열림' : '잠김'}</span></div>
        </button>`).join('') || '<p class="note" style="padding:22px 0">아직 들어간 그룹이 없어요.</p>'}</div>
    </div>
    <div class="two"><button class="btn solid press" id="newG">새 그룹</button><button class="btn press" id="joinG">초대코드 입력</button></div>
    <p class="note">그룹은 초대코드로만 들어올 수 있어요.</p>`;
  $('#pOpen').innerHTML = `
    ${adHTML(H.ads.open)}
    <div>
      <div class="label"><span>열려 있는 방</span><span>${H.opens.length}</span></div>
      <div class="list">${H.opens.map((o) => `
        <button class="item press" data-o="${o.id}">
          <div class="hash">#</div>
          <div class="body"><b>${esc(o.name)}</b><span>${esc(o.desc)}</span></div>
          <div class="side">${o.n.toLocaleString()}명${o.joined ? '<span class="pill fill">참여 중</span>' : ''}</div>
        </button>`).join('')}</div>
    </div>
    <button class="btn wide press" id="newO">오픈채팅 만들기</button>
    <p class="note">오픈채팅은 누구나 들어올 수 있고, 사진 잠금이 없어요.</p>`;
  syncSeg();
}
let homeT;
function refreshHome() {
  clearTimeout(homeT);
  homeT = setTimeout(async () => { try { H = await api('/home'); renderHome(); armCycle(); } catch (_) {} }, 150);
}
$('#home').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.g) openRoom('g', b.dataset.g, b);
  else if (b.dataset.o) openRoom('o', b.dataset.o, b);
  else if (b.id === 'todayBtn') { const g = H.groups.find((g) => !g.posted) || H.groups[0]; g ? openRoom('g', g.id, b) : newGroup(); }
  else if (b.id === 'newG') newGroup();
  else if (b.id === 'joinG') joinGroup();
  else if (b.id === 'newO') newOpen();
  else if (b.id === 'meBtn') profile();
});
function formSheet(html, onOk) {
  sheet(html + '<button class="btn solid wide press" id="ok">확인</button>', (s, close) => {
    const go = () => act($('#ok', s), () => onOk(s, close));
    $('#ok', s).onclick = go;
    $('input', s).onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
  });
}
function newGroup() {
  formSheet('<h2>새 그룹 만들기</h2><p>이름을 정하면 초대코드가 만들어져요.</p><input class="field" id="gName" maxlength="16" placeholder="그룹 이름" autocomplete="off">', async (s, close) => {
    const name = $('#gName', s).value.trim(); if (!name) return toast('그룹 이름을 적어 주세요');
    const { id } = await api('/groups', { name }); close(); refreshHome();
    setTimeout(async () => { await openRoom('g', id); setTimeout(invite, 600); }, 250);
  });
}
function joinGroup() {
  formSheet('<h2>초대코드로 들어가기</h2><p>친구가 보내 준 여섯 자리 코드를 입력하세요.</p><input class="field codein" id="gCode" maxlength="6" placeholder="······" autocomplete="off" autocapitalize="characters">', async (s, close) => {
    const code = $('#gCode', s).value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return toast('코드는 영문과 숫자 여섯 자리예요');
    const { id } = await api('/groups/join', { code }); close(); refreshHome();
    setTimeout(() => openRoom('g', id), 250);
  });
}
function newOpen() {
  formSheet('<h2>오픈채팅 만들기</h2><p>주제 하나만 정하면 돼요.</p><input class="field" id="oName" maxlength="18" placeholder="방 이름" autocomplete="off">', async (s, close) => {
    const name = $('#oName', s).value.trim(); if (!name) return toast('방 이름을 적어 주세요');
    const { id } = await api('/opens', { name }); close(); refreshHome();
    setTimeout(() => openRoom('o', id), 250);
  });
}
function profile() {
  formSheet(`<h2>내 프로필</h2>
    <input class="field" id="myName" maxlength="10" value="${esc(H.me.name)}" autocomplete="off" aria-label="이름">
    <div class="stats"><div><b>${H.me.streak}</b><span>연속 일수</span></div><div><b>${H.groups.length}</b><span>그룹</span></div><div><b>${H.opens.filter((o) => o.joined).length}</b><span>오픈채팅</span></div></div>
    <p>계정은 이 기기의 브라우저에 묶여 있어요.</p>`, async (s, close) => {
    const name = $('#myName', s).value.trim(); if (!name) return toast('이름을 적어 주세요');
    if (name !== H.me.name) await api('/me', { name });
    close(); refreshHome();
  });
}

/* ── 대화방 ── */
function msgHTML(m, prev, fresh) {
  if (m.kind === 'sys') return `<div class="sys${fresh ? ' in' : ''}" data-id="${m.id}">${esc(m.text)}</div>`;
  const me = m.from === H.me.id, showName = !me && (!prev || prev.from !== m.from || prev.kind === 'sys');
  const body = m.kind === 'photo'
    ? `<figure class="shot"><img src="/api/photo/${m.id}" alt="${esc(m.name)}의 오늘 사진" loading="lazy">
        <figcaption><b>${esc(me ? '나' : m.name)}</b><span>${hm(m.t)} · ${lateText(m.late || 0)}</span></figcaption></figure>`
    : `<div class="line"><div class="bubble">${esc(m.text)}</div><time>${hm(m.t)}</time></div>`;
  return `<div class="row ${me ? 'me' : 'them'}${fresh ? ' in' : ''}" data-id="${m.id}">${showName ? `<div class="nm">${esc(m.name)}</div>` : ''}${body}</div>`;
}
function stripHTML(d) {
  const me = d.members.find((m) => m.id === H.me.id), rest = d.members.filter((m) => m.id !== H.me.id);
  return [me && { ...me, label: '나' }, ...rest].filter(Boolean).map((p) => `<div class="who"><div class="ring ${p.done ? 'done' : ''}">${esc(p.name[0])}</div>${esc(p.label || p.name)}</div>`).join('');
}
const composerHTML = () => `<form class="composer pad"><input id="msgInput" placeholder="메시지" autocomplete="off" enterkeyhint="send" maxlength="1000"><button class="ico send press" aria-label="보내기">${I.send}</button></form>`;
function bodyHTML(c) {
  const d = c.d;
  if (c.type === 'g' && !d.unlocked) {
    const done = d.members.filter((m) => m.done).length;
    return `<div class="gate">
      <div class="ghost"><i style="width:54%"></i><i class="ph"></i><i class="r" style="width:38%"></i><i style="width:66%"></i><i class="r" style="width:50%"></i><i style="width:44%"></i></div>
      <div class="gate-card">${I.lock}
        <h3>사진을 찍어야 대화방이 열려요</h3>
        <p>${hm(d.cycle.at)}에 케틴이 울렸어요. ${d.hidden.msgs || d.hidden.photos ? `지금 안에 메시지 ${d.hidden.msgs}개, 사진 ${d.hidden.photos}장이 있어요.` : `${done ? `${done}명이 먼저 찍었어요.` : '아직 아무도 안 찍었어요. 첫 번째가 되어 보세요.'}`}</p>
        <button class="btn solid wide press" data-act="shoot">오늘 사진 찍기</button>
      </div></div>`;
  }
  const msgs = `<div class="msgs pad">${d.msgs.map((m, i) => msgHTML(m, d.msgs[i - 1])).join('')}</div>`;
  if (c.type === 'o' && !d.joined) return msgs + `<div class="composer pad"><button class="btn solid wide press" data-act="join">이 방에 참여하기</button></div>`;
  return msgs + composerHTML();
}
function paintBody(c, reveal) {
  const b = $('.rbody', c.el); b.innerHTML = bodyHTML(c);
  const box = $('.msgs', b);
  if (box) { box.scrollTop = box.scrollHeight; if (reveal) box.classList.add('reveal'); box.querySelectorAll('img').forEach((i) => (i.onload = () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 500) box.scrollTop = box.scrollHeight; })); }
}
function paintHead(c) {
  const d = c.d, g = c.type === 'g';
  $('.ttl span', c.el).textContent = g ? `${d.members.length}명 · ${d.members.filter((m) => m.done).length}명 찍음` : `${d.n.toLocaleString()}명 · 오픈채팅`;
  if (g) $('.strip', c.el).innerHTML = stripHTML(d);
}
async function openRoom(type, id, btn) {
  if (cur) return;
  const d = await act(btn, () => api((type === 'g' ? '/groups/' : '/opens/') + id)); if (!d) return;
  const g = type === 'g', el = document.createElement('div'); el.className = 'screen enter';
  el.innerHTML = `
    <div class="chead pad"><button class="back" data-act="back" aria-label="뒤로">${I.back}</button>
      <div class="ttl"><b>${esc(d.name)}</b><span></span></div>
      ${g ? `<button class="code press" data-act="invite">${esc(d.code)}</button>` : ''}</div>
    ${g ? '<div class="strip pad"></div>' : adHTML(d.ad, true)}
    <div class="rbody"></div>`;
  app.insertBefore(el, $('#splash'));
  cur = { type, id, key: type + ':' + id, d, el };
  paintHead(cur); paintBody(cur);
  requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.remove('enter'); $('#home').classList.add('under'); }));
  el.addEventListener('click', onRoomClick); el.addEventListener('dblclick', onLike);
  el.addEventListener('submit', (e) => { e.preventDefault(); const i = $('input', e.target), t = i.value.trim(); if (!t) return; i.value = ''; sendText(t); });
  swipeBack(el);
}
function closeRoom() {
  if (!cur) return; const el = cur.el; cur = null;
  el.classList.add('enter'); $('#home').classList.remove('under'); refreshHome(); setTimeout(() => el.remove(), 540);
}
function swipeBack(el) {
  let on = false, sx = 0, dx = 0, w = 1, t0 = 0; const prev = $('#home');
  el.addEventListener('pointerdown', (e) => { const r = app.getBoundingClientRect(); if (e.clientX - r.left > 26) return;
    on = true; sx = e.clientX; dx = 0; w = r.width; t0 = e.timeStamp; el.setPointerCapture(e.pointerId); el.style.transition = prev.style.transition = 'none'; });
  el.addEventListener('pointermove', (e) => { if (!on) return; dx = Math.max(0, e.clientX - sx);
    el.style.transform = `translateX(${dx}px)`; prev.style.transform = `translateX(${-28 + (dx / w) * 28}%)`; });
  const end = (e) => { if (!on) return; on = false; el.style.transition = prev.style.transition = ''; el.style.transform = prev.style.transform = '';
    if (dx > w * 0.35 || (dx > 30 && dx / (e.timeStamp - t0) > 0.5)) closeRoom(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
function appendMsg(c, m) {
  const box = $('.msgs', c.el); if (!box || box.querySelector(`[data-id="${m.id}"]`)) return;
  const prev = c.d.msgs[c.d.msgs.length - 1]; c.d.msgs.push(m);
  box.insertAdjacentHTML('beforeend', msgHTML(m, prev, true)); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}
// 방 상태를 서버에서 다시 받아 온다. 잠금 상태가 바뀌었으면 본문을 통째로 다시 그린다.
async function refreshRoom() {
  const c = cur; if (!c) return;
  try {
    const d = await api((c.type === 'g' ? '/groups/' : '/opens/') + c.id); if (cur !== c) return;
    const flipped = c.type === 'g' && d.unlocked !== c.d.unlocked, wasLocked = c.type === 'g' && !c.d.unlocked;
    c.d = d; paintHead(c);
    if (flipped || wasLocked) paintBody(c, flipped && d.unlocked);
  } catch (e) { if (e.status === 404) closeRoom(); }
}
async function sendText(text) {
  const c = cur;
  try { appendMsg(c, await api((c.type === 'g' ? '/groups/' : '/opens/') + c.id + '/messages', { text })); }
  catch (e) { toast(e.message); if (e.status === 423) refreshRoom(); }
}
function onRoomClick(e) {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const k = a.dataset.act;
  if (k === 'back') closeRoom();
  else if (k === 'invite') invite();
  else if (k === 'shoot') camera.click();
  else if (k === 'join') act(a, async () => { cur.d = await api('/opens/' + cur.id + '/join', {}); paintHead(cur); paintBody(cur); });
}
function onLike(e) {
  const shot = e.target.closest('.shot'); if (!shot) return;
  const h = document.createElement('div'); h.className = 'heart'; h.innerHTML = I.heart; shot.appendChild(h); setTimeout(() => h.remove(), 900); buzz(12);
}
function invite() {
  const c = cur; if (!c || c.type !== 'g') return; const d = c.d; let armed = false;
  sheet(`<h2>친구 초대하기</h2><p>이 코드를 아는 사람만 '${esc(d.name)}'에 들어올 수 있어요.</p>
    <div class="bigcode" id="theCode">${esc(d.code)}</div>
    <button class="btn solid wide press" id="copy">코드 복사</button>
    <div class="label"><span>멤버 ${d.members.length}명</span><span>오늘 ${d.members.filter((m) => m.done).length}명 찍음</span></div>
    <button class="btn wide press" id="leave">그룹 나가기</button>`, (s, close) => {
    $('#copy', s).onclick = async (e) => {
      try { await navigator.clipboard.writeText(d.code); e.target.textContent = '복사했어요'; }
      catch (_) { const r = document.createRange(); r.selectNodeContents($('#theCode', s)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); e.target.textContent = '코드를 길게 눌러 복사하세요'; }
    };
    $('#leave', s).onclick = (e) => {
      if (!armed) { armed = true; e.target.textContent = '한 번 더 누르면 나가요'; return; }
      act(e.target, async () => { await api('/groups/' + c.id + '/leave', {}); close(); closeRoom(); });
    };
  });
}

/* ── 오늘 사진 찍기 ── */
const camera = $('#camera');
camera.onchange = () => {
  const f = camera.files[0]; camera.value = ''; const c = cur; if (!f || !c || c.type !== 'g') return;
  const img = new Image(), url = URL.createObjectURL(f);
  img.onload = async () => {
    const k = Math.min(1, 1080 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
    cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    const btn = $('[data-act="shoot"]', c.el); if (btn) btn.textContent = '올리는 중…';
    const d = await act(btn, () => api('/groups/' + c.id + '/shot', { image: cv.toDataURL('image/jpeg', 0.78) }));
    if (cur !== c) return;
    if (!d) { if (btn) btn.textContent = '오늘 사진 찍기'; return refreshRoom(); }
    c.d = d; paintHead(c); paintBody(c, true); buzz([10, 40, 18]); toast('대화방이 열렸어요');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('사진을 열 수 없어요. 다시 찍어 주세요'); };
  img.src = url;
};

/* ── 실시간 ── */
function connect() {
  const es = new EventSource('/api/events'); let opened = false;
  es.onopen = () => { if (opened) { refreshHome(); refreshRoom(); } opened = true; }; // 끊겼다 붙으면 놓친 것을 다시 받는다
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data), here = cur && cur.key === ev.room;
    if (!here) return refreshHome();
    if (ev.type === 'msg' && (cur.type === 'o' || cur.d.unlocked)) appendMsg(cur, ev.msg);
    if (ev.type === 'hidden' || ev.shot || ev.members) refreshRoom();
  };
}
// 다음 케틴이 울리는 순간 모든 그룹이 다시 잠긴다.
let cycleT;
function armCycle() {
  clearTimeout(cycleT);
  const ms = H.cycle.next - Date.now() + 1500;
  cycleT = setTimeout(() => { toast('오늘의 케틴이 울렸어요'); buzz([30, 60, 30]); refreshHome(); refreshRoom(); }, Math.min(Math.max(ms, 1000), 2 ** 31 - 1));
}
async function start() { H = await api('/home'); renderHome(); armCycle(); connect(); }
start().catch((e) => { if (e.status === 401) onboard(); else toast('서버에 연결할 수 없어요'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && H) { refreshHome(); refreshRoom(); } });
document.fonts && document.fonts.ready.then(syncSeg);
