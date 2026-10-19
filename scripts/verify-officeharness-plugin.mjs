#!/usr/bin/env node
/**
 * verify-officeharness-plugin — local smoke test for the bundled plugin.
 *
 * 1. Validate the four files managed-host.cjs hashes before launching.
 * 2. Start/reuse the managed host through the plugin's own lifecycle module.
 * 3. Fetch `/` and `/capabilities` and assert the workspace is served with a
 *    token and the expected host protocol.
 * 4. Release the preview lease and stop only the host this script started.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const PLUGIN = process.env.OFFICEHARNESS_PLUGIN_DIR ?? path.join(HOME, 'Documents', 'apps', 'OfficeHarness', 'officeharness_plugins', 'office-harness');
const PROFILE = process.env.OFFICEHARNESS_PROFILE_DIR ?? path.join(HOME, '.coderix', 'officeharness', 'embedded');
const ASSETS = path.join(PLUGIN, 'host', 'assets');
const requireCjs = createRequire(import.meta.url);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function verifyInventory() {
  const inventory = JSON.parse(readFileSync(path.join(PLUGIN, 'PACKAGE-FILES.json'), 'utf8'));
  for (const name of ['runtime/bin/node', 'host/managed-service.cjs', 'host/managed-host.cjs', 'host/host.cjs']) {
    const entries = inventory.files.filter((entry) => entry.path === name);
    if (entries.length !== 1) {
      fail(`inventory entry ${name}`);
      continue;
    }
    const file = path.join(PLUGIN, name);
    const bytes = readFileSync(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = entries[0];
    const ok = existsSync(file) && bytes.length === entry.bytes && sha256 === entry.sha256;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
    if (!ok) fail(`hash/mode mismatch ${name}`);
  }
}

async function main() {
  if (!existsSync(path.join(PLUGIN, 'plugin.json'))) throw new Error(`plugin not found: ${PLUGIN}`);
  verifyInventory();

  const { ensureHost, attachClient } = requireCjs(path.join(PLUGIN, 'host', 'managed-host.cjs'));
  const service = await ensureHost({
    profile: PROFILE,
    root: ASSETS,
    packageRoot: PLUGIN,
    port: 0,
    idleGraceMs: 120_000,
  });
  const lease = await attachClient({ profile: PROFILE, root: ASSETS, service, kind: 'preview' });
  console.log(`OK   host ${service.url} (pid ${service.pid}, started ${service.started})`);

  try {
    const metadata = JSON.parse(readFileSync(path.join(PROFILE, 'connection.json'), 'utf8'));
    const token = readFileSync(metadata.tokenFile, 'utf8').trim();
    const index = await fetch(`${service.url}/`);
    const html = await index.text();
    const hasToken = html.includes('window.OFFICE_TOKEN="') && html.includes('office-engine-frame');
    console.log(`${index.ok && hasToken ? 'OK  ' : 'FAIL'} workspace index (${index.status}, token=${hasToken})`);
    if (!index.ok || !hasToken) fail('workspace index');

    const capabilities = await fetch(`${service.url}/capabilities`, {
      headers: { 'X-OfficeHarness-Token': token },
    });
    const body = await capabilities.json();
    const protocolOk = capabilities.ok && body.protocol?.name === 'officeharness-host' && body.protocol?.version === 1;
    console.log(`${protocolOk ? 'OK  ' : 'FAIL'} capabilities (${capabilities.status}, tools=${body.tools?.length ?? 0})`);
    if (!protocolOk) fail('capabilities');

    const status = await fetch(`${service.url}/status`, {
      headers: { 'X-OfficeHarness-Token': token },
    });
    const statusBody = await status.json();
    const statusOk = status.ok && typeof statusBody === 'object' && typeof statusBody.online === 'boolean';
    console.log(`${statusOk ? 'OK  ' : 'FAIL'} status (${status.status}, online=${statusBody.online})`);
    if (!statusOk) fail('status');
  } finally {
    await lease.release().catch(() => {});
    if (service.started) {
      try {
        process.kill(service.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
