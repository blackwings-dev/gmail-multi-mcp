/**
 * Domain types for the Calendar layer.
 */

import type { AccountId } from '../core/errors.js';

/**
 * A calendar time is one of two different things and conflating them is how
 * all-day events end up an hour early: a timed event has an instant, an all-day
 * event has a *date* with no instant at all.
 */
export interface EventTime {
  /** RFC 3339 with offset for timed events; `YYYY-MM-DD` for all-day ones. */
  value: string | null;
  timeZone: string | null;
}

export interface AttendeeInfo {
  email: string;
  displayName: string | null;
  responseStatus: string | null;
  optional: boolean;
  organizer: boolean;
}

export interface CalendarEventInfo {
  account: AccountId;
  calendarId: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  status: string | null;
  organizer: string | null;
  attendees: AttendeeInfo[];
  htmlLink: string | null;
  meetingLink: string | null;
  /** Set when this is one instance of a repeating event. */
  recurringEventId: string | null;
  created: string | null;
  updated: string | null;
}

export interface MultiAccountEvents {
  timeMin: string;
  timeMax: string;
  accountsSearched: AccountId[];
  totalResults: number;
  events: CalendarEventInfo[];
  failures?: { account: AccountId; error: string }[];
}

/** How Google should notify attendees about a change. */
export type SendUpdates = 'all' | 'externalOnly' | 'none';

export interface EventWriteRequest {
  summary: string;
  /** RFC 3339 with offset for a timed event, `YYYY-MM-DD` when `allDay`. */
  start: string;
  end: string;
  allDay?: boolean;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
  sendUpdates?: SendUpdates;
}

/** Every field optional: an update touches only what it names. */
export interface EventPatchRequest {
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
  sendUpdates?: SendUpdates;
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
}

export interface FreeTimeResult {
  timeMin: string;
  timeMax: string;
  /** IANA zone the working-hours bounds were interpreted in. */
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  weekdaysOnly: boolean;
  minimumMinutes: number;
  accountsQueried: AccountId[];
  busyIntervals: number;
  slots: FreeSlot[];
  failures?: { account: AccountId; error: string }[];
  /**
   * True when at least one calendar could not be read.
   *
   * When this is set, `slots` is EMPTY on purpose. A gap computed from an
   * incomplete picture is the most expensive kind of wrong answer here: it
   * looks like an answer and it books a meeting over something real.
   */
  incomplete?: true;
  note?: string;
}
