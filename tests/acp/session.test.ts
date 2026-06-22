/**
 * ACP Session lifecycle tests.
 * Uses in-process AgentApp ↔ ClientApp connections to test
 * session/create, delete, resume, list, close flows.
 */

import { describe, it, expect } from 'vitest';
import { agent, client } from '@agentclientprotocol/sdk';

describe('ACP Session Lifecycle', () => {
  // In-memory session store (simulates agent.ts ActiveSession map)
  const sessions = new Map<string, { id: string }>();

  function buildApp() {
    const app = agent({ name: 'test' });

    app.onRequest('session/new', async () => {
      const id = `session-${Date.now()}`;
      sessions.set(id, { id });
      return {
        sessionId: id,
        modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: '' }] },
      };
    });

    app.onRequest('session/list', async () => ({
      sessions: Array.from(sessions.values()).map((s) => ({
        sessionId: s.id,
        cwd: '/tmp',
        title: 'Test Session',
        updatedAt: new Date().toISOString(),
      })),
    }));

    app.onRequest('session/delete', async ({ params: req }) => {
      sessions.delete(req.sessionId);
      return {};
    });

    app.onRequest('session/resume', async ({ params: req }) => {
      if (!sessions.has(req.sessionId)) throw new Error('Session not found');
      return { modes: undefined };
    });

    app.onRequest('session/close', async ({ params: req }) => {
      sessions.delete(req.sessionId);
      return {};
    });

    return app;
  }

  describe('session/new', () => {
    it('should create a new session with unique ID', async () => {
      const cl = client({ name: 'test-client' });
      await cl.connectWith(buildApp(), async (ctx) => {
        const s1 = await ctx.buildSession('/tmp').start();
        expect(s1.sessionId).toBeTruthy();
        expect(sessions.has(s1.sessionId)).toBe(true);
        s1.dispose();
      });
    });
  });

  describe('session/list', () => {
    it('should list all sessions', async () => {
      const app = buildApp();
      // Pre-populate some sessions
      sessions.set('pre-1', { id: 'pre-1' });
      sessions.set('pre-2', { id: 'pre-2' });

      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        const resp = await ctx.request('session/list', {} as any);
        expect(resp.sessions.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('session/delete', () => {
    it('should remove a session', async () => {
      sessions.set('temp-1', { id: 'temp-1' });
      const app = buildApp();
      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        await ctx.request('session/delete', { sessionId: 'temp-1' } as any);
        expect(sessions.has('temp-1')).toBe(false);
      });
    });
  });

  describe('session/resume', () => {
    it('should succeed for known session', async () => {
      sessions.set('resume-me', { id: 'resume-me' });
      const app = buildApp();
      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        const resp = await ctx.request('session/resume', {
          sessionId: 'resume-me',
          cwd: '/tmp',
        } as any);
        expect(resp).toBeDefined();
      });
    });

    it('should reject for unknown session', async () => {
      const app = buildApp();
      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        await expect(
          ctx.request('session/resume', { sessionId: 'nonexistent' } as any),
        ).rejects.toThrow();
      });
    });
  });

  describe('session/close', () => {
    it('should remove the session from active set', async () => {
      sessions.set('close-me', { id: 'close-me' });
      const app = buildApp();
      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        await ctx.request('session/close', { sessionId: 'close-me' } as any);
        expect(sessions.has('close-me')).toBe(false);
      });
    });
  });
});
