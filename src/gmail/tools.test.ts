/**
 * The Gmail tools, end to end through the MCP server against a fake Google.
 *
 * The assertions lean on what the server SENDS, not only on what it answers:
 * which account signed the request, what the outgoing message really contains,
 * and that the "safe" tools never reach the endpoints of the dangerous ones.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  ALICE,
  BOB,
  decodeRaw,
  on,
  requests,
  sent,
  startHarness,
  type Harness,
  type Route,
} from '../testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** A Gmail message resource as `users.messages.get` returns it. */
function message(
  id: string,
  opts: {
    threadId?: string;
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    body?: string;
    labels?: string[];
    internalDate?: number;
    messageId?: string;
    references?: string;
  } = {},
): Record<string, unknown> {
  const headers = [
    { name: 'From', value: opts.from ?? 'Ana <ana@cliente.es>' },
    { name: 'To', value: opts.to ?? ALICE },
    { name: 'Subject', value: opts.subject ?? `Asunto ${id}` },
    { name: 'Date', value: new Date(opts.internalDate ?? 1_760_000_000_000).toUTCString() },
    { name: 'Message-ID', value: opts.messageId ?? `<${id}@mail.example>` },
  ];
  if (opts.cc) headers.push({ name: 'Cc', value: opts.cc });
  if (opts.references) headers.push({ name: 'References', value: opts.references });
  return {
    id,
    threadId: opts.threadId ?? `t-${id}`,
    labelIds: opts.labels ?? ['INBOX'],
    snippet: `snippet ${id}`,
    internalDate: String(opts.internalDate ?? 1_760_000_000_000),
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: b64url(opts.body ?? `Cuerpo de ${id}`) },
    },
  };
}

/** Each account's mailbox: search returns its ids, get returns the message. */
function mailboxes(boxes: Record<string, Record<string, unknown>[]>): Route[] {
  return [
    on('GET', '/gmail/v1/users/me/messages', (req) => {
      const box = boxes[req.account ?? ''];
      if (!box) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
      return { body: { messages: box.map((m) => ({ id: m['id'], threadId: m['threadId'] })) } };
    }),
    on('GET', /^\/gmail\/v1\/users\/me\/messages\/[^/]+$/, (req) => {
      const id = req.url.pathname.split('/').pop();
      const found = boxes[req.account ?? '']?.find((m) => m['id'] === id);
      return found ? { body: found } : { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    }),
  ];
}

test('list_accounts reports every account, its alias and a Gmail-only account that needs re-consent', async () => {
  h = await startHarness([], [
    { email: ALICE, alias: 'alice' },
    { email: BOB, scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  ]);
  const { isError, data } = await h.call('list_accounts');
  assert.equal(isError, false);
  assert.equal(data['accountCount'], 2);
  const accounts = data['accounts'] as { email: string; alias: string | null; needsReauthorization: boolean }[];
  assert.deepEqual(
    accounts.map((a) => [a.email, a.alias, a.needsReauthorization]),
    [
      [ALICE, 'alice', false],
      [BOB, null, true],
    ],
  );
  assert.match(String(data['warning']), /bob@example\.com/);
  // Without probe it must not touch the network at all.
  assert.equal(requests.length, 0);
});

test('search_emails over every account merges by date and still answers when one account fails', async () => {
  h = await startHarness(
    mailboxes({
      [ALICE]: [message('a1', { internalDate: 1_760_000_100_000 }), message('a2', { internalDate: 1_760_000_300_000 })],
      // Bob has no mailbox route: his search fails with a 401.
    }),
  );
  const { isError, data } = await h.call('search_emails', { query: 'is:unread' });
  assert.equal(isError, false);
  const results = data['results'] as { id: string; account: string }[];
  assert.deepEqual(
    results.map((r) => r.id),
    ['a2', 'a1'],
    'newest first',
  );
  const failures = data['failures'] as { account: string }[];
  assert.deepEqual(
    failures.map((f) => f.account),
    [BOB],
  );
  // The query reached Gmail exactly as given.
  const searches = sent('GET', /\/users\/me\/messages$/);
  assert.ok(searches.every((r) => r.url.searchParams.get('q') === 'is:unread'));
});

test('search_emails with an alias searches only that account, signed with its own token', async () => {
  h = await startHarness(mailboxes({ [ALICE]: [message('a1')], [BOB]: [message('b1')] }));
  const { data } = await h.call('search_emails', { query: 'factura', account: 'bob' });
  assert.deepEqual(
    (data['results'] as { id: string }[]).map((r) => r.id),
    ['b1'],
  );
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.account === BOB), 'no request may be signed by another account');
});

test('read_message decodes the body and the headers', async () => {
  h = await startHarness(
    mailboxes({ [ALICE]: [message('m1', { subject: 'Presupuesto', body: 'Hola, ¿qué tal? Adjunto el presupuesto.' })] }),
  );
  const { isError, data } = await h.call('read_message', { account: ALICE, message_id: 'm1' });
  assert.equal(isError, false);
  assert.equal(data['subject'], 'Presupuesto');
  assert.equal(data['body'], 'Hola, ¿qué tal? Adjunto el presupuesto.');
  assert.equal(data['from'], 'Ana <ana@cliente.es>');
});

test('read_message on an unknown account is refused before any request is made', async () => {
  h = await startHarness([]);
  const { isError, data } = await h.call('read_message', { account: 'nadie@example.com', message_id: 'm1' });
  assert.equal(isError, true);
  assert.ok(data['error']);
  assert.equal(requests.length, 0);
});

test('read_thread returns every message of the conversation in order', async () => {
  h = await startHarness([
    on('GET', '/gmail/v1/users/me/threads/t1', () => ({
      body: { id: 't1', messages: [message('m1', { threadId: 't1', subject: 'Hilo' }), message('m2', { threadId: 't1', subject: 'Re: Hilo' })] },
    })),
  ]);
  const { data } = await h.call('read_thread', { account: ALICE, thread_id: 't1' });
  assert.equal(data['messageCount'], 2);
  assert.equal(data['subject'], 'Hilo');
  assert.deepEqual(
    (data['messages'] as { id: string }[]).map((m) => m.id),
    ['m1', 'm2'],
  );
});

test('send_message builds a clean RFC 822 message from the right account', async () => {
  h = await startHarness([
    on('POST', '/gmail/v1/users/me/messages/send', () => ({ body: { id: 's1', threadId: 'ts1', labelIds: ['SENT'] } })),
  ]);
  const { isError, data } = await h.call('send_message', {
    account: 'alice',
    to: ['Ana <ana@cliente.es>'],
    cc: ['jefe@cliente.es'],
    subject: 'Reunión del jueves',
    body: 'Nos vemos a las 10.',
  });
  assert.equal(isError, false);
  assert.equal(data['id'], 's1');

  const [req] = sent('POST', /\/messages\/send$/);
  assert.ok(req);
  assert.equal(req.account, ALICE);
  const raw = decodeRaw((req.json as { raw: string }).raw);
  assert.match(raw, /^From: alice@example\.com\r\n/);
  assert.match(raw, /\r\nTo: Ana <ana@cliente\.es>\r\n/);
  assert.match(raw, /\r\nCc: jefe@cliente\.es\r\n/);
  // Non-ASCII subject is RFC 2047-encoded, not sent raw.
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw)?.[1] ?? '';
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Reunión del jueves');
  const body = raw.split('\r\n\r\n')[1] ?? '';
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Nos vemos a las 10.');
});

test('send_message cannot be used to smuggle extra headers through the subject or recipients', async () => {
  h = await startHarness([
    on('POST', '/gmail/v1/users/me/messages/send', () => ({ body: { id: 's1', threadId: 't' } })),
  ]);
  await h.call('send_message', {
    account: ALICE,
    to: ['ana@cliente.es\r\nBcc: espia@evil.example'],
    subject: 'Hola\r\nBcc: espia@evil.example',
    body: 'x',
  });
  const [req] = sent('POST', /\/messages\/send$/);
  assert.ok(req);
  const headers = decodeRaw((req.json as { raw: string }).raw).split('\r\n\r\n')[0] ?? '';
  assert.doesNotMatch(headers, /^Bcc:/m, 'no injected header line');
});

test('send_message rejects an empty recipient list before contacting Gmail', async () => {
  h = await startHarness([]);
  const { isError } = await h.call('send_message', { account: ALICE, to: [], subject: 's', body: 'b' });
  assert.equal(isError, true);
  assert.equal(requests.length, 0);
});

test('create_draft saves a draft and never sends', async () => {
  h = await startHarness([
    on('POST', '/gmail/v1/users/me/drafts', () => ({ body: { id: 'd1', message: { id: 'm9', threadId: 't9' } } })),
  ]);
  const { isError, data } = await h.call('create_draft', {
    account: ALICE,
    to: ['ana@cliente.es'],
    subject: 'Borrador',
    body: 'Pendiente de revisar',
    thread_id: 't9',
  });
  assert.equal(isError, false);
  assert.equal(data['draftId'], 'd1');
  assert.equal(sent('POST', /\/messages\/send$/).length, 0);
  const [req] = sent('POST', /\/drafts$/);
  assert.equal((req?.json as { message: { threadId: string } }).message.threadId, 't9');
});

test('reply threads correctly: Re: prefix once, In-Reply-To, References and the same thread', async () => {
  const original = message('m1', {
    threadId: 't1',
    subject: 'Re: Propuesta',
    cc: 'socio@cliente.es',
    messageId: '<orig@cliente.es>',
    references: '<first@cliente.es>',
  });
  h = await startHarness([
    ...mailboxes({ [ALICE]: [original] }),
    on('POST', '/gmail/v1/users/me/messages/send', () => ({ body: { id: 'r1', threadId: 't1' } })),
  ]);
  const { isError } = await h.call('reply', { account: ALICE, message_id: 'm1', body: 'De acuerdo.' });
  assert.equal(isError, false);

  const [req] = sent('POST', /\/messages\/send$/);
  const json = req?.json as { raw: string; threadId: string };
  assert.equal(json.threadId, 't1');
  const headers = decodeRaw(json.raw).split('\r\n\r\n')[0] ?? '';
  assert.match(headers, /^To: Ana <ana@cliente\.es>$/m);
  assert.match(headers, /^Subject: Re: Propuesta$/m, 'no "Re: Re:"');
  assert.match(headers, /^In-Reply-To: <orig@cliente\.es>$/m);
  assert.match(headers, /^References: <first@cliente\.es> <orig@cliente\.es>$/m);
  assert.doesNotMatch(headers, /^Cc:/m, 'reply without reply_all copies nobody');
});

test('reply with reply_all keeps the original Cc', async () => {
  h = await startHarness([
    ...mailboxes({ [ALICE]: [message('m1', { cc: 'socio@cliente.es' })] }),
    on('POST', '/gmail/v1/users/me/messages/send', () => ({ body: { id: 'r1', threadId: 't' } })),
  ]);
  await h.call('reply', { account: ALICE, message_id: 'm1', body: 'Ok', reply_all: true });
  const [req] = sent('POST', /\/messages\/send$/);
  assert.match(decodeRaw((req?.json as { raw: string }).raw), /^Cc: socio@cliente\.es$/m);
});

const LABELS = on('GET', '/gmail/v1/users/me/labels', () => ({
  body: {
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'UNREAD', name: 'UNREAD', type: 'system' },
      { id: 'Label_7', name: 'Clientes', type: 'user' },
    ],
  },
}));

test('list_labels returns ids, names and types', async () => {
  h = await startHarness([LABELS]);
  const { data } = await h.call('list_labels', { account: ALICE });
  assert.deepEqual(
    (data['labels'] as { id: string; name: string }[]).map((l) => [l.id, l.name]),
    [
      ['INBOX', 'INBOX'],
      ['UNREAD', 'UNREAD'],
      ['Label_7', 'Clientes'],
    ],
  );
});

test('label_message resolves names case-insensitively and sends ids', async () => {
  h = await startHarness([
    LABELS,
    on('POST', '/gmail/v1/users/me/messages/m1/modify', () => ({ body: message('m1', { labels: ['INBOX', 'Label_7'] }) })),
  ]);
  const { isError } = await h.call('label_message', {
    account: ALICE,
    message_id: 'm1',
    add_labels: ['clientes'],
    remove_labels: ['unread'],
  });
  assert.equal(isError, false);
  const [req] = sent('POST', /\/modify$/);
  assert.deepEqual(req?.json, { addLabelIds: ['Label_7'], removeLabelIds: ['UNREAD'] });
});

test('label_message with an unknown label fails and modifies nothing', async () => {
  h = await startHarness([LABELS]);
  const { isError, data } = await h.call('label_message', { account: ALICE, message_id: 'm1', add_labels: ['Inexistente'] });
  assert.equal(isError, true);
  assert.match(String(data['error']), /Inexistente/);
  assert.equal(sent('POST', /\/modify$/).length, 0);
});

test('trash_email moves to the bin, says which message, and never deletes for good', async () => {
  h = await startHarness([
    ...mailboxes({ [ALICE]: [message('m1', { subject: 'Spam evidente' })] }),
    on('POST', '/gmail/v1/users/me/messages/m1/trash', () => ({ body: { id: 'm1', threadId: 't-m1', labelIds: ['TRASH'] } })),
  ]);
  const { isError, data } = await h.call('trash_email', { account: ALICE, message_id: 'm1' });
  assert.equal(isError, false);
  assert.equal(data['trashed'], true);
  assert.equal(data['subject'], 'Spam evidente');
  assert.equal(
    requests.filter((r) => r.method === 'DELETE').length,
    0,
    'trash must never become a permanent delete',
  );
});

test('untrash_email restores the message', async () => {
  h = await startHarness([
    ...mailboxes({ [ALICE]: [message('m1', { labels: ['TRASH'] })] }),
    on('POST', '/gmail/v1/users/me/messages/m1/untrash', () => ({ body: { id: 'm1', threadId: 't-m1', labelIds: ['INBOX'] } })),
  ]);
  const { data } = await h.call('untrash_email', { account: ALICE, message_id: 'm1' });
  assert.equal(data['trashed'], false);
});
