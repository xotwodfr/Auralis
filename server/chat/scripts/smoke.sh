#!/usr/bin/env bash
# End-to-end smoke + persistence check for a running (or startable) stack, CHAT.md §8.3:
# health → two throwaway users → DM → message → `down`/`up` → `--force-recreate` → message, session and instanceId
# still there, no new anonymous volumes. The throwaway users are disabled at the end (rows are never hard-deleted).
# Usage: scripts/smoke.sh   (SMOKE_URL overrides the address; default from CHAT_BIND_ADDRESS/CHAT_PORT in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
host=${CHAT_BIND_ADDRESS:-127.0.0.1}
[ "$host" = 0.0.0.0 ] && host=127.0.0.1
base=${SMOKE_URL:-http://$host:${CHAT_PORT:-8790}}

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
json() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
api() { curl -fsS -H 'content-type: application/json' "$@"; }

dangling_before=$(docker volume ls -qf dangling=true | sort)

step "start"
docker compose up -d --wait
curl -fsS "$base/readyz" >/dev/null || fail "readyz"
instance=$(curl -fsS "$base/api/v1/server-info" | json instanceId)
[ -n "$instance" ] || fail "no instanceId"
echo "instanceId $instance"

step "users, DM, message"
suffix=$(date -u +%Y%m%d%H%M%S)
password="smoke-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
for who in a b; do printf '%s\n' "$password" | docker compose run --rm -T chat node src/cli.ts create-user "smoke-$suffix-$who"; done
login() { api -d "{\"username\":\"smoke-$suffix-$1\",\"password\":\"$password\",\"deviceName\":\"smoke\"}" "$base/api/v1/auth/login"; }
token_a=$(login a | json token)
user_b=$(login b | grep -o '"user":{"id":"[^"]*"' | cut -d'"' -f6)
conv=$(api -H "authorization: Bearer $token_a" -d "{\"userId\":\"$user_b\"}" "$base/api/v1/conversations/direct" | json id)
body="smoke message $suffix"
api -H "authorization: Bearer $token_a" -d "{\"clientMessageId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"body\":\"$body\"}" "$base/api/v1/conversations/$conv/messages" >/dev/null

check() {
  curl -fsS "$base/readyz" >/dev/null || fail "readyz $1"
  [ "$(curl -fsS "$base/api/v1/server-info" | json instanceId)" = "$instance" ] || fail "instanceId changed $1"
  curl -fsS -H "authorization: Bearer $token_a" "$base/api/v1/conversations/$conv/messages" | grep -q "$body" || fail "message missing $1"
  echo "ok $1"
}
check "before restart"

step "down (no -v) → up"
docker compose down
docker compose up -d --wait
check "after down/up"

step "force-recreate"
docker compose up -d --force-recreate --wait
check "after force-recreate"

step "storage"
docker volume inspect auralis-chat_db-data >/dev/null || fail "named volume missing"
count=$(docker compose exec -T db psql -U chat -d chat -tAc "SELECT count(*) FROM messages WHERE body = '$body'")
[ "$count" = 1 ] || fail "expected 1 row, got $count"
[ "$(docker volume ls -qf dangling=true | sort)" = "$dangling_before" ] || fail "new anonymous volume (wrong PostgreSQL mount point?)"
docker compose ps --format '{{.Ports}}' db | grep -q -- '->' && fail "db has a published port"
echo "ok storage"

step "cleanup"
for who in a b; do docker compose run --rm -T chat node src/cli.ts disable-user "smoke-$suffix-$who" >/dev/null; done
echo
echo "SMOKE OK"
