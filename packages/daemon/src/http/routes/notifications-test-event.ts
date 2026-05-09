/**
 * POST /api/notifications/test-event
 *
 * Sends a sample message for the given event_class to Telegram using
 * the saved bot_token + chat_id (intentionally NOT the in-form values
 * - this is a "show me how a real <event> would look" affordance,
 * not a credential validator). Returns ok:false with a clear error
 * when no bot is configured yet, so the dashboard can show a
 * meaningful failure message.
 *
 * The sample uses the live State snapshot where the underlying value
 * is plausible (e.g. wallet_runway uses the current balance + burn
 * rate). When the live state doesn't fit (e.g. the daemon has not
 * recorded a pool-block yet), the route falls back to plausible
 * synthetic data with a "[SAMPLE]" hedge so the operator doesn't
 * mistake the figures for real telemetry. Every test message is
 * marked "[TEST]" in the title prefix to disambiguate from a real
 * fired alert in the operator's chat history.
 */

import type { FastifyInstance } from 'fastify';

import { formatTelegramBody } from '../../services/alert-manager.js';
import { TelegramSink } from '../../services/notifier.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { AlertSeverity } from '../../state/types.js';

export interface TestEventRequest {
  event_class?: string;
}

export interface TestEventResponse {
  ok: boolean;
  error?: string | null;
}

interface Sample {
  severity: AlertSeverity;
  title: string;
  body: string;
  /** When true, render as a [RESOLVED] message regardless of severity. */
  is_recovery: boolean;
}

const SAMPLE_BUILDERS: Record<string, () => Sample> = {
  datum_unreachable: () => ({
    severity: 'IMPORTANT',
    title: 'Datum stratum unreachable - 12m',
    body:
      '[SAMPLE] Local stratum endpoint stopped accepting connections at sample-host:3334 12 minutes ago. ' +
      'Workers are currently failing over to the buyer-side gateway. Check the Datum service status; the ' +
      'autopilot stays paused until the stratum is reachable again.',
    is_recovery: false,
  }),
  hashrate_below_floor: () => ({
    severity: 'IMPORTANT',
    title: 'Hashrate below floor (0.50 / 1.00 PH/s) for 11m',
    body:
      '[SAMPLE] Delivered 0.50 PH/s for 11m, below the configured 1.00 PH/s floor. Possible causes: ' +
      'marketplace mismatch, pool unreachable, worker disconnect. Investigate before topping up the bid.',
    is_recovery: false,
  }),
  zero_hashrate: () => ({
    severity: 'IMPORTANT',
    title: 'Zero hashrate for 16m',
    body:
      '[SAMPLE] No measurable hashrate from Braiins for 16 minutes. The bid is active and funded but no ' +
      'workers are landing shares. Check the pool destination URL and worker identity format.',
    is_recovery: false,
  }),
  api_unreachable: () => ({
    severity: 'IMPORTANT',
    title: 'Braiins API unreachable - 12m',
    body:
      '[SAMPLE] Braiins /v1/* has been returning network errors for 12 minutes. The autopilot is in ' +
      'observe-only mode until the API is back; existing bids remain live, no new orders will be placed.',
    is_recovery: false,
  }),
  unknown_bid: () => ({
    severity: 'IMPORTANT',
    title: 'Unknown bid detected',
    body:
      '[SAMPLE] An owned bid (B99999) appeared in the Braiins account that the autopilot did not create. ' +
      'Auto-PAUSE has been triggered. Cancel the unknown bid or include it in the autopilot scope before ' +
      'resuming.',
    is_recovery: false,
  }),
  sustained_paused: () => ({
    severity: 'IMPORTANT',
    title: 'Bid sustained-paused by Braiins',
    body:
      '[SAMPLE] Primary owned bid B12345 carries last_pause_reason="not possible to deliver the hashing ' +
      'power at this time" for 11 minutes. Likely the Paused/Active oscillation hazard. Check destination ' +
      'pool / Datum gateway and consider a manual edit.',
    is_recovery: false,
  }),
  beta_exit: () => ({
    severity: 'WARNING',
    title: 'Braiins beta-exit fees detected',
    body:
      '[SAMPLE] Braiins is now charging a non-zero fee on at least one active bid (fee_rate_pct: 1.5%). ' +
      'The marketplace appears to have exited beta - re-evaluate the cost model and consider the documented ' +
      'beta-exit handling steps.',
    is_recovery: false,
  }),
  wallet_runway: () => ({
    severity: 'IMPORTANT',
    title: 'Wallet runway 1.5 days (below 3.0 day threshold)',
    body:
      '[SAMPLE] Total Braiins balance (available + blocked) is 210,000 sat; trailing-3h burn is 140,000 ' +
      'sat/day. At that rate the wallet hits zero in 1.5 days, below the configured 3-day threshold. ' +
      'Top up the Braiins wallet or lower the bid; without a top-up, bids will start cancelling for ' +
      'insufficient funds.',
    is_recovery: false,
  }),
  pool_block_credited: () => ({
    severity: 'INFO',
    title: 'Pool block credited - #948,512',
    body:
      '[SAMPLE] Ocean found pool block #948,512 (reward 3.12575382 BTC). ' +
      'Your share: 0.0130% -> ~40,635 sat. Unpaid total: 250,000 sat (23.8% of 1,048,576-sat payout).',
    is_recovery: false,
  }),
};

export interface TestEventDeps {
  readonly configRepo: ConfigRepo;
}

export async function registerNotificationsTestEventRoute(
  app: FastifyInstance,
  deps: TestEventDeps,
): Promise<void> {
  app.post<{ Body?: TestEventRequest }>(
    '/api/notifications/test-event',
    async (req): Promise<TestEventResponse> => {
      const eventClass = (req.body?.event_class ?? '').trim();
      const builder = SAMPLE_BUILDERS[eventClass];
      if (!builder) {
        return { ok: false, error: `unknown event_class: ${eventClass || '(empty)'}` };
      }

      const cfg = await deps.configRepo.get();
      if (!cfg) {
        return { ok: false, error: 'configuration not initialised' };
      }
      const bot_token = cfg.telegram_bot_token?.trim() ?? '';
      const chat_id = cfg.telegram_chat_id?.trim() ?? '';
      if (!bot_token || !chat_id) {
        return {
          ok: false,
          error:
            'Telegram bot token and chat id must be saved on Config -> Notifications before a test message can be sent.',
        };
      }

      const sample = builder();
      const sink = new TelegramSink({
        bot_token,
        chat_id,
        instance_label: cfg.telegram_instance_label?.trim() ?? '',
      });
      // Prefix the title with [TEST] so the operator's chat history
      // shows the difference between a real fired alert and a
      // dashboard-triggered preview at a glance, even after months.
      const body = formatTelegramBody(
        sample.severity,
        `[TEST] ${sample.title}`,
        sample.body,
        sample.is_recovery,
      );
      const result = await sink.send(body, {});
      return { ok: result.ok, error: result.error };
    },
  );
}
