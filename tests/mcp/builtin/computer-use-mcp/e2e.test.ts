#!/usr/bin/env npx tsx
/**
 * Computer Use MCP — End-to-End Integration Test
 *
 * Usage:
 *   npx tsx tests/mcp/builtin/computer-use-mcp/e2e.test.ts
 *
 * Connects to coderix --computer-use-mcp subprocess via MCP stdio
 * and calls tools just like a real agent would.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'node:child_process';

// ── Detect binary ────────────────────────────────────────────────────────

// Always use tsx for source TypeScript in dev mode.
const command = 'npx';
const args = ['tsx', 'packages/coderix-cli/src/cli/main.tsx', '--computer-use-mcp'];

// ── Helpers ──────────────────────────────────────────────────────────────

function extractText(result: any): string {
  if (!result?.content) return JSON.stringify(result);
  const texts = result.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  return texts || JSON.stringify(result);
}

function hasImage(result: any): boolean {
  return result?.content?.some((c: any) => c.type === 'image') ?? false;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔧 Computer Use MCP — End-to-End Test\n');

  // Check prerequisites
  const missing: string[] = [];
  for (const tool of ['screencapture', 'cliclick', 'osascript']) {
    try {
      execSync(`which ${tool}`, { stdio: 'pipe' });
    } catch {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    console.log(`⚠️  Missing tools: ${missing.join(', ')}`);
    if (missing.includes('cliclick')) {
      console.log('   Install cliclick: brew install cliclick');
    }
    console.log('   Mouse/keyboard tools will fail without these.\n');
  }

  // Connect to MCP server via stdio
  console.log(`📡 Starting: ${command} ${args.join(' ')}`);
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'cu-e2e-test', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log('✅ Connected to coder-computer-use-mcp\n');

  let passed = 0;
  let failed = 0;

  // ── Step 1: List tools ─────────────────────────────────────────────
  try {
    console.log('📋 1/7  Listing tools...');
    const result = await client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    );
    console.log(`   ✅ ${result.tools.length} tools found`);
    for (const t of result.tools) {
      console.log(`      - ${t.name}`);
    }
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Step 2: request_access ─────────────────────────────────────────
  try {
    console.log('🔑 2/7  Requesting access...');
    const result = await client.callTool(
      {
        name: 'request_access',
        arguments: {
          apps: ['Finder', 'TextEdit', 'Safari'],
          reason: 'E2E testing of Computer Use',
          clipboardRead: true,
          clipboardWrite: true,
        },
      },
      CallToolResultSchema,
    );
    const text = extractText(result);
    console.log(`   ✅ ${text.slice(0, 150)}`);
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Step 3: Screenshot ─────────────────────────────────────────────
  let screenshotHasImage = false;
  try {
    console.log('📸 3/7  Taking screenshot...');
    const result = await client.callTool(
      { name: 'screenshot', arguments: {} },
      CallToolResultSchema,
    );
    screenshotHasImage = hasImage(result);
    const info = extractText(result).slice(0, 200);
    console.log(`   Image: ${screenshotHasImage}`);
    console.log(`   Info: ${info}`);
    console.log(`   ✅ Screenshot captured`);
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Step 4: Cursor position ────────────────────────────────────────
  try {
    console.log('🖱️  4/7  Getting cursor position...');
    const result = await client.callTool(
      { name: 'cursor_position', arguments: {} },
      CallToolResultSchema,
    );
    console.log(`   ✅ ${extractText(result)}`);
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message} (cliclick required)`);
    failed++;
  }
  console.log();

  // ── Step 5: List granted apps ──────────────────────────────────────
  try {
    console.log('📜 5/7  Listing granted applications...');
    const result = await client.callTool(
      { name: 'list_granted_applications', arguments: {} },
      CallToolResultSchema,
    );
    console.log(`   ✅ ${extractText(result)}`);
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Step 6: Wait ────────────────────────────────────────────────────
  try {
    console.log('⏱️  6/7  Testing wait (0.5s)...');
    await client.callTool(
      { name: 'wait', arguments: { duration: 0.5 } },
      CallToolResultSchema,
    );
    console.log('   ✅ Wait completed');
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Step 7: Clipboard ──────────────────────────────────────────────
  try {
    console.log('📋 7/7  Testing clipboard read/write...');
    await client.callTool(
      { name: 'write_clipboard', arguments: { text: 'Hello from Coderix Computer Use MCP!' } },
      CallToolResultSchema,
    );
    const read = await client.callTool(
      { name: 'read_clipboard', arguments: {} },
      CallToolResultSchema,
    );
    const text = extractText(read);
    console.log(`   ✅ Clipboard: "${text.slice(0, 60)}"`);
    passed++;
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
    failed++;
  }
  console.log();

  // ── Summary ────────────────────────────────────────────────────────
  console.log('='.repeat(55));
  console.log(`Results: ${passed} passed, ${failed} failed out of 7 tests`);
  if (failed === 0) {
    console.log('🎉 All Computer Use MCP tools working!');
  } else {
    console.log('⚠️  Some tools failed. Check prerequisites above.');
  }
  console.log('='.repeat(55));

  await client.close();
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
