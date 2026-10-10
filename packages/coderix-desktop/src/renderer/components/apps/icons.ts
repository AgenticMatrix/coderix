import { Boxes, type LucideIcon } from 'lucide-react';

/**
 * App icon map — resolves a plugin manifest's `icon` key to a LucideIcon.
 * Unknown keys fall back to `Boxes`.
 */

const APP_ICONS: Record<string, LucideIcon> = {
  boxes: Boxes,
  cad: Boxes,
  'cad-harness': Boxes,
};

export function resolveAppIcon(key: string | null | undefined): LucideIcon {
  if (!key) return Boxes;
  return APP_ICONS[key] ?? Boxes;
}
