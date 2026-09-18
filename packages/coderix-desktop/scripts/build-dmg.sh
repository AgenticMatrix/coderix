#!/usr/bin/env bash
#
# Coderix Desktop — 一键打包 DMG（含防破解处理）
#
# 产出：
#   packages/coderix-desktop/release/Coderix-<ver>-universal.dmg
#
# 流程：
#   electron-vite build → 主进程字节码化(bytenode) → 渲染层混淆(javascript-obfuscator)
#   → 生成 icon.icns → electron-builder 打包（universal / 未签名 / asar 开启）
#
# 用法：
#   bash packages/coderix-desktop/scripts/build-dmg.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
cd "$DESKTOP_DIR"

BUILD_DIR="$DESKTOP_DIR/.build-dmg"
ESBUILDER="$DESKTOP_DIR/node_modules/.bin/electron-builder"
VITE="$DESKTOP_DIR/node_modules/.bin/electron-vite"
# Bun 用于把 @coderix/cli 编译为原生可执行文件（随 .app 分发，首次启动自动安装到 PATH）。
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

# ---------- 输出辅助 ----------
c_blue=$'\033[1;36m'
c_green=$'\033[1;32m'
c_red=$'\033[1;31m'
c_reset=$'\033[0m'

log() { printf '\n%s==>%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()  { printf '%s  ✓%s %s\n' "$c_green" "$c_reset" "$*"; }
die() { printf '%sERROR:%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

# ---------- 预检 ----------
log "预检环境"
command -v node     >/dev/null 2>&1 || die "未找到 node"
command -v pnpm     >/dev/null 2>&1 || die "未找到 pnpm"
command -v sips     >/dev/null 2>&1 || die "未找到 sips"
command -v iconutil >/dev/null 2>&1 || die "未找到 iconutil"
[ -x "$BUN" ]       || die "未找到 bun（CLI 编译需要，安装：https://bun.sh）"
[ -x "$VITE" ]      || die "未找到 electron-vite（请先 pnpm install）"
[ -x "$ESBUILDER" ] || die "未找到 electron-builder（请先 pnpm install）"
node -e "require('bytenode')"                     >/dev/null 2>&1 || die "未找到 bytenode（请先 pnpm install）"
node -e "require('javascript-obfuscator')"        >/dev/null 2>&1 || die "未找到 javascript-obfuscator（请先 pnpm install）"
ELECTRON_BIN="$(node -p "require('electron')" 2>/dev/null)" || die "未找到 electron"
[ -f "$ELECTRON_BIN" ] || die "electron 二进制不存在：$ELECTRON_BIN"
ok "node $(node -v) · pnpm $(pnpm -v) · electron $(node -p "require('electron/package.json').version")"

# ---------- 1. 构建前端 + 主进程 + preload ----------
log "构建应用（electron-vite build）"
"$VITE" build
[ -f "$DESKTOP_DIR/dist/main/index.cjs" ] || die "构建失败：未生成 dist/main/index.cjs"
[ -f "$DESKTOP_DIR/dist/renderer/index.html" ] || die "构建失败：未生成 dist/renderer/index.html"
ok "dist 已生成"

# ---------- 2. 主进程字节码化（bytenode） ----------
log "主进程字节码化（bytenode / electronMain）"
node "$SCRIPT_DIR/compile-bytecode.mjs"
ok "主进程已编译为 V8 字节码"

# ---------- 3. 渲染层混淆（javascript-obfuscator） ----------
log "渲染层混淆（javascript-obfuscator）"
NODE_OPTIONS="--max-old-space-size=8192" node "$SCRIPT_DIR/obfuscate-renderer.mjs"
ok "渲染层已混淆"

# ---------- 4. 生成 icon.icns ----------
log "生成 icon.icns"
ICON_PNG="$DESKTOP_DIR/assets/icon.png"
ICNS="$DESKTOP_DIR/assets/icon.icns"
# 图标源为「闪电」logo 的正方形 PNG；缺失时用 gen-icon.py 重新生成（需 python3 + Pillow）。
if [ ! -f "$ICON_PNG" ]; then
  command -v python3 >/dev/null 2>&1 || die "缺少 assets/icon.png，且未找到 python3（可手动运行 scripts/gen-icon.py 生成）"
  python3 "$SCRIPT_DIR/gen-icon.py"
fi
[ -f "$ICON_PNG" ] || die "图标源图不存在：$ICON_PNG"
ICONSET="$BUILD_DIR/icon.iconset"
mkdir -p "$DESKTOP_DIR/assets" "$ICONSET"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done
for s in 32 64 256 512; do
  b=$((s/2))
  sips -z "$s" "$s" "$ICON_PNG" --out "$ICONSET/icon_${b}x${b}@2x.png" >/dev/null
done
sips -z 1024 1024 "$ICON_PNG" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$ICNS"
ok "icon.icns 已生成"

# ---------- 4b. 编译 coderix CLI 为原生可执行文件（Bun） ----------
# 分别产出 arm64 与 x64 两个 Mach-O 单架构二进制，随 .app 一起分发；
# 首次启动时由主进程按 process.arch 选择对应 slice 建立 /usr/local/bin 等处的
# 符号链接。不在此处 lipo 合并：Bun 编译产物体量较大，lipo 在受限环境易 OOM，
# 且双二进制让安装逻辑无需依赖 fat-binary 处理。
log "编译 coderix CLI（Bun → 原生可执行，arm64 + x64）"
CLI_BUILD_DIR="$BUILD_DIR/cli"
mkdir -p "$CLI_BUILD_DIR"
CLI_ENTRY="$ROOT/packages/coderix-cli/src/cli/main.tsx"
[ -f "$CLI_ENTRY" ] || die "未找到 CLI 入口：$CLI_ENTRY"
( cd "$ROOT" && "$BUN" build --compile --minify --target=bun-darwin-arm64 --outfile "$CLI_BUILD_DIR/coderix-arm64" "$CLI_ENTRY" )
( cd "$ROOT" && "$BUN" build --compile --minify --target=bun-darwin-x64   --outfile "$CLI_BUILD_DIR/coderix-x64"   "$CLI_ENTRY" )
chmod +x "$CLI_BUILD_DIR/coderix-arm64" "$CLI_BUILD_DIR/coderix-x64"
ok "coderix CLI 已编译（arm64 + x64）"

# ---------- 5. 组装自包含 staging（规避 pnpm 工作区符号链接） ----------
log "组装 staging（自包含 node_modules）"
STAGING="$BUILD_DIR/staging"
rm -rf "$STAGING"
mkdir -p "$STAGING/node_modules"

cp -R "$DESKTOP_DIR/dist"   "$STAGING/dist"
cp -R "$DESKTOP_DIR/assets" "$STAGING/assets"
cp "$DESKTOP_DIR/electron-builder.yml" "$STAGING/electron-builder.yml"
# CLI 原生二进制（extraResources → Contents/Resources/cli/）
cp -R "$CLI_BUILD_DIR" "$STAGING/cli"
# 首次启动引导所需：bundled skills + 默认 settings.json（extraResources）
[ -d "$ROOT/resources/skills" ] && cp -R "$ROOT/resources/skills" "$STAGING/skills"
mkdir -p "$STAGING/config"
[ -f "$ROOT/config/default_settings.json" ] && cp "$ROOT/config/default_settings.json" "$STAGING/default_settings.json"

# 精简 package.json：只保留入口与运行时外部依赖，去除 workspace/已打包依赖，
# 避免 electron-builder 沿 node_modules 符号链接收集到包目录之外。
# electron-builder 只收集 dependencies 里列出的 node_modules，故必须显式列出
# 运行时真正需要的 bytenode 与 node-pty。
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  const p = {
    name: pkg.name,
    // 关键：打包产物必须带 productName，否则 app.getName() 回落到 "@coderix/desktop"，
    // userData 会与 `pnpm dev` 的开发实例共用 (~/Library/Application Support/@coderix/desktop)，
    // 导致单实例锁冲突，打包版一启动就 app.quit()。
    productName: "Coderix",
    version: pkg.version,
    main: "dist/main/index.cjs",
    dependencies: {
      bytenode: pkg.dependencies.bytenode,
      "node-pty": pkg.dependencies["node-pty"],
    },
  };
  fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 2));
' "$DESKTOP_DIR/package.json" "$STAGING/package.json"

# 物化为真实目录（自包含）。
cp -RL "$DESKTOP_DIR/node_modules/bytenode"  "$STAGING/node_modules/bytenode"
cp -RL "$DESKTOP_DIR/node_modules/node-pty"  "$STAGING/node_modules/node-pty"
# node-pty 声明了 node-addon-api（仅构建期头文件，但 electron-builder 会收集它）。
NODE_ADDON_API="$(ls -d "$ROOT/node_modules/.pnpm/node-addon-api@7"*/node_modules/node-addon-api 2>/dev/null | head -1)"
[ -d "$NODE_ADDON_API" ] && cp -RL "$NODE_ADDON_API" "$STAGING/node_modules/node-addon-api"
ok "staging 就绪"

# ---------- 6. electron-builder 打包（universal / 未签名） ----------
log "electron-builder 打包（dmg，universal，未签名）"
# 国内网络环境从 npmmirror 下载 Electron，避免 GitHub 直连超时/损坏缓存。
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
( cd "$STAGING" && CSC_IDENTITY_AUTO_DISCOVERY=false "$ESBUILDER" --mac dmg --universal )

mkdir -p "$DESKTOP_DIR/release"
cp -f "$STAGING"/release/*.dmg "$DESKTOP_DIR/release/" 2>/dev/null || true
cp -f "$STAGING"/release/*.zip "$DESKTOP_DIR/release/" 2>/dev/null || true

# ---------- 汇总 ----------
echo
printf '%s========== 完成 ==========%s\n' "$c_green" "$c_reset"
# 只打 dmg 目标时没有 *.zip，ls 会因 *.zip 不匹配返回非零，导致 set -e 误报失败；加 || true 兜底。
ls -lh "$DESKTOP_DIR/release"/*.dmg "$DESKTOP_DIR/release"/*.zip 2>/dev/null | awk '{print "  "$5"  "$9}' || true
echo
echo "产物目录：$DESKTOP_DIR/release"
echo "验证：双击 .dmg，把 Coderix.app 拖入 /Applications 后运行"
