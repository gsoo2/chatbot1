#!/usr/bin/env bash
# 매일 DB 사본을 /var/backups/ketin 에 남기고 14일 지난 것은 지웁니다. (ketin 사용자로 실행)
set -euo pipefail
DATA="${DATA_DIR:-/var/lib/ketin}"
OUT="${BACKUP_DIR:-/var/backups/ketin}"
F="$OUT/ketin-$(date +%Y%m%d-%H%M%S).db"
/usr/local/bin/node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.prepare("VACUUM INTO ?").run(process.argv[2]);
db.close();' "$DATA/ketin.db" "$F"
gzip -f "$F"
find "$OUT" -name 'ketin-*.db.gz' -mtime +14 -delete
