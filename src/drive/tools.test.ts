/**
 * The Drive tools, end to end through the MCP server against a fake Google.
 *
 * drive_share is the one that can leak real data, so most of the care goes
 * there: no notification email unless asked, never a notification for a public
 * link, and no permission created when the request is incomplete.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { ALICE, BOB, on, requests, sent, startHarness, type Harness } from '../testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DOC = 'application/vnd.google-apps.document';

function file(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `${id}.txt`,
    mimeType: 'text/plain',
    size: '12',
    modifiedTime: '2026-10-10T10:00:00.000Z',
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    parents: ['root'],
    ...extra,
  };
}

test('drive_search across accounts matches name and contents and skips the bin', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/files', (req) => ({
      body: { files: [file(req.account === ALICE ? 'a1' : 'b1')] },
    })),
  ]);
  const { isError, data } = await h.call('drive_search', { query: "presupuesto d'Ana" });
  assert.equal(isError, false);
  assert.deepEqual(
    (data['results'] as { id: string }[]).map((f) => f.id).sort(),
    ['a1', 'b1'],
  );
  for (const req of sent('GET', /^\/drive\/v3\/files$/)) {
    const q = req.url.searchParams.get('q') ?? '';
    assert.match(q, /name contains 'presupuesto d\\'Ana' or fullText contains 'presupuesto d\\'Ana'/, 'quote escaped');
    assert.match(q, /trashed = false$/);
  }
});

test('drive_search without any query is refused before contacting Drive', async () => {
  h = await startHarness([]);
  const { isError } = await h.call('drive_search', { account: ALICE });
  assert.equal(isError, true);
  assert.equal(requests.length, 0);
});

test('drive_read exports a Google Doc to plain text', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/files/d1', () => ({ body: file('d1', { name: 'Contrato', mimeType: DOC, size: undefined }) })),
    on('GET', '/drive/v3/files/d1/export', (req) => {
      assert.equal(req.url.searchParams.get('mimeType'), 'text/plain');
      return { text: 'Cláusula primera.' };
    }),
  ]);
  const { isError, data } = await h.call('drive_read', { account: ALICE, file_id: 'd1' });
  assert.equal(isError, false);
  assert.equal(data['content'], 'Cláusula primera.');
  assert.equal(data['exportedAs'], 'text/plain');
});

test('drive_read truncates to max_chars and says so', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/files/t1', (req) =>
      req.url.searchParams.get('alt') === 'media' ? { text: 'x'.repeat(600) + 'FIN' } : { body: file('t1', { size: '603' }) },
    ),
  ]);
  const { data } = await h.call('drive_read', { account: ALICE, file_id: 't1', max_chars: 500 });
  assert.equal(data['content'], 'x'.repeat(500));
  assert.equal(data['truncated'], true);
});

test('drive_read refuses a binary file instead of dumping it', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/files/p1', () => ({ body: file('p1', { name: 'foto.png', mimeType: 'image/png' }) })),
  ]);
  const { isError, data } = await h.call('drive_read', { account: ALICE, file_id: 'p1' });
  assert.equal(isError, true);
  assert.match(String(data['error']), /not text/);
  assert.equal(
    requests.filter((r) => r.url.searchParams.get('alt') === 'media').length,
    0,
    'the binary is never downloaded',
  );
});

test('drive_list lists a folder, defaulting to the root', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/files', () => ({
      body: { files: [file('f1', { mimeType: 'application/vnd.google-apps.folder', name: 'Clientes' }), file('x1')] },
    })),
  ]);
  const { isError, data } = await h.call('drive_list', { account: ALICE });
  assert.equal(isError, false);
  const q = sent('GET', /^\/drive\/v3\/files$/)[0]?.url.searchParams.get('q');
  assert.equal(q, "'root' in parents and trashed = false");
  const entries = (data['files'] ?? data['entries']) as { name: string; isFolder: boolean }[];
  assert.equal(entries[0]?.name, 'Clientes');
  assert.equal(entries[0]?.isFolder, true, 'folders first');
});

test('drive_upload puts inline text in the given folder', async () => {
  h = await startHarness([
    on('POST', '/upload/drive/v3/files', () => ({ body: file('u1', { name: 'notas.md', parents: ['F1'] }) })),
  ]);
  const { isError, data } = await h.call('drive_upload', {
    account: BOB,
    name: 'notas.md',
    content: '# Notas de la reunión',
    parent_folder_id: 'F1',
  });
  assert.equal(isError, false);
  assert.equal(data['id'], 'u1');
  const [req] = sent('POST', /^\/upload\/drive\/v3\/files$/);
  assert.equal(req?.account, BOB);
  assert.match(req?.body ?? '', /"parents":\["F1"\]/);
  assert.match(req?.body ?? '', /# Notas de la reunión/);
});

test('drive_upload refuses both inline content and a local path at once', async () => {
  h = await startHarness([]);
  const { isError } = await h.call('drive_upload', { account: ALICE, name: 'x.txt', content: 'a', local_path: '/etc/hosts' });
  assert.equal(isError, true);
  assert.equal(requests.length, 0);
});

test('drive_create_doc asks Drive for a real Google Doc converted from text', async () => {
  h = await startHarness([
    on('POST', '/upload/drive/v3/files', () => ({ body: file('g1', { name: 'Acta', mimeType: DOC }) })),
  ]);
  const { isError, data } = await h.call('drive_create_doc', { account: ALICE, name: 'Acta', content: 'Primera línea\nSegunda' });
  assert.equal(isError, false);
  assert.equal(data['mimeType'], DOC);
  assert.match(sent('POST', /\/files$/)[0]?.body ?? '', /"mimeType":"application\/vnd\.google-apps\.document"/);
});

const SHARE_ROUTES = [
  on('GET', '/drive/v3/files/s1', () => ({ body: { id: 's1', name: 'Propuesta.pdf', webViewLink: 'https://drive.google.com/s1' } })),
  on('POST', '/drive/v3/files/s1/permissions', (req) => ({ body: { id: 'perm1', ...(req.json as object) } })),
];

test('drive_share with a person sends no notification email unless asked', async () => {
  h = await startHarness(SHARE_ROUTES);
  const { isError, data } = await h.call('drive_share', {
    account: ALICE,
    file_id: 's1',
    type: 'user',
    role: 'reader',
    email_address: 'ana@cliente.es',
  });
  assert.equal(isError, false);
  assert.equal(data['fileName'], 'Propuesta.pdf');
  const [req] = sent('POST', /\/permissions$/);
  assert.equal(req?.url.searchParams.get('sendNotificationEmail'), 'false');
  assert.deepEqual(req?.json, { type: 'user', role: 'reader', emailAddress: 'ana@cliente.es' });
});

test('drive_share never sends a notification for a public link, even if asked', async () => {
  h = await startHarness(SHARE_ROUTES);
  const { data } = await h.call('drive_share', { account: ALICE, file_id: 's1', type: 'anyone', role: 'reader', notify: true });
  assert.equal(data['publicLink'], true);
  assert.equal(sent('POST', /\/permissions$/)[0]?.url.searchParams.get('sendNotificationEmail'), 'false');
});

test('drive_share for a user without an address creates no permission', async () => {
  h = await startHarness(SHARE_ROUTES);
  const { isError } = await h.call('drive_share', { account: ALICE, file_id: 's1', type: 'user', role: 'writer' });
  assert.equal(isError, true);
  assert.equal(sent('POST', /\/permissions$/).length, 0);
});

test('drive_share rejects ownership transfer at the schema', async () => {
  h = await startHarness(SHARE_ROUTES);
  const { isError } = await h.call('drive_share', {
    account: ALICE,
    file_id: 's1',
    type: 'user',
    role: 'owner',
    email_address: 'ana@cliente.es',
  });
  assert.equal(isError, true);
  assert.equal(requests.length, 0);
});

test('a Drive tool on an account without the Drive scope is refused before any request', async () => {
  h = await startHarness([], [{ email: ALICE, scopes: ['https://www.googleapis.com/auth/gmail.modify'] }]);
  const { isError, data } = await h.call('drive_list', { account: ALICE });
  assert.equal(isError, true);
  assert.equal(data['code'], 'MISSING_SCOPE');
  assert.equal(requests.length, 0);
});

test('drive_shared_drives lists the shared drives of an account with their ids', async () => {
  h = await startHarness([
    on('GET', '/drive/v3/drives', () => ({ body: { drives: [{ id: 'SD1', name: 'Clientes' }] } })),
  ]);
  const { isError, data } = await h.call('drive_shared_drives', { account: ALICE });
  assert.equal(isError, false);
  assert.match(JSON.stringify(data), /"id":\s*"SD1"/);
  assert.match(JSON.stringify(data), /"name":\s*"Clientes"/);
  assert.ok(requests.every((r) => r.account === ALICE));
});
