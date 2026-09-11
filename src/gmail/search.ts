/**
 * Search, over one account or over all of them at once.
 *
 * The multi-account case is the reason this server exists, so it is built to
 * degrade rather than fail: one revoked account must not take down a search
 * across the other four.
 */

import type { gmail_v1 } from '@googleapis/gmail';
import { readConfig } from '../auth/token-store.js';
import { mapWithConcurrency } from '../core/concurrency.js';
import { gmailFor, mapGmailError, summarizeMessage } from './client.js';
import type { AccountId, EmailSummary, MultiAccountSearchResult } from './types.js';
import { GmailMcpError } from './types.js';

/** Gmail allows 500; this is a context-window limit, not an API one. */
const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 20;

/**
 * `messages.list` returns bare ids, so every hit costs a second request.
 * Six at a time keeps latency down without tripping per-user rate limits.
 */
const METADATA_CONCURRENCY = 6;

/** Only the headers the summary actually shows — a smaller, faster response. */
const SUMMARY_HEADERS = ['From', 'Subject', 'Date'];

export interface SortableSummary {
  summary: EmailSummary;
  /** Epoch ms. Gmail's `internalDate` is authoritative; the Date header lies. */
  sortKey: number;
}

/** A search over one account: either its messages, or why it could not answer. */
interface AccountOutcome {
  account: AccountId;
  ok: boolean;
  messages: SortableSummary[];
  error?: string;
}

function clampMaxResults(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(requested), MAX_RESULTS_CAP);
}

async function hydrate(
  api: gmail_v1.Gmail,
  account: AccountId,
  ids: string[],
): Promise<SortableSummary[]> {
  const fetched = await mapWithConcurrency(ids, METADATA_CONCURRENCY, async (id) => {
    const response = await api.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: SUMMARY_HEADERS,
    });
    return response.data;
  });

  return fetched.map((message) => ({
    summary: summarizeMessage(account, message),
    sortKey: Number.parseInt(message.internalDate ?? '0', 10) || 0,
  }));
}

/**
 * Orders messages newest first and trims to `limit`.
 *
 * Split out from the fetching so it can be tested without a network, because
 * the ordering is not cosmetic: `limit` applies per account on the way in, and
 * the merged list is cut to the same number afterwards. The sort decides *which
 * messages survive the cut*, so getting it wrong does not reorder a page — it
 * drops mail from it.
 *
 * The key is always `internalDate`, never the `Date` header. The header is
 * written by whoever sent the message and is routinely wrong; one message
 * claiming to be from 2099 would be enough to push a real one out of the page.
 */
export function mergeByRecency(perAccount: SortableSummary[][], limit: number): EmailSummary[] {
  return perAccount
    .flat()
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, limit)
    .map((entry) => entry.summary);
}

/** Fetches one account's hits, still carrying their sort keys. Throws on failure. */
async function fetchAccount(
  reference: AccountId,
  query: string,
  limit: number,
): Promise<SortableSummary[]> {
  const { email, api } = await gmailFor(reference);

  try {
    const listed = await api.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: limit,
    });

    const ids = (listed.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');

    if (ids.length === 0) return [];

    return await hydrate(api, email, ids);
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

/** Searches a single account. Throws on failure — the caller decides how to react. */
export async function searchAccount(
  reference: AccountId,
  query: string,
  maxResults?: number,
): Promise<EmailSummary[]> {
  const limit = clampMaxResults(maxResults);
  return mergeByRecency([await fetchAccount(reference, query, limit)], limit);
}

/** Searches one account and captures failure as a value instead of throwing. */
async function searchAccountSafely(
  account: AccountId,
  query: string,
  maxResults: number,
): Promise<AccountOutcome> {
  try {
    return { account, ok: true, messages: await fetchAccount(account, query, maxResults) };
  } catch (error) {
    return {
      account,
      ok: false,
      messages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Searches every configured account in parallel and merges the results.
 *
 * `maxResults` is per account, then the merged list is trimmed to the same
 * number: asking for 20 across three accounts should not return 60.
 */
export async function searchAllAccounts(
  query: string,
  maxResults?: number,
): Promise<MultiAccountSearchResult> {
  const limit = clampMaxResults(maxResults);
  const config = await readConfig();

  if (config.accounts.length === 0) {
    throw new GmailMcpError(
      'NO_ACCOUNTS',
      'No Gmail accounts are configured. Run "gmail-multi-mcp setup" to add one.',
    );
  }

  const outcomes = await Promise.all(
    config.accounts.map((account) => searchAccountSafely(account.email, query, limit)),
  );

  // Re-sort the merged set: per-account ordering says nothing about the whole.
  const merged = mergeByRecency(
    outcomes.map((outcome) => outcome.messages),
    limit,
  );

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ account: o.account, error: o.error ?? 'unknown error' }));

  const result: MultiAccountSearchResult = {
    query,
    accountsSearched: outcomes.filter((o) => o.ok).map((o) => o.account),
    totalResults: merged.length,
    results: merged,
  };

  // Silence about a failed account would be the worst outcome: the agent would
  // read "3 results" and never learn that a fourth mailbox was unreachable.
  if (failures.length > 0) result.failures = failures;

  return result;
}
