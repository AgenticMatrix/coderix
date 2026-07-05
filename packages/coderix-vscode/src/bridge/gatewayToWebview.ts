/**
 * gatewayToWebview.ts — Translate GatewayEvent → WebviewOutboundMessage
 *
 * Maps the shared bridge events (from @coder/bridge) into the webview's
 * message format. Each GatewayEvent maps to zero or more webview messages.
 */

import type { GatewayEvent } from './events.js';
import type { WebviewOutboundMessage, UsageInfo } from '../types/webviewProtocol';

export function gatewayToWebview(
  ev: GatewayEvent,
  sessionId: string,
): WebviewOutboundMessage[] {
  const sid = ev.session_id ?? sessionId;

  switch (ev.type) {
    case 'message.start':
      return [];

    case 'message.delta':
      return [{ type: 'messageDelta', text: ev.payload?.text ?? ev.payload?.rendered ?? '', sessionId: sid }];

    case 'message.complete': {
      const p = ev.payload ?? {};
      const usage: UsageInfo | undefined = p.usage
        ? {
            calls: p.usage.calls ?? 1,
            input: p.usage.input ?? 0,
            output: p.usage.output ?? 0,
            cache: p.usage.cache ?? 0,
            total: p.usage.total ?? 0,
            cost_usd: p.usage.cost_usd,
          }
        : undefined;
      return [{ type: 'messageComplete', text: p.text ?? '', usage, sessionId: sid }];
    }

    case 'thinking.delta':
      return [{ type: 'thinkingDelta', text: ev.payload?.text ?? '', sessionId: sid }];

    case 'tool.start': {
      const sp = ev.payload;
      return [
        {
          type: 'toolStart',
          toolId: sp.tool_id,
          name: sp.name ?? 'unknown',
          args: sp.args_text,
        },
      ];
    }

    case 'tool.complete': {
      const cp = ev.payload;
      return [
        {
          type: 'toolComplete',
          toolId: cp.tool_id,
          name: cp.name ?? 'unknown',
          durationMs: Math.round((cp.duration_s ?? 0) * 1000),
          error: cp.error,
          resultText: cp.result_text,
        },
      ];
    }

    case 'tool.progress':
    case 'tool.generating':
    case 'tool.input_delta':
      return [];

    case 'approval.request': {
      const ap = ev.payload;
      return [
        {
          type: 'approvalRequest',
          requestId: ap.request_id ?? ap.tool_use_id ?? '',
          command: ap.command,
          description: ap.description,
        },
      ];
    }

    case 'status.update': {
      const sup = ev.payload ?? {};
      const kind = sup.kind ?? '';
      let status: 'thinking' | 'generating' | 'running_tool' | 'ready' | 'error' = 'ready';
      if (kind === 'thinking') status = 'thinking';
      else if (kind === 'generating') status = 'generating';
      else if (kind === 'tool') status = 'running_tool';
      else if (kind === 'error') status = 'error';

      return [{ type: 'statusUpdate', status, message: sup.text, sessionId: sid }];
    }

    case 'error': {
      return [
        { type: 'errorMessage', message: ev.payload?.message ?? 'Unknown error' },
        { type: 'statusUpdate', status: 'error', message: ev.payload?.message, sessionId: sid },
      ];
    }

    case 'session.info': {
      const info = ev.payload;
      return [
        {
          type: 'configUpdate',
          config: {
            model: info?.model ?? '',
            provider: '',
            permissionMode: 'ask',
          },
        },
      ];
    }

    case 'sessionHistory':
      return [{
        type: 'sessionHistory' as const,
        messages: (ev.messages as Array<{ role: 'assistant' | 'user' | 'system' | 'tool'; text: string }>),
        sessionId: ev.sessionId ?? sid,
      }];

    case 'sessionSwitched':
      return [{
        type: 'sessionSwitched',
        sessionId: ev.sessionId ?? sid,
        title: ev.title,
      }];

    case 'reasoning.delta': {
      return [{ type: 'thinkingDelta', text: ev.payload?.text ?? '', sessionId: sid }];
    }
    case 'reasoning.available': {
      return [{ type: 'thinkingDelta', text: ev.payload?.text ?? 'Reasoning available', sessionId: sid }];
    }

    case 'question.request': {
      const qp = ev.payload;
      return [{
        type: 'questionRequest' as const,
        requestId: qp.request_id ?? '',
        toolName: qp.tool_name ?? 'Question',
        questions: qp.questions ?? [],
      }];
    }

    case 'background.complete': {
      const bgc = ev.payload;
      return [{ type: 'subagentProgress', agentId: bgc.task_id ?? 'background', goal: 'Background task', status: 'completed', summary: bgc.text }];
    }

    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.progress': {
      const sg = ev.payload;
      return [{
        type: 'subagentProgress',
        agentId: sg.subagent_id ?? 'unknown',
        goal: sg.goal ?? '',
        status: ev.type === 'subagent.spawn_requested' ? 'running' : 'running',
        taskIndex: sg.task_index ?? 0,
        taskCount: sg.task_count ?? 0,
        currentTool: sg.tool_name,
        filesRead: sg.files_read,
        filesWritten: sg.files_written,
        durationSeconds: sg.duration_seconds,
        tokensUsed: (sg.input_tokens ?? 0) + (sg.output_tokens ?? 0),
        summary: sg.text ?? sg.summary,
      }];
    }

    case 'subagent.complete': {
      const sc = ev.payload;
      return [{
        type: 'subagentProgress',
        agentId: sc.subagent_id ?? 'unknown',
        goal: sc.goal ?? '',
        status: sc.status === 'completed' ? 'completed' : sc.status === 'interrupted' ? 'interrupted' : 'error',
        taskIndex: sc.task_index ?? 0,
        taskCount: sc.task_count ?? 0,
        filesRead: sc.files_read,
        filesWritten: sc.files_written,
        durationSeconds: sc.duration_seconds,
        tokensUsed: (sc.input_tokens ?? 0) + (sc.output_tokens ?? 0),
        summary: sc.summary ?? sc.text ?? '',
      }];
    }

    // Events not yet translated to webview
    case 'gateway.ready':
    case 'gateway.stderr':
    case 'gateway.start_timeout':
    case 'gateway.protocol_error':
    case 'skin.changed':
    case 'voice.status':
    case 'voice.transcript':
    case 'browser.progress':
    case 'clarify.request':
    case 'sudo.request':
    case 'secret.request':
    case 'review.summary':
    case 'subagent.thinking':
    case 'subagent.tool':
      return [];
  }
}
