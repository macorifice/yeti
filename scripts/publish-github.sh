#!/usr/bin/env bash
# Publishes a copy of the package to GitHub Packages under the @macorifice scope.
# The npm package (yeti-mcp) is untouched: this script works on a temporary copy
# with the scoped name, so the repository keeps a single package.json.
#
# Usage: scripts/publish-github.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCOPE="@macorifice"
REGISTRY="https://npm.pkg.github.com"

cd "$ROOT"
npm run build

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R dist README.md LICENSE "$TMP/"
node -e '
const fs = require("fs");
const [src, dest, scope] = process.argv.slice(1);
const p = JSON.parse(fs.readFileSync(src, "utf8"));
const bare = p.name.replace(/^@[^/]+\//, "");
p.name = `${scope}/${bare}`;
p.publishConfig = { registry: process.env.REGISTRY, access: "public" };
fs.writeFileSync(dest, JSON.stringify(p, null, 2) + "\n");
' package.json "$TMP/package.json" "$SCOPE"

cd "$TMP"
npm publish --registry="$REGISTRY" --access public "$@"
