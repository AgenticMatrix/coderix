import type { LucideIcon } from 'lucide-react';

/**
 * App registry — the list of apps shown in the sidebar's "应用" (Apps) tab.
 *
 * An app = a set of skills + MCP servers + a display page, optionally bound to a
 * plugin agent identity. Attaching an app to a conversation forms a "workspace":
 * the conversation drives the app (via its skills/MCP tools) on the left, and the
 * app's display page renders on the right.
 *
 * This file is now a **dev fallback** — the primary source of truth is the
 * file-based plugin manifest (`~/.coderix/plugins/<name>/plugin.json`), surfaced via
 * `plugins:list` and mapped into cards in `LibraryView.tsx`. Add an app here only
 * for quick local iteration; ship apps as plugin manifests.
 */

import { resolveAppIcon } from './icons';

export type AppDisplayKind = 'cad-viewer' | 'blender-viewer';

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  /** Icon key (mapped to a LucideIcon via `resolveAppIcon`). */
  icon: string;
  /** Skills enabled on the conversation while this app is attached. */
  skills: string[];
  /** MCP servers enabled on a conversation created from this app. */
  mcpServers: string[];
  /** Agent registry key bound to conversations created from this app. */
  agentType?: string;
  display: {
    kind: AppDisplayKind;
  };
}

export { resolveAppIcon };

export const APPS: AppDefinition[] = [
  {
    id: 'cad-harness',
    name: 'CAD Harness',
    description: '对话式 CAD 生成',
    icon: 'boxes',
    skills: ['cad', 'cad-viewer'],
    mcpServers: ['cad-control'],
    agentType: 'cad-harness',
    display: { kind: 'cad-viewer' },
  },
  {
    id: 'blender-harness',
    name: 'Blender Harness',
    description: '对话式 Blender 建模',
    icon: 'blender',
    skills: [],
    mcpServers: ['blender'],
    agentType: 'blender-harness',
    display: { kind: 'blender-viewer' },
  },
];

// Keep the LucideIcon type in scope for consumers that still type icon helpers.
export type { LucideIcon };
