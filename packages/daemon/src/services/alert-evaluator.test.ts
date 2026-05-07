import { describe, expect, it, vi } from 'vitest';

import { AlertEvaluator } from './alert-evaluator.js';
import type { AlertManager } from './alert-manager.js';
import type { State } from '../controller/types.js';

type Recorded = Parameters<AlertManager['recordAlert']>[0];

function makeManager(): AlertManager & { recorded: Recorded[]; nextId: number } {
  let nextId = 1;
  const recorded: Recorded[] = [];
  return {
    recorded,
    get nextId() { return nextId; },
    set nextId(v: number) { nextId = v; },
    recordAlert: vi.fn(async (args: Recorded) => {
      recorded.push(args);
      return nextId++;
    }),
  } as unknown as AlertManager & { recorded: Recorded[]; nextId: number };
}

function makeState(overrides: Partial<State>): State {
  const base = {
    tick_at: 0,
    config: {
      pool_outage_blip_tolerance_seconds: 60, // → threshold = 60*5 = 300s = 5m
      below_floor_alert_after_minutes: 10,
      zero_hashrate_loud_alert_after_minutes: 15,
      minimum_floor_hashrate_ph: 0.5,
    },
    datum: { reachable: true, connections: 1, hashrate_ph: 1, last_ok_at: 0, consecutive_failures: 0 },
    actual_hashrate: { owned_ph: 1.0, unknown_ph: 0, total_ph: 1.0 },
    below_floor_since: null,
  } as unknown as State;
  return { ...base, ...overrides } as State;
}

describe('AlertEvaluator - datum_unreachable', () => {
  it('does nothing while Datum is reachable', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    await ev.evaluate(makeState({}));
    now += 60_000;
    await ev.evaluate(makeState({}));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('arms but does not fire below the threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    await ev.evaluate(bad);
    now += 60_000; // 60s, threshold is 5*60 = 300s
    await ev.evaluate(bad);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('fires once after the threshold elapses', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    await ev.evaluate(bad);
    now += 5 * 60_000;
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('datum_unreachable');
    expect(mgr.recorded[0]!.severity).toBe('LOUD');
  });

  it('pairs a recovery message when Datum becomes reachable again', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    const ok = makeState({});
    await ev.evaluate(bad);
    now += 5 * 60_000;
    await ev.evaluate(bad); // fires alert id=1
    now += 60_000;
    await ev.evaluate(ok); // recovery
    expect(mgr.recordAlert).toHaveBeenCalledTimes(2);
    expect(mgr.recorded[1]!.event_class).toBe('datum_unreachable_recovery');
    expect(mgr.recorded[1]!.severity).toBe('INFO');
    expect(mgr.recorded[1]!.paired_alert_id).toBe(1);
  });

  it('clears state without recovery if the bad streak never crossed the threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    await ev.evaluate(makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 1 },
    }));
    now += 60_000;
    await ev.evaluate(makeState({}));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });
});

describe('AlertEvaluator - hashrate_below_floor', () => {
  it('fires after the configured threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      below_floor_since: 0,
      actual_hashrate: { owned_ph: 0.2, unknown_ph: 0, total_ph: 0.2 },
    });
    await ev.evaluate(bad);
    now += 10 * 60_000;
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('hashrate_below_floor');
  });
});
