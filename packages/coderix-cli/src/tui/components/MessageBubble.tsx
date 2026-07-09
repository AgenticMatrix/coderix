import { Box, Text, useStdout } from 'ink';
import { useState, useEffect } from 'react';

import type {
  Message, TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock,
  TodoUpdateBlock, TurnBoundary, SubagentBlock,
  CompactionBoundary, SpeculationBlock, CompletionBoundary,
} from '../../types.js';
import { MarkdownRenderer, displayWidth } from './MarkdownRenderer.js';
import { getToolUseRenderer, getToolResultRenderer } from '../../tools/registry.js';;
import { TodoUpdateBlockRenderer } from './blocks/TodoUpdateBlockRenderer.js';
import { TurnBoundaryRenderer } from './blocks/TurnBoundaryRenderer.js';
import { SubagentBlockRenderer } from './blocks/SubagentBlockRenderer.js';
import { CompactionBoundaryRenderer } from './blocks/CompactionBoundaryRenderer.js';
import { SpeculationBlockRenderer } from './blocks/SpeculationBlockRenderer.js';
import { CompletionBoundaryRenderer } from './blocks/CompletionBoundaryRenderer.js';

interface MessageBubbleProps {
  message: Message;
  contentExpanded?: boolean;
  theme?: string;
}

/** Extract display text from blocks (text blocks concatenated). */
function blocksText(blocks: Message['blocks']): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.content)
    .join('');
}

/** Word-wrap plain text at word boundaries, respecting display width. */
function wordWrapText(text: string, maxWidth: number): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const words = line.split(/(?<=\s)/);
    let cur = '';
    let curW = 0;
    for (const word of words) {
      const w = displayWidth(word);
      if (curW === 0 || curW + w <= maxWidth) {
        cur += word;
        curW += w;
      } else {
        if (cur) result.push(cur);
        cur = word.replace(/^\s+/, '');
        curW = displayWidth(cur);
      }
    }
    if (cur) result.push(cur);
  }
  return result;
}

/** Extract thinking text from blocks. */
function blocksThinking(blocks: Message['blocks']): string | undefined {
  const tb = blocks.find((b): b is ThinkingBlock => b.type === 'thinking');
  return tb?.content;
}

/** Build a human-readable parameter summary from tool input. */
function buildParamSummary(input: Record<string, unknown>): string {
  // Try common parameter patterns
  const filePath = input.file_path as string | undefined;
  if (filePath) {
    const short = filePath.split('/').slice(-2).join('/');
    return short;
  }
  const command = input.command as string | undefined;
  if (command) {
    return command.length > 50 ? command.slice(0, 47) + '...' : command;
  }
  const pattern = input.pattern as string | undefined;
  if (pattern) return pattern;
  const url = input.url as string | undefined;
  if (url) {
    try {
      const u = new URL(url);
      return u.hostname + u.pathname.slice(0, 30);
    } catch {
      return url.length > 40 ? url.slice(0, 37) + '...' : url;
    }
  }
  // Fallback: first non-internal key-value
  const keys = Object.keys(input).filter(k => !k.startsWith('_'));
  if (keys.length > 0) {
    const v = String(input[keys[0]]);
    return v.length > 40 ? v.slice(0, 37) + '...' : v;
  }
  return '';
}

/**
 * Renders a single chat message with role-based styling.
 *
 * For assistant messages with ContentBlocks, renders blocks in order:
 *   thinking → text → tool_use → tool_result → ...
 *
 * Falls back to legacy `content` / `thinking` fields when blocks are empty.
 *
 * Tool blocks are rendered via the tool registry (getToolUseRenderer / getToolResultRenderer),
 * allowing per-tool specialised renderers to be swapped in.
 */
export function MessageBubble({ message, contentExpanded, theme }: MessageBubbleProps) {
  const { role } = message;
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(
    () => stdout?.columns ?? process.stdout.columns ?? 80,
  );
  useEffect(() => {
    if (stdout?.columns && stdout.columns !== termWidth) {
      setTermWidth(stdout.columns);
    }
  }, [stdout?.columns]);
  const maxWidth = Math.max(20, Math.floor(termWidth * 0.9));
  const textColor = theme === 'light' ? '#000000' : '#FFFFFF';
  const userBgColor = theme === 'light' ? 'black' : 'white';
  const userTextColor = theme === 'light' ? '#FFFFFF' : '#000000';

  // ── Determine content source ──────────────────────────────
  const hasBlocks = message.blocks && message.blocks.length > 0;
  const displayContent = hasBlocks ? blocksText(message.blocks) : message.content;
  const thinkingContent = hasBlocks
    ? (blocksThinking(message.blocks) ?? message.thinking)
    : message.thinking;

  // ── System ────────────────────────────────────────────────
  if (role === 'system') {
    return (
      <Box flexDirection="row" marginBottom={1}>
        <Box width={2} flexShrink={0} />
        <Box flexGrow={1}>
          <Text dimColor>
            <Text color="grey">[System]</Text> {displayContent}
          </Text>
        </Box>
      </Box>
    );
  }

  // ── User ──────────────────────────────────────────────────

  // Tool-result-only user messages: display inline without "You:" prefix
  const isToolResultOnly =
    role === 'user' &&
    hasBlocks &&
    message.blocks.every((b) => b.type === 'tool_result');

  if (role === 'user' && !isToolResultOnly) {
    const USER_FOLD = 10;
    const contentLines = displayContent.split(/\r?\n|\r/);
    const tooLong = contentLines.length > USER_FOLD;
    const displayLines = tooLong
      ? [...contentLines.slice(0, 6), `... [${contentLines.length - 6} more lines]`]
      : contentLines;

    return (
      <Box flexDirection="column" marginBottom={1}>
        {displayLines.map((line, i) => (
          <Box key={i} flexDirection="row">
            <Box width={2}>
              <Text color="#4FC3F7" bold>
                {i === 0 ? '❯' : ' '}
              </Text>
            </Box>
            <Box flexGrow={1} backgroundColor={userBgColor}>
              <Text color={userTextColor}>{line}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    );
  }

  // ── Block renderer dispatcher ───────────────────────────────
  // Defined before the role sections so it's accessible from both
  // tool-result-only user messages and the assistant section.
  const renderBlock = (block: Message['blocks'][number], idx: number) => {
    // ── Tool use ────────────────────────────────────────────
    if (block.type === 'tool_use') {
      const tu = block as ToolUseBlock;
      const Renderer = getToolUseRenderer(tu.toolName);
      return (
        <Renderer
          key={idx}
          toolName={tu.toolName}
          toolId={tu.toolId}
          input={tu.input}
          paramSummary={buildParamSummary(tu.input)}
          state={tu.state}
          riskLevel={tu.riskLevel}
          permissionState={tu.permissionState}
          duration={tu.duration}
          result={tu.result}
          contentExpanded={contentExpanded}
        />
      );
    }

    // ── Tool result ─────────────────────────────────────────
    if (block.type === 'tool_result') {
      const tr = block as ToolResultBlock;
      const ResultRenderer = getToolResultRenderer(tr.toolName);
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <ResultRenderer
              content={tr.content}
              isError={tr.isError}
              truncated={tr.truncated}
              duration={tr.duration}
              toolName={tr.toolName}
              metadata={tr.metadata}
              contentExpanded={contentExpanded}
            />
          </Box>
        </Box>
      );
    }

    // ── Todo update ─────────────────────────────────────────
    if (block.type === 'todo_update') {
      const td = block as TodoUpdateBlock;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <TodoUpdateBlockRenderer
              todos={td.todos}
              oldTodos={td.oldTodos}
            />
          </Box>
        </Box>
      );
    }

    // ── Turn boundary ───────────────────────────────────────
    if (block.type === 'turn_boundary') {
      const tb = block as TurnBoundary;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <TurnBoundaryRenderer
              turnId={tb.turnId}
              summary={tb.summary}
            />
          </Box>
        </Box>
      );
    }

    // ── Sub-agent ───────────────────────────────────────────
    if (block.type === 'subagent') {
      const sa = block as SubagentBlock;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <SubagentBlockRenderer
              agentType={sa.agentType}
              agentName={sa.agentName}
              state={sa.state}
              messageCount={sa.messageCount}
            />
          </Box>
        </Box>
      );
    }

    // ── Compaction boundary ─────────────────────────────────
    if (block.type === 'compaction') {
      const cb = block as CompactionBoundary;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <CompactionBoundaryRenderer
              removedCount={cb.removedCount}
              reason={cb.reason}
            />
          </Box>
        </Box>
      );
    }

    // ── Speculation ─────────────────────────────────────────
    if (block.type === 'speculation') {
      const sp = block as SpeculationBlock;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <SpeculationBlockRenderer
              state={sp.state}
            />
          </Box>
        </Box>
      );
    }

    // ── Completion boundary ─────────────────────────────────
    if (block.type === 'completion') {
      const cp = block as CompletionBoundary;
      return (
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <CompletionBoundaryRenderer
              stopReason={cp.stopReason}
            />
          </Box>
        </Box>
      );
    }

    return null;
  };

  // ── Tool result (system-generated user message) ─────────────
  // Rendered inline (no "You:" prefix, no AI: header) for
  // tool_result blocks that follow tool_use in the agent loop.
  if (isToolResultOnly) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {message.blocks.map((block, idx) => (
          <Box key={idx} flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexGrow={1}>
              {renderBlock(block, idx)}
            </Box>
          </Box>
        ))}
      </Box>
    );
  }

  // ── Assistant ─────────────────────────────────────────────

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column">
        {/* Render blocks in their natural order */}
        {hasBlocks
          ? (() => {
              return message.blocks.map((block, idx) => {
                if (block.type === 'thinking') {
                  const thinkingLines = block.content.split('\n');
                  const tooLong = thinkingLines.length > 2;
                  const collapsed = tooLong && !message.thinkingExpanded;
                  const logicalLines = collapsed
                    ? thinkingLines.slice(0, 2)
                    : thinkingLines;
                  const thinkWidth = Math.max(20, maxWidth - 2);
                  const isThoughtDone = message.thinkingDuration != null;

                  const headerText = isThoughtDone
                    ? `Thought · ${(message.thinkingDuration! / 1000).toFixed(1)}s · ${message.thinkingTokens} tokens`
                    : 'Thinking...';

                  return (
                    <Box key={idx} flexDirection="row" marginBottom={1}>
                      <Box width={2} flexShrink={0} />
                      <Box flexDirection="column" flexGrow={1}>
                        <Text color={textColor}>{headerText}</Text>
                        <Box paddingLeft={2} flexDirection="column">
                          {logicalLines.flatMap(line => wordWrapText(line, thinkWidth)).map((line, i) => (
                            <Text key={i} dimColor color="grey">{line || ' '}</Text>
                          ))}
                          {collapsed ? (
                            <Text dimColor color="grey">{`... ${thinkingLines.length - 2} more lines (Ctrl+D to detail)`}</Text>
                          ) : null}
                          {tooLong && message.thinkingExpanded ? (
                            <Text dimColor color="grey">{'(Ctrl+D to detail)'}</Text>
                          ) : null}
                        </Box>
                      </Box>
                    </Box>
                  );
                }

                if (block.type === 'text') {
                  return (
                    <Box key={idx} flexDirection="row">
                      <Box width={2} flexShrink={0} />
                      <Box flexGrow={1}>
                        <MarkdownRenderer content={block.content} theme={theme} />
                      </Box>
                    </Box>
                  );
                }

                return renderBlock(block, idx);
              });
            })()
          : null}

        {/* Fallback: legacy string content when no blocks */}
        {!hasBlocks && displayContent ? (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexGrow={1}>
              <MarkdownRenderer content={displayContent} theme={theme} />
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
