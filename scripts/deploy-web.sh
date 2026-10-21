#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/web/dist"
TARGET="/srv/auralis"

echo "Building Auralis web..."
cd "$ROOT"
npm run build:web

if [[ ! -f "$DIST/index.html" ]]; then
    echo "ERROR: Build output missing: $DIST/index.html" >&2
    exit 1
fi

echo "Deploying to $TARGET..."
sudo install -d -o root -g caddy -m 0755 "$TARGET"
sudo rsync -a --delete "$DIST/" "$TARGET/"
sudo chown -R root:caddy "$TARGET"
sudo chmod -R u=rwX,g=rX,o=rX "$TARGET"

echo "Auralis web deployed successfully."
