/**
 * Merging results from several mailboxes into one page.
 *
 * This is the part of multi-account search that can lose mail. `maxResults` is
 * applied per account when fetching, and the merged list is then cut to the
 * same number — so the sort order is what decides which messages make it into
 * the answer and which are silently dropped.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeByRecency, type SortableSummary } from './search.js';
import type { AccountId, EmailSummary } from './types.js';

/**
 * A summary whose `date` header disagrees with its true `internalDate`.
 *
 * Defaults to a header an hour *ahead* of reality, which is the shape of the
 * problem: senders inflate their dates, they rarely understate them.
 */
function hit(
  account: AccountId,
  id: string,
  internalDate: number,
  headerDate = new Date(internalDate + 3_600_000).toUTCString(),
): SortableSummary {
  const summary: EmailSummary = {
    account,
    id,
    threadId: id,
    from: 'someone@example.com',
    subject: id,
    date: headerDate,
    snippet: null,
    labelIds: [],
    unread: false,
  };
  return { summary, sortKey: internalDate };
}

const ids = (summaries: EmailSummary[]): string[] => summaries.map((s) => s.id);

const T = Date.UTC(2026, 8, 11, 12, 0, 0);
const minutes = (n: number): number => n * 60_000;

test('interleaves accounts by recency rather than by account', () => {
  const a = [hit('a@x.com', 'a-new', T), hit('a@x.com', 'a-old', T - minutes(30))];
  const b = [hit('b@x.com', 'b-mid', T - minutes(10))];

  assert.deepEqual(ids(mergeByRecency([a, b], 10)), ['a-new', 'b-mid', 'a-old']);
});

/**
 * The reason the limit is applied again after merging: asking for 20 across
 * three accounts must not return 60.
 */
test('trims the merged page to the limit, keeping the newest', () => {
  const a = [hit('a@x.com', 'a1', T), hit('a@x.com', 'a2', T - minutes(40))];
  const b = [hit('b@x.com', 'b1', T - minutes(10)), hit('b@x.com', 'b2', T - minutes(50))];

  const merged = mergeByRecency([a, b], 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(ids(merged), ['a1', 'b1']);
});

/**
 * The regression this function exists for.
 *
 * A message whose `Date` header claims 2099 must not climb to the top. Ordering
 * by the header would put it first and, with the trim right behind, push a real
 * message out of the page entirely.
 */
test('a forged Date header does not reorder the page', () => {
  const liar = hit('a@x.com', 'forged', T - minutes(120), 'Fri, 01 Jan 2099 00:00:00 +0000');
  const real = [hit('b@x.com', 'real-1', T), hit('b@x.com', 'real-2', T - minutes(5))];

  const merged = mergeByRecency([[liar], real], 2);
  assert.deepEqual(ids(merged), ['real-1', 'real-2'], 'the forged date must not win');
  assert.ok(
    !ids(merged).includes('forged'),
    'and it must not displace a genuinely newer message',
  );
});

/** A missing or unparseable header must not matter at all: it is never read. */
test('messages with no usable Date header still sort correctly', () => {
  const noHeader = hit('a@x.com', 'headerless', T - minutes(1));
  noHeader.summary.date = null;
  const garbage = hit('a@x.com', 'garbage', T - minutes(2), 'not a date at all');

  assert.deepEqual(
    ids(mergeByRecency([[garbage, noHeader], [hit('b@x.com', 'newest', T)]], 10)),
    ['newest', 'headerless', 'garbage'],
  );
});

test('an account that returned nothing contributes nothing', () => {
  const a = [hit('a@x.com', 'only', T)];
  assert.deepEqual(ids(mergeByRecency([a, [], []], 10)), ['only']);
  assert.deepEqual(mergeByRecency([[], []], 10), []);
});

test('a limit larger than the result set returns everything', () => {
  const a = [hit('a@x.com', 'a1', T)];
  const b = [hit('b@x.com', 'b1', T - minutes(1))];
  assert.equal(mergeByRecency([a, b], 100).length, 2);
});
