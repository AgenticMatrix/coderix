/**
 * Plan mode attachment — dynamically injects workflow instructions into
 * the system prompt while plan mode is active.
 *
 * Throttling: full 5-phase instructions on turn 0 (first turn in plan mode)
 * and every 5 turns thereafter. A sparse one-line reminder on all other turns.
 */

import type { PlanModeState } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Inject full workflow instructions every N turns. */
const FULL_INSTRUCTION_INTERVAL = 5;

// ---------------------------------------------------------------------------
// Full 5-phase workflow
// ---------------------------------------------------------------------------

function getFullInstructions(state: PlanModeState): string {
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet — you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. The ONLY exception: you may write .md and .txt files (e.g. the plan file, research notes).

## Plan File
${state.planFilePath ? `You MUST write your plan to this exact file path:\n  ${state.planFilePath}\nDo NOT use a different filename — ExitPlanMode will only read from this file.` : 'No plan file yet — create one at the path specified in the plan file info.'}

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with it. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. Launch 1 Explore agent to efficiently explore the codebase.
   - For most tasks, 1 agent is enough — give it a comprehensive prompt covering all areas.
   - Use multiple agents only when tasks are truly independent — exploring different
     projects, separate architecture layers, or unrelated modules that a single agent
     could not reasonably cover. Each agent should have a distinct, non-overlapping focus.
   - Quality over quantity — prefer fewer agents with broader prompts.

### Phase 2: Design
Goal: Design an implementation approach.

Launch 1 Plan agent to design the implementation based on the user's intent and your exploration results from Phase 1.
- Default: Launch 1 Plan agent — it helps validate your understanding and consider alternatives.
- Skip agents: Only for truly trivial tasks (typo fixes, single-line changes, simple renames).
- Use multiple agents when the task has fundamentally different architectural approaches
  worth comparing — each agent explores a distinct strategy.

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces.
- Describe requirements and constraints.
- Request a detailed implementation plan.

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.

1. Read the critical files identified by agents to deepen your understanding.
2. Ensure the plans align with the user's original request.
3. Use AskUserQuestion to clarify any remaining questions with the user.

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).

- Begin with a Context section: explain why this change is being made — the problem it addresses, what prompted it, and the intended outcome.
- Include only your recommended approach, not all alternatives.
- Ensure the plan file is concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Reference existing functions and utilities you found that should be reused, with their file paths.
- Include a verification section describing how to test the changes end-to-end.

### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file — you should always call ExitPlanMode to indicate to the user that you are done planning.

This is critical — your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons.

**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval via text or AskUserQuestion. Phrases like "Is this plan okay?" or "Should I proceed?" MUST use ExitPlanMode.

NOTE: At any point through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don't make large assumptions about user intent. The goal is to present a well-researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Sparse reminder
// ---------------------------------------------------------------------------

function getSparseInstructions(state: PlanModeState): string {
  return `<system-reminder>
Plan mode still active (see full instructions earlier in conversation). Read-only except .md/.txt files. Follow the 5-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.
</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get plan mode attachment content for the current turn.
 * Returns null if plan mode is not active or this turn should be skipped.
 *
 * @param state - Current plan mode state (null if not in plan mode)
 * @returns Attachment string to prepend to system prompt, or null
 */
export function getPlanModeAttachmentContent(state: PlanModeState | null): string | null {
  if (!state || state.hasExitedPlanMode) return null;

  const isFirstTurn = state.turnCount === 0;
  const isIntervalTurn = state.turnCount > 0 && state.turnCount % FULL_INSTRUCTION_INTERVAL === 0;

  if (isFirstTurn || isIntervalTurn) {
    return getFullInstructions(state);
  }

  return getSparseInstructions(state);
}

/**
 * Increment the plan mode turn counter. Called at the end of each turn
 * while in plan mode (after the model response is received).
 */
export function incrementPlanModeTurn(state: PlanModeState): void {
  state.turnCount += 1;
}
