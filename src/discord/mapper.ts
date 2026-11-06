/**
 * Channel-name -> JIRA-project-key derivation (design decision #3).
 *
 *   proj-checkout        -> CHECKOUT
 *   proj-payment-service -> PAYMENTSERVICE
 *   checkout             -> CHECKOUT
 *
 * Pure. Returns null when no syntactically valid key can be derived (e.g. a channel
 * with no letters). Note: this only normalizes the *shape* of the key — whether a
 * matching JIRA project actually exists is the sync engine's log-and-skip (design
 * #3), deliberately not checked here.
 */

const PREFIXES = ['proj-', 'project-'];

export function channelNameToProjectKey(channelName: string): string | null {
  let name = channelName.trim().toLowerCase();

  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }

  // JIRA keys are uppercase alphanumeric; strip everything else.
  const key = name.replace(/[^a-z0-9]/g, '').toUpperCase();

  // A valid key must be non-empty and start with a letter.
  if (key.length === 0 || !/^[A-Z]/.test(key)) {
    return null;
  }
  return key;
}
