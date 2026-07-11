/**
 * TUI Tool Renderer Types
 *
 * React/Ink renderer interfaces for @coderix/cli tool rendering.
 * Separated from @coderix/core which has zero UI dependencies.
 */

import type { ToolPlugin as CoreToolPlugin } from '@coderix/core';
import type React from 'react';

// ── Renderer Props ────────────────────────────────────────────────────

export interface ToolUseRendererProps {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  paramSummary?: string;
  state: 'pending' | 'executing' | 'done' | 'error';
  riskLevel?: 'safe' | 'mutation' | 'destructive';
  permissionState?: 'approved' | 'denied' | 'pending';
  duration?: number;
  expanded?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
  result?: {
    content: string;
    isError: boolean;
    metadata?: Record<string, unknown>;
  };
  contentExpanded?: boolean;
  termWidth?: number;
}

export interface ToolResultRendererProps {
  content: string;
  isError: boolean;
  truncated?: boolean;
  collapseThreshold?: number;
  duration?: number;
  toolName?: string;
  metadata?: Record<string, unknown>;
  contentExpanded?: boolean;
}

// ── Renderer Components ───────────────────────────────────────────────

export type ToolUseRenderer = (props: ToolUseRendererProps) => React.ReactNode;
export type ToolResultRenderer = (props: ToolResultRendererProps) => React.ReactNode;

// ── Extended Plugin (core executor + TUI renderer) ────────────────────

export interface ToolPlugin extends CoreToolPlugin {
  useRenderer?: ToolUseRenderer;
  resultRenderer?: ToolResultRenderer;
}
