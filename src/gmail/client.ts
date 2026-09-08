/**
 * The Gmail layer: authenticated clients, MIME parsing and MIME building.
 *
 * Everything that touches `gmail_v1` lives here so the rest of the codebase
 * works with the clean types from `./types.js`.
 */

import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { getAuthenticatedClient, type GoogleOAuthClient } from '../auth/oauth.js';
import { resolveAccount } from '../auth/token-store.js';
import type {
  AccountId,
  AttachmentInfo,
  DraftResult,
  EmailMessage,
  EmailSummary,
  LabelInfo,
  OutgoingMessage,
  SendResult,
  ThreadResult,
} from './types.js';
import { GmailMcpError } from './types.js';

/** Bodies above this are truncated: a single email must not blow the context window. */
const MAX_BODY_CHARS = 60_000;

/**
 * Clients are cached per account for the process lifetime.
 *
 * This is not just a speed optimisation: the cached `OAuth2Client` owns the
 * `tokens` listener that persists refreshed credentials, so rebuilding it on
 * every call would multiply listeners and re-read the token file needlessly.
 */
const clientCache = new Map<AccountId, Promise<gmail_v1.Gmail>>();

async function buildClient(email: AccountId): Promise<gmail_v1.Gmail> {
  const authClient: GoogleOAuthClient = await getAuthenticatedClient(email);
  return gmailApi({ version: 'v1', auth: authClient });
}

/** Resolves an account reference (email or alias) and returns a ready client. */
export async function gmailFor(reference: AccountId): Promise<{
  email: AccountId;
  api: gmail_v1.Gmail;
}> {
  const account = await resolveAccount(reference);
  let pending = clientCache.get(account.email);
  if (!pending) {
    pending = buildClient(account.email);
    clientCache.set(account.email, pending);
  }
  try {
    return { email: account.email, api: await pending };
  } catch (error) {
    // A failed build must not poison the cache for every later call.
    clientCache.delete(account.email);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface HttpishError {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: unknown };
}

/**
 * Turns a Gaxios/Google failure into something an agent can act on.
 *
 * The distinction that matters is 401/403 (re-authorise) versus 429/5xx (retry
 * later) versus 404 (the id is wrong): an agent that cannot tell them apart
 * will retry the one case that will never succeed.
 */
export function mapGmailError(error: unknown, account?: AccountId): GmailMcpError {
  if (error instanceof GmailMcpError) return error;

  const e = error as HttpishError;
  const status =
    typeof e?.response?.status === 'number'
      ? e.response.status
      : typeof e?.status === 'number'
        ? e.status
        : typeof e?.code === 'number'
          ? e.code
          : undefined;

  const detail = typeof e?.message === 'string' ? e.message : String(error);

  switch (status) {
    case 401:
      return new GmailMcpError(
        'NOT_AUTHORIZED',
        `Gmail rejected the credentials for ${account ?? 'this account'}. ` +
          `The refresh token may have been revoked — re-run "gmail-multi-mcp setup".`,
        account,
      );
    case 403:
      return new GmailMcpError(
        'NOT_AUTHORIZED',
        `Access denied by Gmail: ${detail}. This is usually a missing scope or a ` +
          `disabled Gmail API in the Google Cloud project.`,
        account,
      );
    case 404:
      return new GmailMcpError('NOT_FOUND', `Not found: ${detail}`, account);
    case 429:
      return new GmailMcpError(
        'RATE_LIMITED',
        `Gmail rate limit hit for ${account ?? 'this account'}. Wait and retry.`,
        account,
      );
    default:
      if (typeof status === 'number' && status >= 500) {
        return new GmailMcpError(
          'API_ERROR',
          `Gmail is failing (HTTP ${status}): ${detail}. This is transient; retry.`,
          account,
        );
      }
      return new GmailMcpError('API_ERROR', detail, account);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header.name?.toLowerCase() === lower) return header.value ?? null;
  }
  return null;
}

/** Splits an address header on commas that are not inside quotes or angle brackets. */
function splitAddresses(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<') inAngle = true;
    else if (char === '>') inAngle = false;

    if (char === ',' && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last) out.push(last);
  return out;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Last-resort conversion so an HTML-only email is still readable as text. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ExtractedBody {
  plain: string[];
  html: string[];
  attachments: AttachmentInfo[];
}

/** Walks the MIME tree once, collecting text, HTML and attachment metadata. */
function walkParts(part: gmail_v1.Schema$MessagePart | undefined, out: ExtractedBody): void {
  if (!part) return;

  const mimeType = part.mimeType ?? '';
  const filename = part.filename ?? '';
  const data = part.body?.data;

  if (filename.length > 0) {
    out.attachments.push({
      attachmentId: part.body?.attachmentId ?? null,
      filename,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: part.body?.size ?? 0,
    });
  } else if (data) {
    if (mimeType === 'text/plain') out.plain.push(decodeBase64Url(data));
    else if (mimeType === 'text/html') out.html.push(decodeBase64Url(data));
  }

  for (const child of part.parts ?? []) walkParts(child, out);
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  body: string;
  truncated: boolean;
  attachments: AttachmentInfo[];
} {
  const collected: ExtractedBody = { plain: [], html: [], attachments: [] };
  walkParts(payload, collected);

  // text/plain wins; HTML is only stripped when there is nothing else.
  const raw =
    collected.plain.length > 0
      ? collected.plain.join('\n').trim()
      : collected.html.length > 0
        ? htmlToText(collected.html.join('\n'))
        : '';

  const truncated = raw.length > MAX_BODY_CHARS;
  return {
    body: truncated ? `${raw.slice(0, MAX_BODY_CHARS)}\n\n[... truncated ...]` : raw,
    truncated,
    attachments: collected.attachments,
  };
}

export function parseMessage(account: AccountId, message: gmail_v1.Schema$Message): EmailMessage {
  const headers = message.payload?.headers ?? undefined;
  const { body, truncated, attachments } = extractBody(message.payload ?? undefined);

  const parsed: EmailMessage = {
    account,
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    labelIds: message.labelIds ?? [],
    from: headerValue(headers, 'From'),
    to: splitAddresses(headerValue(headers, 'To')),
    cc: splitAddresses(headerValue(headers, 'Cc')),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: message.snippet ?? null,
    body,
    attachments,
    messageIdHeader: headerValue(headers, 'Message-ID'),
    referencesHeader: headerValue(headers, 'References'),
  };
  if (truncated) parsed.bodyTruncated = true;
  return parsed;
}

export function summarizeMessage(
  account: AccountId,
  message: gmail_v1.Schema$Message,
): EmailSummary {
  const headers = message.payload?.headers ?? undefined;
  const labelIds = message.labelIds ?? [];
  return {
    account,
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: message.snippet ?? null,
    labelIds,
    unread: labelIds.includes('UNREAD'),
  };
}

// ---------------------------------------------------------------------------
// Building outgoing mail
// ---------------------------------------------------------------------------

/**
 * RFC 2047 encoded-word, needed for any header that is not pure ASCII.
 *
 * Without this a subject like "Reunión" arrives mojibake — a bug that only
 * shows up outside English and is easy to ship unnoticed.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Strips CR/LF so a crafted value cannot inject extra headers. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildRawMessage(from: AccountId, message: OutgoingMessage): string {
  if (message.to.length === 0) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'At least one "to" recipient is required.');
  }

  const contentType = message.isHtml === true ? 'text/html' : 'text/plain';
  const headers: string[] = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${message.to.map((a) => sanitizeHeaderValue(a)).join(', ')}`,
  ];

  if (message.cc && message.cc.length > 0) {
    headers.push(`Cc: ${message.cc.map((a) => sanitizeHeaderValue(a)).join(', ')}`);
  }
  if (message.bcc && message.bcc.length > 0) {
    headers.push(`Bcc: ${message.bcc.map((a) => sanitizeHeaderValue(a)).join(', ')}`);
  }

  headers.push(`Subject: ${encodeHeader(sanitizeHeaderValue(message.subject))}`);

  // These two are what actually make a reply thread in every mail client.
  if (message.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(message.inReplyTo)}`);
  if (message.references) headers.push(`References: ${sanitizeHeaderValue(message.references)}`);

  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: ${contentType}; charset="UTF-8"`);
  headers.push('Content-Transfer-Encoding: base64');

  const body = Buffer.from(message.body, 'utf8').toString('base64');
  // Gmail accepts long base64 lines, but wrapping keeps the message RFC-clean.
  const wrapped = body.replace(/(.{76})/g, '$1\r\n');

  const raw = `${headers.join('\r\n')}\r\n\r\n${wrapped}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function fetchMessage(reference: AccountId, messageId: string): Promise<EmailMessage> {
  const { email, api } = await gmailFor(reference);
  try {
    const response = await api.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return parseMessage(email, response.data);
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

export async function fetchThread(reference: AccountId, threadId: string): Promise<ThreadResult> {
  const { email, api } = await gmailFor(reference);
  try {
    const response = await api.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });
    const messages = (response.data.messages ?? []).map((m) => parseMessage(email, m));
    return {
      account: email,
      threadId,
      subject: messages[0]?.subject ?? null,
      messageCount: messages.length,
      messages,
    };
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

export async function listLabels(reference: AccountId): Promise<{
  account: AccountId;
  labels: LabelInfo[];
}> {
  const { email, api } = await gmailFor(reference);
  try {
    const response = await api.users.labels.list({ userId: 'me' });
    const labels: LabelInfo[] = (response.data.labels ?? []).map((label) => {
      const info: LabelInfo = {
        id: label.id ?? '',
        name: label.name ?? '',
        type: label.type ?? null,
      };
      if (typeof label.messagesTotal === 'number') info.messagesTotal = label.messagesTotal;
      if (typeof label.messagesUnread === 'number') info.messagesUnread = label.messagesUnread;
      return info;
    });
    return { account: email, labels };
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

/**
 * Resolves a label name to its id, because agents naturally say "Important",
 * not "IMPORTANT" or "Label_42".
 */
async function resolveLabelIds(
  api: gmail_v1.Gmail,
  account: AccountId,
  names: string[],
): Promise<string[]> {
  const response = await api.users.labels.list({ userId: 'me' });
  const labels = response.data.labels ?? [];

  return names.map((name) => {
    const needle = name.trim().toLowerCase();
    const match =
      labels.find((l) => l.id?.toLowerCase() === needle) ??
      labels.find((l) => l.name?.toLowerCase() === needle);
    if (!match?.id) {
      const known = labels.map((l) => l.name).filter(Boolean).join(', ');
      throw new GmailMcpError(
        'NOT_FOUND',
        `No label matching "${name}" in ${account}. Available: ${known}`,
        account,
      );
    }
    return match.id;
  });
}

export async function labelMessage(
  reference: AccountId,
  messageId: string,
  addLabels: string[],
  removeLabels: string[],
): Promise<EmailSummary> {
  const { email, api } = await gmailFor(reference);
  try {
    const addLabelIds = addLabels.length > 0 ? await resolveLabelIds(api, email, addLabels) : [];
    const removeLabelIds =
      removeLabels.length > 0 ? await resolveLabelIds(api, email, removeLabels) : [];

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      throw new GmailMcpError(
        'INVALID_ARGUMENT',
        'Nothing to do: provide at least one label in "add_labels" or "remove_labels".',
        email,
      );
    }

    const response = await api.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    return summarizeMessage(email, response.data);
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

export async function createDraft(
  reference: AccountId,
  message: OutgoingMessage,
): Promise<DraftResult> {
  const { email, api } = await gmailFor(reference);
  try {
    const raw = buildRawMessage(email, message);
    const response = await api.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: message.threadId ? { raw, threadId: message.threadId } : { raw },
      },
    });
    return {
      account: email,
      draftId: response.data.id ?? '',
      messageId: response.data.message?.id ?? '',
      threadId: response.data.message?.threadId ?? '',
    };
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

export async function sendMessage(
  reference: AccountId,
  message: OutgoingMessage,
): Promise<SendResult> {
  const { email, api } = await gmailFor(reference);
  try {
    const raw = buildRawMessage(email, message);
    const response = await api.users.messages.send({
      userId: 'me',
      requestBody: message.threadId ? { raw, threadId: message.threadId } : { raw },
    });
    return {
      account: email,
      id: response.data.id ?? '',
      threadId: response.data.threadId ?? '',
      labelIds: response.data.labelIds ?? [],
    };
  } catch (error) {
    throw mapGmailError(error, email);
  }
}

/**
 * Replies to a message, keeping the thread intact.
 *
 * Threading needs three things and all three are easy to forget: the same
 * `threadId`, an `In-Reply-To` pointing at the original `Message-ID`, and a
 * `References` chain. Omit them and the reply shows up as a new conversation.
 */
export async function replyToMessage(
  reference: AccountId,
  messageId: string,
  body: string,
  options: { replyAll?: boolean; isHtml?: boolean } = {},
): Promise<SendResult> {
  const original = await fetchMessage(reference, messageId);

  const to = original.from ? [original.from] : [];
  if (to.length === 0) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `Message ${messageId} has no From header to reply to.`,
      original.account,
    );
  }

  const cc = options.replyAll === true ? original.cc : [];
  const subject = original.subject ?? '';
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

  const references = [original.referencesHeader, original.messageIdHeader]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');

  const outgoing: OutgoingMessage = {
    to,
    subject: replySubject,
    body,
    threadId: original.threadId,
  };
  if (cc.length > 0) outgoing.cc = cc;
  if (original.messageIdHeader) outgoing.inReplyTo = original.messageIdHeader;
  if (references) outgoing.references = references;
  if (options.isHtml === true) outgoing.isHtml = true;

  return sendMessage(reference, outgoing);
}

/** Live probe used by `list_accounts` to report more than "a file exists". */
export async function probeAccount(reference: AccountId): Promise<{
  emailAddress: string;
  messagesTotal: number;
}> {
  const { email, api } = await gmailFor(reference);
  try {
    const profile = await api.users.getProfile({ userId: 'me' });
    return {
      emailAddress: profile.data.emailAddress ?? email,
      messagesTotal: profile.data.messagesTotal ?? 0,
    };
  } catch (error) {
    throw mapGmailError(error, email);
  }
}
