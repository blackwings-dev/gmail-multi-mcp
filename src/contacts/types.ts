/**
 * Domain types for the Contacts layer.
 *
 * The People API returns every field as an array of objects carrying their own
 * metadata, source and provenance. That is faithful to how Google stores a
 * contact and useless to read, so it is flattened here.
 */

import type { AccountId } from '../core/errors.js';

export interface ContactValue {
  value: string;
  /** "home", "work", "mobile"… free text; Google does not constrain it. */
  type: string | null;
  primary: boolean;
}

export interface ContactOrganization {
  name: string | null;
  title: string | null;
  department: string | null;
}

export interface ContactInfo {
  account: AccountId;
  /** `people/c1234…` — the id every other Contacts tool takes. */
  resourceName: string;
  /**
   * Optimistic-concurrency token.
   *
   * Google REFUSES an update that does not carry the current one, which is why
   * `contacts_update` re-reads the contact before writing rather than trusting
   * whatever the caller last saw.
   */
  etag: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  emails: ContactValue[];
  phones: ContactValue[];
  organizations: ContactOrganization[];
  notes: string | null;
  addresses: string[];
  urls: string[];
  photoUrl: string | null;
  updated: string | null;
}

export interface ContactSearchResult {
  query: string;
  accountsSearched: AccountId[];
  totalResults: number;
  results: ContactInfo[];
  /** Only present when at least one account failed; the rest still returned. */
  failures?: { account: AccountId; error: string }[];
}

export interface ContactListPage {
  account: AccountId;
  totalResults: number;
  contacts: ContactInfo[];
  /** Pass back as `page_token` to get the next page. Absent on the last one. */
  nextPageToken?: string;
  /** What Google says the whole address book holds, not just this page. */
  totalPeople: number | null;
}

/**
 * What `contacts_create` and `contacts_update` accept.
 *
 * Every field optional so an update can touch one thing — but see the warning
 * in `client.ts`: on update, naming a field and leaving it empty CLEARS it.
 */
export interface ContactWriteRequest {
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
}
