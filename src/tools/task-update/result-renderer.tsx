import React from 'react';
import type { ToolResultRendererProps } from '../types.js';

/**
 * TaskUpdate results are rendered inline in the tool-use block.
 * This result renderer suppresses the separate tool_result block.
 */
export function TaskUpdateResultRenderer(_props: ToolResultRendererProps): React.ReactNode {
  return null;
}
