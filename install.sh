#!/bin/sh
set -eu
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HCM_ROOT="${HCM_HOME:-$HOME/.codex/hcm}"
mkdir -p "$HCM_ROOT"
cp -R "$SRC_DIR/bin" "$SRC_DIR/web" "$HCM_ROOT/"
chmod +x "$HCM_ROOT/bin/"*

LEGACY_ROOT="$HOME/.codex/hermes-codex"
if [ -f "$LEGACY_ROOT/data/memories.json" ]; then
  HCM_ROOT="$HCM_ROOT" LEGACY_ROOT="$LEGACY_ROOT" node <<'NODE'
const fs = require('fs');
const path = require('path');
const hcmRoot = process.env.HCM_ROOT;
const legacyRoot = process.env.LEGACY_ROOT;
const hcmData = path.join(hcmRoot, 'data');
const legacyData = path.join(legacyRoot, 'data');
function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  ensure(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function copyFileIfMissing(src, dest) {
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    ensure(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}
function copyDirMerge(src, dest) {
  if (!fs.existsSync(src)) return;
  ensure(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirMerge(source, target);
    else if (!fs.existsSync(target)) fs.copyFileSync(source, target);
  }
}
ensure(hcmData);
const legacyStore = readJson(path.join(legacyData, 'memories.json'), { schema: 2, memories: [] });
const hcmStore = readJson(path.join(hcmData, 'memories.json'), { schema: 2, memories: [] });
const byId = new Map((hcmStore.memories || []).map(memory => [memory.id, memory]));
let added = 0;
for (const memory of legacyStore.memories || []) {
  if (!byId.has(memory.id)) {
    byId.set(memory.id, memory);
    added += 1;
  }
}
if (added > 0) {
  writeJson(path.join(hcmData, 'memories.json'), { schema: 2, memories: [...byId.values()] });
  copyFileIfMissing(path.join(legacyData, 'audit.jsonl'), path.join(hcmData, 'audit.jsonl'));
  copyFileIfMissing(path.join(legacyData, 'sessions.sqlite'), path.join(hcmData, 'sessions.sqlite'));
  copyDirMerge(path.join(legacyData, 'events'), path.join(hcmData, 'events'));
  copyDirMerge(path.join(legacyData, 'backups'), path.join(hcmData, 'backups'));
  copyDirMerge(path.join(legacyRoot, 'skills'), path.join(hcmRoot, 'skills'));
  console.log(`Migrated ${added} legacy memories from ${legacyRoot}`);
}
NODE
fi

"$HCM_ROOT/bin/install-hcm-shell"
echo "Horizon Context Memory installed to $HCM_ROOT"
echo "Run: hcm"
