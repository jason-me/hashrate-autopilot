/**
 * #318: repository for `system_events` - config changes (one row per
 * changed field on a save) and daemon boots. Feeds the unified History
 * log via GET /api/system-events.
 */
import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export interface SystemEventRow {
  id: number;
  occurred_at: number;
  kind: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  detail: string | null;
}

export interface SystemEventInsert {
  occurred_at: number;
  kind: 'config_change' | 'daemon_started';
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  detail?: string | null;
}

export class SystemEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(args: SystemEventInsert): Promise<void> {
    await this.db
      .insertInto('system_events')
      .values({
        occurred_at: args.occurred_at,
        kind: args.kind,
        field: args.field ?? null,
        old_value: args.old_value ?? null,
        new_value: args.new_value ?? null,
        detail: args.detail ?? null,
      })
      .execute();
  }

  /** Insert many config-change rows in one statement (empty = no-op). */
  async insertMany(rows: readonly SystemEventInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto('system_events')
      .values(
        rows.map((r) => ({
          occurred_at: r.occurred_at,
          kind: r.kind,
          field: r.field ?? null,
          old_value: r.old_value ?? null,
          new_value: r.new_value ?? null,
          detail: r.detail ?? null,
        })),
      )
      .execute();
  }

  /** Events in [sinceMs, untilMs], newest first, capped. */
  async listSince(sinceMs: number, untilMs: number, limit = 1000): Promise<SystemEventRow[]> {
    const rows = await this.db
      .selectFrom('system_events')
      .selectAll()
      .where('occurred_at', '>=', sinceMs)
      .where('occurred_at', '<=', untilMs)
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .execute();
    return rows as SystemEventRow[];
  }
}
