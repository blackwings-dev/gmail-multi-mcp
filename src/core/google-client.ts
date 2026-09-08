/**
 * Authenticated API clients, one per account per service, plus the scope gate.
 *
 * ⚠️ THE SCOPE GATE LIVES HERE, AND ONLY HERE.
 *
 * Every Drive and Calendar tool has to go through a client, and every client
 * comes from this class — so an account missing a scope is refused by
 * construction rather than by each handler remembering to ask. Putting the
 * check in the handlers would leave a blind spot the moment someone adds one
 * more tool and forgets: the boundary has to be defined by what the thing *is*
 * (a call into an API) and not by where the code happens to sit.
 */

import { getAuthenticatedClient, grantedScopes, type GoogleOAuthClient } from '../auth/oauth.js';
import { readTokens, resolveAccount } from '../auth/token-store.js';
import type { AccountId } from './errors.js';
import { GmailMcpError } from './errors.js';

export interface ServiceRequirement {
  /** Human name of the API, used in error messages: "Gmail", "Drive", "Calendar". */
  name: string;
  /** Holding ANY ONE of these is enough. Lets a narrower scope satisfy a service. */
  anyOf: readonly string[];
}

/**
 * Refuses an account that was never granted the scope this service needs.
 *
 * This is not a nicety. Without it the user gets a raw Google 403 whose text
 * ("Request had insufficient authentication scopes") gives no hint that the fix
 * is re-running setup, and an agent will retry it forever.
 */
async function assertScope(email: AccountId, requirement: ServiceRequirement): Promise<void> {
  const tokens = await readTokens(email);
  if (!tokens) {
    throw new GmailMcpError(
      'NOT_AUTHORIZED',
      `No stored credentials for ${email}. Run "gmail-multi-mcp setup" and authorise the account.`,
      email,
    );
  }

  const granted = grantedScopes(tokens.scope);
  if (requirement.anyOf.some((scope) => granted.has(scope))) return;

  throw new GmailMcpError(
    'MISSING_SCOPE',
    `${email} is authorised, but not for ${requirement.name}. This account was connected ` +
      `before ${requirement.name} support was added, and a token refresh will NOT fix it: ` +
      `Google binds a refresh token to the scopes granted when it was issued. Re-run ` +
      `"gmail-multi-mcp setup" and add this account again with option 1 — it re-consents ` +
      `and overwrites in place, so there is nothing to remove first. The other services ` +
      `keep working meanwhile.`,
    email,
  );
}

/**
 * A per-account client cache for one Google API.
 *
 * Caching is not only a speed optimisation: the underlying `OAuth2Client` owns
 * the `tokens` listener that persists refreshed credentials, so rebuilding it
 * per call would multiply listeners and re-read the token file for nothing.
 */
export class AccountClientCache<T> {
  private readonly requirement: ServiceRequirement;
  private readonly build: (auth: GoogleOAuthClient) => T;
  private readonly cache = new Map<AccountId, Promise<T>>();

  constructor(requirement: ServiceRequirement, build: (auth: GoogleOAuthClient) => T) {
    this.requirement = requirement;
    this.build = build;
  }

  /** Resolves an account reference (email or alias) and returns a ready client. */
  async for(reference: AccountId): Promise<{ email: AccountId; api: T }> {
    const account = await resolveAccount(reference);

    // Checked on every call, not once at build time: the user may re-authorise
    // while the server is running, and a cached verdict would outlive the fix.
    await assertScope(account.email, this.requirement);

    let pending = this.cache.get(account.email);
    if (!pending) {
      pending = getAuthenticatedClient(account.email).then((auth) => this.build(auth));
      this.cache.set(account.email, pending);
    }

    try {
      return { email: account.email, api: await pending };
    } catch (error) {
      // A failed build must not poison the cache for every later call.
      this.cache.delete(account.email);
      throw error;
    }
  }
}
