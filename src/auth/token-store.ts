/**
 * Persistence for config and per-account tokens.
 *
 * Layout, fixed by design so the CLI and the server always agree:
 *
 *   ~/.gmail-multi-mcp/
 *     config.json            OAuth client + the list of accounts
 *     tokens/<email>.json    one refresh token per account
 *
 * Tokens are never written to the project directory: a repository is the last
 * place a refresh token should live.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink, chmod, readdir } from 'node:fs/promises';
import type { AccountConfig, AccountId, Config, StoredTokens } from '../gmail/types.js';
import { GmailMcpError } from '../gmail/types.js';

export const ROOT_DIR = join(homedir(), '.gmail-multi-mcp');
export const CONFIG_PATH = join(ROOT_DIR, 'config.json');
export const TOKENS_DIR = join(ROOT_DIR, 'tokens');

const EMPTY_CONFIG: Config = { version: 1, accounts: [] };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

/**
 * An email address becomes a filename, so it must not be able to escape the
 * directory. Anything outside a conservative allow-list is percent-encoded.
 */
function tokenFileName(email: AccountId): string {
  return `${encodeURIComponent(email.toLowerCase())}.json`;
}

function tokenPath(email: AccountId): string {
  return join(TOKENS_DIR, tokenFileName(email));
}

async function ensureDirs(): Promise<void> {
  await mkdir(TOKENS_DIR, { recursive: true });
}

/**
 * Best-effort restrictive permissions. On Windows POSIX modes are largely
 * ignored, so this is a hardening measure on Unix and a no-op elsewhere —
 * never a reason to fail the write.
 */
async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch {
    /* Not fatal: the file is written either way. */
  }
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { accounts?: unknown }).accounts)
    ) {
      throw new GmailMcpError(
        'API_ERROR',
        `Malformed config at ${CONFIG_PATH}. Delete it and run "gmail-multi-mcp setup" again.`,
      );
    }
    return parsed as Config;
  } catch (error) {
    if (isMissing(error)) return { ...EMPTY_CONFIG, accounts: [] };
    if (error instanceof GmailMcpError) throw error;
    throw new GmailMcpError(
      'API_ERROR',
      `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await restrictPermissions(CONFIG_PATH);
}

export async function readTokens(email: AccountId): Promise<StoredTokens | null> {
  try {
    const raw = await readFile(tokenPath(email), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { refreshToken?: unknown }).refreshToken !== 'string'
    ) {
      return null;
    }
    return parsed as StoredTokens;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new GmailMcpError(
      'NOT_AUTHORIZED',
      `Could not read tokens for ${email}: ${error instanceof Error ? error.message : String(error)}`,
      email,
    );
  }
}

export async function writeTokens(email: AccountId, tokens: StoredTokens): Promise<void> {
  await ensureDirs();
  const path = tokenPath(email);
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
  await restrictPermissions(path);
}

export async function deleteTokens(email: AccountId): Promise<void> {
  try {
    await unlink(tokenPath(email));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function listTokenFiles(): Promise<string[]> {
  try {
    return await readdir(TOKENS_DIR);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Adds an account, or updates it in place if the email is already registered. */
export async function upsertAccount(account: AccountConfig): Promise<Config> {
  const config = await readConfig();
  const index = config.accounts.findIndex(
    (a) => a.email.toLowerCase() === account.email.toLowerCase(),
  );
  if (index >= 0) {
    config.accounts[index] = account;
  } else {
    config.accounts.push(account);
  }
  await writeConfig(config);
  return config;
}

export async function removeAccount(email: AccountId): Promise<boolean> {
  const config = await readConfig();
  const before = config.accounts.length;
  config.accounts = config.accounts.filter(
    (a) => a.email.toLowerCase() !== email.toLowerCase(),
  );
  const removed = config.accounts.length !== before;
  if (removed) {
    await writeConfig(config);
    await deleteTokens(email);
  }
  return removed;
}

/**
 * Resolves an account reference to a configured email.
 *
 * Accepts the full address or an alias, so an agent can say "work" instead of
 * memorising the address.
 */
export async function resolveAccount(reference: AccountId): Promise<AccountConfig> {
  const config = await readConfig();
  const needle = reference.trim().toLowerCase();
  const match =
    config.accounts.find((a) => a.email.toLowerCase() === needle) ??
    config.accounts.find((a) => a.alias?.toLowerCase() === needle);

  if (!match) {
    const known = config.accounts.map((a) => a.email).join(', ') || '(none)';
    throw new GmailMcpError(
      'UNKNOWN_ACCOUNT',
      `Unknown account "${reference}". Configured accounts: ${known}. Run "gmail-multi-mcp setup" to add one.`,
      reference,
    );
  }
  return match;
}
