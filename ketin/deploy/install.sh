#!/usr/bin/env bash
# ketin 서버 설치·업데이트 스크립트 (Ubuntu 22.04 / 24.04, Oracle Cloud Always Free 기준)
#
#   sudo bash deploy/install.sh <도메인> [DuckDNS 토큰]
#   예) sudo bash deploy/install.sh ketin.duckdns.org 1a2b3c4d-....
#
# 여러 번 실행해도 안전합니다. 다시 실행하면 코드만 새로 깔고 데이터와 GM 코드는 그대로 둡니다.
set -euo pipefail

DOMAIN="${1:-}"
DUCK_TOKEN="${2:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/ketin
DATA=/var/lib/ketin
ENVF=/etc/ketin.env
BACKUPS=/var/backups/ketin

[ "$(id -u)" = 0 ] || { echo "sudo 로 실행해 주세요."; exit 1; }
if [ -z "$DOMAIN" ] && [ -f "$ENVF" ]; then DOMAIN="$(sed -n 's#^PUBLIC_ORIGIN=https://##p' "$ENVF")"; fi
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || { echo "사용법: sudo bash deploy/install.sh <도메인> [DuckDNS 토큰]"; exit 1; }

echo "== 1/7 기본 도구"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils gnupg cron iptables >/dev/null

echo "== 2/7 Node.js 22"
if ! /usr/local/bin/node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "지원하지 않는 CPU: $(uname -m)"; exit 1 ;; esac
  TMP="$(mktemp -d)"
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$TMP/sums"
  FILE="$(grep -o "node-v22[0-9.]*-linux-$ARCH.tar.xz" "$TMP/sums" | head -1)"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" sums | sha256sum -c - >/dev/null)
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi
echo "   node $(/usr/local/bin/node -v)"

echo "== 3/7 Caddy (HTTPS 인증서 자동 발급)"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "== 4/7 앱 설치"
id ketin >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin ketin
install -d -o ketin -g ketin -m 750 "$DATA" "$BACKUPS"
install -d -m 755 "$APP"
rm -rf "$APP/public"
cp -r "$SRC/server.js" "$SRC/store.js" "$SRC/package.json" "$SRC/public" "$APP/"
install -m 755 "$SRC/deploy/backup.sh" "$APP/backup.sh"
chown -R root:root "$APP"

if [ ! -f "$ENVF" ]; then
  GM="$(head -c 18 /dev/urandom | base64 | tr '+/' '-_')"
  cat > "$ENVF" <<ENV
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
DATA_DIR=$DATA
PUBLIC_ORIGIN=https://$DOMAIN
GM_CODE=$GM
# 구글 로그인을 켜려면 아래 두 줄의 # 을 지우고 값을 넣은 뒤: sudo systemctl restart ketin
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=
ENV
else
  sed -i "s#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=https://$DOMAIN#" "$ENVF"
fi
chown root:ketin "$ENVF"; chmod 640 "$ENVF"

cat > /etc/systemd/system/ketin.service <<UNIT
[Unit]
Description=ketin
After=network-online.target
Wants=network-online.target

[Service]
User=ketin
Group=ketin
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning $APP/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
ReadWritePaths=$DATA
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT

echo "== 5/7 HTTPS 프록시"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 4MB
	}
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
CADDY

echo "== 6/7 방화벽 (80, 443 열기)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

echo "== 7/7 주소 연결 · 백업 · 시작"
if [ -n "$DUCK_TOKEN" ] && [[ "$DOMAIN" == *.duckdns.org ]]; then
  printf 'url="https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "${DOMAIN%.duckdns.org}" "$DUCK_TOKEN" > /etc/ketin-duckdns
  chmod 600 /etc/ketin-duckdns
  echo "   DuckDNS: $(curl -fsS -K /etc/ketin-duckdns || echo 실패)"
  echo '*/5 * * * * root curl -fsS -K /etc/ketin-duckdns -o /dev/null' > /etc/cron.d/ketin-duckdns
fi
echo "17 19 * * * ketin $APP/backup.sh" > /etc/cron.d/ketin-backup   # 매일 한국 시간 04:17

systemctl daemon-reload
systemctl enable -q ketin caddy cron 2>/dev/null || true
systemctl restart ketin
systemctl restart caddy

sleep 2
if curl -fsS http://127.0.0.1:3000/health >/dev/null; then echo "   앱 서버 정상"; else echo "   앱 서버가 안 떴어요:  sudo journalctl -u ketin -n 50"; exit 1; fi

cat <<DONE

완료!
  주소      https://$DOMAIN        (인증서 발급에 1분쯤 걸릴 수 있어요)
  관리자    https://$DOMAIN/admin
  GM 코드   sudo grep GM_CODE $ENVF
  로그      sudo journalctl -u ketin -f
  업데이트  git pull && sudo bash deploy/install.sh

접속이 안 되면 Oracle 콘솔의 Security List 에 80, 443 수신 규칙이 있는지 확인하세요.
DONE
