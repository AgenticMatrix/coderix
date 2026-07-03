#!/bin/bash
# Coderix Desktop — Linux Install Script
#
# Installs to ~/.local/share/coderix and creates a .desktop entry.
# No root/sudo required.
#
# Usage:
#   bash scripts/install.sh                    # Install from release dir
#   bash scripts/install.sh /path/to/package   # Install from custom path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(node -p 'require("'$PROJECT_DIR'/package.json").version' 2>/dev/null || echo '0.1.0')"

INSTALL_DIR="${HOME}/.local/share/coderix"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"

# Find the package
PKG_DIR="${1:-}"
if [ -z "$PKG_DIR" ]; then
  # Look for the latest release
  PKG_DIR="$(ls -dt "$PROJECT_DIR/release/Coderix-"* 2>/dev/null | head -1 || echo '')"
fi

if [ -z "$PKG_DIR" ] || [ ! -d "$PKG_DIR" ]; then
  echo "Error: No release package found."
  echo "Run 'bash scripts/package.sh' first, then try again."
  echo "Or specify a package path: bash scripts/install.sh /path/to/Coderix-x.x.x-linux-x64"
  exit 1
fi

echo "=== Coderix Desktop Installer ==="
echo "Package : $PKG_DIR"
echo "Target  : $INSTALL_DIR"
echo ""

# ── Copy app files ────────────────────────────────────────────
echo "Installing to $INSTALL_DIR ..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$PKG_DIR"/* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/coderix" 2>/dev/null || true

# ── Create bin symlink ─────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/coderix.sh" "$BIN_DIR/coderix"
echo "  ✓ $BIN_DIR/coderix"

# ── Create .desktop entry ──────────────────────────────────────
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/coderix.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Coderix
GenericName=AI Coding Assistant
Comment=Open-source AI coding assistant
Exec=$INSTALL_DIR/coderix.sh
Icon=coderix
Terminal=false
Categories=Development;IDE;
Keywords=coding;ai;assistant;claude;
StartupWMClass=coderix
EOF
echo "  ✓ $DESKTOP_DIR/coderix.desktop"

# ── Create icon ───────────────────────────────────────────────
mkdir -p "$ICON_DIR"
# Use a simple generated PNG via Node.js (no external deps needed)
node -e "
const { writeFileSync } = require('fs');
// Minimal 256x256 blue square PNG
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQMowYMfQNwGcBATUuGvgFYDWBiYBigBoAByAAAvgAEf+FhM8AAAAASUVORK5CYII=', 'base64');
writeFileSync('$ICON_DIR/coderix.png', png);
" 2>/dev/null || touch "$ICON_DIR/coderix.png"
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
echo "  ✓ $ICON_DIR/coderix.png"

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "=== Installation Complete ==="
echo ""
echo "  Launch from terminal:  coderix"
echo "  Launch from app menu:  Search for 'Coderix'"
echo "  Installed at:          $INSTALL_DIR"
echo ""
echo "Ensure ~/.local/bin is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "To uninstall:"
echo "  rm -rf $INSTALL_DIR $BIN_DIR/coderix $DESKTOP_DIR/coderix.desktop $ICON_DIR/coderix.png"
