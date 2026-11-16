import { describe, expect, it } from 'vitest';
import { messagesRequestToChat } from '../protocol-gateway/messages-to-chat.js';

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string }>;
};

/** Roles in order, with a marker for the assistant turns that made tool calls. */
function roleSequence(converted: { messages: ChatMessage[] }): string[] {
  return converted.messages.map((m) =>
    m.role === 'assistant' && m.tool_calls ? 'assistant+tool_calls' : m.role,
  );
}

/**
 * Every `tool` message must directly follow the assistant turn that issued the
 * calls. Strict OpenAI-compatible upstreams (api.tensoris.ai, used for the
 * `tensorisai/*` models) reject the whole request with
 *   400 Message role 'tool' is not supported by this model
 * when the tool message is separated from its assistant turn by a user message
 * — even though the tool role itself is supported.
 */
function toolMessagesFollowAssistant(converted: { messages: ChatMessage[] }): boolean {
  let prev = '';
  return converted.messages.every((m) => {
    // Consecutive `tool` messages are fine (parallel calls); a `user` message
    // wedged between the calls and their results is what upstream rejects.
    const ok = m.role !== 'tool' || prev === 'assistant+tool_calls' || prev === 'tool';
    prev = m.role === 'assistant' && m.tool_calls ? 'assistant+tool_calls' : m.role;
    return ok;
  });
}

describe('messagesRequestToChat tool_result placement', () => {
  const userTurn = { role: 'user', content: [{ type: 'text', text: '继续' }] };
  const assistantWithTool = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
  };
  const toolResult = {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: 'file.txt',
  };

  it('keeps a tool_result ahead of the text in the same user message', () => {
    // The CLI appends the next prompt to the tool-result turn when the user
    // sends a message right after a tool call; emitting the text first makes
    // the request invalid upstream.
    const converted = messagesRequestToChat({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistantWithTool,
        { role: 'user', content: [toolResult, { type: 'text', text: '继续' }] },
      ],
    }) as { messages: ChatMessage[] };

    expect(roleSequence(converted)).toEqual([
      'user',
      'assistant+tool_calls',
      'tool',
      'user',
    ]);
    expect(toolMessagesFollowAssistant(converted)).toBe(true);
  });

  it('places tool messages before text regardless of block order', () => {
    const converted = messagesRequestToChat({
      model: 'm',
      messages: [
        userTurn,
        assistantWithTool,
        { role: 'user', content: [{ type: 'text', text: '继续' }, toolResult] },
      ],
    }) as { messages: ChatMessage[] };

    expect(roleSequence(converted)).toEqual([
      'user',
      'assistant+tool_calls',
      'tool',
      'user',
    ]);
  });

  it('emits consecutive tool messages for parallel tool calls', () => {
    const converted = messagesRequestToChat({
      model: 'm',
      messages: [
        userTurn,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'b', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: '1' },
            { type: 'tool_result', tool_use_id: 'b', content: '2' },
            { type: 'text', text: '继续' },
          ],
        },
      ],
    }) as { messages: ChatMessage[] };

    expect(roleSequence(converted)).toEqual([
      'user',
      'assistant+tool_calls',
      'tool',
      'tool',
      'user',
    ]);
    expect(toolMessagesFollowAssistant(converted)).toBe(true);
  });
});