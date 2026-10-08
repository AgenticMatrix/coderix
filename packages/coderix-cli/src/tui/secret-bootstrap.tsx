/**
 * Startup secret collection for MCP servers.
 *
 * MCP is initialized before the main TUI mounts, so servers that declare
 * `secretEnv` entries with no stored/ambient value are collected here first, in
 * a small standalone ink prompt. Values go to ~/.coderix/mcp/secrets.json and
 * are merged into the server's env at connect time.
 */

import React, { useState } from 'react';
import { renderSync } from '@coderix/tui';
import { loadEnabledMcpConfigs, getSecret, setSecret } from '@coderix/core';
import { SecretPrompt } from './components/SecretPrompt.js';

interface MissingSecret {
  server: string;
  envVar: string;
}

/** Enabled stdio servers whose declared secrets are missing from store + env. */
function collectMissingSecrets(cwd: string): MissingSecret[] {
  const configs = loadEnabledMcpConfigs(cwd);
  const missing: MissingSecret[] = [];

  for (const [server, config] of Object.entries(configs)) {
    if (!('command' in config)) continue;
    for (const envVar of config.secretEnv ?? []) {
      if (process.env[envVar]) continue;
      if (getSecret(server, envVar)) continue;
      missing.push({ server, envVar });
    }
  }
  return missing;
}

function SecretBootstrap({
  missing,
  onDone,
}: {
  missing: MissingSecret[];
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const current = missing[index]!;

  const advance = () => {
    if (index + 1 >= missing.length) onDone();
    else setIndex(index + 1);
  };

  return (
    <SecretPrompt
      server={current.server}
      envVar={current.envVar}
      progress={{ index: index + 1, total: missing.length }}
      onSubmit={(value) => {
        setSecret(current.server, current.envVar, value);
        advance();
      }}
      onSkip={advance}
    />
  );
}

/**
 * Prompt for any missing MCP secrets. No-op when nothing is missing. In a
 * non-interactive session it logs a hint instead of prompting.
 */
export async function promptForMissingSecrets(cwd: string): Promise<void> {
  const missing = collectMissingSecrets(cwd);
  if (missing.length === 0) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const list = missing.map((m) => `${m.server}.${m.envVar}`).join(', ');
    process.stderr.write(
      `[MCP] Missing secrets: ${list} — export the env vars or add them to ~/.coderix/mcp/secrets.json\n`,
    );
    return;
  }

  await new Promise<void>((resolve) => {
    let unmount: (() => void) | undefined;
    const instance = renderSync(
      <SecretBootstrap
        missing={missing}
        onDone={() => {
          unmount?.();
          resolve();
        }}
      />,
    );
    unmount = instance.unmount;
  });
}
