import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute, setPreExecSecurityCheck } from './executor.js';
import { BashRenderer } from './renderer.js';
import { createBashSecurityCheck } from './security-check.js';

// ── Install security check hook at plugin load time ──────────────────
// This must happen before any commands are executed. The security check
// blocks dangerous commands (code exec, destructive ops, network exfil)
// and classifies read-only commands for dynamic concurrency safety.
setPreExecSecurityCheck(createBashSecurityCheck());

const bashPlugin: ToolPlugin = {
  name: 'bash',
  schema,
  executor: execute,
  useRenderer: BashRenderer,
  paramSummary: (input) => {
    const cmd = input.command as string;
    if (!cmd) return undefined;
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  },
};

export default bashPlugin;
