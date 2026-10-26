import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSessionTitleUpdated } from '../ipc-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('onSessionTitleUpdated', () => {
  it('returns a no-op when the loaded preload predates the API', () => {
    vi.stubGlobal('window', { coderixAPI: {} });
    const callback = vi.fn();

    const unsubscribe = onSessionTitleUpdated(callback);

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('delegates to the preload subscription when available', () => {
    const preloadUnsubscribe = vi.fn();
    const subscribe = vi.fn(() => preloadUnsubscribe);
    vi.stubGlobal('window', { coderixAPI: { onSessionTitleUpdated: subscribe } });
    const callback = vi.fn();

    const unsubscribe = onSessionTitleUpdated(callback);

    expect(subscribe).toHaveBeenCalledWith(callback);
    expect(unsubscribe).toBe(preloadUnsubscribe);
  });
});
