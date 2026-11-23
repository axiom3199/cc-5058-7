import { describe, expect, it } from 'vitest';
import { scenarioById } from '../src/kernel/scenarios';
import { makeSim } from '../src/kernel/engine';

/**
 * The demo's replay promise: a fixed action script must produce a byte-identical
 * frame stream, so a saved replay can be re-derived and audited offline.
 */
function runScript() {
  const sim = makeSim(scenarioById('twin-cover'));
  sim.assign('scout');
  sim.step(0.6);
  sim.moveClue('flash', { x: 19.2, y: 8.6 });
  sim.step(0.8);
  sim.assign('wing');
  sim.blockGoalWithAlly('scout');
  sim.simulateUntil(40);
  return sim;
}

describe('demo replay', () => {
  it('reproduces the exact same frames from the same script', () => {
    const a = runScript();
    const b = runScript();
    const key = (sim: ReturnType<typeof runScript>) =>
      sim.replays.map((f) => ({
        index: f.index,
        event: f.event ? `${f.event.seq}|${f.event.t}|${f.event.kind}|${f.event.actor}|${f.event.text}` : null,
        scout: f.snapshot.agents.find((x) => x.id === 'scout')!.pos,
        ally: f.snapshot.agents.find((x) => x.id === 'ally' || x.id === 'wing')!.pos,
        selected: f.snapshot.selections.slice(-1)[0]?.selected?.candidate.id ?? null,
        reservations: f.snapshot.reservations.length,
      }));
    expect(key(a)).toEqual(key(b));
    expect(a.replays.length).toBeGreaterThan(6);
  });

  it('records both an arrival failure and the later recovery if a goal is blocked', () => {
    const sim = runScript();
    expect(sim.events.some((e) => e.kind === 'note' && e.text.includes('parked'))).toBe(true);
    const scout = sim.agents['scout'];
    expect(scout.status).toBe('inCover');
    expect(scout.arrival?.ok).toBe(true);
  });
});
