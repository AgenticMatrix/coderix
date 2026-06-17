#!/usr/bin/env node
/**
 * 测试脚本：拦截 rm -rf 命令
 *
 * 用法：将此文件放在任意位置，在 .coder/hooks.json 中配置
 *
 * {
 *   "hooks": [{
 *     "event": "PreToolUse",
 *     "command": "node /path/to/security-check.js",
 *     "match": { "toolName": "Bash" }
 *   }]
 * }
 */
const { readFileSync } = require('fs');

// 读取 stdin 中的 JSON 上下文
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const ctx = JSON.parse(Buffer.concat(chunks).toString());
  const { toolName, toolInput } = ctx;

  const cmd = String(toolInput?.command ?? '');

  // 危险命令黑名单
  const dangerous = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf .',
    'sudo rm',
    'mkfs.',
    ':(){ :|:& };:',   // fork bomb
    '> /dev/sda',
  ];

  const blocked = dangerous.some((d) => cmd.includes(d));

  if (blocked) {
    process.stdout.write(JSON.stringify({
      blocked: true,
      reason: `🚫 拦截危险命令: "${cmd}"`,
    }));
  } else {
    process.stdout.write(JSON.stringify({ blocked: false }));
  }
});
