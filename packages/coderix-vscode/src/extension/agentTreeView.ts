import type { TreeDataProvider, Event, TreeItemCollapsibleState } from 'vscode';
import { TreeItem, EventEmitter, TreeItemCollapsibleState as Collapsed, ThemeIcon } from 'vscode';

interface AgentNode {
  id: string;
  label: string;
  description?: string;
  status: 'running' | 'completed' | 'error' | 'idle';
  children?: AgentNode[];
}

class AgentTreeItem extends TreeItem {
  constructor(
    public readonly node: AgentNode,
    collapsibleState: TreeItemCollapsibleState,
  ) {
    super(node.label, collapsibleState);
    this.id = node.id;
    this.description = node.description;
    this.iconPath = new ThemeIcon(
      node.status === 'running' ? 'sync~spin' :
      node.status === 'completed' ? 'pass' :
      node.status === 'error' ? 'error' : 'circle-outline'
    );
    this.contextValue = 'agentNode';
  }
}

export class AgentTreeProvider implements TreeDataProvider<AgentNode> {
  private _onDidChangeTreeData = new EventEmitter<AgentNode | undefined | void>();
  readonly onDidChangeTreeData: Event<AgentNode | undefined | void> = this._onDidChangeTreeData.event;

  private nodes: AgentNode[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setNodes(nodes: AgentNode[]): void {
    this.nodes = nodes;
    this._onDidChangeTreeData.fire();
  }

  addNode(node: AgentNode): void {
    const idx = this.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) {
      this.nodes[idx] = { ...this.nodes[idx], ...node };
    } else {
      this.nodes.push(node);
    }
    this._onDidChangeTreeData.fire();
  }

  updateNode(id: string, updates: Partial<AgentNode>): void {
    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      this.nodes[idx] = { ...this.nodes[idx], ...updates };
      this._onDidChangeTreeData.fire();
    }
  }

  clear(): void {
    this.nodes = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AgentNode): TreeItem {
    const hasKids = element.children && element.children.length > 0;
    return new AgentTreeItem(
      element,
      hasKids ? Collapsed.Expanded : Collapsed.None,
    );
  }

  getChildren(element?: AgentNode): AgentNode[] {
    if (!element) {
      return this.nodes;
    }
    return element.children ?? [];
  }
}
