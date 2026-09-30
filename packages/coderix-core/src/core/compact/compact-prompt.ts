/**
 * compact-prompt.ts — prompts used to summarize a conversation during compaction.
 *
 * Provides the no-tools preamble and trailer, the full multi-section compact
 * prompt, and the helpers that format the resulting summary for display.
 */

// ---------------------------------------------------------------------------
// Preamble / trailer
// ---------------------------------------------------------------------------

const NO_TOOLS_PREAMBLE = `CRITICAL: your reply must be TEXT ONLY. Do not invoke any tool.

- No Read, no Bash, no Grep, no Glob, no Edit, no Write — nothing at all.
- Everything you need is already present in the conversation above.
- Any tool call will be rejected and will burn your only turn, failing the task.
- Your whole reply must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: do not invoke any tool. Reply in plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'A tool call will be rejected and the task will fail.';

// ---------------------------------------------------------------------------
// Analysis instruction
// ---------------------------------------------------------------------------

const DETAILED_ANALYSIS_INSTRUCTION = `Before you write the summary itself, think the conversation through inside <analysis> tags so that nothing important slips past you. As you go:

1. Walk the conversation in order, message by message, and for each part pin down:
   - what the user explicitly asked for
   - how you set about fulfilling it
   - the important decisions, technical concepts, and code patterns
   - concrete details such as:
     - file names
     - complete code snippets
     - function signatures
     - file edits
   - the errors you hit and how you resolved them
   - any specific feedback the user gave you, especially when they told you to do something differently
2. Re-check the result for technical accuracy and completeness, making sure every required element is covered.`;

// ---------------------------------------------------------------------------
// Base compact prompt — summarizing the whole conversation
// ---------------------------------------------------------------------------

const BASE_COMPACT_PROMPT = `Produce a detailed summary of the conversation so far, tracking closely what the user asked for and what you did in response.
The summary has to be thorough about technical details, code patterns, and architectural decisions, so that development can continue seamlessly once the context is gone.

${DETAILED_ANALYSIS_INSTRUCTION}

Include these sections in your summary:

1. Primary Request and Intent: Lay out every explicit request and intent from the user in full.
2. Key Technical Concepts: List the significant technical concepts, technologies, and frameworks that came up.
3. Files and Code Sections: Enumerate the files and code sections you looked at, changed, or created. Give the most recent messages the most weight, include complete snippets where they matter, and note why each file read or edit mattered.
4. Errors and fixes: List every error you ran into and how you resolved it. Pay particular attention to feedback the user gave you, especially when they told you to do something differently.
5. Problem Solving: Describe the problems you solved and any troubleshooting still in progress.
6. All user messages: List every user message that is not a tool result. These matter for understanding the user's feedback and how their intent shifted.
7. Pending Tasks: Outline the tasks you have explicitly been asked to do but have not yet finished.
8. Current Work: Describe precisely what you were doing right before this summary was requested, focusing on the most recent user and assistant messages, and include file names and snippets where useful.
9. Optional Next Step: State the next step tied to your most recent work. IMPORTANT: it must follow DIRECTLY from the user's latest explicit request and the task you were on immediately before this summary. If that task already wrapped up, list a next step only when it is explicitly in line with the user's request; do not wander into tangential or long-finished requests without checking with the user first.
                       When there is a next step, quote the most recent conversation directly so it is clear exactly where you left off. Quote verbatim, so the task cannot be misinterpreted.

Here is the structure your output should follow:

<example>
<analysis>
[Your reasoning, covering every point thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Why this file matters]
      - [What changed in it, if anything]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed it]
      - [Any user feedback about the error]
    - [...]

5. Problem Solving:
   [Solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non-tool-use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of what you were doing]

9. Optional Next Step:
   [The next step to take, if any]

</summary>
</example>

Write your summary of the conversation so far in this structure, keeping it precise and complete.

There may be extra summarization instructions in the context you were given. If so, follow them when writing the summary. Examples of such instructions:
<example>
## Compact Instructions
Focus the summary on TypeScript edits, and call out the mistakes you made and how you corrected them.
</example>

<example>
# Summary instructions
While compacting, emphasize test output and code changes, and quote file reads in full.
</example>
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full compact system prompt.
 *
 * @param customInstructions - Optional user-specified or hook-provided
 *   additional summarization instructions appended after the base prompt.
 */
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += NO_TOOLS_TRAILER;

  return prompt;
}

/**
 * Format a raw compact summary by stripping the <analysis> drafting
 * scratchpad and replacing <summary> XML tags with a readable header.
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary;

  // Strip analysis section — it's a drafting scratchpad that improves
  // summary quality but has no informational value once the summary is written.
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');

  // Extract and format the summary section
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] || '';
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    );
  }

  // Clean up extra whitespace between sections
  formatted = formatted.replace(/\n\n+/g, '\n\n');

  return formatted.trim();
}

/**
 * Build the user-facing summary message content that wraps the formatted
 * compact summary. This is displayed to the model as context.
 */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
): string {
  const formattedSummary = formatCompactSummary(summary);

  let content = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formattedSummary}`;

  if (suppressFollowUpQuestions) {
    content += `\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`;
  }

  if (transcriptPath) {
    content += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at:\n${transcriptPath}`;
  }

  return content;
}

/**
 * Build a simple context string from messages for the compact LLM call.
 * Each message is truncated to keep the prompt size manageable.
 */
export function buildCompactContext(messages: import('../types.js').Message[]): string {
  const parts: string[] = [];
  parts.push('Below is the conversation to summarize:\n');

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    const role = msg.role === 'assistant' ? 'ASSISTANT' : 'USER';
    if (typeof msg.content === 'string') {
      parts.push(`[${role}] ${msg.content.slice(0, 2000)}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push(`[${role}] ${(block.text ?? '').slice(0, 2000)}`);
        } else if (block.type === 'tool_use') {
          parts.push(`[${role} — used tool: ${block.name}]`);
        } else if (
          block.type === 'tool_result' &&
          typeof block.content === 'string'
        ) {
          parts.push(`[tool result] ${block.content.slice(0, 500)}`);
        }
      }
    }
  }

  return parts.join('\n');
}
