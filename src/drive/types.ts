/**
 * Domain types for the Drive layer.
 *
 * Same principle as `gmail/types.ts`: `drive_v3.Schema$File` is a wall of
 * `string | null | undefined` and changes between revisions, so it is flattened
 * here into shapes a tool response can promise.
 */

import type { AccountId } from '../core/errors.js';

export interface DriveFileInfo {
  account: AccountId;
  id: string;
  name: string;
  mimeType: string;
  /** Google-native documents report no size; that is not an error. */
  sizeBytes: number | null;
  modifiedTime: string | null;
  createdTime: string | null;
  webViewLink: string | null;
  owners: string[];
  parents: string[];
  shared: boolean;
  trashed: boolean;
  isFolder: boolean;
  /** True for Docs, Sheets, Slides and friends — they must be exported, not downloaded. */
  isGoogleNative: boolean;
}

export interface DriveSearchResult {
  query: string;
  accountsSearched: AccountId[];
  totalResults: number;
  results: DriveFileInfo[];
  /** Only present when at least one account failed; the rest still returned. */
  failures?: { account: AccountId; error: string }[];
}

export interface DriveFolderListing {
  account: AccountId;
  folderId: string;
  folderName: string | null;
  totalResults: number;
  files: DriveFileInfo[];
}

export interface DriveFileContent {
  account: AccountId;
  id: string;
  name: string;
  mimeType: string;
  /** The MIME type the content was converted to, when the file is Google-native. */
  exportedAs: string | null;
  content: string;
  /** Set when the content was cut to keep the response manageable. */
  truncated?: boolean;
  sizeBytes: number | null;
  webViewLink: string | null;
}

export interface DriveUploadResult {
  account: AccountId;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  webViewLink: string | null;
  parents: string[];
}

export interface DrivePermissionResult {
  account: AccountId;
  fileId: string;
  fileName: string | null;
  permissionId: string;
  role: string;
  type: string;
  grantedTo: string | null;
  /** True when the file was made reachable by anyone holding the link. */
  publicLink: boolean;
  webViewLink: string | null;
}

/** What `drive_share` accepts. Deliberately narrower than the Drive API. */
export interface ShareRequest {
  /** `user` and `group` need an address; `domain` needs a domain; `anyone` is a public link. */
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'reader' | 'commenter' | 'writer';
  emailAddress?: string;
  domain?: string;
  /** Send Google's notification email. Off by default: sharing should be quiet unless asked. */
  notify?: boolean;
  message?: string;
}

export interface UploadRequest {
  name: string;
  /** Inline content, for text the model composed itself. */
  content?: string;
  /** A path on the machine running this server, for a file that already exists. */
  localPath?: string;
  mimeType?: string;
  parentFolderId?: string;
}
