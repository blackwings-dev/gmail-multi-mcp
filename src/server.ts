/**
 * The MCP server: twenty-eight tools over N Google accounts — Gmail, Drive, Calendar
 * and Contacts.
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
  trashMessage,
  untrashMessage,
} from './gmail/client.js';
import { searchAccount, searchAllAccounts } from './gmail/search.js';
import { missingScopes } from './auth/oauth.js';
import {
  createGoogleDoc,
  listDriveFolder,
  readDriveFile,
  searchAllDrives,
  searchDrive,
  shareDriveFile,
  uploadToDrive,
} from './drive/client.js';
import {
  createEvent,
  deleteEvent,
  findFreeTime,
  getEvent,
  listEvents,
  listEventsAllAccounts,
  updateEvent,
} from './calendar/client.js';
import type { SendUpdates } from './calendar/types.js';
import {
  createContact,
  getContact,
  listContacts,
  searchAllContacts,
  searchContacts,
  updateContact,
} from './contacts/client.js';
import type { ContactWriteRequest } from './contacts/types.js';
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

const optionalAccountArg = z
  .string()
  .optional()
  .describe('Restrict to one account. Omit to use every configured account at once.');

const calendarIdArg = z
  .string()
  .optional()
  .describe('Calendar id. Defaults to "primary", the account own calendar.');

const sendUpdatesArg = z
  .enum(['all', 'externalOnly', 'none'])
  .optional()
  .describe('Whether Google emails the attendees. Defaults to "none": nobody is mailed.');

/**
 * Every instant this server accepts has to say what offset it is in.
 *
 * A bare "2026-09-10T09:00:00" would be read in whatever zone the server happens
 * to run in, and the resulting answer looks completely normal while being an
 * hour or nine wrong.
 */
function isoInstantArg(label: string): z.ZodString {
  return z
    .string()
    .min(1)
    .describe(
      `${label}. ISO 8601 WITH an explicit UTC offset or "Z" — for example ` +
        '"2026-09-10T09:00:00+02:00".',
    );
}

const contactIdArg = z
  .string()
  .min(1)
  .describe(
    'Contact id as returned by contacts_search or contacts_list, e.g. "people/c123456".',
  );

/**
 * The writable fields of a contact, shared by create and update.
 *
 * On UPDATE each of these is a REPLACEMENT, not an addition: the People API
 * swaps out every field named in the request, so sending one email address
 * deletes the others. The tool descriptions say so; this is the reason.
 */
const contactFieldArgs = {
  given_name: z.string().optional().describe('First name.'),
  family_name: z.string().optional().describe('Surname.'),
  emails: z
    .array(z.string().min(1))
    .optional()
    .describe('Email addresses, in full. On update this REPLACES the existing list.'),
  phones: z
    .array(z.string().min(1))
    .optional()
    .describe('Phone numbers, in full. On update this REPLACES the existing list.'),
  organization: z.string().optional().describe('Company or organisation.'),
  job_title: z.string().optional().describe('Role within that organisation.'),
  notes: z.string().optional().describe('Free-text note stored on the contact.'),
};

interface ContactArgs {
  account: string;
  given_name?: string;
  family_name?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  job_title?: string;
  notes?: string;
}

function toContactWrite(args: ContactArgs): ContactWriteRequest {
  return {
    ...(args.given_name !== undefined ? { givenName: args.given_name } : {}),
    ...(args.family_name !== undefined ? { familyName: args.family_name } : {}),
    ...(args.emails !== undefined ? { emails: args.emails } : {}),
    ...(args.phones !== undefined ? { phones: args.phones } : {}),
    ...(args.organization !== undefined ? { organization: args.organization } : {}),
    ...(args.job_title !== undefined ? { jobTitle: args.job_title } : {}),
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
  };
}

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
        'Gmail, Drive, Calendar and Contacts across multiple Google accounts. The tools whose ' +
        '"account" is OPTIONAL (search_emails, drive_search, calendar_list_events, ' +
        'calendar_find_free_time, contacts_search) work across every connected account at ' +
        'once when it is omitted, ' +
        'and report per-account failures instead of hiding them. Call ' +
        'list_accounts first when you do not know which accounts exist, or when a tool ' +
        'fails with MISSING_SCOPE — that means the account was connected before that ' +
        'service was supported here and has to be re-authorised.',
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
            missingScopes: missingScopes(tokens?.scope ?? null),
            needsReauthorization: tokens !== null && missingScopes(tokens.scope).length > 0,
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

      const stale = statuses.filter((s) => s.needsReauthorization).map((s) => s.email);

      return ok({
        configPath: '~/.gmail-multi-mcp/config.json',
        accountCount: statuses.length,
        accounts: statuses,
        ...(stale.length > 0
          ? {
              warning:
                `These accounts predate Drive and Calendar support and can only do Gmail: ${stale.join(
                  ', ',
                )}. A token refresh cannot add the missing scopes — the user has to run ` +
                '"gmail-multi-mcp setup" and add each one again with option 1, which ' +
                're-consents and overwrites in place.',
            }
          : {}),
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

  // --- trash_email ---------------------------------------------------------
  server.registerTool(
    'trash_email',
    {
      title: 'Move an email to the bin',
      description:
        'Move a message to the bin. This is NOT a permanent delete: the message keeps ' +
        'existing and untrash_email brings it back. Gmail does empty the bin by itself ' +
        'after 30 days, so it becomes permanent eventually — treat it as reversible for ' +
        'a month, not for ever. This server has no permanent-delete tool at all. The ' +
        'answer names the message that moved, so a wrong id is visible immediately.',
      inputSchema: {
        account: accountArg,
        message_id: z.string().min(1).describe('Message to move to the bin.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async ({ account, message_id }: { account: string; message_id: string }) =>
      ok(await trashMessage(account, message_id)),
    ),
  );

  // --- untrash_email -------------------------------------------------------
  server.registerTool(
    'untrash_email',
    {
      title: 'Recover an email from the bin',
      description:
        'Take a message back out of the bin and restore the labels it had. Only works ' +
        'while the message is still there — once Gmail has emptied the bin, after about ' +
        '30 days, there is nothing left to recover. Use search_emails with "in:trash" to ' +
        'find what is in there.',
      inputSchema: {
        account: accountArg,
        message_id: z.string().min(1).describe('Message to take out of the bin.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ account, message_id }: { account: string; message_id: string }) =>
      ok(await untrashMessage(account, message_id)),
    ),
  );

  // =========================================================================
  // Drive
  // =========================================================================

  // --- drive_search --------------------------------------------------------
  server.registerTool(
    'drive_search',
    {
      title: 'Search Drive',
      description:
        'Find files in Google Drive. Omit "account" to search EVERY connected Drive in ' +
        'parallel and get one merged list, most recently modified first; if one account ' +
        'fails the others still return and the failure is reported in "failures". ' +
        'Use "query" for plain words (matched against filename and file contents) and ' +
        '"drive_query" only when you need raw Drive query syntax, e.g. ' +
        `"mimeType = 'application/pdf' and modifiedTime > '2026-01-01T00:00:00'".`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free text. Matched against both the file name and the file contents.'),
        drive_query: z
          .string()
          .optional()
          .describe('Raw Drive query syntax, ANDed with "query" when both are given.'),
        account: optionalAccountArg,
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum files to return (per account when searching all). Default 20.'),
        include_trashed: z
          .boolean()
          .optional()
          .describe('Include files in the bin. Defaults to false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        query,
        drive_query,
        account,
        max_results,
        include_trashed,
      }: {
        query?: string;
        drive_query?: string;
        account?: string;
        max_results?: number;
        include_trashed?: boolean;
      }) => {
        const parts = {
          ...(query ? { text: query } : {}),
          ...(drive_query ? { raw: drive_query } : {}),
          ...(include_trashed === true ? { includeTrashed: true } : {}),
        };
        if (account) {
          const files = await searchDrive(account, parts, max_results);
          return ok({
            accountsSearched: [account],
            totalResults: files.length,
            results: files,
          });
        }
        return ok(await searchAllDrives(parts, max_results));
      },
    ),
  );

  // --- drive_read ----------------------------------------------------------
  server.registerTool(
    'drive_read',
    {
      title: 'Read a Drive file',
      description:
        'Read a file as text. Google Docs are exported to plain text, Sheets to CSV and ' +
        'Slides to plain text; ordinary text files are downloaded as they are. Binary ' +
        'files (PDF, images, archives) are refused with a link instead — this tool does ' +
        'not download them. Long content is truncated and says so.',
      inputSchema: {
        file_id: z.string().min(1).describe('File id, as returned by drive_search.'),
        account: accountArg,
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .optional()
          .describe('Cut the content at this many characters. Default 60000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        file_id,
        account,
        max_chars,
      }: {
        file_id: string;
        account: string;
        max_chars?: number;
      }) => ok(await readDriveFile(account, file_id, max_chars)),
    ),
  );

  // --- drive_list ----------------------------------------------------------
  server.registerTool(
    'drive_list',
    {
      title: 'List a Drive folder',
      description:
        'List what is inside a folder, sub-folders first. Omit "folder_id" for the root ' +
        'of My Drive. Use drive_search when you know what you are looking for but not ' +
        'where it lives.',
      inputSchema: {
        account: accountArg,
        folder_id: z
          .string()
          .optional()
          .describe('Folder id. Defaults to "root", the top of My Drive.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum entries to return. Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        account,
        folder_id,
        max_results,
      }: {
        account: string;
        folder_id?: string;
        max_results?: number;
      }) => ok(await listDriveFolder(account, folder_id ?? 'root', max_results)),
    ),
  );

  // --- drive_upload --------------------------------------------------------
  server.registerTool(
    'drive_upload',
    {
      title: 'Upload a file to Drive',
      description:
        'Put a file in Drive. Give either "content" for text you composed, or ' +
        '"local_path" for a file that already exists on the machine running this server ' +
        '— exactly one of the two. The file is private to the account until something ' +
        'shares it.',
      inputSchema: {
        account: accountArg,
        name: z.string().min(1).describe('File name in Drive, including its extension.'),
        content: z.string().optional().describe('Inline text content.'),
        local_path: z
          .string()
          .optional()
          .describe('Absolute path to a file on the machine running this server.'),
        mime_type: z
          .string()
          .optional()
          .describe('MIME type. Guessed from the file extension when omitted.'),
        parent_folder_id: z
          .string()
          .optional()
          .describe('Destination folder. Defaults to the root of My Drive.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        name,
        content,
        local_path,
        mime_type,
        parent_folder_id,
      }: {
        account: string;
        name: string;
        content?: string;
        local_path?: string;
        mime_type?: string;
        parent_folder_id?: string;
      }) =>
        ok(
          await uploadToDrive(account, {
            name,
            ...(content !== undefined ? { content } : {}),
            ...(local_path ? { localPath: local_path } : {}),
            ...(mime_type ? { mimeType: mime_type } : {}),
            ...(parent_folder_id ? { parentFolderId: parent_folder_id } : {}),
          }),
        ),
    ),
  );

  // --- drive_create_doc ----------------------------------------------------
  server.registerTool(
    'drive_create_doc',
    {
      title: 'Create a Google Doc',
      description:
        'Create a real Google Doc — not a text file — from plain text. Line breaks are ' +
        'kept; formatting is not, because the content is converted from plain text on ' +
        'the way in. Returns the document id and a link to open it.',
      inputSchema: {
        account: accountArg,
        name: z.string().min(1).describe('Document title.'),
        content: z.string().optional().describe('Initial body text. May be empty.'),
        parent_folder_id: z
          .string()
          .optional()
          .describe('Destination folder. Defaults to the root of My Drive.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        name,
        content,
        parent_folder_id,
      }: {
        account: string;
        name: string;
        content?: string;
        parent_folder_id?: string;
      }) => ok(await createGoogleDoc(account, name, content ?? '', parent_folder_id)),
    ),
  );

  // --- drive_share ---------------------------------------------------------
  server.registerTool(
    'drive_share',
    {
      title: 'Share a Drive file',
      description:
        'Grant someone access to a file. This GIVES AWAY ACCESS to real data and cannot ' +
        'be undone from here. type "user" or "group" needs "email_address"; "domain" ' +
        'needs "domain"; type "anyone" makes the file readable by ANYONE WITH THE LINK, ' +
        'so only use it when the user asked for a public link in so many words. No ' +
        'notification email is sent unless "notify" is true.',
      inputSchema: {
        account: accountArg,
        file_id: z.string().min(1).describe('File to share.'),
        type: z
          .enum(['user', 'group', 'domain', 'anyone'])
          .describe('Who the permission is for. "anyone" means a public link.'),
        role: z
          .enum(['reader', 'commenter', 'writer'])
          .describe('What they may do. Ownership transfer is deliberately not offered.'),
        email_address: z.string().optional().describe('Required for type "user" or "group".'),
        domain: z.string().optional().describe('Required for type "domain".'),
        notify: z
          .boolean()
          .optional()
          .describe('Send Google’s notification email. Defaults to false.'),
        message: z.string().optional().describe('Note included in the notification email.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(
      async ({
        account,
        file_id,
        type,
        role,
        email_address,
        domain,
        notify,
        message,
      }: {
        account: string;
        file_id: string;
        type: 'user' | 'group' | 'domain' | 'anyone';
        role: 'reader' | 'commenter' | 'writer';
        email_address?: string;
        domain?: string;
        notify?: boolean;
        message?: string;
      }) =>
        ok(
          await shareDriveFile(account, file_id, {
            type,
            role,
            ...(email_address ? { emailAddress: email_address } : {}),
            ...(domain ? { domain } : {}),
            ...(notify !== undefined ? { notify } : {}),
            ...(message ? { message } : {}),
          }),
        ),
    ),
  );

  // =========================================================================
  // Calendar
  // =========================================================================

  // --- calendar_list_events ------------------------------------------------
  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      description:
        'List events in a time range. Omit "account" to look at EVERY connected calendar ' +
        'at once, merged and sorted by start time. Repeating events are expanded into ' +
        'their real occurrences. Times must carry an explicit UTC offset.',
      inputSchema: {
        time_min: isoInstantArg('Start of the range'),
        time_max: isoInstantArg('End of the range'),
        account: optionalAccountArg,
        calendar_id: calendarIdArg,
        max_results: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .describe('Maximum events to return per account. Default 25.'),
        query: z
          .string()
          .optional()
          .describe('Free text over summary, description, location and attendees.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        time_min,
        time_max,
        account,
        calendar_id,
        max_results,
        query,
      }: {
        time_min: string;
        time_max: string;
        account?: string;
        calendar_id?: string;
        max_results?: number;
        query?: string;
      }) => {
        const options = {
          timeMin: time_min,
          timeMax: time_max,
          ...(calendar_id ? { calendarId: calendar_id } : {}),
          ...(max_results !== undefined ? { maxResults: max_results } : {}),
          ...(query ? { query } : {}),
        };
        if (account) {
          const events = await listEvents(account, options);
          return ok({
            timeMin: time_min,
            timeMax: time_max,
            accountsSearched: [account],
            totalResults: events.length,
            events,
          });
        }
        return ok(await listEventsAllAccounts(options));
      },
    ),
  );

  // --- calendar_get_event --------------------------------------------------
  server.registerTool(
    'calendar_get_event',
    {
      title: 'Read a calendar event',
      description:
        'Read one event in full: description, location, attendees and their responses, ' +
        'and the link to open it.',
      inputSchema: {
        account: accountArg,
        event_id: z.string().min(1).describe('Event id, as returned by calendar_list_events.'),
        calendar_id: calendarIdArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        account,
        event_id,
        calendar_id,
      }: {
        account: string;
        event_id: string;
        calendar_id?: string;
      }) => ok(await getEvent(account, event_id, calendar_id)),
    ),
  );

  // --- calendar_create_event -----------------------------------------------
  server.registerTool(
    'calendar_create_event',
    {
      title: 'Create a calendar event',
      description:
        'Create an event. For a timed event, "start" and "end" are ISO 8601 WITH an ' +
        'offset. For an all-day event set "all_day" and give plain dates (YYYY-MM-DD) — ' +
        'note that Google treats the end date as EXCLUSIVE, so a one-day event ends on ' +
        'the following day. Listing attendees puts the event on their calendars; they ' +
        'are only emailed when "send_updates" says so.',
      inputSchema: {
        account: accountArg,
        summary: z.string().min(1).describe('Event title.'),
        start: z.string().min(1).describe('Start. ISO 8601 with offset, or YYYY-MM-DD if all_day.'),
        end: z.string().min(1).describe('End. ISO 8601 with offset, or YYYY-MM-DD if all_day.'),
        all_day: z.boolean().optional().describe('Treat start and end as plain dates.'),
        time_zone: z
          .string()
          .optional()
          .describe('IANA zone stored with the event, e.g. "Europe/Madrid".'),
        description: z.string().optional().describe('Body of the event.'),
        location: z.string().optional().describe('Where it happens.'),
        attendees: z.array(z.string().min(1)).optional().describe('Attendee email addresses.'),
        calendar_id: calendarIdArg,
        send_updates: sendUpdatesArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        summary,
        start,
        end,
        all_day,
        time_zone,
        description,
        location,
        attendees,
        calendar_id,
        send_updates,
      }: {
        account: string;
        summary: string;
        start: string;
        end: string;
        all_day?: boolean;
        time_zone?: string;
        description?: string;
        location?: string;
        attendees?: string[];
        calendar_id?: string;
        send_updates?: SendUpdates;
      }) =>
        ok(
          await createEvent(account, {
            summary,
            start,
            end,
            ...(all_day !== undefined ? { allDay: all_day } : {}),
            ...(time_zone ? { timeZone: time_zone } : {}),
            ...(description ? { description } : {}),
            ...(location ? { location } : {}),
            ...(attendees ? { attendees } : {}),
            ...(calendar_id ? { calendarId: calendar_id } : {}),
            ...(send_updates ? { sendUpdates: send_updates } : {}),
          }),
        ),
    ),
  );

  // --- calendar_update_event -----------------------------------------------
  server.registerTool(
    'calendar_update_event',
    {
      title: 'Update a calendar event',
      description:
        'Change an existing event. Only the fields you give are touched — except ' +
        '"start" and "end", which must be given together or not at all, because moving ' +
        'one end alone reshapes the meeting. Passing "attendees" REPLACES the guest ' +
        'list rather than adding to it.',
      inputSchema: {
        account: accountArg,
        event_id: z.string().min(1).describe('Event to change.'),
        summary: z.string().optional().describe('New title.'),
        start: z.string().optional().describe('New start. Must be given with "end".'),
        end: z.string().optional().describe('New end. Must be given with "start".'),
        all_day: z.boolean().optional().describe('Treat the new start and end as plain dates.'),
        time_zone: z.string().optional().describe('IANA zone stored with the event.'),
        description: z.string().optional().describe('New body.'),
        location: z.string().optional().describe('New location.'),
        attendees: z
          .array(z.string().min(1))
          .optional()
          .describe('Replacement guest list, in full.'),
        calendar_id: calendarIdArg,
        send_updates: sendUpdatesArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(
      async ({
        account,
        event_id,
        summary,
        start,
        end,
        all_day,
        time_zone,
        description,
        location,
        attendees,
        calendar_id,
        send_updates,
      }: {
        account: string;
        event_id: string;
        summary?: string;
        start?: string;
        end?: string;
        all_day?: boolean;
        time_zone?: string;
        description?: string;
        location?: string;
        attendees?: string[];
        calendar_id?: string;
        send_updates?: SendUpdates;
      }) =>
        ok(
          await updateEvent(account, event_id, {
            ...(summary !== undefined ? { summary } : {}),
            ...(start !== undefined ? { start } : {}),
            ...(end !== undefined ? { end } : {}),
            ...(all_day !== undefined ? { allDay: all_day } : {}),
            ...(time_zone ? { timeZone: time_zone } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(attendees ? { attendees } : {}),
            ...(calendar_id ? { calendarId: calendar_id } : {}),
            ...(send_updates ? { sendUpdates: send_updates } : {}),
          }),
        ),
    ),
  );

  // --- calendar_delete_event -----------------------------------------------
  server.registerTool(
    'calendar_delete_event',
    {
      title: 'Delete a calendar event',
      description:
        'Delete an event. This is IRREVERSIBLE from here — there is no undo and no bin. ' +
        'The event is read before deletion so the answer says what was removed. Only do ' +
        'this when the user has clearly asked for it.',
      inputSchema: {
        account: accountArg,
        event_id: z.string().min(1).describe('Event to delete.'),
        calendar_id: calendarIdArg,
        send_updates: sendUpdatesArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(
      async ({
        account,
        event_id,
        calendar_id,
        send_updates,
      }: {
        account: string;
        event_id: string;
        calendar_id?: string;
        send_updates?: SendUpdates;
      }) => ok(await deleteEvent(account, event_id, calendar_id, send_updates)),
    ),
  );

  // --- calendar_find_free_time ---------------------------------------------
  server.registerTool(
    'calendar_find_free_time',
    {
      title: 'Find free time',
      description:
        'Find gaps that are free on EVERY account asked about, within working hours. ' +
        '"time_min" and "time_max" must carry an explicit UTC offset. Working hours are ' +
        'interpreted in "timezone" (IANA), which defaults to the zone this server runs ' +
        'in and is always echoed back. IMPORTANT: if any calendar cannot be read, NO ' +
        'slots are returned and "incomplete" is set — a gap computed without one ' +
        "person's calendar is a double-booking, not an answer.",
      inputSchema: {
        time_min: isoInstantArg('Earliest instant to consider'),
        time_max: isoInstantArg('Latest instant to consider'),
        accounts: z
          .array(z.string().min(1))
          .optional()
          .describe('Restrict to these accounts. Omit to use every configured account.'),
        timezone: z
          .string()
          .optional()
          .describe('IANA zone for the working-hours bounds, e.g. "Europe/Madrid".'),
        workday_start: z.string().optional().describe('Start of the working day, "HH:MM". Default 09:00.'),
        workday_end: z.string().optional().describe('End of the working day, "HH:MM". Default 18:00.'),
        weekdays_only: z
          .boolean()
          .optional()
          .describe('Skip Saturdays and Sundays. Defaults to true.'),
        minimum_minutes: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe('Ignore gaps shorter than this. Default 30.'),
        calendar_id: calendarIdArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        time_min,
        time_max,
        accounts,
        timezone,
        workday_start,
        workday_end,
        weekdays_only,
        minimum_minutes,
        calendar_id,
      }: {
        time_min: string;
        time_max: string;
        accounts?: string[];
        timezone?: string;
        workday_start?: string;
        workday_end?: string;
        weekdays_only?: boolean;
        minimum_minutes?: number;
        calendar_id?: string;
      }) =>
        ok(
          await findFreeTime({
            timeMin: time_min,
            timeMax: time_max,
            ...(accounts ? { accounts } : {}),
            ...(timezone ? { timezone } : {}),
            ...(workday_start ? { workdayStart: workday_start } : {}),
            ...(workday_end ? { workdayEnd: workday_end } : {}),
            ...(weekdays_only !== undefined ? { weekdaysOnly: weekdays_only } : {}),
            ...(minimum_minutes !== undefined ? { minimumMinutes: minimum_minutes } : {}),
            ...(calendar_id ? { calendarId: calendar_id } : {}),
          }),
        ),
    ),
  );

  // =========================================================================
  // Contacts
  // =========================================================================

  // --- contacts_search -----------------------------------------------------
  server.registerTool(
    'contacts_search',
    {
      title: 'Search contacts',
      description:
        'Find people in the account address book. The query matches names, nicknames, ' +
        'email addresses, phone numbers and organisations. Omit "account" to search ' +
        'EVERY connected address book at once. The same person in two accounts is ' +
        'returned TWICE on purpose — each copy has its own id and belongs to a ' +
        'different address book, so merging them would make contacts_update edit the ' +
        'wrong one.',
      inputSchema: {
        query: z.string().min(1).describe('Name, email, phone number or company.'),
        account: optionalAccountArg,
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum contacts to return (per account when searching all). Default 20.'),
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
          const contacts = await searchContacts(account, query, max_results);
          return ok({
            query,
            accountsSearched: [account],
            totalResults: contacts.length,
            results: contacts,
          });
        }
        return ok(await searchAllContacts(query, max_results));
      },
    ),
  );

  // --- contacts_get --------------------------------------------------------
  server.registerTool(
    'contacts_get',
    {
      title: 'Read a contact',
      description:
        'Read one contact in full: every email and phone with its label, organisation, ' +
        'job title, postal addresses, links and notes.',
      inputSchema: {
        account: accountArg,
        resource_name: contactIdArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ account, resource_name }: { account: string; resource_name: string }) =>
      ok(await getContact(account, resource_name)),
    ),
  );

  // --- contacts_list -------------------------------------------------------
  server.registerTool(
    'contacts_list',
    {
      title: 'List contacts',
      description:
        'Page through an account address book, most recently changed first. Returns ' +
        '"nextPageToken" when there is more; pass it back as "page_token" for the next ' +
        'page. Use contacts_search when you are looking for someone in particular.',
      inputSchema: {
        account: accountArg,
        page_size: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Contacts per page. Default 50, maximum 200.'),
        page_token: z
          .string()
          .optional()
          .describe('The "nextPageToken" from the previous call. Omit for the first page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async ({
        account,
        page_size,
        page_token,
      }: {
        account: string;
        page_size?: number;
        page_token?: string;
      }) => ok(await listContacts(account, page_size, page_token)),
    ),
  );

  // --- contacts_create -----------------------------------------------------
  server.registerTool(
    'contacts_create',
    {
      title: 'Create a contact',
      description:
        'Add a person to the account address book. At least one field is required. ' +
        'Google does not check for duplicates — search first if the person might ' +
        'already be there.',
      inputSchema: {
        account: accountArg,
        ...contactFieldArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args: ContactArgs) => ok(await createContact(args.account, toContactWrite(args)))),
  );

  // --- contacts_update -----------------------------------------------------
  server.registerTool(
    'contacts_update',
    {
      title: 'Update a contact',
      description:
        'Change an existing contact. ⚠️ Each field you name is REPLACED, not merged: ' +
        'passing "emails" with one address removes every other address that contact ' +
        'had. Fields you do not name are left alone. Read the contact first with ' +
        'contacts_get and send back the full list of whichever field you are editing. ' +
        'The current version is re-read before writing, so a change made elsewhere in ' +
        'the meantime cannot be silently overwritten.',
      inputSchema: {
        account: accountArg,
        resource_name: contactIdArg,
        ...contactFieldArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args: ContactArgs & { resource_name: string }) =>
      ok(await updateContact(args.account, args.resource_name, toContactWrite(args))),
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
