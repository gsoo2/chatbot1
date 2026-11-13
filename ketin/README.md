# ketin

사진을 찍어야 대화방이 열리는 그룹챗. 하루에 한 번 "케틴"이 울리면 모든 그룹 대화방이 잠기고, 그 그룹에 사진을 올린 사람에게만 다시 열린다.

## 실행

Node 22.13 이상.

```
npm install
npm start        # http://localhost:3000
npm test         # 잠금, 로그인, 보안 규칙 확인
```

| 환경변수 | 뜻 | 없으면 |
| --- | --- | --- |
| `GM_CODE` | 운영자 로그인 코드. 길고 예측할 수 없게 정한다 | 첫 실행 때 만들어 콘솔에 보여 준다 |
| `DATABASE_URL` | Postgres 주소. 데이터와 사진을 여기에 보관한다 | 서버 디스크(`DATA_DIR`)에만 저장 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 구글 로그인 | 구글 버튼이 숨겨지고 게스트 가입만 된다 |
| `PUBLIC_ORIGIN` | 서비스 주소 (`https://…`). Render에서는 자동으로 잡힌다 | 요청의 호스트를 쓴다 |
| `PORT`, `DATA_DIR` | 포트, 로컬 저장 폴더 | 3000, `./data` |

## 무료로 배포하기 (Render + Neon)

비밀 값은 저장소나 채팅에 적지 말고 Render의 Environment 화면에만 넣는다.

1. **Neon** (neon.tech) 에서 무료 프로젝트를 만들고 연결 문자열(`postgresql://…`)을 복사한다.
2. **Render** (render.com) → New → Web Service → 이 저장소와 브랜치를 고른다.
   - Root Directory: `ketin`
   - Build Command: `npm ci --omit=dev`
   - Start Command: `node --disable-warning=ExperimentalWarning server.js`
   - Instance Type: Free, Health Check Path: `/health`
   - Environment: `NODE_VERSION=22.16.0`, `DATABASE_URL=`(Neon 주소), `GM_CODE=`(직접 정한 긴 코드)
   - Blueprint를 쓰면 `ketin/render.yaml` 이 같은 설정을 대신 채워 준다.
3. 배포가 끝나면 `https://<서비스 이름>.onrender.com` 이 주소다. 서비스 이름을 `ketin` 으로 정하면 `ketin.onrender.com` 이 되지만, 이미 쓰는 사람이 있으면 다른 이름이 붙는다.
4. **구글 로그인**: Google Cloud Console → Google Auth Platform → 클라이언트 만들기(웹 애플리케이션).
   - 승인된 자바스크립트 원본: `https://<주소>`
   - 승인된 리디렉션 URI: `https://<주소>/auth/google/callback`
   - 개인정보처리방침 주소: `https://<주소>/privacy`
   - 발급된 ID와 비밀키를 Render 환경변수 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 에 넣고 다시 배포한다. 누구나 로그인하게 하려면 앱을 "프로덕션"으로 게시한다.
5. 앱에서 가입 → 프로필 → GM 코드 입력. 그 계정으로 `/admin` 이 열린다.

무료 플랜은 15분 동안 접속이 없으면 잠들고, 다음 접속 때 깨어나느라 수십 초 걸린다. 데이터는 Neon에 있으므로 잠들거나 재배포해도 남는다. 서버가 갑자기 죽으면 마지막 몇 초의 변경은 잃을 수 있다.

## 규칙

- 케틴 시각은 하루 한 번, 한국 시간 10:00~22:00 사이에 서버가 정한다. 다음 케틴이 울릴 때까지가 한 회차다.
- 그룹 대화방은 이번 회차에 그 그룹에 사진을 올린 멤버에게만 메시지, 사진 파일, 미리보기를 내려준다. 잠금은 서버가 강제한다.
- 그룹은 여섯 자리 초대코드로만 들어온다. 오픈채팅은 누구나 참여하고 잠금이 없다.

## 운영

- **GM**: 프로필에서 GM 코드를 넣은 계정은 `/admin` 을 쓰고, 오픈채팅 메시지를 눌러 지울 수 있다. 그룹 대화는 운영 기능으로 볼 수 없다.
- **문의**: 사용자가 프로필 → 문의하기로 보내면 `/admin` 에 쌓이고, 답변을 쓰면 그 사용자의 문의 목록에 나타난다.
- **광고**: `/admin` 에서 올리고 끄고 지운다. 자리는 홈, 오픈채팅 목록, 오픈채팅 방 안. 노출 수와 클릭 수가 쌓인다.

## 보안

- 세션 쿠키는 HttpOnly, SameSite=Lax, HTTPS에서 Secure. 서버에는 토큰의 해시만 저장한다.
- 다른 사이트에서 보낸 변경 요청은 거절한다 (Origin 확인, JSON 본문만 허용).
- 횟수 제한: GM 코드와 초대코드 시도, 가입, 메시지, 문의, 방 만들기, IP당 전체 요청.
- CSP로 외부 스크립트를 막고, 프레임에 넣을 수 없게 하며, HTTPS에서는 HSTS를 건다.
- 모든 SQL은 값을 따로 넘기는 방식이고, 화면에 넣는 글자는 전부 이스케이프한다.
- 사진은 JPEG만 받고 크기를 제한하며, 잠금 확인을 거쳐서만 내려준다.

## 아직 없는 것

- 푸시 알림 (케틴이 울려도 앱을 열어야 안다)
- 사용자끼리의 차단, 앱 안에서의 계정 삭제 (지금은 문의로 요청)
- 서버 여러 대로 늘리기 (지금 구조는 한 대 기준)
