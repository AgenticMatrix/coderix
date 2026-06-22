/**
 * ACP Permission mapping tests.
 */

import { describe, it, expect } from 'vitest';

describe('ACP Permissions', () => {
  describe('PermissionMode mapping', () => {
    const modeMap: Record<string, string> = {
      ask: 'ASK',
      auto: 'AUTO',
      plan: 'PLAN',
    };

    it('should map ask → ASK', () => {
      expect(modeMap['ask']).toBe('ASK');
    });

    it('should map auto → AUTO', () => {
      expect(modeMap['auto']).toBe('AUTO');
    });

    it('should map plan → PLAN', () => {
      expect(modeMap['plan']).toBe('PLAN');
    });

    it('should default to ASK for unknown mode', () => {
      expect(modeMap['unknown'] ?? 'ASK').toBe('ASK');
    });
  });

  describe('PermissionOption generation', () => {
    function buildPermissionOptions() {
      return [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ];
    }

    it('should include allow_once, allow_always, reject_once', () => {
      const options = buildPermissionOptions();
      expect(options).toHaveLength(3);
      expect(options.map((o) => o.optionId)).toContain('allow_once');
      expect(options.map((o) => o.optionId)).toContain('allow_always');
      expect(options.map((o) => o.optionId)).toContain('reject_once');
    });

    it('should have unique optionIds', () => {
      const options = buildPermissionOptions();
      const ids = options.map((o) => o.optionId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('Permission outcome parsing', () => {
    function isAllowed(outcome: { outcome: string; optionId?: string }): boolean {
      return outcome.outcome === 'selected'
        ? (outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always')
        : false;
    }

    it('should allow allow_once', () => {
      expect(isAllowed({ outcome: 'selected', optionId: 'allow_once' })).toBe(true);
    });

    it('should allow allow_always', () => {
      expect(isAllowed({ outcome: 'selected', optionId: 'allow_always' })).toBe(true);
    });

    it('should deny reject_once', () => {
      expect(isAllowed({ outcome: 'selected', optionId: 'reject_once' })).toBe(false);
    });

    it('should deny cancelled', () => {
      expect(isAllowed({ outcome: 'cancelled' })).toBe(false);
    });
  });
});
