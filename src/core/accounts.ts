/**
 * Running one operation across every configured account.
 *
 * This is the shape the whole server is built around: a cross-account call must
 * degrade rather than fail, because one revoked account taking down a search
 * over the other four is worse than useless — it is silently wrong.
 *
 * Deliberately NOT a merge helper. Each caller merges its own way: email by
 * date, Drive by modification time, free/busy by interval intersection. A
 * generic merge would have to be wrong for two of the three.
 */

import { readConfig } from '../auth/token-store.js';
import type { AccountId } from './errors.js';
import { GmailMcpError } from './errors.js';

export interface AccountOutcome<T> {
  account: AccountId;
  ok: boolean;
  value?: T;
  error?: string;
}

export interface AcrossAccounts<T> {
  /** Every account, in configuration order, successes and failures alike. */
  outcomes: AccountOutcome<T>[];
  /** The accounts that answered. */
  succeeded: AccountId[];
  /** Only the failures, in the shape tool responses report them. */
  failures: { account: AccountId; error: string }[];
  /** The values of the accounts that answered, in configuration order. */
  values: T[];
}

/**
 * Runs `task` once per configured account, in parallel, capturing failures as
 * values instead of exceptions.
 *
 * `only` restricts the run to a subset — emails or aliases. Omitted, it means
 * every configured account.
 *
 * Throws only when there is nothing to run against at all: an empty account
 * list is a configuration problem the user has to fix, not a partial result.
 */
export async function runAcrossAccounts<T>(
  task: (account: AccountId) => Promise<T>,
  only?: readonly AccountId[],
): Promise<AcrossAccounts<T>> {
  const targets =
    only && only.length > 0 ? [...only] : (await readConfig()).accounts.map((a) => a.email);

  if (targets.length === 0) {
    throw new GmailMcpError(
      'NO_ACCOUNTS',
      'No accounts are configured. Run "gmail-multi-mcp setup" to add one.',
    );
  }

  const outcomes: AccountOutcome<T>[] = await Promise.all(
    targets.map(async (reference): Promise<AccountOutcome<T>> => {
      try {
        return { account: reference, ok: true, value: await task(reference) };
      } catch (error) {
        return {
          account: reference,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const values: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok && outcome.value !== undefined) values.push(outcome.value);
  }

  return {
    outcomes,
    succeeded: outcomes.filter((o) => o.ok).map((o) => o.account),
    failures: outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ account: o.account, error: o.error ?? 'unknown error' })),
    values,
  };
}
