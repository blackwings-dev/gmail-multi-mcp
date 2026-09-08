/**
 * Domain types for gmail-multi-mcp.
 *
 * Everything the MCP layer speaks is defined here, deliberately decoupled from
 * the raw `gmail_v1.Schema$*` shapes: the Google types are riddled with
 * `null | undefined` and change between API revisions, and we do not want that
 * leaking into tool responses.
 */

import type { AccountId } from '../core/errors.js';

/**
 * The account id and the error taxonomy now live in `core/`: Drive and Calendar
 * need exactly the same ones, and duplicating an error class is how two halves
 * of a codebase stop agreeing on what a failure means. Re-exported here so every
 * import path that already pointed at this file keeps working.
 */
export type { AccountId, GmailMcpErrorCode } from '../core/errors.js';
export { GmailMcpError } from '../core/errors.js';

/** OAuth client credentials. One Google Cloud project serves every account. */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Loopback redirect. Must match the Google Cloud OAuth client configuration. */
  redirectUri: string;
}

/** Tokens as persisted on disk, one file per account. */
export interface StoredTokens {
  accessToken: string | null;
  /**
   * The long-lived credential. Without it the account cannot refresh and must be
   * re-authorised, so its absence is treated as a hard error rather than ignored.
   */
  refreshToken: string;
  /** Epoch milliseconds. */
  expiryDate: number | null;
  scope: string | null;
  tokenType: string | null;
}

/** An account entry in `config.json`. Tokens live in a separate file. */
export interface AccountConfig {
  email: AccountId;
  /** Free-form label shown to the user, e.g. "work" or "personal". */
  alias?: string;
  addedAt: string;
}

export interface Config {
  version: 1;
  /** Optional: credentials can also come from the environment, which wins. */
  oauth?: {
    clientId: string;
    clientSecret: string;
  };
  accounts: AccountConfig[];
}

/** Reported by `list_accounts`. */
export interface AccountStatus {
  email: AccountId;
  alias: string | null;
  addedAt: string;
  /** False when the token file is missing or unreadable. */
  authorized: boolean;
  /** True when the stored access token is past its expiry; it will auto-refresh. */
  accessTokenExpired: boolean;
  scopes: string[];
  /** Scopes this build needs that the stored token never got. */
  missingScopes: string[];
  /** True when a scope is missing. A refresh will NOT fix it; only a new consent will. */
  needsReauthorization: boolean;
  /** Populated only when a live probe succeeded. */
  emailAddress?: string;
  messagesTotal?: number;
  /** Present when the account could not be reached. */
  error?: string;
}

/** A message as returned to the MCP client. */
export interface EmailMessage {
  account: AccountId;
  id: string;
  threadId: string;
  labelIds: string[];
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  snippet: string | null;
  /** Plain-text body, decoded and with the HTML fallback stripped when needed. */
  body: string;
  /** Set when the body was truncated to keep responses manageable. */
  bodyTruncated?: boolean;
  attachments: AttachmentInfo[];
  /** RFC 5322 Message-ID, needed to thread replies correctly. */
  messageIdHeader: string | null;
  referencesHeader: string | null;
}

export interface AttachmentInfo {
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Lightweight row used in search results. */
export interface EmailSummary {
  account: AccountId;
  id: string;
  threadId: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  labelIds: string[];
  unread: boolean;
}

export interface ThreadResult {
  account: AccountId;
  threadId: string;
  subject: string | null;
  messageCount: number;
  messages: EmailMessage[];
}

export interface LabelInfo {
  id: string;
  name: string;
  type: string | null;
  messagesTotal?: number;
  messagesUnread?: number;
}

/** Result of a search over one account. Failures are values, not exceptions. */
export interface AccountSearchOutcome {
  account: AccountId;
  ok: boolean;
  messages: EmailSummary[];
  error?: string;
}

export interface MultiAccountSearchResult {
  query: string;
  accountsSearched: AccountId[];
  totalResults: number;
  results: EmailSummary[];
  /** Only present when at least one account failed; the rest still returned. */
  failures?: { account: AccountId; error: string }[];
}

/**
 * The outcome of moving a message to the bin, or bringing it back.
 *
 * `trashed` is read from the labels Gmail returns AFTER the change, not from
 * what we asked for: it reports what happened rather than what was intended.
 */
export interface TrashResult {
  account: AccountId;
  id: string;
  threadId: string;
  /** True when the message now carries the TRASH label. */
  trashed: boolean;
  labelIds: string[];
  subject: string | null;
  from: string | null;
  date: string | null;
}

export interface SendResult {
  account: AccountId;
  id: string;
  threadId: string;
  labelIds: string[];
}

export interface DraftResult {
  account: AccountId;
  draftId: string;
  messageId: string;
  threadId: string;
}

/** Payload shared by `create_draft`, `send_message` and `reply`. */
export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** When set, the message is attached to an existing thread. */
  threadId?: string;
  /** RFC 5322 Message-ID of the message being answered. */
  inReplyTo?: string;
  references?: string;
  isHtml?: boolean;
}
