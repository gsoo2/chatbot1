const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let key=''; // 앱에서 GM 코드로 로그인했다면 비워 둔 채로도 들어와진다. 코드는 저장하지 않는다.
const PLACE={home:'홈',open:'오픈채팅 목록',chat:'오픈채팅 방'};
async function call(path,method,body){
  const r=await fetch('/api/admin'+path,{method:method||'GET',headers:{...(key?{'x-admin-key':key}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'요청이 실패했어요');return j;
}
async function load(){
  try{
    const d=await call('/overview');$('#login').hidden=true;$('#panel').hidden=false;$('#msg').textContent=d.saved.ok?'':'주의: 마지막 저장이 실패했어요. 서버 기록을 확인해 주세요.';
    const s=d.stats;
    $('#tiles').innerHTML=[['가입자',s.users],['구글 연결',s.google],['지금 접속',s.online],['그룹',s.groups],['오픈채팅',s.opens],['메시지',s.messages],['이번 케틴 사진',s.shotsToday]].map(([l,v])=>`<div><b>${v.toLocaleString()}</b><span>${l}</span></div>`).join('');
    $('#inq').innerHTML=d.inquiries.map(q=>`<div class="inq"><small>${new Date(q.created).toLocaleString('ko-KR')} · ${esc(q.name||'탈퇴한 사용자')}${q.email?' · '+esc(q.email):''}</small><div>${esc(q.text)}</div>
      ${q.reply?`<div class="done"><b>답변</b> ${esc(q.reply)}</div>`:`<form data-q="${q.id}"><input maxlength="1000" placeholder="답변" required><button>보내기</button></form>`}</div>`).join('')||'<p>들어온 문의가 없어요.</p>';
    $('#ads').innerHTML=d.ads.map(a=>`<tr class="${a.active?'':'off'}"><td>${PLACE[a.placement]||esc(a.placement)}</td>
      <td><b>${esc(a.title)}</b><small>${esc(a.body)}</small><small>${esc(a.link)}</small></td>
      <td class="n">${a.impressions.toLocaleString()}</td><td class="n">${a.clicks.toLocaleString()}</td><td class="n">${a.impressions?(a.clicks/a.impressions*100).toFixed(1)+'%':'–'}</td>
      <td class="n"><button class="ghost" data-t="${a.id}">${a.active?'끄기':'켜기'}</button> <button class="ghost" data-d="${a.id}">삭제</button></td></tr>`).join('')||'<tr><td colspan="6">광고가 없어요.</td></tr>';
  }catch(e){$('#login').hidden=false;$('#panel').hidden=true;if(key)$('#msg').textContent=e.message;key=''}
}
$('#keyForm').onsubmit=e=>{e.preventDefault();key=$('#key').value.trim();$('#key').value='';load()};
$('#adForm').onsubmit=async e=>{e.preventDefault();
  try{await call('/ads','POST',{placement:$('#placement').value,title:$('#title').value,body:$('#body').value,link:$('#link').value});e.target.reset();load()}
  catch(err){$('#msg').textContent=err.message}};
$('#inq').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;
  try{await call('/inquiries/'+f.dataset.q+'/reply','POST',{reply:f.querySelector('input').value});load()}catch(err){$('#msg').textContent=err.message}});
const armed=new Set();
$('#ads').onclick=async e=>{const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.t)await call('/ads/'+b.dataset.t+'/toggle','POST');
    else if(b.dataset.d){if(!armed.has(b.dataset.d)){armed.add(b.dataset.d);b.textContent='정말 삭제';return}await call('/ads/'+b.dataset.d,'DELETE')}
    load();
  }catch(err){$('#msg').textContent=err.message}};
load();
