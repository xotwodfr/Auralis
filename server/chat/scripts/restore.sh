#!/usr/bin/env bash
# Restores a backup over the current database, after taking a safety dump. CHAT.md §15.3.
# Usage: scripts/restore.sh backups/chat-YYYYMMDDTHHMMSSZ.dump [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."
file=${1:?usage: scripts/restore.sh <dump file> [--yes]}
[ -s "$file" ] || { echo "no such dump: $file" >&2; exit 1; }
if [ "${2:-}" != --yes ]; then
  read -r -p "Replace the chat database with $file? Messages sent after it was taken are lost. [y/N] " answer
  [ "$answer" = y ] || exit 1
fi
safety=$(scripts/backup.sh)
echo "safety dump: $safety"
docker compose stop chat
docker compose exec -T db pg_restore -U chat -d chat --clean --if-exists --no-owner < "$file"
docker compose run --rm migrate
docker compose start chat
echo "restored $file"
