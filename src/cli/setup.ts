/**
 * Interactive setup.
 *
 * This is the only part of the project that may write to stdout: it runs in a
 * terminal, never as the MCP stdio server.
 */

import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import open from 'open';

import { missingScopes, runAuthorizationFlow } from '../auth/oauth.js';
import {
  CONFIG_PATH,
  ROOT_DIR,
  TOKENS_DIR,
  readConfig,
  readTokens,
  removeAccount,
  upsertAccount,
  writeConfig,
} from '../auth/token-store.js';
import { probeAccount } from '../gmail/client.js';
import { GmailMcpError } from '../gmail/types.js';

/**
 * The readline interface is created on FIRST USE, not at module load.
 *
 * Created eagerly it starts consuming stdin immediately, so any async work that
 * happens before the first prompt — reading the config, checking which accounts
 * are missing scopes — drains piped input and the answers are gone before
 * anything asks for them. Interactively you would never notice; with a pipe the
 * CLI just says the input closed and exits.
 */
let rl: ReturnType<typeof createInterface> | null = null;

function input(): ReturnType<typeof createInterface> {
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout });
  }
  return rl;
}

/**
 * Raised when input ends: Ctrl+D, a closed pipe, or a non-interactive shell.
 *
 * Without this, the next `rl.question` after EOF throws ERR_USE_AFTER_CLOSE and
 * the CLI dies with a stack trace — which is what a user gets for pressing
 * Ctrl+D, a perfectly normal way to leave a prompt.
 */
class SetupAborted extends Error {
  constructor() {
    super('input closed');
    this.name = 'SetupAborted';
  }
}

function line(text = ''): void {
  stdout.write(`${text}\n`);
}

function heading(text: string): void {
  line();
  line(chalk.bold.cyan(text));
  line(chalk.cyan('─'.repeat(text.length)));
}

function ok(text: string): void {
  line(`${chalk.green('✔')} ${text}`);
}

function warn(text: string): void {
  line(`${chalk.yellow('!')} ${text}`);
}

function bad(text: string): void {
  line(`${chalk.red('✖')} ${text}`);
}

function dim(text: string): void {
  line(chalk.dim(text));
}

async function ask(question: string): Promise<string> {
  // No pre-check on `inputClosed`: a closed stream can still have a buffered
  // line waiting, and refusing to read it would throw away a real answer.
  try {
    const answer = await input().question(chalk.bold(`${question} `));
    return answer.trim();
  } catch {
    // readline closed underneath us: treat it as "the user is done".
    throw new SetupAborted();
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} ${chalk.dim('(y/N)')}`)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function banner(): void {
  line();
  line(chalk.bold.magenta('  gmail-multi-mcp'));
  dim('  Gmail, Drive, Calendar and Contacts. One Google Cloud project, as many accounts.');
  line();
  dim(`  config  ${CONFIG_PATH}`);
  dim(`  tokens  ${TOKENS_DIR}`);
}

/**
 * Credentials must exist before anything else can happen. Environment wins, so
 * a machine that already exports them never gets asked.
 */
async function ensureCredentials(): Promise<boolean> {
  if (process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']) {
    ok('OAuth credentials found in the environment.');
    return true;
  }

  const config = await readConfig();
  if (config.oauth?.clientId && config.oauth.clientSecret) {
    ok('OAuth credentials found in config.json.');
    return true;
  }

  heading('Google Cloud credentials');
  line('You need an OAuth client of type ' + chalk.bold('Desktop app') + '.');
  line();
  line(`  ${chalk.dim('1.')} Open ${chalk.underline('https://console.cloud.google.com/apis/credentials')}`);
  line(`  ${chalk.dim('2.')} Enable the ${chalk.bold('Gmail API')} for the project.`);
  line(`  ${chalk.dim('3.')} Create Credentials → OAuth client ID → ${chalk.bold('Desktop app')}.`);
  line(`  ${chalk.dim('4.')} Copy the client ID and client secret below.`);
  line();
  dim('  A Desktop-app client accepts any loopback port, which is what lets one');
  dim('  project serve every account without registering redirect URIs.');
  dim('  The callback uses 127.0.0.1, not localhost, to avoid a header overflow');
  dim('  from cookies other local dev servers leave on the shared localhost origin.');
  line();

  const clientId = await ask('Client ID:');
  if (!clientId) {
    bad('No client ID given.');
    return false;
  }
  const clientSecret = await ask('Client secret:');
  if (!clientSecret) {
    bad('No client secret given.');
    return false;
  }

  config.oauth = { clientId, clientSecret };
  config.version = 1;
  await writeConfig(config);
  ok(`Saved to ${CONFIG_PATH}`);
  return true;
}

async function addAccount(): Promise<void> {
  heading('Add a Google account');
  line('A browser window will open. Sign in with the account you want to add.');
  dim('Adding a second account? Sign out of Google first, or use a private window.');
  line();

  try {
    const { email } = await runAuthorizationFlow(async (url) => {
      line(chalk.dim('Opening your browser…'));
      line();
      dim('If it does not open, paste this URL yourself:');
      line(chalk.underline(url));
      line();
      try {
        await open(url);
      } catch {
        warn('Could not launch a browser automatically. Use the URL above.');
      }
    });

    const alias = await ask(`Alias for ${chalk.bold(email)} ${chalk.dim('(optional, e.g. "work")')}:`);

    await upsertAccount({
      email,
      ...(alias ? { alias } : {}),
      addedAt: new Date().toISOString(),
    });

    ok(`Connected ${chalk.bold(email)}`);

    try {
      const profile = await probeAccount(email);
      dim(`   ${profile.messagesTotal.toLocaleString()} messages in the mailbox.`);
    } catch {
      warn('Saved, but a test call to Gmail failed. Check that the Gmail API is enabled.');
    }
  } catch (error) {
    if (error instanceof SetupAborted) throw error;
    if (error instanceof GmailMcpError) bad(error.message);
    else bad(error instanceof Error ? error.message : String(error));
  }
}

/** Turns a scope URL into the product name a person would recognise. */
function serviceOf(scope: string): string {
  if (scope.includes('/gmail')) return 'Gmail';
  if (scope.includes('/drive')) return 'Drive';
  if (scope.includes('/calendar')) return 'Calendar';
  if (scope.includes('/contacts')) return 'Contacts';
  return scope;
}

/**
 * Says out loud that an account is only half connected.
 *
 * An account authorised before Drive and Calendar existed here keeps working for
 * Gmail and fails for the rest, which from the outside looks like the new tools
 * are broken. Nothing about it is visible unless something says so: the token
 * file is valid, it refreshes fine, and the scopes it lacks are simply absent.
 */
async function warnAboutStaleAccounts(): Promise<void> {
  const config = await readConfig();
  const stale: string[] = [];

  for (const account of config.accounts) {
    const tokens = await readTokens(account.email);
    if (tokens && missingScopes(tokens.scope).length > 0) stale.push(account.email);
  }
  if (stale.length === 0) return;

  line();
  warn(`${stale.length} account${stale.length === 1 ? '' : 's'} need re-authorising:`);
  for (const email of stale) line(`    ${chalk.yellow('·')} ${email}`);
  dim('  They were connected before some of these services were supported here, so part');
  dim('  of the toolset will refuse them. A refresh cannot add the missing scopes: Google');
  dim('  binds a refresh token to the scopes it was issued with. Choose 1 and add each');
  dim('  account again — it re-consents and overwrites in place, nothing to remove first.');
}

async function listAccounts(): Promise<void> {
  heading('Configured accounts');
  const config = await readConfig();

  if (config.accounts.length === 0) {
    warn('None yet.');
    return;
  }

  for (const account of config.accounts) {
    const tokens = await readTokens(account.email);
    const label = account.alias ? chalk.dim(` (${account.alias})`) : '';
    if (!tokens) {
      line(`  ${chalk.red('●')} ${account.email}${label} ${chalk.red('— not authorised')}`);
      continue;
    }
    const expired =
      tokens.expiryDate !== null && tokens.expiryDate <= Date.now()
        ? chalk.yellow(' — access token expired, will refresh')
        : '';

    const missing = missingScopes(tokens.scope);
    if (missing.length > 0) {
      line(`  ${chalk.yellow('●')} ${account.email}${label}${expired}`);
      line(
        `      ${chalk.yellow('needs re-authorising')} — no access to ` +
          `${missing.map(serviceOf).join(' or ')}. Choose 1 and add it again.`,
      );
      continue;
    }
    line(`  ${chalk.green('●')} ${account.email}${label}${expired}`);
  }
}

async function removeAccountFlow(): Promise<void> {
  heading('Remove an account');
  const config = await readConfig();
  if (config.accounts.length === 0) {
    warn('Nothing to remove.');
    return;
  }
  for (const account of config.accounts) line(`  · ${account.email}`);
  line();

  const email = await ask('Email to remove:');
  if (!email) return;

  if (!(await confirm(`Delete ${chalk.bold(email)} and its stored token?`))) {
    dim('Cancelled.');
    return;
  }

  const removed = await removeAccount(email);
  if (removed) {
    ok(`Removed ${email}`);
    dim('Its refresh token is still valid at Google. To revoke it fully, visit');
    dim('https://myaccount.google.com/permissions');
  } else {
    warn(`${email} was not configured.`);
  }
}

/**
 * The path an MCP client should launch: always the *built* entry point, even
 * when this CLI is itself running from source through tsx. Printing whatever
 * happens to be executing right now would hand the user a `.ts` file that
 * `node` cannot run.
 */
function serverEntryPath(): string {
  const packageRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  return join(packageRoot, 'dist', 'index.js');
}

function showClientConfig(): void {
  heading('Wire it into your MCP client');

  const entry = serverEntryPath();

  line(`${chalk.bold('Claude Code')} — run this, then restart it:`);
  line();
  line(chalk.dim(`  claude mcp add gmail-multi-mcp --scope user -- node ${entry}`));
  line();
  line(`${chalk.bold('Claude Desktop')} and others — add this to the client's config file:`);
  line();
  const snippet = {
    mcpServers: {
      'gmail-multi-mcp': {
        command: 'node',
        args: [entry],
      },
    },
  };
  line(chalk.dim(JSON.stringify(snippet, null, 2)));
  line();
  dim('Build first if you have not: npm run build');
  dim(`Credentials and tokens are read from ${ROOT_DIR} — nothing goes in the client config.`);
}

export async function runSetup(): Promise<void> {
  banner();

  if (!(await ensureCredentials())) {
    rl?.close();
    process.exitCode = 1;
    return;
  }

  await warnAboutStaleAccounts();

  try {
    await menuLoop();
  } catch (error) {
    if (!(error instanceof SetupAborted)) throw error;
    line();
    dim('Input closed. Nothing was changed.');
  } finally {
    rl?.close();
  }
}

async function menuLoop(): Promise<void> {
  for (;;) {
    heading('What now?');
    line(`  ${chalk.bold('1')}  Add a Google account`);
    line(`  ${chalk.bold('2')}  List accounts`);
    line(`  ${chalk.bold('3')}  Remove an account`);
    line(`  ${chalk.bold('4')}  Show MCP client configuration`);
    line(`  ${chalk.bold('q')}  Quit`);
    line();

    const choice = (await ask('Choice:')).toLowerCase();

    switch (choice) {
      case '1':
        await addAccount();
        break;
      case '2':
        await listAccounts();
        break;
      case '3':
        await removeAccountFlow();
        break;
      case '4':
        showClientConfig();
        break;
      case 'q':
      case 'quit':
      case 'exit':
        line();
        dim('Bye.');
        return;
      default:
        warn('Pick 1, 2, 3, 4 or q.');
    }
  }
}
