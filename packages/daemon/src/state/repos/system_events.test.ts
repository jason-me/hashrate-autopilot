import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { SystemEventsRepo } from './system_events.js';

/** #318: SystemEventsRepo - config-change + daemon-boot log events. */
describe('SystemEventsRepo (#318)', () => {
  let handle: DatabaseHandle;
  let repo: SystemEventsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new SystemEventsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('starts empty', async () => {
    expect(await repo.listSince(0, 10_000)).toEqual([]);
  });

  it('records a daemon-started event and reads it back', async () => {
    await repo.insert({ occurred_at: 1_000, kind: 'daemon_started', detail: 'build 706' });
    const rows = await repo.listSince(0, 10_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'daemon_started', detail: 'build 706', field: null });
  });

  it('records config-change rows via insertMany, newest first', async () => {
    await repo.insertMany([
      { occurred_at: 2_000, kind: 'config_change', field: 'max_bid', old_value: '49000', new_value: '50000' },
      { occurred_at: 3_000, kind: 'config_change', field: 'floor', old_value: '1', new_value: '1.2' },
    ]);
    const rows = await repo.listSince(0, 10_000);
    expect(rows.map((r) => r.field)).toEqual(['floor', 'max_bid']); // desc by occurred_at
    expect(rows[0]).toMatchObject({ old_value: '1', new_value: '1.2' });
  });

  it('insertMany([]) is a no-op', async () => {
    await repo.insertMany([]);
    expect(await repo.listSince(0, 10_000)).toEqual([]);
  });

  it('honours the [since, until] window', async () => {
    await repo.insert({ occurred_at: 500, kind: 'daemon_started' });
    await repo.insert({ occurred_at: 5_000, kind: 'daemon_started' });
    await repo.insert({ occurred_at: 50_000, kind: 'daemon_started' });
    const rows = await repo.listSince(1_000, 10_000);
    expect(rows.map((r) => r.occurred_at)).toEqual([5_000]);
  });
});
