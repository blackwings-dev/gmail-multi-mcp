/**
 * The Drive layer: authenticated clients, queries, exports and uploads.
 *
 * Everything that touches `drive_v3` lives here so the rest of the codebase
 * works with the clean types from `./types.js`.
 *
 * The scope gate is NOT in this file — it is inside `AccountClientCache`, which
 * every function below has to go through to get a client. That is deliberate:
 * a check placed here would have to be repeated in each new function, and the
 * one that gets forgotten is the one that matters.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { drive as driveApi, type drive_v3 } from '@googleapis/drive';

import { DRIVE_SCOPES } from '../auth/oauth.js';
import { runAcrossAccounts } from '../core/accounts.js';
import type { AccountId } from '../core/errors.js';
import { GmailMcpError, mapGoogleError } from '../core/errors.js';
import { AccountClientCache } from '../core/google-client.js';
import type {
  DriveFileContent,
  DriveFileInfo,
  DriveFolderListing,
  DrivePermissionResult,
  DriveSearchResult,
  DriveUploadResult,
  ShareRequest,
  UploadRequest,
} from './types.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** Same ceiling as an email body: one file must not swallow the context window. */
const MAX_CONTENT_CHARS = 60_000;

/** Above this we refuse rather than stream megabytes of binary into a JSON response. */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 20;

const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,owners(emailAddress),parents,shared,trashed';

const LIST_FIELDS = `files(${FILE_FIELDS})`;

/**
 * How a Google-native document becomes text.
 *
 * A Doc cannot be downloaded, only exported, and picking the export format is a
 * product decision rather than a technical one: CSV for a sheet keeps the table
 * legible to a model, where XLSX would arrive as unreadable bytes.
 */
const EXPORT_FORMATS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

/** MIME types we are willing to return as text without exporting. */
function isTextual(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-yaml',
    'application/yaml',
    'application/sql',
    'image/svg+xml',
  ].includes(mimeType);
}

const driveClients = new AccountClientCache<drive_v3.Drive>(
  { name: 'Drive', anyOf: DRIVE_SCOPES },
  (authClient) => driveApi({ version: 'v3', auth: authClient }),
);

/** Resolves an account reference (email or alias) and returns a ready client. */
export function driveFor(reference: AccountId): Promise<{
  email: AccountId;
  api: drive_v3.Drive;
}> {
  return driveClients.for(reference);
}

function mapDriveError(error: unknown, account?: AccountId): GmailMcpError {
  return mapGoogleError(error, 'Drive', account);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Drive query values are single-quoted, so an apostrophe in a filename ends the
 * string and the rest is parsed as syntax. "Ana's notes" is not an exotic case.
 */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface QueryParts {
  text?: string;
  raw?: string;
  includeTrashed?: boolean;
}

function buildDriveQuery({ text, raw, includeTrashed }: QueryParts): string {
  const clauses: string[] = [];

  const trimmedText = text?.trim();
  if (trimmedText) {
    const value = escapeQueryValue(trimmedText);
    clauses.push(`(name contains '${value}' or fullText contains '${value}')`);
  }

  const trimmedRaw = raw?.trim();
  if (trimmedRaw) clauses.push(`(${trimmedRaw})`);

  if (clauses.length === 0) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      'Give either "query" (free text) or "drive_query" (raw Drive query syntax).',
    );
  }

  if (includeTrashed !== true) clauses.push('trashed = false');
  return clauses.join(' and ');
}

function clampMaxResults(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(requested), MAX_RESULTS_CAP);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toFileInfo(account: AccountId, file: drive_v3.Schema$File): DriveFileInfo {
  const mimeType = file.mimeType ?? 'application/octet-stream';
  const size = file.size !== null && file.size !== undefined ? Number.parseInt(file.size, 10) : NaN;

  return {
    account,
    id: file.id ?? '',
    name: file.name ?? '(untitled)',
    mimeType,
    sizeBytes: Number.isFinite(size) ? size : null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    webViewLink: file.webViewLink ?? null,
    owners: (file.owners ?? [])
      .map((owner) => owner.emailAddress)
      .filter((address): address is string => typeof address === 'string'),
    parents: file.parents ?? [],
    shared: file.shared === true,
    trashed: file.trashed === true,
    isFolder: mimeType === FOLDER_MIME,
    isGoogleNative: mimeType.startsWith(GOOGLE_NATIVE_PREFIX),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Searches one account's Drive. Throws on failure — the caller decides how to react. */
export async function searchDrive(
  reference: AccountId,
  parts: QueryParts,
  maxResults?: number,
): Promise<DriveFileInfo[]> {
  const limit = clampMaxResults(maxResults);
  const q = buildDriveQuery(parts);
  const { email, api } = await driveFor(reference);

  try {
    const response = await api.files.list({
      q,
      pageSize: limit,
      fields: LIST_FIELDS,
      orderBy: 'modifiedTime desc',
    });
    return (response.data.files ?? []).map((file) => toFileInfo(email, file));
  } catch (error) {
    throw mapDriveError(error, email);
  }
}

/**
 * Searches every configured account's Drive in parallel and merges the results.
 *
 * `maxResults` is per account, then the merged list is trimmed to the same
 * number — asking for 20 across three accounts should not return 60.
 */
export async function searchAllDrives(
  parts: QueryParts,
  maxResults?: number,
): Promise<DriveSearchResult> {
  const limit = clampMaxResults(maxResults);
  const across = await runAcrossAccounts((account) => searchDrive(account, parts, limit));

  const merged = across.values
    .flat()
    .sort((a, b) => {
      const left = a.modifiedTime ? Date.parse(a.modifiedTime) : 0;
      const right = b.modifiedTime ? Date.parse(b.modifiedTime) : 0;
      return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left);
    })
    .slice(0, limit);

  const result: DriveSearchResult = {
    query: buildDriveQuery(parts),
    accountsSearched: across.succeeded,
    totalResults: merged.length,
    results: merged,
  };

  // Silence about a failed account would be the worst outcome: the agent would
  // read "3 files" and never learn that a fourth Drive was unreachable.
  if (across.failures.length > 0) result.failures = across.failures;
  return result;
}

// ---------------------------------------------------------------------------
// Listing a folder
// ---------------------------------------------------------------------------

export async function listDriveFolder(
  reference: AccountId,
  folderId: string,
  maxResults?: number,
): Promise<DriveFolderListing> {
  const limit = clampMaxResults(maxResults);
  const { email, api } = await driveFor(reference);
  const target = folderId.trim() || 'root';

  try {
    let folderName: string | null = null;
    if (target !== 'root') {
      const meta = await api.files.get({ fileId: target, fields: 'id,name,mimeType' });
      if (meta.data.mimeType !== FOLDER_MIME) {
        throw new GmailMcpError(
          'INVALID_ARGUMENT',
          `${target} is not a folder (${meta.data.mimeType ?? 'unknown type'}). ` +
            'Use drive_read for a file.',
          email,
        );
      }
      folderName = meta.data.name ?? null;
    }

    const response = await api.files.list({
      q: `'${escapeQueryValue(target)}' in parents and trashed = false`,
      pageSize: limit,
      fields: LIST_FIELDS,
      // Folders first, then most recently touched: the shape of a file browser.
      orderBy: 'folder,modifiedTime desc',
    });

    const files = (response.data.files ?? []).map((file) => toFileInfo(email, file));
    return {
      account: email,
      folderId: target,
      folderName: target === 'root' ? 'My Drive' : folderName,
      totalResults: files.length,
      files,
    };
  } catch (error) {
    throw mapDriveError(error, email);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Gaxios types the body as the resource schema even when the request asked for
 * raw media, so what actually arrives is a string. Narrowing at the boundary is
 * the honest way to say that: the declared type is wrong, and this is where the
 * lie stops.
 */
function asText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return JSON.stringify(data, null, 2);
}

export async function readDriveFile(
  reference: AccountId,
  fileId: string,
  maxChars = MAX_CONTENT_CHARS,
): Promise<DriveFileContent> {
  const { email, api } = await driveFor(reference);

  try {
    const meta = await api.files.get({ fileId, fields: FILE_FIELDS });
    const info = toFileInfo(email, meta.data);

    if (info.isFolder) {
      throw new GmailMcpError(
        'INVALID_ARGUMENT',
        `${info.name} is a folder. Use drive_list to see what is inside it.`,
        email,
      );
    }

    let raw: unknown;
    let exportedAs: string | null = null;

    if (info.isGoogleNative) {
      const format = EXPORT_FORMATS[info.mimeType];
      if (!format) {
        throw new GmailMcpError(
          'INVALID_ARGUMENT',
          `${info.name} is a ${info.mimeType}, which has no text representation. ` +
            `Open it at ${info.webViewLink ?? 'Drive'}.`,
          email,
        );
      }
      exportedAs = format;
      const response = await api.files.export(
        { fileId, mimeType: format },
        { responseType: 'text' },
      );
      raw = response.data;
    } else {
      if (!isTextual(info.mimeType)) {
        throw new GmailMcpError(
          'INVALID_ARGUMENT',
          `${info.name} is ${info.mimeType}, which is not text. This tool does not download ` +
            `binary files. Open it at ${info.webViewLink ?? 'Drive'}.`,
          email,
        );
      }
      if (info.sizeBytes !== null && info.sizeBytes > MAX_DOWNLOAD_BYTES) {
        throw new GmailMcpError(
          'INVALID_ARGUMENT',
          `${info.name} is ${Math.round(info.sizeBytes / 1024 / 1024)} MB, over the ` +
            `${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit for reading a file inline.`,
          email,
        );
      }
      const response = await api.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      raw = response.data;
    }

    const full = asText(raw);
    const truncated = full.length > maxChars;

    const content: DriveFileContent = {
      account: email,
      id: info.id,
      name: info.name,
      mimeType: info.mimeType,
      exportedAs,
      content: truncated ? full.slice(0, maxChars) : full,
      sizeBytes: info.sizeBytes,
      webViewLink: info.webViewLink,
    };
    if (truncated) content.truncated = true;
    return content;
  } catch (error) {
    throw mapDriveError(error, email);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function guessMimeType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const table: Readonly<Record<string, string>> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    zip: 'application/zip',
  };
  return table[extension] ?? 'application/octet-stream';
}

export async function uploadToDrive(
  reference: AccountId,
  request: UploadRequest,
): Promise<DriveUploadResult> {
  const { email, api } = await driveFor(reference);

  const hasInline = typeof request.content === 'string';
  const hasPath = typeof request.localPath === 'string' && request.localPath.length > 0;

  if (hasInline === hasPath) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      'Give exactly one of "content" (inline text) or "local_path" (a file on this machine).',
      email,
    );
  }

  let body: string | ReturnType<typeof createReadStream>;
  let name = request.name.trim();

  if (hasPath && request.localPath) {
    const stats = await stat(request.localPath).catch(() => null);
    if (!stats?.isFile()) {
      throw new GmailMcpError(
        'INVALID_ARGUMENT',
        `No readable file at ${request.localPath}.`,
        email,
      );
    }
    if (!name) name = basename(request.localPath);
    body = createReadStream(request.localPath);
  } else {
    if (!name) {
      throw new GmailMcpError('INVALID_ARGUMENT', 'A name is required for inline content.', email);
    }
    body = request.content ?? '';
  }

  const mimeType = request.mimeType ?? guessMimeType(name);

  try {
    const response = await api.files.create({
      requestBody: {
        name,
        ...(request.parentFolderId ? { parents: [request.parentFolderId] } : {}),
      },
      media: { mimeType, body },
      fields: FILE_FIELDS,
    });
    const info = toFileInfo(email, response.data);
    return {
      account: email,
      id: info.id,
      name: info.name,
      mimeType: info.mimeType,
      sizeBytes: info.sizeBytes,
      webViewLink: info.webViewLink,
      parents: info.parents,
    };
  } catch (error) {
    throw mapDriveError(error, email);
  }
}

/**
 * Creates a real Google Doc, not a text file.
 *
 * The trick is asking Drive for a `google-apps.document` while uploading
 * `text/plain`: Drive converts on the way in. Creating the file and then
 * writing to it would need the Docs API and a second scope.
 */
export async function createGoogleDoc(
  reference: AccountId,
  name: string,
  content: string,
  parentFolderId?: string,
): Promise<DriveUploadResult> {
  const { email, api } = await driveFor(reference);
  const title = name.trim();

  if (!title) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'A document needs a name.', email);
  }

  try {
    const response = await api.files.create({
      requestBody: {
        name: title,
        mimeType: 'application/vnd.google-apps.document',
        ...(parentFolderId ? { parents: [parentFolderId] } : {}),
      },
      ...(content ? { media: { mimeType: 'text/plain', body: content } } : {}),
      fields: FILE_FIELDS,
    });
    const info = toFileInfo(email, response.data);
    return {
      account: email,
      id: info.id,
      name: info.name,
      mimeType: info.mimeType,
      sizeBytes: info.sizeBytes,
      webViewLink: info.webViewLink,
      parents: info.parents,
    };
  } catch (error) {
    throw mapDriveError(error, email);
  }
}

export async function shareDriveFile(
  reference: AccountId,
  fileId: string,
  request: ShareRequest,
): Promise<DrivePermissionResult> {
  const { email, api } = await driveFor(reference);

  if ((request.type === 'user' || request.type === 'group') && !request.emailAddress) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `Sharing with a ${request.type} needs "email_address".`,
      email,
    );
  }
  if (request.type === 'domain' && !request.domain) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'Sharing with a domain needs "domain".', email);
  }

  // Google refuses a notification for a link permission, and it would have
  // nobody to notify anyway.
  const notify = request.type === 'anyone' ? false : request.notify === true;

  try {
    const meta = await api.files.get({ fileId, fields: 'id,name,webViewLink' });

    const response = await api.permissions.create({
      fileId,
      sendNotificationEmail: notify,
      ...(notify && request.message ? { emailMessage: request.message } : {}),
      requestBody: {
        type: request.type,
        role: request.role,
        ...(request.emailAddress ? { emailAddress: request.emailAddress } : {}),
        ...(request.domain ? { domain: request.domain } : {}),
      },
      fields: 'id,type,role,emailAddress,domain',
    });

    return {
      account: email,
      fileId,
      fileName: meta.data.name ?? null,
      permissionId: response.data.id ?? '',
      role: response.data.role ?? request.role,
      type: response.data.type ?? request.type,
      grantedTo: response.data.emailAddress ?? response.data.domain ?? null,
      publicLink: request.type === 'anyone',
      webViewLink: meta.data.webViewLink ?? null,
    };
  } catch (error) {
    throw mapDriveError(error, email);
  }
}
