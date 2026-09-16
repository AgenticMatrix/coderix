/**
 * Coderix Desktop — Renderer Entry Point
 *
 * Bootstraps the React application inside the Electron renderer process.
 * Imports global styles before any component rendering to prevent FOUC.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import './styles/variables.css';
import './styles/globals.css';
import 'katex/dist/katex.min.css';

// ---------------------------------------------------------------------------
// Type augmentation for the coderixAPI exposed via preload contextBridge
// ---------------------------------------------------------------------------

declare global {
  interface CoderixQuestionRequest {
    toolUseId: string;
    toolName: string;
    questions: Array<{
      header: string;
      question: string;
      options?: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    }>;
  }

  interface Window {
    coderixAPI: {
      query: { submit(query: string, sessionId?: string, skills?: string[]): Promise<{ status: string }>; interrupt(): Promise<{ status: string }> };
      session: { create(opts?: { title?: string; cwd?: string; model?: string }): Promise<{ id: string; title: string; turnCount: number }>; list(): Promise<unknown[]>; get(sessionId: string): Promise<unknown>; load(sessionId: string): Promise<unknown>; fork(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<{ status: string }>; setModel(model: string): Promise<{ status: string; model: string }>; setSkills(skills: string[]): Promise<{ status: string; skills: string[] }> };
      skills: { list(): Promise<Array<{ name: string; description: string; source: string }>>; listDirs(): Promise<string[]>; addDir(): Promise<{ canceled: boolean; dirs: string[]; skills: Array<{ name: string; description: string; source: string }> }>; removeDir(path: string): Promise<{ dirs: string[]; skills: Array<{ name: string; description: string; source: string }> }> };
      permission: { approve(toolUseId: string): Promise<{ status: string }>; approveSession(toolUseId: string): Promise<{ status: string }>; approveAlways(toolUseId: string): Promise<{ status: string }>; deny(toolUseId: string): Promise<{ status: string }>; setMode(mode: string): Promise<{ mode: string }> };
      question: { answer(toolUseId: string, answers: Record<string, string | string[]>): Promise<{ status: string }> };
      fs: { readFile(filePath: string): Promise<{ content: string; path: string }>; writeFile(path: string, content: string): Promise<{ status: string; path: string }>; listDir(dirPath: string): Promise<{ path: string; entries: unknown[] }>; watch(watchPath: string): Promise<{ watcherId: string; path: string }> };
      terminal: { create(opts?: { cwd?: string; rows?: number; cols?: number }): Promise<{ terminalId: string }>; write(sessionId: string, data: string): void; resize(sessionId: string, rows: number, cols: number): void; destroy(sessionId: string): void; onData(sessionId: string, callback: (data: string) => void): () => void; onExit(sessionId: string, callback: (exitCode: number) => void): () => void };
      config: { get(): Promise<unknown>; set(key: string, value: unknown): Promise<{ key: string; value: unknown; status: string }>; getModelList(): Promise<unknown[]>; testConnection(baseUrl: string, apiKey?: string): Promise<unknown>; reload(): Promise<{ status: string }> };
      project: { get(): Promise<{ path: string }>; list(): Promise<{ paths: string[] }>; set(path: string): Promise<{ canceled: boolean; path: string }>; select(): Promise<{ canceled: boolean; path: string }> };
      app: { getVersion(): Promise<string>; checkUpdate(): Promise<{ updateAvailable: boolean; currentVersion?: string; version?: string; skipped?: boolean; reason?: string; error?: string }>; quit(): void; openExternal(url: string): Promise<{ status: string; error?: string }> };
      git: {
        status(): Promise<{ branch: string; files: Array<{ file: string; type: string; code: string }>; commits: Array<{ hash: string; message: string; graph: string; refs: string }>; ahead: number; behind: number }>;
        diff(file: string, staged?: boolean): Promise<{ diff: string; error?: string }>;
        log(maxCount?: number): Promise<{ commits: Array<{ hash: string; message: string; graph: string; refs: string }> }>;
        show(hash: string): Promise<{ diff: string; files: Array<{ file: string; type: string }>; author: string; date: string; filesChanged: number; insertions: number; deletions: number; error?: string }>;
        commitBody(hash: string): Promise<{ body: string }>;
        showFile(hash: string, file: string): Promise<{ diff: string; content: string; error?: string }>;
        stage(file?: string, all?: boolean): Promise<{ status: string }>;
        unstage(file?: string, all?: boolean): Promise<{ status: string }>;
        commit(message: string): Promise<{ status: string; error?: string }>;
        push(opts?: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean; tags?: boolean }): Promise<{ status: string; output?: string; error?: string }>;
        pull(opts?: { remote?: string; branch?: string; rebase?: boolean }): Promise<{ status: string; output?: string; error?: string }>;
        fetch(opts?: { remote?: string; prune?: boolean; all?: boolean }): Promise<{ status: string; output?: string; error?: string }>;
        discard(file: string): Promise<{ status: string; error?: string }>;
        branchList(): Promise<{ branches: Array<{ name: string; hash: string; upstream: string; current: boolean }> }>;
        checkout(opts: { branch: string; create?: boolean; base?: string }): Promise<{ status: string; output?: string; error?: string }>;
        branchDelete(branch: string, force?: boolean): Promise<{ status: string; error?: string }>;
        stashList(): Promise<{ stashes: Array<{ ref: string; message: string; date: string }> }>;
        stashSave(opts?: { message?: string; includeUntracked?: boolean }): Promise<{ status: string; output?: string; error?: string }>;
        stashPop(ref?: string): Promise<{ status: string; output?: string; error?: string }>;
        stashDrop(ref?: string): Promise<{ status: string; error?: string }>;
        commitAmend(message?: string): Promise<{ status: string; output?: string; error?: string }>;
        stageHunk(file: string, hunk: string): Promise<{ status: string; error?: string }>;
        revertHunk(file: string, hunk: string): Promise<{ status: string; error?: string }>;
      };
      browser: {
        create(tabId: string, url: string): Promise<void>;
        destroy(tabId: string): Promise<void>;
        navigate(tabId: string, url: string): Promise<void>;
        goBack(tabId: string): Promise<void>;
        goForward(tabId: string): Promise<void>;
        reload(tabId: string): Promise<void>;
        stop(tabId: string): Promise<void>;
        setZoomFactor(tabId: string, factor: number): Promise<void>;
        executeJavaScript(tabId: string, code: string): Promise<unknown>;
        getPageInfo(tabId: string): Promise<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }>;
        setBounds(tabId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
        show(tabId: string, bounds?: { x: number; y: number; width: number; height: number }): Promise<void>;
        hide(tabId: string): Promise<void>;
        onEvent(callback: (event: { tabId: string; type: string; url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean; errorDescription?: string }) => void): () => void;
        onOpenNewTab(callback: (url: string) => void): () => void;
        onOpenUrl(callback: (url: string) => void): () => void;
      };
      onStreamEvent(callback: (event: unknown) => void): () => void;
      onPermissionRequest(callback: (req: unknown) => void): () => void;
      onStateChange(callback: (change: unknown) => void): () => void;
      onQuestionRequest(callback: (req: CoderixQuestionRequest) => void): () => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Global error capture for debugging
// ---------------------------------------------------------------------------

window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error?.message, event.error?.stack);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled Rejection]', event.reason?.message, event.reason?.stack);
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
