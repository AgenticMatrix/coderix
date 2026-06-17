#!/usr/bin/env node
/**
 * 测试脚本：记录所有工具调用到日志
 *
 * 用法：在 .coder/hooks.json 中配置
 * {
 *   "hooks": [{
 *     "event": "PostToolUse",
 *     "command": "node /path/to/tool-logger.js"
 *   }]
 * }
 */
const { appendFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const logDir = join(homedir(), '.coder', 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const ctx = JSON.parse(Buffer.concat(chunks).toString());
  const { toolName, isError, timestamp } = ctx;

  const log = JSON.stringify({
    time: new Date(timestamp).toISOString(),
    tool: toolName,
    status: isError ? 'FAIL' : 'OK',
  });

  appendFileSync(join(logDir, 'tool-usage.log'), log + '\n');
  process.stdout.write(JSON.stringify({}));
});
