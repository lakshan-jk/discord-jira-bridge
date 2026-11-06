import { describe, expect, it } from 'vitest';
import { channelNameToProjectKey } from './mapper.js';

describe('channelNameToProjectKey', () => {
  it('strips the proj- prefix and uppercases (design #3)', () => {
    expect(channelNameToProjectKey('proj-checkout')).toBe('CHECKOUT');
  });

  it('normalizes longer multi-word names into a valid key', () => {
    expect(channelNameToProjectKey('proj-payment-service')).toBe('PAYMENTSERVICE');
    expect(channelNameToProjectKey('project-billing')).toBe('BILLING');
  });

  it('accepts a bare channel name with no prefix', () => {
    expect(channelNameToProjectKey('checkout')).toBe('CHECKOUT');
  });

  it('returns null when no valid key can be derived', () => {
    expect(channelNameToProjectKey('proj-')).toBeNull();
    expect(channelNameToProjectKey('123')).toBeNull(); // must start with a letter
    expect(channelNameToProjectKey('   ')).toBeNull();
  });
});
