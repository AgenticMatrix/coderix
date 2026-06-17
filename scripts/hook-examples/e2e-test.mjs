#!/usr/bin/env node
/**
 * 端到端 Hook 验证脚本
 *
 * 不启动完整 CoderAgent，直接加载真实的 HookManager 类，
 * 用 .coder/hooks.json 配置跑完整链路，验证结果。
 *
 * 用法：
 *   cd CoderAgent
 *   node scripts/hook-examples/e2e-test.mjs
 */

import { existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const HOOKS_FILE = join(PROJECT_ROOT, '.coder', 'hooks.json');
const SRC_HOOKS = join(PROJECT_ROOT, 'src', 'hooks', 'manager.ts');

// ── 清理旧配置 ──
if (existsSync(HOOKS_FILE)) rmSync(HOOKS_FILE);

console.log('🔧 创建测试 .coder/hooks.json ...\n');
if (!existsSync(dirname(HOOKS_FILE))) mkdirSync(dirname(HOOKS_FILE), { recursive: true });

writeFileSync(HOOKS_FILE, JSON.stringify({
  hooks: [
    {
      event: 'PreToolUse',
      command: `node ${join(__dirname, 'security-check.cjs')}`,
      match: { toolName: 'Bash' },
    },
    {
      event: 'PostToolUse',
      command: `node ${join(__dirname, 'tool-logger.cjs')}`,
    },
  ],
}, null, 2));

// ── 动态导入 HookManager ──
const { HookManager } = await import(SRC_HOOKS);

const mgr = new HookManager({
  autoLoad: true, // 读取刚创建的 .coder/hooks.json
});

console.log('📋 已加载 hooks:', mgr['loader'].totalCount());

// ═══════════════════════════════════════════════════════════════
// 测试 1: 安全命令 — 应该通过
// ═══════════════════════════════════════════════════════════════
console.log('\n--- 测试 1: 安全命令 "ls -la" ---');
const r1 = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'ls -la' });
console.log('  期望: blocked=false');
console.log('  实际:', JSON.stringify(r1));
console.log(r1.blocked === false ? '  ✅ 通过' : '  ❌ 失败');

// ═══════════════════════════════════════════════════════════════
// 测试 2: 危险命令 — 应该被拦截
// ═══════════════════════════════════════════════════════════════
console.log('\n--- 测试 2: 危险命令 "rm -rf /" ---');
const r2 = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'rm -rf /' });
console.log('  期望: blocked=true');
console.log('  实际:', JSON.stringify(r2));
console.log(r2.blocked === true ? '  ✅ 通过' : '  ❌ 失败');

// ═══════════════════════════════════════════════════════════════
// 测试 3: Read 工具不匹配 Bash filter — 应该跳过
// ═══════════════════════════════════════════════════════════════
console.log('\n--- 测试 3: Read 工具（不匹配 Bash filter）---');
const r3 = await mgr.onPreToolUse('s1', '/tmp', 'Read', { file_path: '/etc/passwd' });
console.log('  期望: blocked=false（filter 不匹配）');
console.log('  实际:', JSON.stringify(r3));
console.log(r3.blocked === false ? '  ✅ 通过' : '  ❌ 失败');

// ═══════════════════════════════════════════════════════════════
// 测试 4: PostToolUse 触发 logger
// ═══════════════════════════════════════════════════════════════
console.log('\n--- 测试 4: PostToolUse 触发日志 ---');
await mgr.onPostToolUse('s1', '/tmp', 'Bash', { command: 'ls' }, { output: 'file1 file2', success: true }, true, 100);
const logDir = join(process.env.HOME, '.coder', 'logs', 'tool-usage.log');
if (existsSync(logDir)) {
  console.log('  ✅ 日志文件已创建:', logDir);
} else {
  console.log('  ⚠️  日志文件未找到（可能在非 home 目录运行）');
}

// ═══════════════════════════════════════════════════════════════
// 测试 5: Fail-open — 配置一个不存在的脚本，不应崩溃
// ═══════════════════════════════════════════════════════════════
console.log('\n--- 测试 5: Fail-open（不存在的脚本）---');
writeFileSync(HOOKS_FILE, JSON.stringify({
  hooks: [{
    event: 'PreToolUse',
    command: '/nonexistent/script',
  }],
}, null, 2));
mgr.reload();

const r5 = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'ls' });
console.log('  期望: blocked=false（脚本不存在，fail-open）');
console.log('  实际:', JSON.stringify(r5));
console.log(r5.blocked === false ? '  ✅ 通过' : '  ❌ 失败');

// ── 清理 ──
rmSync(HOOKS_FILE);
console.log('\n🧹 已清理测试配置\n');
