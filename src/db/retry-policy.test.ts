import { describe, expect, it } from 'vitest';
import { backoffDelayMs, decideFailure } from './retry-policy.js';

describe('decideFailure', () => {
  it('dead-letters permanent failures immediately, regardless of attempts', () => {
    expect(decideFailure({ attempts: 1, maxAttempts: 5, kind: 'permanent' })).toBe('dead-letter');
  });

  it('retries transient failures while attempts remain', () => {
    expect(decideFailure({ attempts: 1, maxAttempts: 3, kind: 'transient' })).toBe('retry');
    expect(decideFailure({ attempts: 2, maxAttempts: 3, kind: 'transient' })).toBe('retry');
  });

  it('dead-letters a transient failure once the attempt ceiling is reached', () => {
    expect(decideFailure({ attempts: 3, maxAttempts: 3, kind: 'transient' })).toBe('dead-letter');
    expect(decideFailure({ attempts: 4, maxAttempts: 3, kind: 'transient' })).toBe('dead-letter');
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with attempts', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
  });

  it('caps at five minutes', () => {
    expect(backoffDelayMs(100)).toBe(5 * 60_000);
  });

  it('honours a server Retry-After when provided', () => {
    expect(backoffDelayMs(1, 7_000)).toBe(7_000);
  });
});
