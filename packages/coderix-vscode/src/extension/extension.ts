import type { ExtensionContext, StatusBarItem } from 'vscode';
import { window, commands, StatusBarAlignment } from 'vscode';
import { WebviewManager } from './webviewManager';
import { AgentTreeProvider } from './agentTreeView';

let webviewManager: WebviewManager | null = null;
let statusBarItem: StatusBarItem | null = null;
let agentTreeProvider: AgentTreeProvider | null = null;

export function getAgentTreeProvider(): AgentTreeProvider | null {
  return agentTreeProvider;
}

function sendTheme(): void {
  const kind = window.activeColorTheme.kind === 2 || window.activeColorTheme.kind === 3
    ? 'dark' : 'light';
  webviewManager?.postMessage({ type: 'themeChange', kind });
}

function createStatusBar(): StatusBarItem {
  const item = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  item.text = '$(hubot) Coder: Ready';
  item.tooltip = 'Coder Agent';
  item.command = 'coder.chat.start';
  item.show();
  return item;
}

export function updateStatusBar(
  status: string,
  model?: string,
  isBusy?: boolean,
): void {
  if (!statusBarItem) return;

  let icon = '$(hubot)';
  if (isBusy) {
    icon = '$(loading~spin)';
  }

  const modelText = model ? ` · ${model}` : '';
  const statusText = status || (isBusy ? 'Working...' : 'Ready');
  statusBarItem.text = `${icon} Coder: ${statusText}${modelText}`;

  if (isBusy) {
    statusBarItem.backgroundColor = undefined;
  }
}

export function showAgentNotification(message: string): void {
  window.showInformationMessage(message, 'Show').then((selection) => {
    if (selection === 'Show') {
      commands.executeCommand('coder.chat.start');
    }
  });
}

export function activate(context: ExtensionContext): void {
  webviewManager = new WebviewManager(context, {
    onStatusChange: (status, model, isBusy) => updateStatusBar(status, model, isBusy),
    onAgentNotification: (message) => showAgentNotification(message),
    onAgentProgress: (agentId, goal, status) => {
      if (agentTreeProvider) {
        const nodeStatus = status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'idle';
        agentTreeProvider.addNode({
          id: agentId,
          label: goal,
          status: nodeStatus,
        });
      }
    },
  });
  statusBarItem = createStatusBar();

  // Register agent tree view
  agentTreeProvider = new AgentTreeProvider();
  const treeView = window.createTreeView('coderAgentTree', {
    treeDataProvider: agentTreeProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    statusBarItem,
    treeView,
    commands.registerCommand('coder.chat.start', () => {
      webviewManager?.show();
      sendTheme();
    }),
    commands.registerCommand('coder.chat.newSession', async () => {
      const gw = await webviewManager?.getGateway();
      gw?.createSession(false);
      window.showInformationMessage('New Coder session created.');
    }),
    window.onDidChangeActiveColorTheme(() => sendTheme()),
  );
}

export function deactivate(): void {
  if (webviewManager) {
    webviewManager.dispose();
    webviewManager = null;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
}
