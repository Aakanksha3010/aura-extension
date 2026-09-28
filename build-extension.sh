#!/usr/bin/env bash
# build-extension.sh — produce a Chrome Web Store upload package.
#
# Allowlist, not denylist. `zip -r . -x ...` ships whatever you forgot to
# exclude, and this directory contains key.pem (the signing key — leaking it
# lets anyone publish updates under this extension's identity), the full .git
# history, the Supabase server code, and internal planning docs. None of that
# belongs in a package handed to Google and unpacked on every user's machine.
#
# Usage:  ./build-extension.sh          → dist/aura-<version>.zip

set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/aura-${VERSION}.zip"

# Exactly what the extension needs at runtime. Add to this list deliberately.
FILES=(
  manifest.json
  popup.html
  popup.css
  popup.js
  background.js
  content.js
  lib/supabase-client.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

echo "Building Aura ${VERSION}"

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "  MISSING: $f" >&2; exit 1; }
done

rm -rf dist && mkdir -p dist
zip -q "$OUT" "${FILES[@]}"

# Belt and braces: assert the finished archive contains nothing dangerous.
# The allowlist above should already guarantee this — this catches the day
# someone adds an entry without thinking it through.
CONTENTS=$(unzip -Z1 "$OUT")
for bad in 'key.pem' '\.git' '\.env' 'supabase/' 'eval/' '\.DS_Store' 'BETA-AND-LAUNCH' 'BILLING-AND-STATUS' '\.pem$'; do
  if echo "$CONTENTS" | grep -qE "$bad"; then
    echo "  REFUSING: package contains '$bad'" >&2
    rm -f "$OUT"
    exit 1
  fi
done

# The signing key must not be in the tree we zipped from either — a stray copy
# under a shipped directory would have been caught above, but say so loudly.
if echo "$CONTENTS" | grep -qiE 'pem|secret|credential'; then
  echo "  REFUSING: suspicious filename in package" >&2
  rm -f "$OUT"; exit 1
fi

echo
echo "$CONTENTS" | sed 's/^/  /'
echo
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Upload at: https://chrome.google.com/webstore/devconsole"
