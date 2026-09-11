/**
 * The wall-clock arithmetic behind `calendar_find_free_time`.
 *
 * These functions are pure, so they are the cheapest place in the codebase to
 * buy confidence — and the most expensive place to be wrong. A one-hour shift
 * here does not throw: it returns a plausible-looking slot that happens to be
 * occupied, which is exactly the failure the module header warns about.
 *
 * Every expected value below was checked against the IANA data for 2026:
 * Europe/Madrid moves to CEST on 29 March and back to CET on 25 October.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  mergeIntervals,
  parseClockTime,
  parseInstant,
  subtractIntervals,
  weekdayOf,
  zonedDateParts,
  zonedTimeToInstant,
} from './timezone.js';

const MADRID = 'Europe/Madrid';
const iso = (d: Date): string => d.toISOString();

test('maps wall-clock time to an instant on both sides of the DST change', () => {
  // Winter: CET, one hour ahead of UTC.
  assert.equal(iso(zonedTimeToInstant(2026, 1, 15, 9, 0, MADRID)), '2026-01-15T08:00:00.000Z');
  // Summer: CEST, two hours ahead.
  assert.equal(iso(zonedTimeToInstant(2026, 7, 15, 9, 0, MADRID)), '2026-07-15T07:00:00.000Z');
});

/**
 * The case the two-pass algorithm exists for: the day before and the day of the
 * change. A single-pass version reads the offset at the wrong instant and gets
 * one of these two an hour off.
 */
test('the day either side of the spring change comes out right', () => {
  assert.equal(iso(zonedTimeToInstant(2026, 3, 28, 9, 0, MADRID)), '2026-03-28T08:00:00.000Z');
  assert.equal(iso(zonedTimeToInstant(2026, 3, 29, 9, 0, MADRID)), '2026-03-29T07:00:00.000Z');
});

/**
 * When clocks go back, 02:30 happens twice: at 00:30Z under CEST and again at
 * 01:30Z under CET.
 *
 * This pins the *observed* behaviour — the later one. Note that the function's
 * own comment claims it resolves to the first occurrence; it does not. If the
 * choice is ever changed deliberately, this assertion should change with it,
 * and the comment should be made to agree.
 */
test('an ambiguous wall-clock hour resolves to the later occurrence', () => {
  assert.equal(iso(zonedTimeToInstant(2026, 10, 25, 2, 30, MADRID)), '2026-10-25T01:30:00.000Z');
});

/** In spring the clock jumps 02:00 -> 03:00, so 02:30 never happens. */
test('a wall-clock time that does not exist still yields an instant', () => {
  assert.equal(iso(zonedTimeToInstant(2026, 3, 29, 2, 30, MADRID)), '2026-03-29T01:30:00.000Z');
});

test('reads back the calendar date in the target zone, not the server one', () => {
  // 23:30Z on the 10th is already the 11th in Madrid.
  const instant = new Date('2026-09-10T23:30:00.000Z');
  assert.deepEqual(zonedDateParts(instant, MADRID), [2026, 9, 11]);
  assert.deepEqual(zonedDateParts(instant, 'UTC'), [2026, 9, 10]);
});

test('weekdayOf agrees with the calendar', () => {
  assert.equal(weekdayOf(2026, 9, 11), 5); // Friday
  assert.equal(weekdayOf(2026, 3, 29), 0); // Sunday, the spring change
});

test('addDays crosses month and year boundaries', () => {
  assert.deepEqual(addDays(2026, 1, 31, 1), [2026, 2, 1]);
  assert.deepEqual(addDays(2026, 12, 31, 1), [2027, 1, 1]);
  assert.deepEqual(addDays(2026, 3, 1, -1), [2026, 2, 28]);
  assert.deepEqual(addDays(2028, 3, 1, -1), [2028, 2, 29]); // leap year
});

test('parseClockTime accepts what a human types and rejects the rest', () => {
  assert.deepEqual(parseClockTime('09:00', 'start'), { hour: 9, minute: 0 });
  assert.deepEqual(parseClockTime('9:05', 'start'), { hour: 9, minute: 5 });
  assert.deepEqual(parseClockTime('  18:30  ', 'start'), { hour: 18, minute: 30 });

  for (const bad of ['24:00', '09:60', '0900', '9', '09:0', 'nine', '']) {
    assert.throws(() => parseClockTime(bad, 'start'), /must look like/, `should reject "${bad}"`);
  }
});

/**
 * The refusal that matters: a timestamp with no offset would be read against
 * whatever zone the server happens to run in, and would look fine while being
 * wrong. Better to fail loudly at the edge.
 */
test('parseInstant demands an explicit offset', () => {
  assert.equal(iso(parseInstant('2026-09-10T09:00:00Z', 'when')), '2026-09-10T09:00:00.000Z');
  assert.equal(iso(parseInstant('2026-09-10T09:00:00+02:00', 'when')), '2026-09-10T07:00:00.000Z');

  assert.throws(() => parseInstant('2026-09-10T09:00:00', 'when'), /explicit UTC offset/);
  assert.throws(() => parseInstant('2026-09-10', 'when'), /explicit UTC offset/);
  assert.throws(() => parseInstant('2026-13-45T09:00:00Z', 'when'), /not a valid date/);
});

test('mergeIntervals collapses overlapping and touching blocks', () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 30, end: 40 },
      { start: 0, end: 10 },
      { start: 5, end: 20 },
    ]),
    [
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ],
    'unsorted input is sorted, and overlaps merge',
  );

  assert.deepEqual(
    mergeIntervals([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]),
    [{ start: 0, end: 20 }],
    'blocks that merely touch are one block',
  );

  assert.deepEqual(
    mergeIntervals([
      { start: 5, end: 5 },
      { start: 10, end: 4 },
    ]),
    [],
    'empty and inverted intervals are dropped',
  );
});

/** The merge writes into its own copies; the caller's array must survive intact. */
test('mergeIntervals does not mutate its input', () => {
  const input = [
    { start: 0, end: 10 },
    { start: 5, end: 20 },
  ];
  mergeIntervals(input);
  assert.deepEqual(input, [
    { start: 0, end: 10 },
    { start: 5, end: 20 },
  ]);
});

test('subtractIntervals removes busy time from a window', () => {
  const window = { start: 0, end: 100 };

  assert.deepEqual(
    subtractIntervals(window, [{ start: 40, end: 60 }]),
    [
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ],
    'a block in the middle leaves a gap either side',
  );

  assert.deepEqual(
    subtractIntervals(window, [{ start: 0, end: 30 }]),
    [{ start: 30, end: 100 }],
    'a block at the start trims the front',
  );

  assert.deepEqual(
    subtractIntervals(window, [{ start: 120, end: 140 }]),
    [{ start: 0, end: 100 }],
    'a block outside the window changes nothing',
  );

  assert.deepEqual(
    subtractIntervals(window, [{ start: -10, end: 200 }]),
    [],
    'a block covering the window leaves nothing free',
  );
});

/** Half a busy hour is not free — the part that overlaps still goes. */
test('subtractIntervals honours partial overlap', () => {
  assert.deepEqual(subtractIntervals({ start: 0, end: 100 }, [{ start: 90, end: 200 }]), [
    { start: 0, end: 90 },
  ]);
});

test('subtractIntervals applies several busy blocks in turn', () => {
  assert.deepEqual(
    subtractIntervals({ start: 0, end: 100 }, [
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 20, end: 50 },
      { start: 60, end: 100 },
    ],
  );
});
