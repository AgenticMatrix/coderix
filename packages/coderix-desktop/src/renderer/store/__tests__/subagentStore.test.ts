import { describe, it, expect, beforeEach } from 'vitest';
import { useSubagentStore } from '../subagentStore.js';

function reset(): void {
  useSubagentStore.setState({ agents: {}, tabs: [], activeAgentId: null });
}

describe('useSubagentStore sub-agent correlation', () => {
  beforeEach(reset);

  it('stores a live record under the canonical tool_use id', () => {
    // The main process re-keys coderix events by `toolUseId`; the record keeps
    // its engine id in `id` so disk lookups still work.
    useSubagentStore.getState().applyEvent('agent_register', 'toolu_X', {
      id: 'sub-y',
      toolUseId: 'toolu_X',
      status: 'running',
    });
    const record = useSubagentStore.getState().agents['toolu_X'];
    expect(record?.id).toBe('sub-y');
    expect(record?.toolUseId).toBe('toolu_X');
  });

  it('opening by tool_use id does not clobber the live engine id or transcript', () => {
    useSubagentStore.getState().applyEvent('agent_register', 'toolu_X', {
      id: 'sub-y',
      toolUseId: 'toolu_X',
      status: 'running',
      transcript: [{ role: 'user', content: 'hi' }],
    });
    // The card seeds with id === toolId while the call is still running.
    useSubagentStore.getState().open('toolu_X', { id: 'toolu_X', status: 'running' });
    const record = useSubagentStore.getState().agents['toolu_X'];
    expect(record?.id).toBe('sub-y');
    expect(record?.transcript).toHaveLength(1);
  });

  it('keeps a cold seed engine id for on-disk transcript loading', () => {
    useSubagentStore.getState().open('toolu_X', { id: 'sub-y', status: 'done' });
    expect(useSubagentStore.getState().agents['toolu_X']?.id).toBe('sub-y');
  });
});
