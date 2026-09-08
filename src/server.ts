/**
 * The MCP server: nine tools over N Gmail accounts.
 *
 * ⚠️ NOTHING IN THIS PROCESS MAY WRITE TO STDOUT.
 * The stdio transport *is* stdout: a stray `console.log` corrupts the JSON-RPC
 * stream and the client disconnects with a parse error that looks like a bug in
 * the client. All diagnostics go to stderr, always.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { readConfig, readTokens } from './auth/token-store.js';
import {
  createDraft,
  fetchMessage,
  fetchThread,
  labelMessage,
  listLabels,
  probeAccount,
  replyToMessage,
  sendMessage,
} from './gmail/client.js';
import { searchAccount, searchAllAccounts } from './gmail/search.js';
import type { AccountStatus, OutgoingMessage } from './gmail/types.js';
import { GmailMcpError } from './gmail/types.js';

export const SERVER_NAME = 'gmail-multi-mcp';
export const SERVER_VERSION = '0.1.0';

/** The MCP content shape returned by every tool here. */
interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string, code?: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  };
}

/**
 * Wraps a handler so a thrown error becomes a tool error instead of killing the
 * server. Known failures keep their message — an agent can act on "re-authorise
 * this account"; it can do nothing with "Internal error".
 */
function guard<A>(handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof GmailMcpError) return fail(error.message, error.code);
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[${SERVER_NAME}] unhandled tool error: ${detail}\n`);
      return fail(`Unexpected failure: ${detail}`, 'API_ERROR');
    }
  };
}

// ---------------------------------------------------------------------------
// Shared argument fragments
// ---------------------------------------------------------------------------

const accountArg = z
  .string()
  .min(1)
  .describe('Configured account: the email address, or the alias given at setup.');

const bodyArg = z.string().min(1).describe('Message body. Plain text unless is_html is true.');

const composeArgs = {
  account: accountArg,
  to: z.array(z.string().min(1)).min(1).describe('Recipients. Plain addresses or "Name <a@b.c>".'),
  subject: z.string().describe('Subject line. Non-ASCII is encoded automatically.'),
  body: bodyArg,
  cc: z.array(z.string().min(1)).optional().describe('Carbon-copy recipients.'),
  bcc: z.array(z.string().min(1)).optional().describe('Blind carbon-copy recipients.'),
  is_html: z.boolean().optional().describe('Send the body as text/html instead of text/plain.'),
  thread_id: z
    .string()
    .optional()
    .describe('Attach to an existing thread. Prefer the "reply" tool for answering a message.'),
};

interface ComposeArgs {
  account: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  is_html?: boolean;
  thread_id?: string;
}

function toOutgoing(args: ComposeArgs): OutgoingMessage {
  const message: OutgoingMessage = { to: args.to, subject: args.subject, body: args.body };
  if (args.cc && args.cc.length > 0) message.cc = args.cc;
  if (args.bcc && args.bcc.length > 0) message.bcc = args.bcc;
  if (args.is_html === true) message.isHtml = true;
  if (args.thread_id) message.threadId = args.thread_id;
  return message;
}

// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Gmail access across multiple accounts. Every tool except list_accounts and ' +
        'search_emails requires an "account". search_emails without "account" searches ' +
        'every configured mailbox at once and merges the results.',
    },
  );

  // --- list_accounts -------------------------------------------------------
  server.registerTool(
    'list_accounts',
    {
      title: 'List Gmail accounts',
      description:
        'List every configured Gmail account and whether it is usable. Call this first ' +
        'when you do not know which accounts exist, or when another tool reports an ' +
        'unknown account.',
      inputSchema: {
        probe: z
          .boolean()
          .optional()
          .describe(
            'Contact Gmail to confirm each account really works. Slower, but detects ' +
              'revoked tokens that look fine on disk. Defaults to false.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ probe }: { probe?: boolean }) => {
      const config = await readConfig();

      const statuses: AccountStatus[] = await Promise.all(
        config.accounts.map(async (account) => {
          const tokens = await readTokens(account.email);
          const status: AccountStatus = {
            email: account.email,
            alias: account.alias ?? null,
            addedAt: account.addedAt,
            authorized: tokens !== null,
            accessTokenExpired:
              tokens?.expiryDate !== null && tokens?.expiryDate !== undefined
                ? tokens.expiryDate <= Date.now()
                : false,
            scopes: tokens?.scope ? tokens.scope.split(' ') : [],
          };

          if (probe === true && tokens) {
            try {
              const live = await probeAccount(account.email);
              status.emailAddress = live.emailAddress;
              status.messagesTotal = live.messagesTotal;
            } catch (error) {
              status.error = error instanceof Error ? error.message : String(error);
              status.authorized = false;
            }
          }
          return status;
        }),
      );

      return ok({
        configPath: '~/.gmail-multi-mcp/config.json',
        accountCount: statuses.length,
        accounts: statuses,
        ...(statuses.length === 0
          ? { hint: 'No accounts yet. Run "gmail-multi-mcp setup" in a terminal to add one.' }
          : {}),
      });
    }),
  );

  // --- search_emails -------------------------------------------------------
  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description:
        'Search with Gmail query syntax (e.g. "from:ana@x.com is:unread newer_than:7d"). ' +
        'Omit "account" to search EVERY configured mailbox in parallel and get one merged, ' +
        'date-sorted list. If one account fails the others still return, and the failure is ' +
        'reported in "failures".',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Gmail search query, exactly as typed in the Gmail search box.'),
        account: z
          .string()
          .optional()
          .describe('Restrict to one account. Omit to search all of them.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum messages to return (per account when searching all). Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        query,
        account,
        max_results,
      }: {
        query: string;
        account?: string;
        max_results?: number;
      }) => {
        if (account) {
          const messages = await searchAccount(account, query, max_results);
          return ok({
            query,
            accountsSearched: [account],
            totalResults: messages.length,
            results: messages,
          });
        }
        return ok(await searchAllAccounts(query, max_results));
      },
    ),
  );

  // --- read_thread ---------------------------------------------------------
  server.registerTool(
    'read_thread',
    {
      title: 'Read a thread',
      description:
        'Read a full conversation, every message in order. Prefer this over read_message ' +
        'when you need the context of an exchange rather than a single email.',
      inputSchema: {
        thread_id: z.string().min(1).describe('Thread id, as returned by search_emails.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ thread_id, account }: { thread_id: string; account: string }) =>
      ok(await fetchThread(account, thread_id)),
    ),
  );

  // --- read_message --------------------------------------------------------
  server.registerTool(
    'read_message',
    {
      title: 'Read a message',
      description:
        'Read one message in full, including its decoded body and attachment metadata. ' +
        'Attachment contents are not downloaded.',
      inputSchema: {
        message_id: z.string().min(1).describe('Message id, as returned by search_emails.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ message_id, account }: { message_id: string; account: string }) =>
      ok(await fetchMessage(account, message_id)),
    ),
  );

  // --- create_draft --------------------------------------------------------
  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft',
      description:
        'Save a draft without sending it. Use this whenever the user has not explicitly ' +
        'asked for the message to go out.',
      inputSchema: composeArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args: ComposeArgs) => ok(await createDraft(args.account, toOutgoing(args)))),
  );

  // --- reply ---------------------------------------------------------------
  server.registerTool(
    'reply',
    {
      title: 'Reply to a message',
      description:
        'Send a reply that stays in the original thread. Handles the subject prefix and the ' +
        'In-Reply-To/References headers, which is what makes it appear as a reply rather ' +
        'than a new conversation. This SENDS immediately.',
      inputSchema: {
        account: accountArg,
        message_id: z.string().min(1).describe('The message being answered.'),
        body: bodyArg,
        reply_all: z
          .boolean()
          .optional()
          .describe('Also copy everyone in the original Cc. Defaults to false.'),
        is_html: z.boolean().optional().describe('Send the body as text/html.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        message_id,
        body,
        reply_all,
        is_html,
      }: {
        account: string;
        message_id: string;
        body: string;
        reply_all?: boolean;
        is_html?: boolean;
      }) => {
        const options: { replyAll?: boolean; isHtml?: boolean } = {};
        if (reply_all !== undefined) options.replyAll = reply_all;
        if (is_html !== undefined) options.isHtml = is_html;
        return ok(await replyToMessage(account, message_id, body, options));
      },
    ),
  );

  // --- send_message --------------------------------------------------------
  server.registerTool(
    'send_message',
    {
      title: 'Send an email',
      description:
        'Compose and SEND a new email immediately. There is no undo. If the user has not ' +
        'clearly asked for it to be sent, use create_draft instead.',
      inputSchema: composeArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args: ComposeArgs) => ok(await sendMessage(args.account, toOutgoing(args)))),
  );

  // --- list_labels ---------------------------------------------------------
  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'List the labels of an account, system and user-created, with their ids. Call this ' +
        'before label_message if you are unsure a label exists.',
      inputSchema: { account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ account }: { account: string }) => ok(await listLabels(account))),
  );

  // --- label_message -------------------------------------------------------
  server.registerTool(
    'label_message',
    {
      title: 'Add or remove labels',
      description:
        'Apply and/or remove labels on a message. Accepts label names or ids — names are ' +
        'resolved case-insensitively. Useful system labels: UNREAD, STARRED, IMPORTANT, ' +
        'SPAM, TRASH. Removing UNREAD marks a message as read.',
      inputSchema: {
        account: accountArg,
        message_id: z.string().min(1).describe('Message to modify.'),
        add_labels: z.array(z.string().min(1)).optional().describe('Labels to apply.'),
        remove_labels: z.array(z.string().min(1)).optional().describe('Labels to remove.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        message_id,
        add_labels,
        remove_labels,
      }: {
        account: string;
        message_id: string;
        add_labels?: string[];
        remove_labels?: string[];
      }) => ok(await labelMessage(account, message_id, add_labels ?? [], remove_labels ?? [])),
    ),
  );

  return server;
}

/** Connects the server to stdio and blocks until the transport closes. */
export async function runServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${SERVER_NAME}] ready on stdio (v${SERVER_VERSION})\n`);
}
