import { render } from 'ink';
import type { Instance, RenderOptions } from 'ink';
import type { ReactNode } from 'react';

export type { Instance, RenderOptions } from 'ink';

/**
 * Mount a component and render it to the terminal. Wraps `ink`'s `render`,
 * which returns the instance synchronously (hence "sync").
 */
export function renderSync(node: ReactNode, options?: RenderOptions): Instance {
  return render(node, options);
}
