#!/bin/bash
# Coderix Desktop — Cross-platform packaging script
#
# Usage:
#   ./scripts/package.sh              # Package for current platform
#   ./scripts/package.sh --mac        # macOS .app bundle
#   ./scripts/package.sh --win        # Windows directory
#   ./scripts/package.sh --linux      # Linux AppImage/directory
#
# Requirements: pnpm, node 22+

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(cd ../../ && pwd)"
VERSION="$(node -p 'require("./package.json").version')"
APP_NAME="Coderix"
ELECTRON_DIR="$ROOT_DIR/node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist"

PLATFORM="${1:-}"

# ── Build production bundle ───────────────────────────────────────
echo "=== Building production bundle ==="
ELECTRON_MAJOR_VER=33 pnpm exec electron-vite build --config electron.vite.prod.config.ts

# ── Detect platform ───────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    CYGWIN*|MINGW*|MSYS*) echo "win32" ;;
    *) echo "unknown" ;;
  esac
}

HOST_PLATFORM="$(detect_platform)"

if [ -z "$PLATFORM" ]; then
  PLATFORM="--$(echo "$HOST_PLATFORM" | sed 's/darwin/mac/;s/win32/win/;s/linux/linux/')"
fi

# ── Copy externalized runtime dependencies ─────────────────────────
copy_runtime_deps() {
  local OUT="$1"
  # undici — externalized because it uses node:sqlite (Node 22+) not in Electron 33
  for d in "$ROOT_DIR/node_modules/.pnpm/undici@7"*; do
    if [ -d "$d/node_modules/undici" ]; then
      mkdir -p "$OUT/node_modules/undici"
      cp -r "$d/node_modules/undici"/* "$OUT/node_modules/undici/"
      echo "  ✓ undici"
      break
    fi
  done
  # @anthropic-ai/sdk — dynamically imported by callModel
  for d in "$ROOT_DIR/node_modules/.pnpm/@anthropic-ai+sdk@0"*; do
    if [ -d "$d/node_modules/@anthropic-ai/sdk" ]; then
      mkdir -p "$OUT/node_modules/@anthropic-ai"
      cp -r "$d/node_modules/@anthropic-ai/sdk" "$OUT/node_modules/@anthropic-ai/"
      echo "  ✓ @anthropic-ai/sdk"
      break
    fi
  done
}

# ── Package based on target platform ──────────────────────────────
package_linux() {
  local OUT="$PWD/release/${APP_NAME}-${VERSION}-linux-x64"
  echo "=== Packaging Linux: $OUT ==="
  rm -rf "$OUT"
  mkdir -p "$OUT"

  # App files
  cp -r dist "$OUT/"
  node -e "
    const pkg = require('./package.json');
    pkg.main = 'dist/main/index.cjs';
    delete pkg.type;
    delete pkg.devDependencies;
    require('fs').writeFileSync('$OUT/package.json', JSON.stringify(pkg, null, 2));
  "

  # Copy externalized runtime deps (not bundled into main.cjs)
  copy_runtime_deps "$OUT"

  # Electron runtime — copy ALL files except the binary itself (renamed)
  for f in "$ELECTRON_DIR/"*; do
    local name="$(basename "$f")"
    if [ "$name" = "electron" ]; then
      cp "$f" "$OUT/coderix"
    elif [ "$name" != "LICENSE" ] && [ "$name" != "LICENSES.chromium.html" ]; then
      cp -r "$f" "$OUT/" 2>/dev/null || true
    fi
  done

  # Launch script
  cat > "$OUT/coderix.sh" << 'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export -n ELECTRON_RUN_AS_NODE 2>/dev/null || true
unset ELECTRON_RUN_AS_NODE
exec "$DIR/coderix" --no-sandbox "$DIR"
LAUNCHER
  chmod +x "$OUT/coderix.sh"

  echo "  → $OUT"
  du -sh "$OUT"
}

package_mac() {
  local OUT="$PWD/release/${APP_NAME}-${VERSION}-macos"
  echo "=== Packaging macOS (directory bundle): $OUT ==="
  rm -rf "$OUT"
  mkdir -p "$OUT/${APP_NAME}.app/Contents/MacOS"
  mkdir -p "$OUT/${APP_NAME}.app/Contents/Resources"

  # App files
  cp -r dist "$OUT/${APP_NAME}.app/Contents/Resources/"
  node -e "
    const pkg = require('./package.json');
    pkg.main = 'dist/main/index.cjs';
    delete pkg.type;
    delete pkg.devDependencies;
    require('fs').writeFileSync('$OUT/${APP_NAME}.app/Contents/Resources/package.json', JSON.stringify(pkg, null, 2));
  "
  copy_runtime_deps "$OUT/${APP_NAME}.app/Contents/Resources"

  # Electron runtime
  cp "$ELECTRON_DIR/electron" "$OUT/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
  for f in "$ELECTRON_DIR/"*.pak "$ELECTRON_DIR/"*.dylib "$ELECTRON_DIR/"*.dat "$ELECTRON_DIR/"*.bin "$ELECTRON_DIR/"*.json; do
    [ -f "$f" ] && cp "$f" "$OUT/${APP_NAME}.app/Contents/Resources/" 2>/dev/null || true
  done
  cp -r "$ELECTRON_DIR/Resources" "$OUT/${APP_NAME}.app/Contents/" 2>/dev/null || true

  chmod +x "$OUT/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"

  # Info.plist
  cat > "$OUT/${APP_NAME}.app/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.coderix.desktop</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

  echo "  → $OUT"
  du -sh "$OUT"
}

package_win() {
  local OUT="$PWD/release/${APP_NAME}-${VERSION}-win32-x64"
  echo "=== Packaging Windows: $OUT ==="
  rm -rf "$OUT"
  mkdir -p "$OUT"

  # App files
  cp -r dist "$OUT/"
  node -e "
    const pkg = require('./package.json');
    pkg.main = 'dist/main/index.cjs';
    delete pkg.type;
    delete pkg.devDependencies;
    require('fs').writeFileSync('$OUT/package.json', JSON.stringify(pkg, null, 2));
  "
  copy_runtime_deps "$OUT"

  # Electron runtime
  for f in "$ELECTRON_DIR/"*; do
    local name="$(basename "$f")"
    if [ "$name" = "electron.exe" ] || [ "$name" = "electron" ]; then
      cp "$f" "$OUT/${APP_NAME}.exe"
    elif [ "$name" != "LICENSE" ] && [ "$name" != "LICENSES.chromium.html" ]; then
      cp -r "$f" "$OUT/" 2>/dev/null || true
    fi
  done

  # Launch batch script
  cat > "$OUT/coderix.bat" << 'BATFILE'
@echo off
start "" "%~dp0Coderix.exe" --no-sandbox "%~dp0"
BATFILE

  echo "  → $OUT"
  du -sh "$OUT"
}

case "$PLATFORM" in
  --mac)   package_mac ;;
  --win)   package_win ;;
  --linux) package_linux ;;
  *)
    echo "Usage: $0 [--mac|--win|--linux]"
    echo "Default: package for current platform"
    if [ "$HOST_PLATFORM" = "linux" ]; then
      package_linux
    elif [ "$HOST_PLATFORM" = "darwin" ]; then
      package_mac
    else
      package_win
    fi
    ;;
esac

echo "=== Done ==="
