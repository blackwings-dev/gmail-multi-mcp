/**
 * Wall-clock time in a named zone, without pulling in a date library.
 *
 * `find_free_time` has to answer "09:00 to 18:00, Europe/Madrid" as a set of
 * instants, and that mapping is not a fixed offset: it moves twice a year. Get
 * it wrong and every slot is silently shifted by an hour for half the year —
 * a failure that produces a perfectly plausible-looking answer, which is the
 * expensive kind.
 */

import { GmailMcpError } from '../core/errors.js';

const MINUTE_MS = 60_000;

/** Rejects a zone name before it can quietly become UTC further down. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `"${timeZone}" is not a known IANA time zone. Use a name like "Europe/Madrid" or "UTC".`,
    );
  }
}

/** The zone this process is running in. The only defensible default. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What the clock on the wall reads in `timeZone` at a given instant. */
function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as "24" under hour12:false.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(instant: Date, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which the wall clock in `timeZone` reads the given date and time.
 *
 * Two passes, because the offset depends on the instant we are still solving
 * for: guess by treating the wall time as UTC, read the offset there, correct,
 * then read the offset again at the corrected instant and apply that one. The
 * second pass is what makes the days either side of a DST change come out right.
 *
 * The one hour that repeats when clocks go back is genuinely ambiguous; this
 * resolves it to the first occurrence. For "when am I free" that is the safe
 * side — it never invents availability.
 */
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = guess - offsetAt(new Date(guess), timeZone);
  const secondOffset = offsetAt(new Date(firstPass), timeZone);
  return new Date(guess - secondOffset);
}

/** The calendar date in `timeZone` at a given instant, as `[year, month, day]`. */
export function zonedDateParts(instant: Date, timeZone: string): [number, number, number] {
  const wall = wallClockAt(instant, timeZone);
  return [wall.year, wall.month, wall.day];
}

/** Day of week for a calendar date: 0 = Sunday, 6 = Saturday. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Adds whole days to a calendar date without ever touching a time zone. */
export function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): [number, number, number] {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return [moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate()];
}

/** Parses "HH:MM" into minutes past midnight. */
export function parseClockTime(value: string, label: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hour = match ? Number.parseInt(match[1] ?? '', 10) : NaN;
  const minute = match ? Number.parseInt(match[2] ?? '', 10) : NaN;

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new GmailMcpError('INVALID_ARGUMENT', `${label} must look like "09:00". Got "${value}".`);
  }
  return { hour, minute };
}

/**
 * An instant, or a refusal.
 *
 * A bare "2026-09-10T09:00:00" means nothing without a zone, and accepting it
 * would silently pick the server's. Google's own JSON has shipped fixed offsets
 * that were wrong for the season; the cure is to demand the offset and check it.
 */
export function parseInstant(value: string, label: string): Date {
  const trimmed = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    throw new GmailMcpError(
      'INVALID_ARGUMENT',
      `${label} must be ISO 8601 with an explicit UTC offset or "Z" — for example ` +
        `"2026-09-10T09:00:00+02:00". Got "${value}", which has no offset and would be ` +
        `interpreted differently depending on where this server runs.`,
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new GmailMcpError('INVALID_ARGUMENT', `${label} is not a valid date: "${value}".`);
  }
  return parsed;
}

export interface Interval {
  start: number;
  end: number;
}

/** Merges overlapping and touching intervals into a minimal ordered set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * `window` minus every busy interval.
 *
 * A busy block that only partially overlaps still removes the part it covers —
 * which is the whole point: half a busy hour is not free.
 */
export function subtractIntervals(window: Interval, busy: Interval[]): Interval[] {
  let free: Interval[] = [{ ...window }];

  for (const block of busy) {
    const next: Interval[] = [];
    for (const segment of free) {
      if (block.end <= segment.start || block.start >= segment.end) {
        next.push(segment);
        continue;
      }
      if (block.start > segment.start) next.push({ start: segment.start, end: block.start });
      if (block.end < segment.end) next.push({ start: block.end, end: segment.end });
    }
    free = next;
    if (free.length === 0) break;
  }
  return free;
}

export const MINUTE = MINUTE_MS;
