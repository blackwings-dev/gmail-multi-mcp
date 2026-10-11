/**
 * The Calendar tools, end to end through the MCP server against a fake Google.
 *
 * Calendar is where a quiet default does the most damage: an agent that creates,
 * moves or deletes an event can email every guest. So the tests pin the "nobody
 * is mailed unless asked" default on all three write paths, and the rule that a
 * free-time search with a missing calendar answers NOTHING rather than a gap
 * that is not really free.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { ALICE, BOB, on, requests, sent, startHarness, type Harness } from '../testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const EVENTS = /^\/calendar\/v3\/calendars\/primary\/events$/;

function event(id: string, start: string, end: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, summary: `Evento ${id}`, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

test('calendar_list_events across accounts merges by start time and expands recurring events', async () => {
  h = await startHarness([
    on('GET', EVENTS, (req) =>
      req.account === ALICE
        ? { body: { items: [event('a1', '2026-10-13T11:00:00+02:00', '2026-10-13T12:00:00+02:00')] } }
        : { body: { items: [event('b1', '2026-10-13T09:00:00+02:00', '2026-10-13T10:00:00+02:00')] } },
    ),
  ]);
  const { isError, data } = await h.call('calendar_list_events', {
    time_min: '2026-10-13T00:00:00+02:00',
    time_max: '2026-10-14T00:00:00+02:00',
  });
  assert.equal(isError, false);
  assert.deepEqual(
    (data['events'] as { id: string; account: string }[]).map((e) => [e.id, e.account]),
    [
      ['b1', BOB],
      ['a1', ALICE],
    ],
  );
  for (const req of sent('GET', EVENTS)) {
    assert.equal(req.url.searchParams.get('singleEvents'), 'true', 'recurring events must be expanded');
    assert.equal(req.url.searchParams.get('orderBy'), 'startTime');
  }
});

test('calendar_list_events refuses a naked local time instead of guessing the zone', async () => {
  h = await startHarness([]);
  const { isError } = await h.call('calendar_list_events', {
    account: ALICE,
    time_min: '2026-10-13T09:00:00',
    time_max: '2026-10-13T18:00:00+02:00',
  });
  assert.equal(isError, true);
  assert.equal(requests.length, 0);
});

test('calendar_get_event returns attendees and their responses', async () => {
  h = await startHarness([
    on('GET', '/calendar/v3/calendars/primary/events/e1', () => ({
      body: event('e1', '2026-10-13T09:00:00+02:00', '2026-10-13T10:00:00+02:00', {
        attendees: [{ email: 'ana@cliente.es', responseStatus: 'accepted' }],
      }),
    })),
  ]);
  const { data } = await h.call('calendar_get_event', { account: ALICE, event_id: 'e1' });
  assert.deepEqual(
    (data['attendees'] as { email: string; responseStatus: string }[]).map((a) => [a.email, a.responseStatus]),
    [['ana@cliente.es', 'accepted']],
  );
});

test('calendar_create_event emails nobody by default', async () => {
  h = await startHarness([
    on('POST', EVENTS, (req) => ({ body: { id: 'n1', ...(req.json as object) } })),
  ]);
  const { isError } = await h.call('calendar_create_event', {
    account: ALICE,
    summary: 'Revisión con Ana',
    start: '2026-10-13T09:00:00+02:00',
    end: '2026-10-13T10:00:00+02:00',
    attendees: ['ana@cliente.es'],
  });
  assert.equal(isError, false);
  const [req] = sent('POST', EVENTS);
  assert.ok(req);
  assert.equal(req.url.searchParams.get('sendUpdates'), 'none');
  const body = req.json as { summary: string; attendees: { email: string }[] };
  assert.equal(body.summary, 'Revisión con Ana');
  assert.deepEqual(body.attendees.map((a) => a.email), ['ana@cliente.es']);
});

test('calendar_create_event mails guests only when send_updates asks for it', async () => {
  h = await startHarness([on('POST', EVENTS, () => ({ body: { id: 'n1' } }))]);
  await h.call('calendar_create_event', {
    account: ALICE,
    summary: 'Demo',
    start: '2026-10-13T09:00:00+02:00',
    end: '2026-10-13T10:00:00+02:00',
    attendees: ['ana@cliente.es'],
    send_updates: 'all',
  });
  assert.equal(sent('POST', EVENTS)[0]?.url.searchParams.get('sendUpdates'), 'all');
});

test('calendar_create_event all-day uses plain dates', async () => {
  h = await startHarness([on('POST', EVENTS, () => ({ body: { id: 'n1' } }))]);
  const { isError } = await h.call('calendar_create_event', {
    account: ALICE,
    summary: 'Vacaciones',
    start: '2026-12-24',
    end: '2026-12-26',
    all_day: true,
  });
  assert.equal(isError, false);
  const body = sent('POST', EVENTS)[0]?.json as { start: { date?: string; dateTime?: string } };
  assert.equal(body.start.date, '2026-12-24');
  assert.equal(body.start.dateTime, undefined);
});

test('calendar_update_event touches only the given fields and emails nobody by default', async () => {
  h = await startHarness([on('PATCH', '/calendar/v3/calendars/primary/events/e1', () => ({ body: { id: 'e1' } }))]);
  const { isError } = await h.call('calendar_update_event', { account: ALICE, event_id: 'e1', location: 'Sala 2' });
  assert.equal(isError, false);
  const [req] = sent('PATCH', /\/events\/e1$/);
  assert.deepEqual(req?.json, { location: 'Sala 2' });
  assert.equal(req?.url.searchParams.get('sendUpdates'), 'none');
});

test('calendar_update_event refuses to move only one end of an event', async () => {
  h = await startHarness([]);
  const { isError, data } = await h.call('calendar_update_event', {
    account: ALICE,
    event_id: 'e1',
    start: '2026-10-13T15:00:00+02:00',
  });
  assert.equal(isError, true);
  assert.match(String(data['error']), /both "start" and "end"/);
  assert.equal(sent('PATCH', /.*/).length, 0);
});

test('calendar_delete_event says what it deleted and emails nobody by default', async () => {
  h = await startHarness([
    on('GET', '/calendar/v3/calendars/primary/events/e1', () => ({
      body: event('e1', '2026-10-13T09:00:00+02:00', '2026-10-13T10:00:00+02:00', { summary: 'Llamada' }),
    })),
    on('DELETE', '/calendar/v3/calendars/primary/events/e1', () => ({ status: 204 })),
  ]);
  const { isError, data } = await h.call('calendar_delete_event', { account: ALICE, event_id: 'e1' });
  assert.equal(isError, false);
  assert.equal(data['deleted'], true);
  assert.equal(data['summary'], 'Llamada');
  assert.equal(sent('DELETE', /\/events\/e1$/)[0]?.url.searchParams.get('sendUpdates'), 'none');
});

const FREEBUSY = '/calendar/v3/freeBusy';

test('calendar_find_free_time returns the gaps free on every account, inside working hours', async () => {
  h = await startHarness([
    on('POST', FREEBUSY, (req) => ({
      body: {
        calendars: {
          // Google often answers with the resolved address instead of "primary".
          [req.account ?? '']: {
            busy:
              req.account === ALICE
                ? [{ start: '2026-10-13T09:00:00+02:00', end: '2026-10-13T10:00:00+02:00' }]
                : [{ start: '2026-10-13T12:00:00+02:00', end: '2026-10-13T13:30:00+02:00' }],
          },
        },
      },
    })),
  ]);
  const { isError, data } = await h.call('calendar_find_free_time', {
    time_min: '2026-10-13T00:00:00+02:00',
    time_max: '2026-10-13T23:59:00+02:00',
    timezone: 'Europe/Madrid',
  });
  assert.equal(isError, false);
  const slots = (data['slots'] as { start: string; end: string }[]).map((s) => [
    new Date(s.start).toISOString(),
    new Date(s.end).toISOString(),
  ]);
  assert.deepEqual(slots, [
    ['2026-10-13T08:00:00.000Z', '2026-10-13T10:00:00.000Z'],
    ['2026-10-13T11:30:00.000Z', '2026-10-13T16:00:00.000Z'],
  ]);
});

test('calendar_find_free_time answers no slots at all when one calendar cannot be read', async () => {
  h = await startHarness([
    on('POST', FREEBUSY, (req) =>
      req.account === ALICE
        ? { body: { calendars: { primary: { busy: [] } } } }
        : { body: { calendars: { primary: { errors: [{ reason: 'notFound' }] } } } },
    ),
  ]);
  const { isError, data } = await h.call('calendar_find_free_time', {
    time_min: '2026-10-13T00:00:00+02:00',
    time_max: '2026-10-13T23:59:00+02:00',
    timezone: 'Europe/Madrid',
  });
  assert.equal(isError, false);
  assert.equal(data['incomplete'], true);
  assert.deepEqual(data['slots'], []);
  assert.deepEqual(
    (data['failures'] as { account: string }[]).map((f) => f.account),
    [BOB],
  );
});
