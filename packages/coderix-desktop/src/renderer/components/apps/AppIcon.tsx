import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * AppIcon — renders a plugin's icon, which is either a LucideIcon (vector) or an
 * image source string (data URI / URL, e.g. Blender's own app icon) returned by
 * `resolveAppIcon`.
 */
export function AppIcon({
  icon,
  size = 20,
}: {
  icon: LucideIcon | string;
  size?: number;
}): React.ReactElement {
  if (typeof icon === 'string') {
    return <img src={icon} alt="" className="w-full h-full object-cover" />;
  }
  const Icon = icon;
  return <Icon size={size} />;
}

AppIcon.displayName = 'AppIcon';
