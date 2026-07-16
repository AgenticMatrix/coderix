#!/bin/bash
# install.sh — One-click installer for Coderix (CLI + Desktop)
#
# Usage:
#   # Remote install (from GitHub)
#   curl -fsSL https://raw.githubusercontent.com/AgenticMatrix/coderix/main/install.sh | bash
#
#   # Local development install (run from repo root)
#   ./install.sh --local      # CLI only
#   ./install.sh --desktop    # Desktop Electron app only
#   ./install.sh --all        # Both CLI and Desktop
#
# This script:
#   1. Checks Node.js >= 22 + pnpm (for monorepo)
#   2. Installs coderix dependencies
#   3. Creates ~/.coderix configuration directory
#   4. Optionally sets up API keys
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

LOCAL_INSTALL=false
DESKTOP_INSTALL=false
for arg in "$@"; do
  case "$arg" in
    --local|--dev) LOCAL_INSTALL=true ;;
    --desktop) DESKTOP_INSTALL=true ;;
    --all) LOCAL_INSTALL=true; DESKTOP_INSTALL=true ;;
  esac
done

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║    Coderix — CLI + Desktop Installer             ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Check Node.js
# ---------------------------------------------------------------------------
NODE_MIN_VERSION=22

if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Node.js is not installed. Attempting automatic installation...${NC}"
  echo ""

  AUTO_INSTALLED=false

  if ! $AUTO_INSTALLED && command -v fnm &> /dev/null; then
    echo -e "${CYAN}fnm detected. Installing Node.js ${NODE_MIN_VERSION}...${NC}"
    fnm install ${NODE_MIN_VERSION} && fnm use ${NODE_MIN_VERSION} && AUTO_INSTALLED=true
  fi

  if ! $AUTO_INSTALLED && [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo -e "${CYAN}nvm detected. Installing Node.js ${NODE_MIN_VERSION}...${NC}"
    . "$HOME/.nvm/nvm.sh" && nvm install ${NODE_MIN_VERSION} && nvm use ${NODE_MIN_VERSION} && AUTO_INSTALLED=true
  fi

  if ! $AUTO_INSTALLED && command -v brew &> /dev/null; then
    echo -e "${CYAN}Homebrew detected. Installing Node.js ${NODE_MIN_VERSION}...${NC}"
    brew install node@${NODE_MIN_VERSION} && AUTO_INSTALLED=true
  fi

  if ! $AUTO_INSTALLED; then
    echo -e "${CYAN}No version manager found. Attempting to install fnm...${NC}"
    if command -v curl &> /dev/null; then
      curl -fsSL https://fnm.vercel.app/install | bash
      FNM_PATH="$HOME/.local/share/fnm"
      [ -d "$HOME/.fnm" ] && FNM_PATH="$HOME/.fnm"
      if [ -f "$FNM_PATH/fnm" ]; then
        export PATH="$FNM_PATH:$PATH"
        eval "$(fnm env)"
        fnm install ${NODE_MIN_VERSION} && fnm use ${NODE_MIN_VERSION} && AUTO_INSTALLED=true
      fi
    fi
  fi

  if $AUTO_INSTALLED; then
    NODE_VERSION=$(node -v | sed "s/v//")
    echo -e "${GREEN}Node.js v${NODE_VERSION} installed successfully${NC}"
  else
    echo -e "${RED}ERROR: Could not automatically install Node.js >= ${NODE_MIN_VERSION}.${NC}"
    echo ""
    echo "Please install Node.js ${NODE_MIN_VERSION}+ manually:"
    echo "  - fnm:  curl -fsSL https://fnm.vercel.app/install | bash"
    echo "  - nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "  - brew: brew install node@${NODE_MIN_VERSION}"
    echo "  - Official: https://nodejs.org/"
    exit 1
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

echo -e "Node.js version: ${GREEN}v${NODE_VERSION}${NC}"

if [ "$NODE_MAJOR" -lt "$NODE_MIN_VERSION" ]; then
  echo -e "${YELLOW}Node.js v${NODE_MAJOR} detected. Coderix requires >= ${NODE_MIN_VERSION}.${NC}"
  echo ""

  AUTO_INSTALLED=false

  if ! $AUTO_INSTALLED && command -v fnm &> /dev/null; then
    echo -e "${CYAN}fnm detected. Installing Node.js 22...${NC}"
    fnm install 22 && fnm use 22 && AUTO_INSTALLED=true
  fi

  if ! $AUTO_INSTALLED && [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo -e "${CYAN}nvm detected. Installing Node.js 22...${NC}"
    . "$HOME/.nvm/nvm.sh" && nvm install 22 && nvm use 22 && AUTO_INSTALLED=true
  fi

  if ! $AUTO_INSTALLED; then
    echo -e "${CYAN}No Node.js version manager found. Attempting to install fnm...${NC}"
    if command -v curl &> /dev/null; then
      curl -fsSL https://fnm.vercel.app/install | bash
      FNM_PATH="$HOME/.local/share/fnm"
      [ -d "$HOME/.fnm" ] && FNM_PATH="$HOME/.fnm"
      if [ -f "$FNM_PATH/fnm" ]; then
        export PATH="$FNM_PATH:$PATH"
        eval "$(fnm env)"
        fnm install 22 && fnm use 22 && AUTO_INSTALLED=true
      fi
    fi
  fi

  if $AUTO_INSTALLED; then
    NODE_VERSION=$(node -v | sed "s/v//")
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    echo -e "${GREEN}Node.js upgraded to v${NODE_VERSION}${NC}"
  else
    echo -e "${RED}ERROR: Could not automatically install Node.js >= ${NODE_MIN_VERSION}.${NC}"
    echo ""
    echo "Please install Node.js 22+ manually:"
    echo "  - fnm:  curl -fsSL https://fnm.vercel.app/install | bash"
    echo "  - nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "  - brew: brew install node@22"
    echo "  - Official: https://nodejs.org/"
    exit 1
  fi
fi

# Check npm version
NPM_MIN_VERSION=10

if command -v npm &> /dev/null; then
  NPM_VERSION=$(npm -v)
  NPM_MAJOR=$(echo "$NPM_VERSION" | cut -d. -f1)
  echo -e "npm version: ${GREEN}v${NPM_VERSION}${NC}"

  if [ "$NPM_MAJOR" -lt "$NPM_MIN_VERSION" ]; then
    echo -e "${YELLOW}WARNING: npm v${NPM_MAJOR} detected. npm >= ${NPM_MIN_VERSION} recommended.${NC}"
    echo "You can upgrade npm with: npm install -g npm@latest"
  fi
fi

# Check pnpm (required for monorepo dev)
if command -v pnpm &> /dev/null; then
  PNPM_VERSION=$(pnpm -v)
  echo -e "pnpm version: ${GREEN}v${PNPM_VERSION}${NC}"
else
  echo -e "${YELLOW}pnpm not found. Installing pnpm...${NC}"
  if command -v npm &> /dev/null; then
    npm install -g pnpm 2>/dev/null && echo -e "${GREEN}pnpm installed${NC}" || echo -e "${YELLOW}WARNING: Could not install pnpm. Desktop build requires pnpm.${NC}"
  else
    echo -e "${YELLOW}WARNING: npm not found, cannot auto-install pnpm.${NC}"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Auto-detect local dev install
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/package.json" ] && grep -q '"coderix"' "${SCRIPT_DIR}/package.json" 2>/dev/null; then
  LOCAL_INSTALL=true
  REPO_DIR="${SCRIPT_DIR}"
fi

# ---------------------------------------------------------------------------
# 3. Install coderix
# ---------------------------------------------------------------------------
echo ""

if $LOCAL_INSTALL || $DESKTOP_INSTALL; then
  echo -e "${CYAN}Local development install detected.${NC}"

  if [ -z "${REPO_DIR:-}" ]; then
    echo -e "${RED}ERROR: --local/--desktop flag used but not inside coderix repo.${NC}"
    echo "Run this script from the repo root:"
    echo "  git clone https://github.com/AgenticMatrix/coderix.git"
    echo "  cd coderix && ./install.sh --local"
    exit 1
  fi

  echo -e "Repo directory: ${GREEN}${REPO_DIR}${NC}"
  echo ""

  # Install root dependencies
  echo -e "${CYAN}Installing monorepo dependencies...${NC}"
  (cd "${REPO_DIR}" && pnpm install)

  if $LOCAL_INSTALL; then
    echo ""
    echo -e "${CYAN}Building CLI...${NC}"
    (cd "${REPO_DIR}" && npm run build 2>/dev/null || pnpm run build:cli 2>/dev/null || echo -e "${YELLOW}CLI build skipped (use: npm run dev:cli)${NC}")

    echo ""
    echo -e "${CYAN}Linking coderix command globally...${NC}"
    (cd "${REPO_DIR}" && npm link --force 2>/dev/null || npm link 2>/dev/null || true)

    echo -e "${GREEN}CLI built and linked locally${NC}"

	# Detect PATH conflicts: if another coderix (bun, brew, etc.) shadows the npm-linked one
	NPM_BIN_DIR=$(npm bin -g 2>/dev/null || echo "")
	RESOLVED_CODERIX=$(command -v coderix 2>/dev/null || echo "")
	if [ -n "$NPM_BIN_DIR" ] && [ -n "$RESOLVED_CODERIX" ] && [ "$RESOLVED_CODERIX" != "$NPM_BIN_DIR/coderix" ]; then
	  echo ""
	  echo -e "${YELLOW}WARNING: Another coderix is shadowing the npm-linked version:${NC}"
	  echo -e "  Resolved:  ${YELLOW}${RESOLVED_CODERIX}${NC}"
	  echo -e "  Expected:  ${NPM_BIN_DIR}/coderix"
	  echo ""
	  echo -e "${YELLOW}Remove the conflicting version to use the latest build:${NC}"
	  echo -e "  rm -f ${RESOLVED_CODERIX}"
	  echo -e "  # Or reorder PATH so ${NPM_BIN_DIR} comes first"
	fi
  fi

  if $DESKTOP_INSTALL; then
    echo ""
    echo -e "${CYAN}Setting up desktop app...${NC}"
    (cd "${REPO_DIR}/packages/coderix-desktop" && pnpm install 2>/dev/null || true)
    echo -e "${GREEN}Desktop app dependencies installed${NC}"
    echo ""
    echo -e "  Launch CLI:     ${YELLOW}npm run dev:cli${NC}"
    echo -e "  Launch Desktop: ${YELLOW}npm run dev:desk${NC}"
  fi

else
  echo -e "${CYAN}coderix from npm registry...${NC}"
  if npm install -g coderix 2>&1; then
    echo -e "${GREEN}coderix installed from npm${NC}"
  else
    echo -e "${YELLOW}npm registry install failed (package may not be published yet).${NC}"
    echo ""
    echo "To install from source:"
    echo "  git clone https://github.com/AgenticMatrix/coderix.git"
    echo "  cd coderix && ./install.sh --local"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 5. Verify installation
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}Verifying installation...${NC}"

if command -v coderix &> /dev/null; then
  CODER_VERSION=$(coderix --version 2>/dev/null || echo "0.1.0")
  echo -e "${GREEN}coderix command available (${CODER_VERSION})${NC}"
else
  echo -e "${YELLOW}coderix command not on PATH yet. Configuring PATH automatically...${NC}"

  SHELL_NAME=$(basename "$SHELL" 2>/dev/null || echo "bash")

  NPM_BIN_DIR=$(npm bin -g 2>/dev/null || echo "")
  if [ -z "$NPM_BIN_DIR" ]; then
    NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "")
    if [ -n "$NPM_PREFIX" ]; then
      NPM_BIN_DIR="${NPM_PREFIX}/bin"
    fi
  fi

  if [ -n "$NPM_BIN_DIR" ] && ! echo "$PATH" | tr ':' '\n' | grep -qxF "$NPM_BIN_DIR"; then
    case "$SHELL_NAME" in
      zsh)
        RC_FILE="$HOME/.zshrc"
        ;;
      bash)
        if [ -f "$HOME/.bash_profile" ]; then
          RC_FILE="$HOME/.bash_profile"
        else
          RC_FILE="$HOME/.bashrc"
        fi
        ;;
      fish)
        RC_FILE="$HOME/.config/fish/config.fish"
        mkdir -p "$(dirname "$RC_FILE")"
        ;;
      *)
        RC_FILE="$HOME/.profile"
        ;;
    esac

    echo "" >> "$RC_FILE"
    echo "# Added by Coderix installer" >> "$RC_FILE"
    echo "export PATH=\"${NPM_BIN_DIR}:\$PATH\"" >> "$RC_FILE"

    export PATH="${NPM_BIN_DIR}:$PATH"

    echo -e "${GREEN}Added ${NPM_BIN_DIR} to PATH in ${RC_FILE}${NC}"
    echo ""
    echo "Run this to apply immediately:"
    echo "  source ${RC_FILE}"

    if command -v coderix &> /dev/null; then
      CODER_VERSION=$(coderix --version 2>/dev/null || echo "0.1.0")
      echo -e "${GREEN}coderix command available (${CODER_VERSION})${NC}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 6. Create configuration directory
# ---------------------------------------------------------------------------
CODERIX_DIR="${HOME}/.coderix"

echo ""
echo -e "${CYAN}Setting up configuration...${NC}"

mkdir -p "${CODERIX_DIR}"
mkdir -p "${CODERIX_DIR}/sessions"
mkdir -p "${CODERIX_DIR}/skills"
mkdir -p "${CODERIX_DIR}/scratchpad"

echo -e "${GREEN}Configuration directory created at ${CODERIX_DIR}${NC}"

# Copy bundled skills (web-bridge, etc.) to ~/.coderix/skills/
if [ -d "${SCRIPT_DIR}/resources/skills" ]; then
  echo ""
  echo -e "${CYAN}Installing bundled skills...${NC}"
  for skill_dir in "${SCRIPT_DIR}/resources/skills"/*/; do
    skill_name=$(basename "${skill_dir}")
    if [ -f "${skill_dir}/SKILL.md" ]; then
      dest_dir="${CODERIX_DIR}/skills/${skill_name}"
      mkdir -p "${dest_dir}"
      # Copy all files from the skill directory
      copied=0
      for src_file in "${skill_dir}"/*; do
        [ -f "$src_file" ] || continue
        fname=$(basename "${src_file}")
        # Don't overwrite user-customized SKILL.md
        if [ "$fname" = "SKILL.md" ] && [ -f "${dest_dir}/${fname}" ]; then
          continue
        fi
        cp "${src_file}" "${dest_dir}/${fname}"
        copied=$((copied + 1))
      done
      echo -e "${GREEN}  + ${skill_name} (${copied} files)${NC}"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 8. Create default settings.json
# ---------------------------------------------------------------------------
SETTINGS_FILE="${CODERIX_DIR}/settings.json"

echo ""
if [ ! -f "$SETTINGS_FILE" ]; then
  cat > "$SETTINGS_FILE" << 'SETTINGS_EOF'
{
  "model_list": [
    {
      "model": ["deepseek-v4-pro"],
      "provider": "deepseek",
      "base_url": "https://api.deepseek.com/anthropic",
      "auth_token_env": "sk-your-api-key-here",
      "max_tokens": 32768
    }
  ],
  "default_model": "deepseek/deepseek-v4-pro"
}
SETTINGS_EOF
  echo -e "${GREEN}Created ${SETTINGS_FILE} with default template${NC}"
  echo ""
  echo -e "${YELLOW}Edit ${SETTINGS_FILE} to configure your API key and model:${NC}"
  echo -e "  - Replace auth_token_env with your API key"
  echo -e "  - Change base_url to your provider's endpoint"
  echo -e "  - Adjust model list and default_model as needed"
else
  echo -e "${GREEN}Existing ${SETTINGS_FILE} found, skipping${NC}"
fi

# ---------------------------------------------------------------------------
# 8. Chrome extension reminder
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}Chrome Extension:${NC}"
echo -e "  To control your existing browser (preserve logins/cookies):"
echo -e "  1. Open ${YELLOW}chrome://extensions/${NC}"
echo -e "  2. Enable ${YELLOW}Developer mode${NC} (toggle top-right)"
echo -e "  3. Click ${YELLOW}Load unpacked${NC}"
echo -e "  4. Select: ${YELLOW}${CODERIX_DIR}/skills/web-bridge/extension/${NC}"
echo ""
echo -e "  Or use CDP mode (no extension needed):"
echo -e "  ${YELLOW}npx tsx ${CODERIX_DIR}/skills/web-bridge/web-bridge-cli.ts --action start-browser${NC}"

# ---------------------------------------------------------------------------
# 9. Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Coderix installation complete!                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Quick Start:${NC}"
echo ""
echo "  # Start CLI interactive session"
echo "  coderix"
echo ""
echo "  # Ask a one-shot question"
echo "  coderix 'Explain this codebase'"
echo ""
if $DESKTOP_INSTALL; then
echo "  # Launch desktop app (dev mode)"
echo "  npm run dev:desk"
echo ""
fi
echo -e "${CYAN}Development:${NC}"
echo "  npm run dev:cli      # CLI dev mode"
echo "  npm run dev:desk     # Electron desktop dev mode"
echo ""
echo -e "${CYAN}Configuration:${NC}"
echo "  ~/.coderix/               — Configuration directory"
echo "  ~/.coderix/settings.json  — Provider & model settings"
echo "  CODERIX.md           — Project-specific instructions"
echo ""
echo -e "${YELLOW}Documentation: https://github.com/AgenticMatrix/Coderix${NC}"
