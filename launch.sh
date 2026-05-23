#!/usr/bin/env bash
# 3D Viewer — launch script (macOS / Linux)
# First run installs deps + builds; subsequent runs just open the app.
set -e
cd "$(dirname "$0")"

ART_DIR="artifacts/point-cloud-viewer"
TARGET_DIR="$ART_DIR/src-tauri/target/release"

# Find the built binary (name differs by OS).
APP_BIN=""
if   [ -x "$TARGET_DIR/3D Viewer" ];          then APP_BIN="$TARGET_DIR/3D Viewer"
elif [ -d "$TARGET_DIR/bundle/macos/3D Viewer.app" ]; then APP_BIN="$TARGET_DIR/bundle/macos/3D Viewer.app"
fi

if [ -n "$APP_BIN" ]; then
  echo "Launching 3D Viewer..."
  if [[ "$APP_BIN" == *.app ]]; then open "$APP_BIN"; else "$APP_BIN" & fi
  exit 0
fi

echo "First-time setup — installing deps and building the desktop app."
echo "Allow 10-15 minutes on first run."

command -v node  >/dev/null 2>&1 || { echo "Install Node 20+ from https://nodejs.org/"; exit 1; }
command -v pnpm  >/dev/null 2>&1 || { corepack enable; corepack prepare pnpm@9 --activate; }
command -v rustc >/dev/null 2>&1 || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; . "$HOME/.cargo/env"; }

pnpm install
TAURI_BUILD=1 pnpm --filter "@workspace/point-cloud-viewer" run tauri build

# Try to launch whatever was built.
if   [ -x "$TARGET_DIR/3D Viewer" ];          then "$TARGET_DIR/3D Viewer" &
elif [ -d "$TARGET_DIR/bundle/macos/3D Viewer.app" ]; then open "$TARGET_DIR/bundle/macos/3D Viewer.app"
else echo "Build done, but couldn't find the binary in $TARGET_DIR"; exit 1
fi
echo "Done. Next time, just run ./launch.sh — it will open instantly."
