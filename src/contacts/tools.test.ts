/**
 * The Contacts tools, end to end through the MCP server against a fake Google.
 *
 * The People API has two traps this server is built around: search needs a
 * warm-up request first, and an update REPLACES every field it names. The tests
 * pin both, plus the etag that stops an update from overwriting someone else's
 * edit.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { ALICE, BOB, on, requests, sent, startHarness, type Harness } from '../testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function person(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceName: `people/${id}`,
    etag: `etag-${id}`,
    names: [{ displayName: name, givenName: name.split(' ')[0], familyName: name.split(' ')[1] }],
    emailAddresses: [{ value: `${id}@cliente.es` }],
    ...extra,
  };
}

const SEARCH = '/v1/people:searchContacts';

test('contacts_search warms the cache first, then searches every account and keeps duplicates apart', async () => {
  h = await startHarness([
    on('GET', SEARCH, (req) => {
      if (req.url.searchParams.get('query') === '') return { body: {} };
      return {
        body: {
          results: [{ person: person(req.account === ALICE ? 'ca' : 'cb', req.account === ALICE ? 'Ana López' : 'Ana López') }],
        },
      };
    }),
  ]);
  const { isError, data } = await h.call('contacts_search', { query: 'Ana' });
  assert.equal(isError, false);
  const results = data['results'] as { resourceName: string; account: string }[];
  assert.deepEqual(
    results.map((r) => [r.account, r.resourceName]).sort(),
    [
      [ALICE, 'people/ca'],
      [BOB, 'people/cb'],
    ],
    'the same person in two address books is returned twice, each with its own id',
  );
  for (const account of [ALICE, BOB]) {
    const queries = sent('GET', /searchContacts$/)
      .filter((r) => r.account === account)
      .map((r) => r.url.searchParams.get('query'));
    assert.deepEqual(queries, ['', 'Ana'], 'warm-up (empty query) before the real search');
  }
});

test('contacts_get refuses an id that is not a contact id, without calling Google', async () => {
  h = await startHarness([]);
  const { isError, data } = await h.call('contacts_get', { account: ALICE, resource_name: 'ana@cliente.es' });
  assert.equal(isError, true);
  assert.match(String(data['error']), /people\//);
  assert.equal(requests.length, 0);
});

test('contacts_get returns the contact fields', async () => {
  h = await startHarness([
    on('GET', '/v1/people/c1', () => ({
      body: person('c1', 'Ana López', {
        organizations: [{ name: 'Cliente SL', title: 'CTO' }],
        phoneNumbers: [{ value: '+34 600 000 000' }],
      }),
    })),
  ]);
  const { data } = await h.call('contacts_get', { account: ALICE, resource_name: 'people/c1' });
  assert.equal(data['displayName'], 'Ana López');
  assert.deepEqual(
    (data['phones'] as { value: string }[]).map((p) => p.value),
    ['+34 600 000 000'],
  );
  assert.equal((data['organizations'] as { title: string }[])[0]?.title, 'CTO');
});

test('contacts_list pages through the address book', async () => {
  h = await startHarness([
    on('GET', '/v1/people/me/connections', (req) => {
      assert.equal(req.url.searchParams.get('pageToken'), 'p2');
      return { body: { connections: [person('c1', 'Ana López'), person('c2', 'Luis Pérez')], nextPageToken: 'p3' } };
    }),
  ]);
  const { data } = await h.call('contacts_list', { account: ALICE, page_token: 'p2' });
  assert.equal(data['totalResults'], 2);
  assert.equal(data['nextPageToken'], 'p3');
});

test('contacts_create sends only the fields given', async () => {
  h = await startHarness([
    on('POST', '/v1/people:createContact', (req) => ({ body: { resourceName: 'people/new', etag: 'e', ...(req.json as object) } })),
  ]);
  const { isError, data } = await h.call('contacts_create', {
    account: BOB,
    given_name: 'Luis',
    family_name: 'Pérez',
    emails: ['luis@cliente.es'],
    organization: 'Cliente SL',
  });
  assert.equal(isError, false);
  assert.equal(data['resourceName'], 'people/new');
  const [req] = sent('POST', /createContact$/);
  assert.equal(req?.account, BOB);
  assert.deepEqual(req?.json, {
    names: [{ givenName: 'Luis', familyName: 'Pérez' }],
    emailAddresses: [{ value: 'luis@cliente.es' }],
    organizations: [{ name: 'Cliente SL' }],
  });
});

test('contacts_update carries the current etag and replaces only the fields it names', async () => {
  h = await startHarness([
    on('GET', '/v1/people/c1', () => ({ body: person('c1', 'Ana López') })),
    on('PATCH', '/v1/people/c1:updateContact', (req) => ({ body: { resourceName: 'people/c1', ...(req.json as object) } })),
  ]);
  const { isError } = await h.call('contacts_update', {
    account: ALICE,
    resource_name: 'people/c1',
    phones: ['+34 611 111 111'],
  });
  assert.equal(isError, false);
  const [req] = sent('PATCH', /updateContact$/);
  assert.equal(req?.url.searchParams.get('updatePersonFields'), 'phoneNumbers', 'emails and names stay untouched');
  assert.deepEqual(req?.json, { phoneNumbers: [{ value: '+34 611 111 111' }], etag: 'etag-c1' });
});

test('contacts_update with nothing to change sends no update', async () => {
  h = await startHarness([on('GET', '/v1/people/c1', () => ({ body: person('c1', 'Ana López') }))]);
  const { isError } = await h.call('contacts_update', { account: ALICE, resource_name: 'people/c1' });
  assert.equal(isError, true);
  assert.equal(sent('PATCH', /.*/).length, 0);
});
