/**
 * webviewManager.ts — Manages the VS Code WebviewPanel lifecycle
 *
 * Creates and manages the chat webview panel. Handles message routing
 * between the webview and the engine/acp client.
 */

import type { ExtensionContext, WebviewPanel } from 'vscode';
import { window, ViewColumn, Uri, workspace } from 'vscode';
import type { WebviewOutboundMessage, WebviewInboundMessage } from '../types/webviewProtocol';
import type { EngineHost } from '../engine/engineHost';

type GatewayLike = {
  submitPrompt(text: string): Promise<void>;
  interrupt(): Promise<void>;
  createSession(silent?: boolean): Promise<void>;
  resumeSession(id: string): Promise<void>;
  listSessions(): void;
  handleApproval(requestId: string, allowed: boolean): void;
  setPermissionMode(mode: 'plan' | 'ask' | 'auto'): void;
  resolveQuestion(requestId: string, answers: Record<string, string>): void;
  dispose(): void;
};

export interface WebviewCallbacks {
  onStatusChange?: (status: string, model?: string, isBusy?: boolean) => void;
  onAgentNotification?: (message: string) => void;
  onAgentProgress?: (agentId: string, goal: string, status: string) => void;
}

export class WebviewManager {
  private panel: WebviewPanel | null = null;
  private gateway: GatewayLike | null = null;
  private context: ExtensionContext;
  private callbacks: WebviewCallbacks;

  constructor(context: ExtensionContext, callbacks: WebviewCallbacks = {}) {
    this.context = context;
    this.callbacks = callbacks;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(ViewColumn.Beside);
      return;
    }

    this.panel = window.createWebviewPanel(
      'coderChat',
      'Coder Agent',
      ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    this.panel.iconPath = Uri.joinPath(
      this.context.extensionUri,
      'resources',
      'icon.png',
    );

    // Load webview HTML
    const webviewUri = Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'index.html',
    );
    const html = this.getHtmlContent(webviewUri);
    this.panel.webview.html = html;

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewInboundMessage) => {
        this.handleWebviewMessage(msg);
      },
      null,
      this.context.subscriptions,
    );

    // Clean up on dispose
    this.panel.onDidDispose(
      () => {
        this.panel = null;
        this.gateway?.dispose();
        this.gateway = null;
      },
      null,
      this.context.subscriptions,
    );
  }

  async getGateway(): Promise<GatewayLike> {
    if (!this.gateway) {
      const { EngineHost } = await import('../engine/engineHost');
      this.gateway = new EngineHost((msg: WebviewOutboundMessage) => this.postMessage(msg));
    }
    return this.gateway;
  }

  async createSession(): Promise<void> {
    (await this.getGateway()).createSession();
  }

  postMessage(msg: WebviewOutboundMessage): void {
    // Trigger callbacks for native VS Code integration
    if (msg.type === 'statusUpdate') {
      this.callbacks.onStatusChange?.(
        msg.message ?? msg.status,
        undefined,
        msg.status !== 'ready' && msg.status !== 'error'
      );
    } else if (msg.type === 'configUpdate') {
      this.callbacks.onStatusChange?.('Ready', msg.config.model, false);
    } else if (msg.type === 'subagentProgress') {
      this.callbacks.onAgentProgress?.(msg.agentId, msg.goal, msg.status);
      if (msg.status === 'completed') {
        this.callbacks.onAgentNotification?.(`Agent "${msg.goal}" completed`);
      }
    }
    this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.gateway?.dispose();
    this.gateway = null;
    this.panel?.dispose();
    this.panel = null;
  }

  private async handleWebviewMessage(msg: WebviewInboundMessage): Promise<void> {
    // webviewReady: respond immediately without waiting for gateway
    if (msg.type === 'webviewReady') {
      return;
    }

    try {
      const gw = await this.getGateway();

      switch (msg.type) {
        case 'submitPrompt':
          gw.submitPrompt(msg.text);
          break;
        case 'interrupt':
          gw.interrupt();
          break;
        case 'approvalRespond':
          gw.handleApproval(msg.requestId, msg.allowed);
          break;
        case 'newSession':
          gw.createSession(false);
          break;
        case 'selectSession':
          gw.resumeSession(msg.sessionId);
          break;
        case 'openFile': {
          const fileUri = Uri.joinPath(workspace.workspaceFolders?.[0]?.uri ?? Uri.file(this.context.extensionUri.fsPath), msg.path);
          workspace.openTextDocument(fileUri).then(
            (doc) => window.showTextDocument(doc),
            () => window.showErrorMessage(`File not found: ${msg.path}`),
          );
          break;
        }
        case 'listSessions': {
          gw.listSessions();
          break;
        }
        case 'setPermissionMode':
          gw.setPermissionMode(msg.mode);
          break;
        case 'questionAnswer':
          gw.resolveQuestion(msg.requestId, msg.answers);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({
        type: 'errorMessage',
        message: `Gateway error: ${message}`,
      });
    }
  }

  private getHtmlContent(webviewUri: Uri): string {
    // In production, webpack generates the HTML via HtmlWebpackPlugin.
    // For development, we serve a minimal page that loads the webview bundle.
    const scriptUri = Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'webview.js',
    );
    const webviewScript = this.panel!.webview.asWebviewUri(scriptUri);

    const csp = `
      default-src 'none';
      style-src ${this.panel!.webview.cspSource} 'unsafe-inline';
      script-src ${this.panel!.webview.cspSource};
      font-src ${this.panel!.webview.cspSource};
    `.replace(/\s+/g, ' ').trim();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Coder Agent</title>
</head>
<body>
  <div id="root"></div>
  <script src="${webviewScript}"></script>
</body>
</html>`;
  }
}
