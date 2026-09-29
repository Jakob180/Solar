#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -x backend/.venv/bin/python ] || [ ! -d frontend/node_modules ]; then
  npm run setup
fi

npm --prefix frontend run build
exec node scripts/dev.mjs --preview
