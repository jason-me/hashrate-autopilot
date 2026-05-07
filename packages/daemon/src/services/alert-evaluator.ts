/**
 * Per-tick alert evaluator (#100).
 *
 * Inspects the controller's `State` snapshot on every tick and decides
 * which of the 9 event classes have just transitioned into / out of
 * a bad state. On transitions it calls into AlertManager.recordAlert
 * (or pairs a recovery row); steady-state ticks short-circuit.
 *
 * State-tracking lives entirely in this object's instance fields.
 * Restarting the daemon clears the in-memory state - that's intentional
 * and consistent with how `belowFloorSince` is rehydrated from
 * runtime_state on boot. If the bad state is still active at boot, the
 * first post-boot tick will see "transition into bad state" and fire
 * the alert again. That's a feature, not a bug: the operator wants a
 * fresh ping after every restart, not silence.
 *
 * This commit wires three detectors end-to-end:
 *   - datum_unreachable     (LOUD) - the 2026-05-06 motivating incident
 *   - hashrate_below_floor  (LOUD)
 *   - zero_hashrate         (LOUD)
 *
 * The remaining six detectors (api_unreachable, wallet_runway,
 * unknown_bid, sustained_paused, beta_exit, low_acceptance) are
 * scaffolded but not yet implemented - see the per-class TODOs.
 * They land in a follow-up commit alongside recovery-message polish.
 */

import type { AlertManager } from './alert-manager.js';
import type { State } from '../controller/types.js';

interface EventState {
  readonly bad_since_ms: number | null;
  /** id of the currently-open alert row, set on the first ping. */
  readonly active_alert_id: number | null;
}

const INITIAL: EventState = { bad_since_ms: null, active_alert_id: null };

export interface AlertEvaluatorOptions {
  readonly alertManager: AlertManager;
  /** Override clock for tests. */
  readonly now?: () => number;
}

export class AlertEvaluator {
  private datum_unreachable: EventState = INITIAL;
  private hashrate_below_floor: EventState = INITIAL;
  private zero_hashrate: EventState = INITIAL;

  private readonly alertManager: AlertManager;
  private readonly now: () => number;

  constructor(opts: AlertEvaluatorOptions) {
    this.alertManager = opts.alertManager;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Per-tick evaluation. Call once per tick after the controller has
   * produced its TickResult. Order: detectors fire in declaration order;
   * each detector's transition logic is independent.
   */
  async evaluate(state: State): Promise<void> {
    await this.evaluateDatumUnreachable(state);
    await this.evaluateBelowFloor(state);
    await this.evaluateZeroHashrate(state);
    // TODO(#100): api_unreachable, wallet_runway, unknown_bid,
    //   sustained_paused, beta_exit, low_acceptance.
  }

  private async evaluateDatumUnreachable(state: State): Promise<void> {
    // Skip when Datum integration isn't configured at all.
    if (state.datum === null) {
      this.datum_unreachable = INITIAL;
      return;
    }
    const isBad = !state.datum.reachable;
    const thresholdMs =
      state.config.pool_outage_blip_tolerance_seconds * 5 * 1000;
    this.datum_unreachable = await this.runTransition({
      event_class: 'datum_unreachable',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.datum_unreachable,
      title: 'Datum stratum unreachable',
      bodyForFiring: (durMs) =>
        `Datum gateway has been unreachable for ${formatDuration(durMs)}. Buyer-side hashrate cannot reach Ocean - shares are not crediting.`,
      bodyForRecovery: (durMs) =>
        `Datum gateway reachable again - was down ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateBelowFloor(state: State): Promise<void> {
    const isBad = state.below_floor_since !== null;
    const thresholdMs = state.config.below_floor_alert_after_minutes * 60_000;
    this.hashrate_below_floor = await this.runTransition({
      event_class: 'hashrate_below_floor',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.hashrate_below_floor,
      title: 'Hashrate below floor',
      bodyForFiring: (durMs) =>
        `Delivered hashrate has been below the configured floor for ${formatDuration(durMs)}. Current: ${state.actual_hashrate.total_ph.toFixed(2)} PH/s; floor: ${state.config.minimum_floor_hashrate_ph.toFixed(2)} PH/s.`,
      bodyForRecovery: (durMs) =>
        `Hashrate back at or above floor - was below for ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateZeroHashrate(state: State): Promise<void> {
    const isBad = state.actual_hashrate.total_ph < 0.001;
    const thresholdMs =
      state.config.zero_hashrate_loud_alert_after_minutes * 60_000;
    this.zero_hashrate = await this.runTransition({
      event_class: 'zero_hashrate',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.zero_hashrate,
      title: 'Zero hashrate',
      bodyForFiring: (durMs) =>
        `No hashrate delivered for ${formatDuration(durMs)}. Likely the upstream marketplace stopped routing - check the active bid and fee state.`,
      bodyForRecovery: (durMs) =>
        `Hashrate flowing again - was zero for ${formatDuration(durMs)}.`,
    });
  }

  // ---------------------------------------------------------------
  // Shared transition machinery
  // ---------------------------------------------------------------

  private async runTransition(args: {
    event_class: string;
    severity: 'LOUD' | 'WARN' | 'INFO';
    isBad: boolean;
    thresholdMs: number;
    currentState: EventState;
    title: string;
    bodyForFiring: (durMs: number) => string;
    bodyForRecovery: (durMs: number) => string;
  }): Promise<EventState> {
    const nowMs = this.now();

    if (args.isBad) {
      // First tick observing bad: arm the timer.
      if (args.currentState.bad_since_ms === null) {
        return { bad_since_ms: nowMs, active_alert_id: null };
      }
      // Already armed - has the threshold been crossed?
      if (
        args.currentState.active_alert_id === null &&
        nowMs - args.currentState.bad_since_ms >= args.thresholdMs
      ) {
        const id = await this.alertManager.recordAlert({
          severity: args.severity,
          title: args.title,
          body: args.bodyForFiring(nowMs - args.currentState.bad_since_ms),
          event_class: args.event_class,
        });
        return { bad_since_ms: args.currentState.bad_since_ms, active_alert_id: id };
      }
      // Either already-fired or below threshold - keep state.
      return args.currentState;
    }

    // Not bad. If we had armed but never fired, just clear.
    if (args.currentState.active_alert_id === null) {
      return INITIAL;
    }

    // Recovery: pair an INFO row to the previously-fired alert.
    const wasBadFor = nowMs - (args.currentState.bad_since_ms ?? nowMs);
    await this.alertManager.recordAlert({
      severity: 'INFO',
      title: args.title.replace(/^/, '✓ ').replace('Datum stratum unreachable', 'Datum reachable'),
      body: args.bodyForRecovery(wasBadFor),
      event_class: args.event_class + '_recovery',
      paired_alert_id: args.currentState.active_alert_id,
    });
    return INITIAL;
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}
