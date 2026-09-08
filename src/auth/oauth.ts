/**
 * OAuth 2.0 for installed applications, one Google Cloud project, N accounts.
 *
 * Uses the loopback redirect flow (RFC 8252): a throwaway HTTP server on an
 * ephemeral port receives the authorization code. Google allows any loopback
 * port for "Desktop app" clients, so nothing has to be pre-registered beyond
 * the client itself — which is what makes "one project, N accounts" practical.
 *
 * ⚠️ The OAuth client comes from `@googleapis/gmail`, NOT from a direct
 * `google-auth-library` dependency. `googleapis-common` bundles its own nested
 * copy, so a client built from the top-level package is a structurally
 * different class and `gmail({ auth })` rejects it. Taking the class from the
 * same package it will be handed to removes the duplication instead of casting
 * around it.
 */


import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { auth, gmail as gmailApi } from '@googleapis/gmail';
import type { AccountId, OAuthCredentials, StoredTokens } from '../gmail/types.js';
import { GmailMcpError } from '../gmail/types.js';
import { readConfig, readTokens, writeTokens } from './token-store.js';

/** The exact OAuth2 client class `@googleapis/gmail` expects. */
export type GoogleOAuthClient = InstanceType<typeof auth.OAuth2>;

/**
 * Gmail: read, drafts, send and labels. `gmail.modify` is everything except
 * permanent deletion — which this server deliberately cannot do.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const;

/**
 * Drive: full access to the user's files.
 *
 * ⚠️ This is a RESTRICTED scope, the same tier Google applies to `gmail.modify`.
 * `drive.file` — access limited to files this app created or the user explicitly
 * picked — is not restricted and would keep verification simpler, but it cannot
 * see files the user already has, so `drive_search` over an existing Drive would
 * return nothing. Full `drive` is the deliberate choice; see the README.
 */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const;

/** Calendar: read and write events, and free/busy queries. */
export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'] as const;

/**
 * Contacts, through the People API: read and write the user own contacts.
 *
 * Not `contacts.readonly`, because `contacts_create` and `contacts_update` write.
 * This does NOT cover "other contacts" — the addresses Google auto-collects from
 * mail — which live behind a separate scope and a separate endpoint.
 */
export const CONTACTS_SCOPES = ['https://www.googleapis.com/auth/contacts'] as const;

/** Everything requested at consent time, in one list. */
export const SCOPES = [
  ...GMAIL_SCOPES,
  ...DRIVE_SCOPES,
  ...CALENDAR_SCOPES,
  ...CONTACTS_SCOPES,
] as const;

/** The space-separated `scope` string Google returns, as a set. */
export function grantedScopes(scope: string | null | undefined): Set<string> {
  return new Set((scope ?? '').split(/\s+/).filter(Boolean));
}

/**
 * Which of the scopes this build needs are absent from a stored token.
 *
 * ⚠️ A refresh will NOT fix these. A refresh token is bound to the scope set
 * granted when it was issued, so an account authorised before Drive and
 * Calendar existed here needs a full re-consent — which is why the flow always
 * passes `prompt: 'consent'`.
 */
export function missingScopes(scope: string | null | undefined): string[] {
  const granted = grantedScopes(scope);
  return SCOPES.filter((required) => !granted.has(required));
}

const CALLBACK_PATH = '/oauth2callback';
/** A browser that never comes back must not hang the CLI forever. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Credentials come from the environment first and `config.json` second.
 *
 * Environment wins so a deployment can inject them without rewriting a file in
 * the user's home directory.
 */
export async function loadCredentials(redirectUri = ''): Promise<OAuthCredentials> {
  const envId = process.env['GOOGLE_CLIENT_ID']?.trim();
  const envSecret = process.env['GOOGLE_CLIENT_SECRET']?.trim();

  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, redirectUri };
  }

  const config = await readConfig();
  if (config.oauth?.clientId && config.oauth.clientSecret) {
    return {
      clientId: config.oauth.clientId,
      clientSecret: config.oauth.clientSecret,
      redirectUri,
    };
  }

  throw new GmailMcpError(
    'NO_CREDENTIALS',
    'No Google OAuth credentials found. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, ' +
      'or run "gmail-multi-mcp setup" to store them in ~/.gmail-multi-mcp/config.json.',
  );
}

function toStoredTokens(credentials: {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
}): StoredTokens {
  if (!credentials.refresh_token) {
    throw new GmailMcpError(
      'NOT_AUTHORIZED',
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and authorise again — Google only ' +
        'issues one on first consent.',
    );
  }
  return {
    accessToken: credentials.access_token ?? null,
    refreshToken: credentials.refresh_token,
    expiryDate: credentials.expiry_date ?? null,
    scope: credentials.scope ?? null,
    tokenType: credentials.token_type ?? null,
  };
}

export interface AuthorizationResult {
  email: AccountId;
  tokens: StoredTokens;
}

/**
 * Runs the interactive consent flow and returns the account's tokens.
 *
 * `onUrl` receives the authorization URL so the caller decides how to surface
 * it — this module never prints anything itself, because the MCP server shares
 * stdout with the protocol.
 */
export async function runAuthorizationFlow(
  onUrl: (url: string) => void | Promise<void>,
): Promise<AuthorizationResult> {
  const state = randomBytes(24).toString('base64url');

  const { server, port } = await startLoopbackServer();
  /*
    ⚠️ 127.0.0.1, NUNCA localhost.

    `localhost` es un origen de cookies COMPARTIDO: cualquier servidor de
    desarrollo que haya corrido en cualquier puerto de localhost puede dejar
    cookies ahi, y el navegador las manda todas juntas a este callback. En una
    maquina con mucho desarrollo local eso supera los 16 KB de cabecera por
    defecto de Node y Google recibe un HTTP 431 «Request Header Fields Too
    Large» — con la autorizacion ya concedida y el codigo perdido.

    Las cookies de `localhost` no viajan a `127.0.0.1`: son hosts distintos a
    efectos de cookies. Ademas asi la redireccion coincide con la direccion
    donde escuchamos de verdad. Google acepta las dos formas para clientes de
    tipo Desktop app.
  */
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  try {
    const credentials = await loadCredentials(redirectUri);
    const client = new auth.OAuth2({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri,
    });

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: [...SCOPES],
      // Without this, a second authorisation of the same account returns no
      // refresh token and the account silently becomes unrefreshable.
      prompt: 'consent',
      state,
    });

    await onUrl(authUrl);

    const code = await waitForCode(server, state);
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    const stored = toStoredTokens(tokens);

    client.setCredentials({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
      expiry_date: stored.expiryDate,
    });

    const email = await fetchAccountEmail(client);
    await writeTokens(email, stored);
    return { email, tokens: stored };
  } finally {
    server.close();
  }
}

interface LoopbackServer {
  server: import('node:http').Server;
  port: number;
}

/**
 * 64 KB, cuatro veces el valor por defecto de Node (16 KB).
 *
 * No es la causa del 431 —esa era el `localhost` de arriba— pero un navegador
 * con muchisimas cookies o cabeceras de proxy puede acercarse igualmente al
 * limite, y aqui el coste de un margen amplio es cero: el servidor vive unos
 * segundos y atiende una sola peticion.
 */
const MAX_HEADER_BYTES = 64 * 1024;

async function startLoopbackServer(): Promise<LoopbackServer> {
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 asks the OS for a free port; loopback only, never exposed.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new GmailMcpError('API_ERROR', 'Could not bind a local port for the OAuth callback.');
  }
  return { server, port: address.port };
}

/** Constant-time comparison so the state check cannot be probed by timing. */
function statesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function waitForCode(server: import('node:http').Server, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GmailMcpError(
          'NOT_AUTHORIZED',
          'Timed out waiting for Google to redirect back. Authorisation was not completed.',
        ),
      );
    }, AUTH_TIMEOUT_MS);

    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };

    server.on('request', (req, res) => {
      // Base ficticia: solo sirve para parsear la ruta y la query.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      const reply = (status: number, title: string, detail: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage(title, detail));
      };

      if (error) {
        reply(400, 'Authorisation denied', `Google returned: ${escapeHtml(error)}`);
        finish(() =>
          reject(new GmailMcpError('NOT_AUTHORIZED', `Authorisation denied: ${error}`)),
        );
        return;
      }

      if (!state || !statesMatch(state, expectedState)) {
        reply(400, 'Rejected', 'The state parameter did not match. Start the flow again.');
        finish(() =>
          reject(
            new GmailMcpError(
              'NOT_AUTHORIZED',
              'OAuth state mismatch — the callback did not come from the request we started.',
            ),
          ),
        );
        return;
      }

      if (!code) {
        reply(400, 'Missing code', 'Google did not return an authorization code.');
        finish(() =>
          reject(new GmailMcpError('NOT_AUTHORIZED', 'No authorization code in the callback.')),
        );
        return;
      }

      reply(200, 'Account connected', 'You can close this tab and return to the terminal.');
      finish(() => resolve(code));
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#111}
  main{max-width:26rem;padding:2rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#555}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

/** Asks Gmail who we just authenticated as. Covered by `gmail.modify`. */
async function fetchAccountEmail(client: GoogleOAuthClient): Promise<AccountId> {
  const api = gmailApi({ version: 'v1', auth: client });
  const profile = await api.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  if (!email) {
    throw new GmailMcpError('API_ERROR', 'Gmail did not return the account email address.');
  }
  return email.toLowerCase();
}

/**
 * Builds an authenticated client for a configured account.
 *
 * Refresh is automatic: `google-auth-library` renews the access token when it
 * has expired, and the `tokens` listener writes the new one back to disk so the
 * next process start does not have to refresh again.
 */
export async function getAuthenticatedClient(email: AccountId): Promise<GoogleOAuthClient> {
  const stored = await readTokens(email);
  if (!stored) {
    throw new GmailMcpError(
      'NOT_AUTHORIZED',
      `No stored credentials for ${email}. Run "gmail-multi-mcp setup" and authorise the account.`,
      email,
    );
  }

  const credentials = await loadCredentials();
  const client = new auth.OAuth2({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });

  // `Credentials` types these as `string | undefined`, not `| null`, so the
  // nulls we persist have to be normalised on the way back in.
  client.setCredentials({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
    expiry_date: stored.expiryDate,
    scope: stored.scope ?? undefined,
    token_type: stored.tokenType ?? undefined,
  });

  client.on('tokens', (fresh) => {
    // Google omits refresh_token on refresh responses; keep the one we have.
    const merged: StoredTokens = {
      accessToken: fresh.access_token ?? stored.accessToken,
      refreshToken: fresh.refresh_token ?? stored.refreshToken,
      expiryDate: fresh.expiry_date ?? stored.expiryDate,
      scope: fresh.scope ?? stored.scope,
      tokenType: fresh.token_type ?? stored.tokenType,
    };
    // Fire-and-forget: a failed cache write must not break a working request.
    void writeTokens(email, merged).catch((error: unknown) => {
      process.stderr.write(
        `[gmail-multi-mcp] could not persist refreshed token for ${email}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  });

  return client;
}
