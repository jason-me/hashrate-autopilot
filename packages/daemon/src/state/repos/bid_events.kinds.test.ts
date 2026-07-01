import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { BidEventsRepo, type BidEventInsert } from './bid_events.js';

/**
 * #318 follow-up: listEventsForHistory `kinds` is an opt-out selector.
 *   - undefined      -> no filter (every kind)
 *   - [X, Y]         -> only those kinds
 *   - []  (explicit) -> the operator hid every action -> zero bid events
 * The empty-array case is the one the old `length > 0` guard collapsed
 * back to "no filter"; this locks the new "0 = 1" behavior.
 */
describe('BidEventsRepo.listEventsForHistory - kinds opt-out (#318)', () => {
  let handle: DatabaseHandle;
  let repo: BidEventsRepo;

  const ev = (kind: BidEventInsert['kind'], occurred_at: number): BidEventInsert => ({
    occurred_at,
    source: 'AUTOPILOT',
    kind,
    braiins_order_id: 'B123',
    old_price_sat: null,
    new_price_sat: 1_000_000,
    speed_limit_ph: 3,
    amount_sat: null,
    reason: null,
    overpay_sat_per_eh_day: null,
    max_overpay_vs_hashprice_sat_per_eh_day: null,
  });

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new BidEventsRepo(handle.db);
    await repo.insert(ev('CREATE_BID', 1_000));
    await repo.insert(ev('EDIT_PRICE', 2_000));
    await repo.insert(ev('EDIT_PRICE', 3_000));
    await repo.insert(ev('CANCEL_BID', 4_000));
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('undefined kinds returns every event (no filter)', async () => {
    const rows = await repo.listEventsForHistory({ limit: 100 });
    expect(rows).toHaveLength(4);
  });

  it('a non-empty subset returns only those kinds', async () => {
    const rows = await repo.listEventsForHistory({ limit: 100, kinds: ['EDIT_PRICE'] });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'EDIT_PRICE')).toBe(true);
  });

  it('an explicit empty kinds list returns no bid events', async () => {
    const rows = await repo.listEventsForHistory({ limit: 100, kinds: [] });
    expect(rows).toEqual([]);
  });
});
