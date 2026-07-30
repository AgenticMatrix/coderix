/**
 * compact-prompt.ts — Compact summarization prompt templates.
 *
 * Ported from claude-code-best's prompt.ts. Provides the full 9-section
 * compact prompt, partial compact prompt variants, and utility functions
 * for formatting compact summaries.
 */

// ---------------------------------------------------------------------------
// Preamble / Trailer
// ---------------------------------------------------------------------------

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.';

// ---------------------------------------------------------------------------
// Analysis instruction
// ---------------------------------------------------------------------------

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

// ---------------------------------------------------------------------------
// Base compact prompt — full conversation summarization
// ---------------------------------------------------------------------------

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
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
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
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
