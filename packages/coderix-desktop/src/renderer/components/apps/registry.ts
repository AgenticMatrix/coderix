import { Boxes, type LucideIcon } from 'lucide-react';

/**
 * App registry — the list of apps shown in the sidebar's "应用" (Apps) tab.
 *
 * An app = a set of skills + a display page. Attaching an app to a conversation
 * forms a "workspace": the conversation drives the app (via its skills) on the
 * left, and the app's display page renders on the right.
 *
 * Add an app by appending an entry here; add a matching `display.kind` branch in
 * `AppDisplayPanel.tsx` (and, if it needs a managed process, a manager in `main/`).
 */

export type AppDisplayKind = 'cad-viewer';

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  /** Skills enabled on the conversation while this app is attached. */
  skills: string[];
  display: {
    kind: AppDisplayKind;
  };
}

export const APPS: AppDefinition[] = [
  {
    id: 'cad-harness',
    name: 'CAD Harness',
    description: '对话式 CAD 生成',
    icon: Boxes,
    skills: ['cad', 'cad-viewer'],
    display: { kind: 'cad-viewer' },
  },
];
