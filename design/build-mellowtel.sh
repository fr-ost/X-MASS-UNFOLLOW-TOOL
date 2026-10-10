#!/bin/sh
# Rebuilds vendor/mellowtel.js: the unmodified Mellowtel SDK bundled as one
# classic script that exposes globalThis.Mellowtel (this extension has no
# bundler, and its service worker uses importScripts). Not shipped.
#   sh design/build-mellowtel.sh [version]     (default 1.7.0)
set -e
V="${1:-1.7.0}"
W="$(mktemp -d)"
cd "$W"
npm init -y >/dev/null
npm install "mellowtel@$V" esbuild --silent --no-audit --no-fund
printf 'import Mellowtel from "mellowtel";\nglobalThis.Mellowtel = Mellowtel;\n' > entry.js
npx esbuild entry.js --bundle --format=iife --platform=browser --target=chrome116 --minify --legal-comments=none --outfile=out.js
OUT="$OLDPWD/vendor/mellowtel.js"
{ printf '/*! mellowtel %s (LGPL-3.0) - https://github.com/mellowtel-inc/mellowtel-js - bundled unmodified as an IIFE exposing globalThis.Mellowtel. Rebuild: design/build-mellowtel.sh. License: vendor/mellowtel.LICENSE.txt */\n' "$V"; cat out.js; } > "$OUT"
cp node_modules/mellowtel/LICENSE.MD "$OLDPWD/vendor/mellowtel.LICENSE.txt"
echo "wrote $OUT"
