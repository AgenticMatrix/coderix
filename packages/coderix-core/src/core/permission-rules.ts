/**
 * Permission rule engine for content-aware allow/deny/ask rules.
 *
 * Supports rule matching with command-content patterns:
 * - Exact match: `Bash` matches the Bash tool (no content restriction)
 * - Exact command match: `Bash(ls)` matches only `ls`
 * - Prefix wildcard match: `Bash(git:*)` matches any command starting with `git `
 * - Glob-style match: `Bash(git *log*)` matches commands containing `log` after `git`
 *
 * Rule precedence: deny > ask > allow.
 * Source priority: cliArg > policySettings > userSettings > projectSettings.
 * Within the same source, more specific rules (with content) override less specific ones.
 */

// ── Types ───────────────────────────────────────────────────────────

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'policySettings'
  | 'cliArg'
  | 'session';

export interface PermissionRule {
  /** Exact tool name, e.g. 'bash', 'write' */
  toolName: string;
  /** Optional command pattern, e.g. 'git push:*', 'npm run test' */
  ruleContent?: string;
  behavior: PermissionBehavior;
  source: PermissionRuleSource;
  /** Human-readable description for the rule */
  description?: string;
}

export type PermissionDecisionReason =
  | { type: 'rule_match'; rule: PermissionRule; matchedPattern?: string }
  | { type: 'mode_default'; mode: string }
  | { type: 'risk_level'; riskLevel: string }
  | { type: 'classification'; category: string; isReadOnly: boolean };

export interface PermissionRuleResult {
  allowed: boolean;
  behavior: 'approve' | 'deny' | 'ask_user';
  reason?: PermissionDecisionReason;
  prompt?: string;
}

// ── Source priorities ───────────────────────────────────────────────

/** Higher index = higher priority for rule conflict resolution. */
const SOURCE_PRIORITY: Record<PermissionRuleSource, number> = {
  session: 0,
  projectSettings: 1,
  userSettings: 2,
  policySettings: 3,
  cliArg: 4,
};

/** Behavior priority: deny > ask > allow. */
const BEHAVIOR_PRIORITY: Record<PermissionBehavior, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

// ── Rule matching ───────────────────────────────────────────────────

/**
 * Check if a rule matches a given tool name and optional command content.
 *
 * Matching logic (most specific wins):
 * 1. No ruleContent → matches all commands for this tool
 * 2. Exact command: `Bash(ls)` matches `ls` exactly
 * 3. Prefix wildcard: `Bash(git:*)` matches any command starting with `git `
 * 4. Glob wildcard: `Bash(git *log*)` matches via glob-like pattern
 */
function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  commandContent?: string,
): boolean {
  // Tool name must match (case-insensitive)
  if (rule.toolName.toLowerCase() !== toolName.toLowerCase()) {
    return false;
  }

  // No content restriction: matches any command for this tool
  if (!rule.ruleContent) {
    return true;
  }

  // No command content: can't match a content-specific rule
  if (!commandContent) {
    return false;
  }

  const pattern = rule.ruleContent;
  const content = commandContent.trim();

  // Exact match
  if (pattern === content) {
    return true;
  }

  // Prefix wildcard: "git:*" or "git :*" matches any command starting with "git "
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trimEnd();
    if (content === prefix) return true;
    if (content.startsWith(prefix + ' ')) return true;
  }

  // Trailing *: "git *" matches any command starting with "git "
  if (pattern.endsWith('*') && !pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1).trimEnd();
    if (content.startsWith(prefix + ' ')) return true;
  }

  // Glob-style: convert to regex
  // Replace * with .* and escape regex special chars
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  const regex = new RegExp('^' + escaped + '$', 'i');
  if (regex.test(content)) {
    return true;
  }

  return false;
}

/**
 * Calculate match specificity. Higher = more specific.
 * Rules with content patterns are more specific than rules without.
 * Longer patterns are more specific than shorter patterns within the same type.
 */
function matchSpecificity(rule: PermissionRule): number {
  if (!rule.ruleContent) return 0;
  // Count non-wildcard characters as specificity score
  return rule.ruleContent.replace(/[*:]/g, '').length + 10; // +10 bonus for having content
}

// ── Rule engine ─────────────────────────────────────────────────────

export class PermissionRuleEngine {
  private rules: PermissionRule[] = [];

  constructor(rules?: PermissionRule[]) {
    if (rules) {
      this.rules = [...rules];
    }
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(toolName: string, ruleContent?: string): void {
    this.rules = this.rules.filter(
      r => !(r.toolName === toolName && r.ruleContent === ruleContent),
    );
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  clearRules(): void {
    this.rules = [];
  }

  /**
   * Evaluate rules against a tool name and optional command content.
   *
   * Algorithm:
   * 1. Find all rules matching the tool name (with optional content)
   * 2. Sort by: behavior priority (deny first) → source priority → specificity
   * 3. The first rule in the sorted list wins
   * 4. If no rules match, return undefined (caller falls back to mode check)
   */
  evaluate(
    toolName: string,
    commandContent?: string,
  ): PermissionRuleResult | undefined {
    // Find all matching rules
    const matching = this.rules.filter(r =>
      ruleMatches(r, toolName, commandContent),
    );

    if (matching.length === 0) {
      return undefined; // No rules match — fall back to mode
    }

    // Sort by priority:
    // 1. Specificity: content rules > no-content rules
    // 2. Source: cliArg > policySettings > userSettings > projectSettings > session
    // 3. Behavior: deny > ask > allow
    matching.sort((a, b) => {
      // Specificity (descending — more specific first)
      const bSpec = matchSpecificity(b) - matchSpecificity(a);
      if (bSpec !== 0) return bSpec;

      // Source priority (descending)
      const bSource = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
      if (bSource !== 0) return bSource;

      // Behavior priority (descending — deny first)
      return BEHAVIOR_PRIORITY[b.behavior] - BEHAVIOR_PRIORITY[a.behavior];
    });


    const winner = matching[0]!;

    return {
      allowed: winner.behavior === 'allow',
      behavior:
        winner.behavior === 'allow'
          ? 'approve'
          : winner.behavior === 'deny'
            ? 'deny'
            : 'ask_user',
      reason: {
        type: 'rule_match',
        rule: winner,
        matchedPattern: winner.ruleContent || undefined,
      },
      prompt:
        winner.behavior === 'ask'
          ? `Allow ${winner.toolName}${winner.ruleContent ? ` (${winner.ruleContent})` : ''}?`
          : undefined,
    };
  }
}
