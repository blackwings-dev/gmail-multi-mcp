/**
 * The Calendar layer: events across accounts, and free/busy arithmetic.
 *
 * Everything that touches `calendar_v3` lives here so the rest of the codebase
 * works with the clean types from `./types.js`. The scope gate is in
 * `AccountClientCache`, which every function below goes through.
 */

import { calendar as calendarApi, type calendar_v3 } from '@googleapis/calendar';

import { CALENDAR_SCOPES } from '../auth/oauth.js';
import { runAcrossAccounts } from '../core/accounts.js';
import type { AccountId } from '../core/errors.js';
import { GmailMcpError, mapGoogleError } from '../core/errors.js';
import { AccountClientCache } from '../core/google-client.js';
import {
  MINUTE,
  addDays,
  assertValidTimeZone,
  mergeIntervals,
  parseClockTime,
  parseInstant,
  subtractIntervals,
  systemTimeZone,
  weekdayOf,
  zonedDateParts,
  zonedTimeToInstant,
  type Interval,
} from './timezone.js';
import type {
  AttendeeInfo,
  CalendarEventInfo,
  EventPatchRequest,
  EventTime,
  EventWriteRequest,
  FreeSlot,
  FreeTimeResult,
  MultiAccountEvents,
  SendUpdates,
} from './types.js';

const DEFAULT_CALENDAR = 'primary';
const MAX_RESULTS_CAP = 250;
const DEFAULT_MAX_RESULTS = 25;

/** A free/busy query over a year would time out and answer nothing useful. */
const MAX_RANGE_DAYS = 62;

const DEFAULT_WORKDAY_START = '09:00';
const DEFAULT_WORKDAY_END = '18:00';
const DEFAULT_MINIMUM_MINUTES = 30;

const calendarClients = new AccountClientCache<calendar_v3.Calendar>(
  { name: 'Calendar', anyOf: CALENDAR_SCOPES },
  (authClient) => calendarApi({ version: 'v3', auth: authClient }),
);

/** Resolves an account reference (email or alias) and returns a ready client. */
export function calendarFor(reference: AccountId): Promise<{
  email: AccountId;
  api: calendar_v3.Calendar;
}> {
  return calendarClients.for(reference);
}

function mapCalendarError(error: unknown, account?: AccountId): GmailMcpError {
  return mapGoogleError(error, 'Calendar', account);
}

function clampMaxResults(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(requested), MAX_RESULTS_CAP);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toEventTime(time: calendar_v3.Schema$EventDateTime | undefined): EventTime {
  return {
    value: time?.dateTime ?? time?.date ?? null,
    timeZone: time?.timeZone ?? null,
  };
}

function toAttendees(attendees: calendar_v3.Schema$EventAttendee[] | undefined): AttendeeInfo[] {
  return (attendees ?? [])
    .filter((a): a is calendar_v3.Schema$EventAttendee & { email: string } =>
      typeof a.email === 'string',
    )
    .map((a) => ({
      email: a.email,
      displayName: a.displayName ?? null,
      responseStatus: a.responseStatus ?? null,
      optional: a.optional === true,
      organizer: a.organizer === true,
    }));
}

function toEventInfo(
  account: AccountId,
  calendarId: string,
  event: calendar_v3.Schema$Event,
): CalendarEventInfo {
  return {
    account,
    calendarId,
    id: event.id ?? '',
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: toEventTime(event.start ?? undefined),
    end: toEventTime(event.end ?? undefined),
    // A date without a time is Google's way of saying "all day"; there is no flag.
    allDay: typeof event.start?.date === 'string',
    status: event.status ?? null,
    organizer: event.organizer?.email ?? null,
    attendees: toAttendees(event.attendees ?? undefined),
    htmlLink: event.htmlLink ?? null,
    meetingLink: event.hangoutLink ?? null,
    recurringEventId: event.recurringEventId ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListEventsOptions {
  timeMin: string;
  timeMax: string;
  calendarId?: string;
  maxResults?: number;
  /** Free-text search over summary, description, location and attendees. */
  query?: string;
}

/** Lists one account's events in a range. Throws on failure. */
export async function listEvents(
  reference: AccountId,
  options: ListEventsOptions,
): Promise<CalendarEventInfo[]> {
  const timeMin = parseInstant(options.timeMin, 'time_min');
  const timeMax = parseInstant(options.timeMax, 'time_max');
  if (timeMax <= timeMin) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'time_max must be after time_min.');
  }

  const calendarId = options.calendarId?.trim() || DEFAULT_CALENDAR;
  const { email, api } = await calendarFor(reference);

  try {
    const response = await api.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: clampMaxResults(options.maxResults),
      // Expands repeating events into real occurrences; without it a weekly
      // stand-up appears once, in the past, and every later instance is invisible.
      singleEvents: true,
      orderBy: 'startTime',
      ...(options.query ? { q: options.query } : {}),
    });
    return (response.data.items ?? []).map((event) => toEventInfo(email, calendarId, event));
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

/** Lists events across every configured account and merges them by start time. */
export async function listEventsAllAccounts(
  options: ListEventsOptions,
): Promise<MultiAccountEvents> {
  const across = await runAcrossAccounts((account) => listEvents(account, options));

  const merged = across.values.flat().sort((a, b) => {
    const left = a.start.value ? Date.parse(a.start.value) : 0;
    const right = b.start.value ? Date.parse(b.start.value) : 0;
    return (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
  });

  const result: MultiAccountEvents = {
    timeMin: options.timeMin,
    timeMax: options.timeMax,
    accountsSearched: across.succeeded,
    totalResults: merged.length,
    events: merged,
  };
  if (across.failures.length > 0) result.failures = across.failures;
  return result;
}

export async function getEvent(
  reference: AccountId,
  eventId: string,
  calendarId = DEFAULT_CALENDAR,
): Promise<CalendarEventInfo> {
  const { email, api } = await calendarFor(reference);
  const target = calendarId.trim() || DEFAULT_CALENDAR;
  try {
    const response = await api.events.get({ calendarId: target, eventId });
    return toEventInfo(email, target, response.data);
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function toSchemaTime(
  value: string,
  allDay: boolean,
  timeZone: string | undefined,
  label: string,
): calendar_v3.Schema$EventDateTime {
  const trimmed = value.trim();

  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new GmailMcpError(
        'INVALID_ARGUMENT',
        `${label} must be a plain date (YYYY-MM-DD) for an all-day event. Got "${value}".`,
      );
    }
    return { date: trimmed };
  }

  // Validated for an explicit offset; a naked local time is refused here rather
  // than reinterpreted somewhere it cannot be seen.
  parseInstant(trimmed, label);
  return { dateTime: trimmed, ...(timeZone ? { timeZone } : {}) };
}

function attendeeList(emails: string[] | undefined): calendar_v3.Schema$EventAttendee[] | undefined {
  if (!emails || emails.length === 0) return undefined;
  return emails.map((email) => ({ email }));
}

export async function createEvent(
  reference: AccountId,
  request: EventWriteRequest,
): Promise<CalendarEventInfo> {
  const { email, api } = await calendarFor(reference);
  const calendarId = request.calendarId?.trim() || DEFAULT_CALENDAR;
  const allDay = request.allDay === true;

  if (request.timeZone) assertValidTimeZone(request.timeZone);

  const start = toSchemaTime(request.start, allDay, request.timeZone, 'start');
  const end = toSchemaTime(request.end, allDay, request.timeZone, 'end');

  const attendees = attendeeList(request.attendees);

  try {
    const response = await api.events.insert({
      calendarId,
      sendUpdates: request.sendUpdates ?? 'none',
      requestBody: {
        summary: request.summary,
        start,
        end,
        ...(request.description ? { description: request.description } : {}),
        ...(request.location ? { location: request.location } : {}),
        ...(attendees ? { attendees } : {}),
      },
    });
    return toEventInfo(email, calendarId, response.data);
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

export async function updateEvent(
  reference: AccountId,
  eventId: string,
  patch: EventPatchRequest,
): Promise<CalendarEventInfo> {
  const { email, api } = await calendarFor(reference);
  const calendarId = patch.calendarId?.trim() || DEFAULT_CALENDAR;

  if (patch.timeZone) assertValidTimeZone(patch.timeZone);

  // `patch` only touches what it names, but start and end are a pair: moving one
  // end of an event without the other is how a meeting silently becomes six hours.
  if ((patch.start === undefined) !== (patch.end === undefined)) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      'Give both "start" and "end", or neither. Changing one alone reshapes the event ' +
        'in a way that is almost never what was meant.',
      email,
    );
  }

  const body: calendar_v3.Schema$Event = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;

  if (patch.start !== undefined && patch.end !== undefined) {
    const allDay = patch.allDay === true;
    body.start = toSchemaTime(patch.start, allDay, patch.timeZone, 'start');
    body.end = toSchemaTime(patch.end, allDay, patch.timeZone, 'end');
  }

  const attendees = attendeeList(patch.attendees);
  if (attendees) body.attendees = attendees;

  if (Object.keys(body).length === 0) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'Nothing to update.', email);
  }

  try {
    const response = await api.events.patch({
      calendarId,
      eventId,
      sendUpdates: patch.sendUpdates ?? 'none',
      requestBody: body,
    });
    return toEventInfo(email, calendarId, response.data);
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

export interface DeleteResult {
  account: AccountId;
  calendarId: string;
  eventId: string;
  deleted: true;
  /** What the event was, read before deleting, so the answer is not just "ok". */
  summary: string | null;
  start: string | null;
}

export async function deleteEvent(
  reference: AccountId,
  eventId: string,
  calendarId = DEFAULT_CALENDAR,
  sendUpdates: SendUpdates = 'none',
): Promise<DeleteResult> {
  const { email, api } = await calendarFor(reference);
  const target = calendarId.trim() || DEFAULT_CALENDAR;

  try {
    // Read first: once it is gone there is nothing left to report, and "deleted
    // something" is a poor confirmation for an irreversible action.
    const existing = await api.events.get({ calendarId: target, eventId });
    await api.events.delete({ calendarId: target, eventId, sendUpdates });

    return {
      account: email,
      calendarId: target,
      eventId,
      deleted: true,
      summary: existing.data.summary ?? null,
      start: existing.data.start?.dateTime ?? existing.data.start?.date ?? null,
    };
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

// ---------------------------------------------------------------------------
// Free time
// ---------------------------------------------------------------------------

export interface FreeTimeOptions {
  timeMin: string;
  timeMax: string;
  timezone?: string;
  workdayStart?: string;
  workdayEnd?: string;
  weekdaysOnly?: boolean;
  minimumMinutes?: number;
  /** Restrict to a subset of accounts. Omitted means every configured account. */
  accounts?: string[];
  calendarId?: string;
}

/** Busy blocks for one account, from Google's own free/busy view. */
async function busyFor(
  reference: AccountId,
  timeMin: Date,
  timeMax: Date,
  calendarId: string,
): Promise<Interval[]> {
  const { email, api } = await calendarFor(reference);

  try {
    const response = await api.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: calendarId }],
      },
    });

    const calendars = response.data.calendars ?? {};

    // Google frequently answers with the RESOLVED calendar id — the account own
    // address — instead of the alias we asked with, so "primary" may not be a key
    // at all. Read literally, that would make every account look unreadable and
    // leave find_free_time returning zero slots for ever, wearing the face of a
    // permissions problem. Falling back to the single entry costs nothing: a
    // calendar that genuinely failed still carries its errors and is caught below.
    const keys = Object.keys(calendars);
    const soleKey = keys.length === 1 ? keys[0] : undefined;
    const entry = calendars[calendarId] ?? (soleKey !== undefined ? calendars[soleKey] : undefined);

    // Google reports per-calendar problems in the body with a 200 status. Left
    // unchecked, a calendar we were not allowed to read would come back with an
    // empty busy list and be indistinguishable from a completely free week.
    const errors = entry?.errors ?? [];
    if (errors.length > 0) {
      const reasons = errors.map((e) => e.reason ?? 'unknown').join(', ');
      throw new GmailMcpError(
        'API_ERROR',
        `Calendar "${calendarId}" could not be read for ${email}: ${reasons}`,
        email,
      );
    }
    if (!entry) {
      throw new GmailMcpError(
        'NOT_FOUND',
        `Calendar "${calendarId}" returned nothing for ${email}.`,
        email,
      );
    }

    return (entry.busy ?? [])
      .map((block) => ({
        start: block.start ? Date.parse(block.start) : NaN,
        end: block.end ? Date.parse(block.end) : NaN,
      }))
      .filter((i): i is Interval => Number.isFinite(i.start) && Number.isFinite(i.end));
  } catch (error) {
    throw mapCalendarError(error, email);
  }
}

/**
 * Finds gaps that are free on EVERY account asked about.
 *
 * The contract, because this is the one tool where a wrong answer looks exactly
 * like a right one:
 *
 * - `time_min` / `time_max` must carry an explicit offset. No naked local times.
 * - Working hours are interpreted in `timezone` (IANA), which defaults to the
 *   zone this server runs in and is always echoed back in the result.
 * - A busy block that overlaps a candidate window only partially still removes
 *   the overlapping part. Half a busy hour is not free.
 * - If ANY account fails, no slots are returned at all. A gap computed without
 *   one person's calendar is a double-booking waiting to happen.
 */
export async function findFreeTime(options: FreeTimeOptions): Promise<FreeTimeResult> {
  const timeMin = parseInstant(options.timeMin, 'time_min');
  const timeMax = parseInstant(options.timeMax, 'time_max');

  if (timeMax <= timeMin) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'time_max must be after time_min.');
  }
  const spanDays = (timeMax.getTime() - timeMin.getTime()) / (24 * 60 * MINUTE);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `The range covers ${Math.ceil(spanDays)} days; the maximum is ${MAX_RANGE_DAYS}. ` +
        'Narrow it down.',
    );
  }

  const timezone = options.timezone?.trim() || systemTimeZone();
  assertValidTimeZone(timezone);

  const workdayStart = options.workdayStart?.trim() || DEFAULT_WORKDAY_START;
  const workdayEnd = options.workdayEnd?.trim() || DEFAULT_WORKDAY_END;
  const opening = parseClockTime(workdayStart, 'workday_start');
  const closing = parseClockTime(workdayEnd, 'workday_end');

  if (closing.hour * 60 + closing.minute <= opening.hour * 60 + opening.minute) {
    throw new GmailMcpError('INVALID_ARGUMENT', 'workday_end must be after workday_start.');
  }

  const weekdaysOnly = options.weekdaysOnly !== false;
  const minimumMinutes =
    options.minimumMinutes && options.minimumMinutes > 0
      ? Math.floor(options.minimumMinutes)
      : DEFAULT_MINIMUM_MINUTES;
  const calendarId = options.calendarId?.trim() || DEFAULT_CALENDAR;

  const across = await runAcrossAccounts(
    (account) => busyFor(account, timeMin, timeMax, calendarId),
    options.accounts,
  );

  const base: FreeTimeResult = {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timezone,
    workdayStart,
    workdayEnd,
    weekdaysOnly,
    minimumMinutes,
    accountsQueried: across.succeeded,
    busyIntervals: 0,
    slots: [],
  };

  if (across.failures.length > 0) {
    return {
      ...base,
      failures: across.failures,
      incomplete: true,
      note:
        'No slots are listed because at least one calendar could not be read. A gap ' +
        'computed from an incomplete picture would look like an answer and book over ' +
        'something real. Fix the accounts in "failures" and ask again.',
    };
  }

  const busy = mergeIntervals(across.values.flat());
  base.busyIntervals = busy.length;

  const slots: FreeSlot[] = [];
  let [year, month, day] = zonedDateParts(timeMin, timezone);
  const [lastYear, lastMonth, lastDay] = zonedDateParts(timeMax, timezone);
  const lastOrdinal = Date.UTC(lastYear, lastMonth - 1, lastDay);

  for (;;) {
    const ordinal = Date.UTC(year, month - 1, day);
    if (ordinal > lastOrdinal) break;

    const isWeekend = [0, 6].includes(weekdayOf(year, month, day));
    if (!weekdaysOnly || !isWeekend) {
      const windowStart = zonedTimeToInstant(
        year,
        month,
        day,
        opening.hour,
        opening.minute,
        timezone,
      ).getTime();
      const windowEnd = zonedTimeToInstant(
        year,
        month,
        day,
        closing.hour,
        closing.minute,
        timezone,
      ).getTime();

      // Clip to the requested range: a search starting at 14:00 must not offer
      // this morning, and the last day must not run past time_max.
      const clipped: Interval = {
        start: Math.max(windowStart, timeMin.getTime()),
        end: Math.min(windowEnd, timeMax.getTime()),
      };

      if (clipped.end > clipped.start) {
        for (const free of subtractIntervals(clipped, busy)) {
          const minutes = Math.floor((free.end - free.start) / MINUTE);
          if (minutes >= minimumMinutes) {
            slots.push({
              start: new Date(free.start).toISOString(),
              end: new Date(free.end).toISOString(),
              minutes,
            });
          }
        }
      }
    }

    [year, month, day] = addDays(year, month, day, 1);
  }

  base.slots = slots;
  return base;
}
