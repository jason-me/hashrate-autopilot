import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { AlertsRepo } from './alerts.js';

/**
 * #316: conditionSpansSince derives timeline spans from open/recovery
 * alert pairs. These tests pin the pairing, the open-ended (ongoing)
 * case, and the window-overlap filter.
 */
describe('AlertsRepo.conditionSpansSince (#316)', () => {
  let handle: DatabaseHandle;
  let repo: AlertsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new AlertsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  async function insertOpener(eventClass: string, createdAt: number): Promise<number> {
    return repo.insert({
      created_at: createdAt,
      severity: 'IMPORTANT',
      title: 'open',
      body: 'b',
      status: 'BUFFERED',
      event_class: eventClass,
      delivery_status: 'sent',
      delivery_attempts: 1,
      next_retry_at_ms: null,
      paired_alert_id: null,
    });
  }

  async function insertRecovery(
    eventClass: string,
    createdAt: number,
    pairedId: number,
  ): Promise<number> {
    return repo.insert({
      created_at: createdAt,
      severity: 'INFO',
      title: 'recovered',
      body: 'b',
      status: 'BUFFERED',
      event_class: eventClass,
      delivery_status: 'sent',
      delivery_attempts: 1,
      next_retry_at_ms: null,
      paired_alert_id: pairedId,
    });
  }

  it('returns [] when there are no condition alerts', async () => {
    expect(await repo.conditionSpansSince(0, 10_000)).toEqual([]);
  });

  it('pairs an opener with its recovery into a closed span', async () => {
    const openId = await insertOpener('hashrate_below_floor', 1_000);
    await insertRecovery('hashrate_below_floor_recovery', 5_000, openId);

    const spans = await repo.conditionSpansSince(0, 10_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      open_id: openId,
      event_class: 'hashrate_below_floor',
      start_ms: 1_000,
      end_ms: 5_000,
    });
  });

  it('leaves end_ms null for an opener with no recovery (ongoing)', async () => {
    await insertOpener('solo_overheating', 2_000);
    const spans = await repo.conditionSpansSince(0, 10_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBeNull();
  });

  it('ignores non-condition event_classes (e.g. pool_block_credited)', async () => {
    await insertOpener('pool_block_credited', 1_000);
    expect(await repo.conditionSpansSince(0, 10_000)).toEqual([]);
  });

  it('excludes a span that closed before the window opened', async () => {
    const openId = await insertOpener('zero_hashrate', 1_000);
    await insertRecovery('zero_hashrate_recovery', 2_000, openId);
    // Window starts at 5_000, after the span already closed at 2_000.
    expect(await repo.conditionSpansSince(5_000, 10_000)).toEqual([]);
  });

  it('excludes an opener that starts after the window ends', async () => {
    await insertOpener('zero_hashrate', 9_000);
    expect(await repo.conditionSpansSince(0, 5_000)).toEqual([]);
  });

  it('includes an open-ended span that started before the window', async () => {
    await insertOpener('datum_unreachable', 1_000);
    const spans = await repo.conditionSpansSince(5_000, 10_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBeNull();
  });

  it('uses the earliest recovery when an opener has two', async () => {
    const openId = await insertOpener('api_unreachable', 1_000);
    await insertRecovery('api_unreachable_recovery', 8_000, openId);
    await insertRecovery('api_unreachable_recovery', 4_000, openId);
    const spans = await repo.conditionSpansSince(0, 10_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBe(4_000);
  });
});
