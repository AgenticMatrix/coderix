/**
 * protocol-gateway/messages-to-chat.ts — Anthropic Messages → OpenAI Chat
 * Completions conversion. Lets the claude-code harness (Anthropic Messages)
 * drive an OpenAI Chat Completions model. Three entry points: request
 * transform, non-streaming response transform, and a stateful SSE transform.
 *
 * Mirrors agentstation-app's protocol-gateway/convert/messages-to-chat.ts.
 */

import type { ProtocolConverter, SseFrame } from './types.js';
import { syntheticId } from './shared.js';

type Json = Record<string, unknown>;

function toBlocks(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content as Json[];
  return [];
}

function systemToText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return (system as Json[])
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

function imageSourceToDataUrl(source: unknown): string {
  const s = (source ?? {}) as Json;
  const mediaType = typeof s.media_type === 'string' ? s.media_type : 'image/png';
  const data = typeof s.data === 'string' ? s.data : '';
  return `data:${mediaType};base64,${data}`;
}

function toolResultToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Json[])
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

function toolChoiceToChat(tc: unknown): unknown {
  const type = (tc as Json)?.type;
  if (type === 'none') return 'none';
  if (type === 'any' || type === 'tool') return 'required';
  const name = (tc as Json)?.name;
  if (name) return { type: 'function', function: { name } };
  return 'auto';
}

function finishReasonToStopReason(fr: string): string {
  switch (fr) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn';
  }
}

export function messagesRequestToChat(body: Json): Json {
  const out: Json = { model: body.model };

  const messages: Json[] = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const msg of (Array.isArray(body.messages) ? (body.messages as Json[]) : [])) {
    const role = msg.role;
    const blocks = toBlocks(msg.content);

    if (role === 'user') {
      const parts: Json[] = [];
      const toolMessages: Json[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          parts.push({ type: 'image_url', image_url: { url: imageSourceToDataUrl(b.source) } });
        } else if (b.type === 'tool_result') {
          toolMessages.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: toolResultToString(b.content),
          });
        }
      }
      if (parts.length > 0) {
        const hasImage = parts.some((p) => p.type === 'image_url');
        messages.push({
          role: 'user',
          content: hasImage ? parts : parts.map((p) => p.text).join(''),
        });
      }
      messages.push(...toolMessages);
    } else if (role === 'assistant') {
      const text: string[] = [];
      const toolCalls: Json[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          text.push(b.text as string);
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      if (text.length > 0 || toolCalls.length > 0) {
        const m: Json = { role: 'assistant' };
        if (text.length > 0) m.content = text.join('');
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        messages.push(m);
      }
    }
    // 'system' never appears inside Messages.messages — ignore.
  }
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as Json[]).map((t) => ({
      type: 'function',
      function: {
        name: t.name ?? '',
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice !== undefined) out.tool_choice = toolChoiceToChat(body.tool_choice);

  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (typeof body.stream === 'boolean') out.stream = body.stream;

  return out;
}

export function chatResponseToMessages(body: Json): Json {
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as Json | undefined;
  const message = (choice?.message ?? {}) as Json;

  const content: Json[] = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const p of message.content as Json[]) {
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
    }
  }
  for (const tc of (Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [])) {
    const fn = (tc.function ?? {}) as Json;
    let input: unknown = {};
    try { input = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id, name: fn.name ?? '', input });
  }

  const finishReason = (choice?.finish_reason as string) ?? 'stop';
  const usage = (body.usage ?? {}) as Json;

  return {
    id: syntheticId('msg_'),
    type: 'message',
    role: 'assistant',
    content,
    model: body.model ?? '',
    stop_reason: finishReasonToStopReason(finishReason as string),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

interface ToolBlock {
  blockIndex: number;
  name: string;
  args: string;
  open: boolean;
}

/** Chat Completions SSE (bare `data:` deltas) → Anthropic Messages SSE. */
export class ChatToMessagesSseConverter {
  private started = false;
  private messageId = '';
  private model = '';
  private blockIndex = 0;
  private textOpen = false;
  private textBlockIndex = -1;
  private tools = new Map<number, ToolBlock>();
  private finishReason = 'stop';
  private usage: Json = {};

  convertSse(_event: string | null, data: string): SseFrame[] {
    let payload: Json;
    try { payload = JSON.parse(data) as Json; } catch { return []; }

    const choice = Array.isArray(payload.choices) ? (payload.choices as Json[])[0] : undefined;
    const delta = ((choice ?? {}) as Json).delta as Json | undefined;
    if (!delta) return [];

    const frames: SseFrame[] = [];
    if (!this.started) {
      this.started = true;
      this.messageId = syntheticId('msg_');
      this.model = (payload.model as string) ?? '';
      frames.push({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      });
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (!this.textOpen) {
        this.textOpen = true;
        this.textBlockIndex = this.blockIndex++;
        frames.push({
          event: 'content_block_start',
          data: JSON.stringify({ type: 'content_block_start', index: this.textBlockIndex, content_block: { type: 'text', text: '' } }),
        });
      }
      frames.push({
        event: 'content_block_delta',
        data: JSON.stringify({ type: 'content_block_delta', index: this.textBlockIndex, delta: { type: 'text_delta', text: delta.content } }),
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Json[]) {
        const idx = (tc.index as number) ?? 0;
        let entry = this.tools.get(idx);
        if (!entry) {
          entry = { blockIndex: this.blockIndex++, name: '', args: '', open: true };
          this.tools.set(idx, entry);
          frames.push({
            event: 'content_block_start',
            data: JSON.stringify({ type: 'content_block_start', index: entry.blockIndex, content_block: { type: 'tool_use', id: tc.id ?? '', name: '', input: {} } }),
          });
        }
        const fn = (tc.function ?? {}) as Json;
        if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments) {
          entry.args += fn.arguments;
          frames.push({
            event: 'content_block_delta',
            data: JSON.stringify({ type: 'content_block_delta', index: entry.blockIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } }),
          });
        }
      }
    }

    if ((choice as Json)?.finish_reason) this.finishReason = (choice as Json).finish_reason as string;
    if (payload.usage) this.usage = payload.usage as Json;

    return frames;
  }

  finishSse(): SseFrame[] {
    if (!this.started) return [];
    const frames: SseFrame[] = [];
    if (this.textOpen) {
      frames.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: this.textBlockIndex }) });
    }
    for (const entry of this.tools.values()) {
      if (entry.open) {
        entry.open = false;
        frames.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: entry.blockIndex }) });
      }
    }
    frames.push({
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: finishReasonToStopReason(this.finishReason), stop_sequence: null },
        usage: { output_tokens: this.usage.completion_tokens ?? 0 },
      }),
    });
    frames.push({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) });
    return frames;
  }
}

/** Fresh converter instance per request (SSE state must not leak across requests). */
export function createMessagesToChatConverter(): ProtocolConverter {
  const sse = new ChatToMessagesSseConverter();
  return {
    convertRequest: messagesRequestToChat,
    convertResponse: chatResponseToMessages,
    convertSse: (event, data) => sse.convertSse(event, data),
    finishSse: () => sse.finishSse(),
  };
}
