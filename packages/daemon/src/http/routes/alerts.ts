/**
 * Alerts HTTP routes (#100).
 *
 * Read-only listing for the dashboard `/alerts` page, plus two
 * mutate endpoints (acknowledge + snooze). The alert-manager owns
 * the *write* side for delivery state; these routes only let the
 * operator annotate rows.
 */

import type { FastifyInstance } from 'fastify';

import type {
  AlertDeliveryStatus,
  AlertSeverity,
} from '../../state/types.js';
import type { AlertRow, AlertsRepo } from '../../state/repos/alerts.js';

export interface AlertsRouteDeps {
  readonly alertsRepo: AlertsRepo;
}

export interface AlertsListQuery {
  since_ms?: string;
  /** #121: cursor; rows strictly older than this. Use createdAt of the last row in the previous page. */
  before_created_at_ms?: string;
  severity?: AlertSeverity;
  delivery_status?: AlertDeliveryStatus;
  unacknowledged_only?: string;
  limit?: string;
}

export interface AlertsListResponse {
  alerts: AlertRow[];
  unacknowledged_high_severity_count: number;
  /** #121: total rows matching the same filter set, ignoring pagination. */
  total_count: number;
  /** #121: are there older rows past the returned page? */
  has_more: boolean;
}

export interface SnoozeRequest {
  minutes: number;
}

export interface SnoozeResponse {
  ok: boolean;
  snoozed_until_ms: number;
}

export interface AcknowledgeResponse {
  ok: boolean;
  acknowledged_at_ms: number;
}

export interface AcknowledgeAllResponse {
  ok: boolean;
  acknowledged_at_ms: number;
  /** Number of rows transitioned from unacknowledged to acknowledged. */
  count: number;
}

const VALID_SEVERITIES: ReadonlySet<AlertSeverity> = new Set(['INFO', 'WARNING', 'ERROR']);
const VALID_DELIVERY: ReadonlySet<AlertDeliveryStatus> = new Set([
  'pending',
  'sent',
  'failed',
  'muted',
  'snoozed',
  'gave_up',
]);

export async function registerAlertsRoutes(
  app: FastifyInstance,
  deps: AlertsRouteDeps,
): Promise<void> {
  app.get<{ Querystring: AlertsListQuery }>(
    '/api/alerts',
    async (req): Promise<AlertsListResponse> => {
      const q = req.query;
      const sinceMs = q.since_ms ? Number(q.since_ms) : undefined;
      const beforeCreatedAt = q.before_created_at_ms
        ? Number(q.before_created_at_ms)
        : undefined;
      // #121: default page size lowered from 200 to 50; 200 was a
      // soft wall on long-history installs. Hard cap stays at 1000
      // so a power-user can still grab a big batch via the API.
      const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : 50;
      const severity = q.severity && VALID_SEVERITIES.has(q.severity) ? q.severity : undefined;
      const deliveryStatus =
        q.delivery_status && VALID_DELIVERY.has(q.delivery_status) ? q.delivery_status : undefined;
      const unacknowledgedOnly = q.unacknowledged_only === 'true' || q.unacknowledged_only === '1';

      const filters: {
        since_ms?: number;
        before_created_at?: number;
        severity?: AlertSeverity;
        delivery_status?: AlertDeliveryStatus;
        unacknowledged_only: boolean;
        limit: number;
      } = {
        unacknowledged_only: unacknowledgedOnly,
        // Over-fetch by 1 so we can derive has_more without a second
        // count query: if the repo returned limit+1 rows, there's at
        // least one more page worth pulling. Drop the trailing row
        // before returning so the operator only sees what they asked
        // for.
        limit: limit + 1,
      };
      if (sinceMs !== undefined) filters.since_ms = sinceMs;
      if (beforeCreatedAt !== undefined) filters.before_created_at = beforeCreatedAt;
      if (severity !== undefined) filters.severity = severity;
      if (deliveryStatus !== undefined) filters.delivery_status = deliveryStatus;

      const [overFetched, highSevCount, totalCount] = await Promise.all([
        deps.alertsRepo.list(filters),
        deps.alertsRepo.countUnacknowledgedHighSeverity(),
        deps.alertsRepo.count({
          ...(severity !== undefined ? { severity } : {}),
          ...(deliveryStatus !== undefined ? { delivery_status: deliveryStatus } : {}),
          unacknowledged_only: unacknowledgedOnly,
        }),
      ]);

      const hasMore = overFetched.length > limit;
      const alerts = hasMore ? overFetched.slice(0, limit) : overFetched;

      return {
        alerts,
        unacknowledged_high_severity_count: highSevCount,
        total_count: totalCount,
        has_more: hasMore,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/alerts/:id/acknowledge',
    async (req, reply): Promise<AcknowledgeResponse | { error: string }> => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid alert id' });
      }
      const existing = await deps.alertsRepo.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'alert not found' });
      }
      const now = Date.now();
      await deps.alertsRepo.markAcknowledged(id, now);
      return { ok: true, acknowledged_at_ms: now };
    },
  );

  app.post(
    '/api/alerts/acknowledge-all',
    async (): Promise<AcknowledgeAllResponse> => {
      const now = Date.now();
      const count = await deps.alertsRepo.markAllAcknowledged(now);
      return { ok: true, acknowledged_at_ms: now, count };
    },
  );

  app.post<{ Params: { id: string }; Body: SnoozeRequest }>(
    '/api/alerts/:id/snooze',
    async (req, reply): Promise<SnoozeResponse | { error: string }> => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid alert id' });
      }
      const minutes = Number(req.body?.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        return reply.code(400).send({ error: 'minutes must be between 1 and 1440' });
      }
      const existing = await deps.alertsRepo.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'alert not found' });
      }
      const until = Date.now() + minutes * 60_000;
      await deps.alertsRepo.snooze(id, until);
      return { ok: true, snoozed_until_ms: until };
    },
  );
}
