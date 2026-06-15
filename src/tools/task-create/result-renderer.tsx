import React from 'react';
import type { ToolResultRendererProps } from '../types.js';

/**
 * TaskCreate results are rendered inline in the tool-use block.
 * This result renderer suppresses the separate tool_result block.
 */
export function TaskCreateResultRenderer(_props: ToolResultRendererProps): React.ReactNode {
  return null;
}
