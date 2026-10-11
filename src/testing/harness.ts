/**
 * Runs the real MCP server against a fake Google, for the tool tests.
 *
 * What is real: the server, every tool handler, the zod schemas, the account and
 * scope plumbing, the OAuth client and the googleapis request builders. What is
 * fake: the network. Each test gets a throwaway home directory with a config and
 * tokens, and every HTTP request Google's libraries make is answered by a route
 * the test declares — and recorded, so a test can assert on what was SENT, which
 * is where the bugs that matter live (who gets mailed, what gets deleted).
 *
 * ⚠️ IMPORT ORDER. `token-store.ts` resolves `homedir()` when it is first loaded,
 * so the home directory has to be pointed at the sandbox BEFORE any module of
 * the server is imported. That is why the server is loaded with a dynamic
 * `import()` inside `startHarness`, and why every test file imports this module
 * and nothing else from `src/`.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export const ALICE = 'alice@example.com';
export const BOB = 'bob@example.com';

const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE = 'https://www.googleapis.com/auth/drive';
const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const CONTACTS = 'https://www.googleapis.com/auth/contacts';
export const ALL_SCOPES = [GMAIL, DRIVE, CALENDAR, CONTACTS];

// ---------------------------------------------------------------------------
// The sandbox home. Set once per process, before the server is imported.
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'gmail-multi-mcp-test-'));
// Fake tokens, but still: nothing of a test run is left behind in the temp dir.
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['GOOGLE_CLIENT_ID'] = 'test-client-id.apps.googleusercontent.com';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-client-secret';

const root = join(home, '.gmail-multi-mcp');
mkdirSync(join(root, 'tokens'), { recursive: true });

interface TestAccount {
  email: string;
  alias?: string;
  scopes?: string[];
}

function writeAccounts(accounts: TestAccount[]): void {
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      accounts: accounts.map((a) => ({ email: a.email, ...(a.alias ? { alias: a.alias } : {}) })),
    }),
  );
  for (const a of accounts) {
    writeFileSync(
      join(root, 'tokens', `${encodeURIComponent(a.email)}.json`),
      JSON.stringify({
        accessToken: `access-${a.email}`,
        refreshToken: `refresh-${a.email}`,
        // Far in the future, so the auth library never tries to refresh.
        expiryDate: Date.now() + 365 * 24 * 3_600_000,
        scope: (a.scopes ?? ALL_SCOPES).join(' '),
        tokenType: 'Bearer',
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// The fake network
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  url: URL;
  /** Which account's token signed it, from the Authorization header. */
  account: string | null;
  body: string;
  /** `body` parsed as JSON, or null when it is not JSON (multipart uploads). */
  json: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  /** A plain-text body, for downloads and exports. Wins over `body`. */
  text?: string;
}

export type Route = (req: RecordedRequest) => FakeResponse | undefined;

let routes: Route[] = [];
export const requests: RecordedRequest[] = [];

async function fakeFetch(input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url: string }).url));
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  const auth = headers.get('authorization') ?? '';
  const body = await readBody(init?.body);
  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = null;
  }
  const req: RecordedRequest = {
    method: (init?.method ?? 'GET').toUpperCase(),
    url,
    account: auth.startsWith('Bearer access-') ? auth.slice('Bearer access-'.length) : null,
    body,
    json,
  };
  requests.push(req);

  for (const route of routes) {
    const res = route(req);
    if (res) {
      const status = res.status ?? 200;
      if (res.text !== undefined) {
        return new Response(res.text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const payload = res.body === undefined ? '' : JSON.stringify(res.body);
      return new Response(status === 204 ? null : payload, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  return new Response(
    JSON.stringify({ error: { code: 404, message: `no fake route for ${req.method} ${url.pathname}` } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}

async function readBody(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<unknown>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return String(body);
}

/**
 * Every Google request goes through a `Gaxios` instance, and there are two
 * copies of the package installed (one nested under googleapis-common), each
 * with a CommonJS and an ESM build. All four are patched, so whichever one a
 * library resolves to ends up on the fake network — and nothing can reach the
 * real one by accident.
 */
async function patchGaxios(): Promise<void> {
  const require = createRequire(import.meta.url);
  const entries = new Set<string>();
  for (const from of ['google-auth-library', 'googleapis-common', '@googleapis/gmail']) {
    try {
      entries.add(require.resolve('gaxios', { paths: [dirname(require.resolve(from))] }));
    } catch {
      /* That library is not installed, or brings no gaxios of its own. */
    }
  }
  for (const entry of entries) {
    const cjs = require(entry) as { Gaxios: { prototype: { request: (opts?: object) => unknown } } };
    patch(cjs.Gaxios);
    const esmEntry = entry.replace(/[\\/]cjs[\\/]/, (m) => m.replace('cjs', 'esm'));
    try {
      const esm = (await import(pathToFileURL(esmEntry).href)) as { Gaxios: { prototype: { request: (opts?: object) => unknown } } };
      patch(esm.Gaxios);
    } catch {
      /* No ESM build at that path: the CJS patch is the one in use. */
    }
  }
}

const PATCHED = Symbol('patched');
function patch(Gaxios: { prototype: { request: (opts?: object) => unknown } & { [PATCHED]?: true } }): void {
  if (Gaxios.prototype[PATCHED]) return;
  const original = Gaxios.prototype.request;
  Gaxios.prototype.request = function (this: unknown, opts: object = {}) {
    return original.call(this, { ...opts, fetchImplementation: fakeFetch, retry: false });
  };
  Gaxios.prototype[PATCHED] = true;
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface ToolCall {
  isError: boolean;
  /** The tool's JSON payload, parsed. */
  data: Record<string, unknown>;
}

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Starts a fresh server over an in-memory transport.
 *
 * `routes` answer the fake network for this test; `accounts` defaults to Alice
 * and Bob with every scope granted.
 */
export async function startHarness(
  testRoutes: Route[],
  accounts: TestAccount[] = [{ email: ALICE, alias: 'alice' }, { email: BOB, alias: 'bob' }],
): Promise<Harness> {
  writeAccounts(accounts);
  routes = testRoutes;
  requests.length = 0;
  await patchGaxios();

  const { createMcpServer } = await import('../server.js');
  const server = createMcpServer();
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      const text = result.content.map((c) => c.text).join('');
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { text };
      }
      return { isError: result.isError === true, data };
    },
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

/** Matches a method and a path; the path may be a RegExp. */
export function on(method: string, path: string | RegExp, respond: (req: RecordedRequest) => FakeResponse): Route {
  return (req) => {
    if (req.method !== method) return undefined;
    const hit = typeof path === 'string' ? req.url.pathname === path : path.test(req.url.pathname);
    return hit ? respond(req) : undefined;
  };
}

/** Requests that reached a given method and path pattern. */
export function sent(method: string, path: RegExp): RecordedRequest[] {
  return requests.filter((r) => r.method === method && path.test(r.url.pathname));
}

/** Decodes the base64url `raw` field Gmail takes for a message. */
export function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
