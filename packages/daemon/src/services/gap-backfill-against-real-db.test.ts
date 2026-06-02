/**
 * #241: run runGapBackfill against the operator's actual state.db
 * (`data/state.db` at the repo root, gitignored) and dump what it sees
 * + what it inserts (if anything). Skipped in CI; only runs when the
 * file is present.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../state/db.js';
import { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import { runGapBackfill } from './gap-backfill.js';
import { runPoolLuckRecompute } from './pool-luck-recompute.js';

const DB_PATH = path.resolve(process.cwd(), 'data/state.db');

describe.skipIf(!existsSync(DB_PATH))(
  'runGapBackfill against operator state.db',
  () => {
    it('reports what gap (if any) it detects on the live DB', async () => {
      const handle = await openDatabase({ path: DB_PATH });
      try {
        const logs: string[] = [];

        const beforeCount = Number(
          (
            await handle.db
              .selectFrom('tick_metrics')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('synthetic', '=', 1)
              .executeTakeFirstOrThrow()
          ).n,
        );

        await runGapBackfill({
          db: handle.db,
          poolBlocksRepo: new PoolBlocksRepo(handle.db),
          log: (m) => logs.push(m),
        });

        const afterCount = Number(
          (
            await handle.db
              .selectFrom('tick_metrics')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('synthetic', '=', 1)
              .executeTakeFirstOrThrow()
          ).n,
        );

        console.log('gap-backfill log against real DB:');
        for (const line of logs) console.log(`  ${line}`);
        console.log(`synthetic rows before: ${beforeCount}, after: ${afterCount}`);

        // Run pool-luck-recompute and see what fraction of synthetics
        // end up with populated pool_luck_30d (Taliesin has 184
        // pool_blocks going back to March; recompute should populate
        // all synthetic rows past earliestEligibleTick AND, with the
        // build-565 fix, every synthetic row regardless).
        const recomputeLogs: string[] = [];
        await runPoolLuckRecompute({
          db: handle.db,
          poolBlocksRepo: new PoolBlocksRepo(handle.db),
          log: (m) => recomputeLogs.push(m),
        });
        console.log('recompute log:');
        for (const line of recomputeLogs) console.log(`  ${line}`);

        const syntheticRows = await handle.db
          .selectFrom('tick_metrics')
          .selectAll()
          .where('synthetic', '=', 1)
          .execute();
        const withLuck = syntheticRows.filter((r) => r.pool_luck_30d !== null);
        console.log(`synthetics with pool_luck_30d populated: ${withLuck.length} / ${syntheticRows.length}`);
        if (withLuck.length > 0) {
          const luckValues = withLuck.map((r) => r.pool_luck_30d!);
          console.log(`pool_luck_30d range: [${Math.min(...luckValues).toFixed(3)}, ${Math.max(...luckValues).toFixed(3)}]`);
          const distinctRounded = new Set(luckValues.map((v) => Math.round(v * 100)));
          console.log(`distinct luck values (rounded to 0.01): ${distinctRounded.size}`);
        }

        expect(typeof afterCount).toBe('number');
      } finally {
        await closeDatabase(handle);
      }
    });
  },
);
