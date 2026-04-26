#!/bin/sh
set -eu
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HCM_ROOT="${HCM_HOME:-$HOME/.codex/hcm}"
mkdir -p "$HCM_ROOT"
cp -R "$SRC_DIR/bin" "$SRC_DIR/web" "$HCM_ROOT/"
chmod +x "$HCM_ROOT/bin/"*
"$HCM_ROOT/bin/install-hcm-shell"
echo "Horizon Context Memory installed to $HCM_ROOT"
echo "Run: hcm"
