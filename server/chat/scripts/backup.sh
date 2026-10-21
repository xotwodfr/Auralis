#!/usr/bin/env bash
# Logical backup (pg_dump custom format) to backups/, written atomically, mode 600, last 14 kept. CHAT.md §15.2.
# Backups contain every message: copy them off-host encrypted (e.g. `age`).
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
out="backups/chat-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U chat -d chat -Fc > "$out.partial"
[ -s "$out.partial" ] || { rm -f "$out.partial"; echo "backup failed: empty dump" >&2; exit 1; }
mv "$out.partial" "$out"
ls -1t backups/chat-*.dump | tail -n +15 | xargs -r rm --
echo "$out"
