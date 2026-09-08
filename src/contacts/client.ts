/**
 * The Contacts layer, over Google's People API.
 *
 * Everything that touches `people_v1` lives here so the rest of the codebase
 * works with the clean types from `./types.js`. The scope gate is in
 * `AccountClientCache`, which every function below goes through.
 *
 * Two things about this API are unlike the others and both bite silently:
 *
 *  1. `searchContacts` reads a server-side cache that has to be WARMED with an
 *     empty query first. Skip the warm-up and the first search of a session
 *     comes back empty — not an error, just nothing, which reads exactly like
 *     "you have no contacts called that".
 *
 *  2. `updateContact` is a REPLACE of the fields named in `updatePersonFields`,
 *     guarded by an `etag`. Name a field and omit its value and you have just
 *     deleted it.
 */

import { people as peopleApi, type people_v1 } from '@googleapis/people';

import { CONTACTS_SCOPES } from '../auth/oauth.js';
import { runAcrossAccounts } from '../core/accounts.js';
import type { AccountId } from '../core/errors.js';
import { GmailMcpError, mapGoogleError } from '../core/errors.js';
import { AccountClientCache } from '../core/google-client.js';
import type {
  ContactInfo,
  ContactListPage,
  ContactOrganization,
  ContactSearchResult,
  ContactValue,
  ContactWriteRequest,
} from './types.js';

const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 20;
const LIST_PAGE_CAP = 200;
const DEFAULT_LIST_PAGE = 50;

/** What we ask for. `searchContacts` calls it readMask; everything else personFields. */
const PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'biographies',
  'addresses',
  'urls',
  'photos',
  'metadata',
].join(',');

const contactsClients = new AccountClientCache<people_v1.People>(
  { name: 'Contacts', anyOf: CONTACTS_SCOPES },
  (authClient) => peopleApi({ version: 'v1', auth: authClient }),
);

/** Resolves an account reference (email or alias) and returns a ready client. */
export function contactsFor(reference: AccountId): Promise<{
  email: AccountId;
  api: people_v1.People;
}> {
  return contactsClients.for(reference);
}

function mapContactsError(error: unknown, account?: AccountId): GmailMcpError {
  return mapGoogleError(error, 'Contacts', account);
}

function clampMaxResults(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(requested), MAX_RESULTS_CAP);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface RawValue {
  value?: string | null;
  type?: string | null;
  metadata?: people_v1.Schema$FieldMetadata;
}

function toValues(entries: RawValue[] | undefined): ContactValue[] {
  const kept = (entries ?? []).filter(
    (entry): entry is RawValue & { value: string } => typeof entry.value === 'string' && entry.value !== '',
  );
  // Google marks the primary in metadata. When nothing is marked — which happens
  // on contacts imported from elsewhere — the first entry is the one every UI
  // shows, so that is what gets the flag.
  const anyMarked = kept.some((entry) => entry.metadata?.primary === true);

  return kept.map((entry, index) => ({
    value: entry.value,
    type: entry.type ?? null,
    primary: anyMarked ? entry.metadata?.primary === true : index === 0,
  }));
}

function toOrganizations(
  entries: people_v1.Schema$Organization[] | undefined,
): ContactOrganization[] {
  return (entries ?? []).map((entry) => ({
    name: entry.name ?? null,
    title: entry.title ?? null,
    department: entry.department ?? null,
  }));
}

function toContactInfo(account: AccountId, person: people_v1.Schema$Person): ContactInfo {
  const name = person.names?.[0];

  return {
    account,
    resourceName: person.resourceName ?? '',
    etag: person.etag ?? null,
    displayName: name?.displayName ?? null,
    givenName: name?.givenName ?? null,
    familyName: name?.familyName ?? null,
    emails: toValues(person.emailAddresses ?? undefined),
    phones: toValues(person.phoneNumbers ?? undefined),
    organizations: toOrganizations(person.organizations ?? undefined),
    notes: person.biographies?.[0]?.value ?? null,
    addresses: (person.addresses ?? [])
      .map((address) => address.formattedValue)
      .filter((value): value is string => typeof value === 'string'),
    urls: (person.urls ?? [])
      .map((url) => url.value)
      .filter((value): value is string => typeof value === 'string'),
    photoUrl: person.photos?.[0]?.url ?? null,
    updated: person.metadata?.sources?.[0]?.updateTime ?? null,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Accounts whose search cache we have already warmed in this process.
 *
 * Google's own guidance is to send a warm-up request with an empty query before
 * the first search. It is not optional in practice: without it the first search
 * returns an empty list, which is indistinguishable from a genuine no-match.
 */
const warmed = new Set<AccountId>();

const WARMUP_SETTLE_MS = 1200;

async function warmUpSearch(api: people_v1.People, email: AccountId): Promise<boolean> {
  if (warmed.has(email)) return false;
  await api.people.searchContacts({ query: '', readMask: PERSON_FIELDS, pageSize: 1 });
  warmed.add(email);
  return true;
}

/** Searches one account's contacts. Throws on failure. */
export async function searchContacts(
  reference: AccountId,
  query: string,
  maxResults?: number,
): Promise<ContactInfo[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      'A search needs a query. Use contacts_list to page through everything instead.',
    );
  }

  const limit = clampMaxResults(maxResults);
  const { email, api } = await contactsFor(reference);

  try {
    const justWarmed = await warmUpSearch(api, email);

    const run = async (): Promise<ContactInfo[]> => {
      const response = await api.people.searchContacts({
        query: trimmed,
        readMask: PERSON_FIELDS,
        pageSize: limit,
      });
      return (response.data.results ?? [])
        .map((result) => result.person)
        .filter((person): person is people_v1.Schema$Person => Boolean(person))
        .map((person) => toContactInfo(email, person));
    };

    const first = await run();

    // The cache is warmed asynchronously on Google's side. An empty first
    // result right after warming means "not ready yet" far more often than it
    // means "no such contact", so it earns exactly one retry — and only on the
    // search that did the warming, never on later ones.
    if (first.length > 0 || !justWarmed) return first;

    await new Promise((resolve) => setTimeout(resolve, WARMUP_SETTLE_MS));
    return await run();
  } catch (error) {
    throw mapContactsError(error, email);
  }
}

/** Searches every configured account's contacts and merges them by name. */
export async function searchAllContacts(
  query: string,
  maxResults?: number,
): Promise<ContactSearchResult> {
  const limit = clampMaxResults(maxResults);
  const across = await runAcrossAccounts((account) => searchContacts(account, query, limit));

  const merged = across.values
    .flat()
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
    .slice(0, limit);

  const result: ContactSearchResult = {
    query,
    accountsSearched: across.succeeded,
    totalResults: merged.length,
    results: merged,
  };

  // The same contact often exists in two accounts. They are NOT de-duplicated:
  // each carries its own resourceName and belongs to a different address book,
  // and merging them would produce an id that updates the wrong one.
  if (across.failures.length > 0) result.failures = across.failures;
  return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Cheap shape check, run before any network call so the useful error is the one you get. */
function assertContactId(resourceName: string): string {
  const target = resourceName.trim();
  if (!target.startsWith('people/')) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `A contact id looks like "people/c1234567890". Got "${resourceName}".`,
    );
  }
  return target;
}

export async function getContact(
  reference: AccountId,
  resourceName: string,
): Promise<ContactInfo> {
  const target = assertContactId(resourceName);
  const { email, api } = await contactsFor(reference);

  try {
    const response = await api.people.get({ resourceName: target, personFields: PERSON_FIELDS });
    return toContactInfo(email, response.data);
  } catch (error) {
    throw mapContactsError(error, email);
  }
}

export async function listContacts(
  reference: AccountId,
  pageSize?: number,
  pageToken?: string,
): Promise<ContactListPage> {
  const { email, api } = await contactsFor(reference);
  const size =
    pageSize && Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(Math.floor(pageSize), LIST_PAGE_CAP)
      : DEFAULT_LIST_PAGE;

  try {
    const response = await api.people.connections.list({
      resourceName: 'people/me',
      personFields: PERSON_FIELDS,
      pageSize: size,
      sortOrder: 'LAST_MODIFIED_DESCENDING',
      ...(pageToken ? { pageToken } : {}),
    });

    const contacts = (response.data.connections ?? []).map((person) =>
      toContactInfo(email, person),
    );

    const page: ContactListPage = {
      account: email,
      totalResults: contacts.length,
      contacts,
      totalPeople: response.data.totalPeople ?? null,
    };
    if (response.data.nextPageToken) page.nextPageToken = response.data.nextPageToken;
    return page;
  } catch (error) {
    throw mapContactsError(error, email);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Turns the request into a Person plus the list of fields it touches.
 *
 * The two go together on purpose: `updatePersonFields` is what Google replaces,
 * so a field listed here MUST have a value in the body or it is erased. Deriving
 * both from the same pass is what keeps them from drifting apart.
 */
function buildPerson(request: ContactWriteRequest): {
  person: people_v1.Schema$Person;
  fields: string[];
} {
  const person: people_v1.Schema$Person = {};
  const fields: string[] = [];

  if (request.givenName !== undefined || request.familyName !== undefined) {
    person.names = [
      {
        ...(request.givenName !== undefined ? { givenName: request.givenName } : {}),
        ...(request.familyName !== undefined ? { familyName: request.familyName } : {}),
      },
    ];
    fields.push('names');
  }

  if (request.emails !== undefined) {
    person.emailAddresses = request.emails.map((value) => ({ value }));
    fields.push('emailAddresses');
  }

  if (request.phones !== undefined) {
    person.phoneNumbers = request.phones.map((value) => ({ value }));
    fields.push('phoneNumbers');
  }

  if (request.organization !== undefined || request.jobTitle !== undefined) {
    person.organizations = [
      {
        ...(request.organization !== undefined ? { name: request.organization } : {}),
        ...(request.jobTitle !== undefined ? { title: request.jobTitle } : {}),
      },
    ];
    fields.push('organizations');
  }

  if (request.notes !== undefined) {
    person.biographies = [{ value: request.notes, contentType: 'TEXT_PLAIN' }];
    fields.push('biographies');
  }

  return { person, fields };
}

export async function createContact(
  reference: AccountId,
  request: ContactWriteRequest,
): Promise<ContactInfo> {
  const { email, api } = await contactsFor(reference);
  const { person, fields } = buildPerson(request);

  if (fields.length === 0) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      'A contact needs at least a name, an email, a phone, an organisation or a note.',
      email,
    );
  }

  try {
    const response = await api.people.createContact({
      personFields: PERSON_FIELDS,
      requestBody: person,
    });
    return toContactInfo(email, response.data);
  } catch (error) {
    throw mapContactsError(error, email);
  }
}

export async function updateContact(
  reference: AccountId,
  resourceName: string,
  request: ContactWriteRequest,
): Promise<ContactInfo> {
  const target = assertContactId(resourceName);
  const { email, api } = await contactsFor(reference);
  const { person, fields } = buildPerson(request);
  if (fields.length === 0) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'Nothing to update.', email);
  }

  try {
    // Read first, for the etag. Google rejects an update that does not carry the
    // current one — which is the point of it: it is what stops this write from
    // silently overwriting a change made on a phone thirty seconds ago.
    const current = await api.people.get({ resourceName: target, personFields: PERSON_FIELDS });
    const etag = current.data.etag;

    if (!etag) {
      throw new GmailMcpError(
        'API_ERROR',
        `Google returned no etag for ${target}, so the update cannot be made safely.`,
        email,
      );
    }

    const response = await api.people.updateContact({
      resourceName: target,
      updatePersonFields: fields.join(','),
      personFields: PERSON_FIELDS,
      requestBody: { ...person, etag },
    });
    return toContactInfo(email, response.data);
  } catch (error) {
    throw mapContactsError(error, email);
  }
}
