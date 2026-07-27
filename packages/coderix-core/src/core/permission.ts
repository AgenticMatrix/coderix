/**
 * PermissionEngine — Plan / Ask / Auto permission system with optional rule engine.
 *
 * In AUTO mode everything is auto-approved.
 * In PLAN mode, only SAFE operations are approved; everything else is denied.
 * In ASK mode, ALL operations require user confirmation.
 * In LOW mode, SAFE auto-approved, MUTATION/DESTRUCTIVE prompt the user.
 *
 * Optional PermissionRuleEngine integration: when rules are configured,
 * they are evaluated BEFORE the mode-based check. Rules can override
 * mode behavior per-tool or per-command-content (e.g., "always deny Bash(rm:*)")
 */

import {
  PermissionMode,
  RiskLevel,
} from './types.js';
import type { ToolDefinition } from './types.js';
import {
  PermissionRuleEngine,
  type PermissionRule,
  type PermissionRuleResult,
  type PermissionBehavior,
} from './permission-rules.js';

// ── Permission check types ──────────────────────────────────────────

export interface PermissionCheck {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: RiskLevel;
}

export interface PermissionResult {
  allowed: boolean;
  behavior: 'approve' | 'deny' | 'ask_user';
  reason?: {
    type: string;
    rule?: PermissionRule;
    mode?: string;
    riskLevel?: string;
    matchedPattern?: string;
  };
  prompt?: string;
}

// ── PermissionEngine ────────────────────────────────────────────────

/**
 * Extract the primary content field from a tool input for use as
 * a permission rule pattern (ruleContent).
 *
 * Returns undefined if the tool has no extractable content (tool-wide rule).
 */
export function extractRuleContent(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  switch (toolName.toLowerCase()) {
    case 'bash':
      return input.command as string | undefined;
    case 'write':
    case 'read':
    case 'notebookedit':
      return input.file_path as string | undefined;
    case 'webfetch':
    case 'websearch': {
      const url = (input.url as string) ?? '';
      try {
        return `domain:${new URL(url).hostname}`;
      } catch {
        return url || undefined;
      }
    }
    default:
      return undefined;
  }
}

export class PermissionEngine {
  private mode: PermissionMode = PermissionMode.ASK;
  private cwd: string;
  private ruleEngine: PermissionRuleEngine;

  constructor(cwd: string, initialRules?: PermissionRule[]) {
    this.cwd = cwd;
    this.ruleEngine = new PermissionRuleEngine(initialRules);
  }

  // ── Mode management ──────────────────────────────────────────────

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  getCwd(): string {
    return this.cwd;
  }

  // ── Rule management ──────────────────────────────────────────────

  /** Add a permission rule to the rule engine. */
  addPermissionRule(rule: PermissionRule): void {
    this.ruleEngine.addRule(rule);
  }

  /** Remove a permission rule by tool name and optional content pattern. */
  removePermissionRule(toolName: string, ruleContent?: string): void {
    this.ruleEngine.removeRule(toolName, ruleContent);
  }

  /** Get all registered permission rules. */
  getPermissionRules(): PermissionRule[] {
    return this.ruleEngine.getRules();
  }

  // ── Permission check ─────────────────────────────────────────────

  /**
   * Check if a tool operation is allowed under the current permission mode.
   *
   * Flow:
   * 1. If a commandContent is provided AND the rule engine has matching rules,
   *    the rule result takes priority (overriding mode behavior).
   * 2. Otherwise, fall back to mode-based check.
   *
   * @param permission - The permission check request
   * @param _toolDef - Optional tool definition (unused currently, reserved for future)
   * @param commandContent - Optional command content for bash command-aware rules
   */
  async check(
    permission: PermissionCheck,
    _toolDef?: ToolDefinition,
    commandContent?: string,
  ): Promise<PermissionResult> {
    // ── 1. Rule engine check (explicit rules override mode) ──────
    if (commandContent || this.ruleEngine.getRules().some(
      r => r.toolName.toLowerCase() === permission.toolName.toLowerCase(),
    )) {
      const ruleResult = this.ruleEngine.evaluate(
        permission.toolName,
        commandContent,
      );

      if (ruleResult) {
        return this._convertRuleResult(ruleResult);
      }
    }

    // ── 2. Mode-based fallback ───────────────────────────────────
    return this._modeCheck(permission);
  }

  // ── Private methods ──────────────────────────────────────────────

  private _convertRuleResult(ruleResult: PermissionRuleResult): PermissionResult {
    return {
      allowed: ruleResult.allowed,
      behavior: ruleResult.behavior,
      reason: ruleResult.reason
        ? {
            type: ruleResult.reason.type,
            rule: ruleResult.reason.type === 'rule_match'
              ? ruleResult.reason.rule
              : undefined,
            matchedPattern: ruleResult.reason.type === 'rule_match'
              ? ruleResult.reason.matchedPattern
              : undefined,
          }
        : undefined,
      prompt: ruleResult.prompt,
    };
  }

  private _modeCheck(permission: PermissionCheck): PermissionResult {
    // AUTO mode: auto-approve everything
    if (this.mode === PermissionMode.AUTO) {
      return { allowed: true, behavior: 'approve', reason: { type: 'mode_default', mode: 'auto' } };
    }

    // PLAN mode: approve safe tools, Write (gated at executor level to only
    // allow the plans directory), ExitPlanMode (user approval is handled
    // by the dedicated dialog in query.ts), and Agent (plan mode needs
    // sub-agents for exploration and planning).
    if (this.mode === PermissionMode.PLAN) {
      if (permission.riskLevel === RiskLevel.SAFE || permission.toolName === 'write' || permission.toolName === 'ExitPlanMode' || permission.toolName === 'Agent') {
        return { allowed: true, behavior: 'approve', reason: { type: 'mode_default', mode: 'plan' } };
      }
      return {
        allowed: false,
        behavior: 'deny',
        reason: { type: 'mode_default', mode: 'plan' },
        prompt: `Plan mode: ${permission.toolName} requires approval`,
      };
    }

    // ASK mode: require confirmation for ALL operations
    if (this.mode === PermissionMode.ASK) {
      return {
        allowed: false,
        behavior: 'ask_user',
        reason: { type: 'mode_default', mode: 'ask' },
        prompt: `Allow ${permission.toolName}?`,
      };
    }

    // LOW mode: auto-approve safe, ask for mutation/destructive
    if (this.mode === PermissionMode.LOW) {
      if (permission.riskLevel === RiskLevel.SAFE) {
        return { allowed: true, behavior: 'approve', reason: { type: 'mode_default', mode: 'low' } };
      }
      return {
        allowed: false,
        behavior: 'ask_user',
        reason: { type: 'mode_default', mode: 'low' },
        prompt: `Allow ${permission.toolName} (${permission.riskLevel})?`,
      };
    }

    // Fallback: unrecognized mode — default to ASK for safety
    // (Never silently approve everything)
    return {
      allowed: false,
      behavior: 'ask_user',
      reason: { type: 'mode_default', mode: 'default' },
      prompt: `Allow ${permission.toolName}?`,
    };
  }
}
