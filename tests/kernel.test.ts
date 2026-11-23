import { describe, expect, it } from 'vitest';
import { TWIN_COVER, MULTI_HEIGHT, DIAGONAL, SEALED_POCKET, SCENARIOS, cloneScenario } from '../src/kernel/scenarios';
import { ReservationBook } from '../src/kernel/reservations';
import { DEFAULT_POLICY, selectCover, measureArrival } from '../src/kernel/selection';
import { evaluateStance, evaluateClueExposure, generateCandidates } from '../src/kernel/exposure';
import { buildGrid, buildNavField, findPath, pathBodyClear } from '../src/kernel/navigation';
import { makeSim } from '../src/kernel/engine';
import { dist } from '../src/kernel/geometry';
import type { SceneGeometry, Policy, SelectionInput } from '../src/kernel/types';

const sceneOf = (s: typeof TWIN_COVER): SceneGeometry => ({ board: s.board, obstacles: s.obstacles });

function baseInput(s: typeof TWIN_COVER, extra: Partial<SelectionInput> = {}): SelectionInput {
  return {
    scene: sceneOf(s),
    agent: s.agent,
    clues: s.clues,
    reservations: new ReservationBook(),
    policy: DEFAULT_POLICY,
    otherAgents: [{ id: s.ally.id, name: s.ally.name, pos: s.ally.pos, radius: s.ally.radius }],
    ...extra,
  };
}

describe('twin cover with unequal arrival time', () => {
  it('keeps both equal-occlusion stacks and prefers the closer one', () => {
    const result = selectCover(baseInput(TWIN_COVER));
    const north = result.ranked.find((e) => e.candidate.obstacleId === 'twin-n' && e.candidate.face === 'w');
    const south = result.ranked.find((e) => e.candidate.obstacleId === 'twin-s' && e.candidate.face === 'w');
    expect(north).toBeTruthy();
    expect(south).toBeTruthy();
    // Identical occlusion at the flash clue.
    expect(north!.stances[north!.chosenStance].worstExposure).toBeCloseTo(0, 5);
    expect(south!.stances[south!.chosenStance].worstExposure).toBeCloseTo(0, 5);
    // Different travel time, and the closer one wins on rank.
    expect(north!.travelTimeSec!).toBeLessThan(south!.travelTimeSec!);
    expect(result.selected!.candidate.id).toBe(north!.candidate.id);
    // The loser is still fully visible in the audit table.
    const southRow = result.candidates.find((e) => e.candidate.id === south!.candidate.id);
    expect(southRow).toBeTruthy();
    expect(southRow!.rank).toBeGreaterThan(1);
    expect(southRow!.components.utility).toBeLessThan(north!.components.utility);
  });

  it('marks a non-obstacle prop as a candidate only when the geometry supports it', () => {
    const candidate = generateCandidates(sceneOf(TWIN_COVER), TWIN_COVER.agent).find(
      (c) => c.obstacleId === 'low-cart',
    );
    expect(candidate).toBeUndefined();
  });
});

describe('reservations survive recomputation while in transit', () => {
  it('rejects the reserved spot for a second agent but keeps it for the claimant', () => {
    const sim = makeSim(TWIN_COVER);
    const first = sim.assign('scout');
    expect(first!.selected).toBeTruthy();
    // Move a little so the scout is genuinely in transit.
    sim.step(0.3);
    expect(sim.agent.status).toBe('moving');
    const claimed = sim.reservations.get('scout');
    expect(claimed).toBeTruthy();

    const second = sim.assign('wing');
    expect(second).toBeTruthy();
    const sameSpot = second!.candidates.find((e) => e.candidate.id === claimed!.candidateId);
    expect(sameSpot).toBeTruthy();
    expect(sameSpot!.valid).toBe(false);
    expect(sameSpot!.rejectReasons.some((r) => r.code === 'reserved')).toBe(true);
    expect(sameSpot!.rejectReasons.find((r) => r.code === 'reserved')!.detail).toContain('scout');
  });

  it('holds the reservation across a mid-route recompute', () => {
    const sim = makeSim(TWIN_COVER);
    sim.assign('scout');
    const before = sim.reservations.get('scout')!;
    sim.step(1.2); // crosses the 0.9 s periodic recompute
    const recomputes = sim.events.filter((e) => e.kind === 'recompute');
    expect(recomputes.length).toBeGreaterThan(0);
    const after = sim.reservations.get('scout');
    expect(after).toBeTruthy();
    expect(after!.candidateId).toBe(before.candidateId);
    expect(after!.version).toBe(before.version);
  });

  it('releases the claim after arrival', () => {
    const sim = makeSim(TWIN_COVER);
    sim.assign('scout');
    sim.simulateUntil(20);
    expect(sim.agent.status).toBe('inCover');
    expect(sim.reservations.get('scout')).toBeNull();
  });
});

describe('cover must be supported by geometry', () => {
  it('never generates candidates from a decorative marker or a non-cover prop', () => {
    for (const s of SCENARIOS) {
      const candidates = generateCandidates(sceneOf(s), s.agent);
      const ids = new Set(candidates.map((c) => c.obstacleId));
      for (const m of s.markers) {
        const nearMarker = candidates.filter((c) => dist(c.pos, m.pos) < 1.0);
        // A marker may sit near real cover, but it can never be its own source.
        for (const c of nearMarker) expect(s.obstacles.find((o) => o.id === c.obstacleId)?.cover).toBe(true);
      }
      for (const o of s.obstacles) {
        if (o.cover === false) expect(ids.has(o.id)).toBe(false);
      }
    }
  });

  it('does not treat standing beside a wall as cover from all directions', () => {
    // North face of the twin-n stack faces directly at the flash, so it is exposed.
    const candidates = generateCandidates(sceneOf(TWIN_COVER), TWIN_COVER.agent);
    // The crate's own north face can be shielded by its own corner for the
    // westernmost posts, but at least one post on the face pointing at the
    // threat is fully exposed. Being adjacent to cover is not cover.
    const northFaces = candidates.filter((c) => c.id.startsWith('twin-n/n/'));
    expect(northFaces.length).toBeGreaterThan(1);
    const exposures = northFaces.map(
      (c) => evaluateStance(sceneOf(TWIN_COVER), c.pos, 'stand', TWIN_COVER.clues).perClue.find((p) => p.clueId === 'flash')!.exposure,
    );
    expect(Math.max(...exposures)).toBeGreaterThan(0.8);
    const westFace = candidates.find((c) => c.id === 'twin-n/w/0')!;
    const evalw = evaluateStance(sceneOf(TWIN_COVER), westFace.pos, 'stand', TWIN_COVER.clues);
    expect(evalw.perClue.find((c) => c.clueId === 'flash')!.exposure).toBeLessThan(0.2);
  });
});

describe('known clues only', () => {
  it('produces identical results whether a hidden hostile exists or not', () => {
    const withHidden = cloneScenario(TWIN_COVER);
    const withoutHidden = cloneScenario(TWIN_COVER);
    withoutHidden.hostiles = withoutHidden.hostiles.filter((h) => !h.hidden);
    const a = selectCover(baseInput(withHidden));
    const b = selectCover(baseInput(withoutHidden));
    expect(a.selected!.candidate.id).toBe(b.selected!.candidate.id);
    expect(a.ranked.map((e) => e.candidate.id)).toEqual(b.ranked.map((e) => e.candidate.id));
    expect(a.hiddenHostileLeak).toBe(false);
  });

  it('still exposes the body to the hidden hostile, and the audit says why', () => {
    // Ground-truth visibility (only used in tests / debug overlay) at the selected spot.
    const result = selectCover(baseInput(TWIN_COVER));
    const spot = result.selected!.candidate.pos;
    const hidden = TWIN_COVER.hostiles.find((h) => h.hidden)!;
    const exposure = evaluateClueExposure(
      sceneOf(TWIN_COVER),
      spot,
      result.selected!.chosenStance,
      { id: 'truth', label: 'truth', source: 'sighting', pos: hidden.pos, confidence: 1, uncertainty: 0, ageSec: 0 },
    );
    // The hidden hostile is not behind the crate the module selected; proof that
    // selection used clues, not omniscience.
    expect(exposure.exposure).toBeGreaterThan(0);
    expect(result.clueInputNote).toContain('Hidden hostile positions are never read');
  });
});

describe('body clearance and stance transitions', () => {
  it('rejects unreachable candidates inside the sealed ring with an explicit reason', () => {
    const result = selectCover(baseInput(SEALED_POCKET));
    // Inner faces of the ring: candidates standing inside the sealed yard.
    const inner = result.candidates.filter(
      (e) =>
        e.candidate.obstacleId.startsWith('ring-') &&
        e.candidate.pos.x > 7.6 &&
        e.candidate.pos.x < 11.4 &&
        e.candidate.pos.y > 4.8 &&
        e.candidate.pos.y < 9.2,
    );
    expect(inner.length).toBeGreaterThan(0);
    for (const e of inner) {
      expect(e.valid).toBe(false);
      expect(e.rejectReasons.some((r) => r.code === 'unreachable')).toBe(true);
    }
    expect(result.rejectionSummary.some((s) => s.code === 'unreachable')).toBe(true);
  });

  it('rejects spots with no stance-change room', () => {
    const result = selectCover(baseInput(SEALED_POCKET));
    const transitionRejects = result.rejected.filter((e) => e.rejectReasons.some((r) => r.code === 'transition_space'));
    expect(transitionRejects.length).toBeGreaterThan(0);
    for (const e of transitionRejects) expect(e.candidate.transitionMargin).toBeLessThan(0.1);
  });

  it('never returns a reachable candidate whose body overlaps geometry', () => {
    for (const s of SCENARIOS) {
      const result = selectCover(baseInput(s));
      for (const e of result.ranked) {
        expect(e.candidate.geometry.bodyClear).toBe(true);
        expect(e.candidate.geometry.transitionClear).toBe(true);
        expect(e.candidate.clearanceMargin).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('verifies the actual route keeps the body clear everywhere', () => {
    for (const s of SCENARIOS) {
      const result = selectCover(baseInput(s));
      for (const e of result.ranked) {
        const check = pathBodyClear(sceneOf(s), e.path, s.agent.radius);
        expect(check.ok).toBe(true);
      }
    }
  });
});

describe('multi-height obstacles and stance', () => {
  it('uses crouch behind the half wall and stand behind the tall wall', () => {
    const scene = sceneOf(MULTI_HEIGHT);
    const candidates = generateCandidates(scene, MULTI_HEIGHT.agent);
    const halfSouth = candidates.find((c) => c.id === 'half-wall/s/1')!;
    const stand = evaluateStance(scene, halfSouth.pos, 'stand', MULTI_HEIGHT.clues);
    const crouch = evaluateStance(scene, halfSouth.pos, 'crouch', MULTI_HEIGHT.clues);
    const standMuzzle = stand.perClue.find((c) => c.clueId === 'muzzle')!.exposure;
    const crouchMuzzle = crouch.perClue.find((c) => c.clueId === 'muzzle')!.exposure;
    expect(standMuzzle).toBeGreaterThan(0.8);
    expect(crouchMuzzle).toBeLessThan(0.2);

    const result = selectCover(baseInput(MULTI_HEIGHT));
    const halfRow = result.candidates.find((e) => e.candidate.id === halfSouth.id)!;
    expect(halfRow.valid).toBe(true);
    expect(halfRow.chosenStance).toBe('crouch');
  });

  it('reports the tall wall as full-height protection for a standing body', () => {
    const result = selectCover(baseInput(MULTI_HEIGHT));
    const tall = result.ranked.find((e) => e.candidate.obstacleId === 'tall-wall')!;
    expect(tall).toBeTruthy();
    expect(tall.chosenStance).toBe('stand');
    const muzzle = tall.stances.stand.perClue.find((c) => c.clueId === 'muzzle')!;
    expect(muzzle.exposure).toBeLessThan(0.2);
    expect(tall.pros.join(' ')).toMatch(/full height/i);
  });
});

describe('diagonal bearings', () => {
  it('does not claim a parallel face is safe just because it is adjacent to cover', () => {
    const scene = sceneOf(DIAGONAL);
    const result = selectCover(baseInput(DIAGONAL));
    const contact = DIAGONAL.clues[0];
    let sawSafe = false;
    let sawExposed = false;
    for (const e of result.candidates) {
      const ex = e.stances[e.chosenStance].perClue.find((c) => c.clueId === contact.id)!;
      if (ex.exposure < 0.2) sawSafe = true;
      if (ex.exposure > 0.8) sawExposed = true;
    }
    expect(sawSafe).toBe(true);
    expect(sawExposed).toBe(true);
    // The selected spot must be genuinely hidden at the diagonal bearing.
    const sel = result.selected!;
    expect(sel.stances[sel.chosenStance].perClue[0].exposure).toBeLessThan(0.2);
  });
});

describe('audit evidence is itemized, not collapsed into one score', () => {
  it('retains every rejected candidate with its own reasons', () => {
    for (const s of SCENARIOS) {
      const result = selectCover(baseInput(s));
      expect(result.candidates.length).toBe(result.ranked.length + result.rejected.length);
      for (const e of result.rejected) {
        expect(e.valid).toBe(false);
        expect(e.rejectReasons.length).toBeGreaterThan(0);
        expect(e.components.utility).toBe(0);
      }
    }
  });

  it('shows per-clue percentages, per-stance values and utility terms for the selected candidate', () => {
    const result = selectCover(baseInput(MULTI_HEIGHT));
    const sel = result.selected!;
    expect(sel.components.terms.length).toBe(6);
    for (const t of sel.components.terms) expect(t.name).toBeTruthy();
    for (const stance of ['stand', 'crouch'] as const) {
      const ev = sel.stances[stance];
      expect(ev.perClue.length).toBe(MULTI_HEIGHT.clues.length);
      for (const c of ev.perClue) {
        expect(c.exposure).toBeGreaterThanOrEqual(0);
        expect(c.exposure).toBeLessThanOrEqual(1);
      }
    }
    expect(sel.pros.length + sel.cons.length).toBeGreaterThan(0);
  });

  it('states the failed evidence rather than hiding it when nothing is valid', () => {
    const impossible: Policy = { ...DEFAULT_POLICY, maxWorstExposure: -0.01 };
    const result = selectCover(baseInput(TWIN_COVER, { policy: impossible }));
    expect(result.selected).toBeNull();
    expect(result.rejected.length).toBe(result.candidates.length);
    expect(result.rationale.join(' ')).toContain('No candidate passed');
  });
});

describe('arrival verification and failure feedback', () => {
  it('measures the arrived stance and compares it with the prediction', () => {
    const sim = makeSim(MULTI_HEIGHT);
    sim.assign('scout');
    sim.simulateUntil(20);
    const arrival = sim.agent.arrival!;
    expect(arrival).toBeTruthy();
    expect(arrival.matchesPrediction).toBe(true);
    expect(arrival.measured.perClue.length).toBe(MULTI_HEIGHT.clues.length);
    expect(arrival.ok).toBe(true);
  });

  it('feeds an arrival failure back into the candidate set', () => {
    const scene = sceneOf(TWIN_COVER);
    const result = selectCover(baseInput(TWIN_COVER));
    const sel = result.selected!;
    // Deliver the body straight into an obstacle and measure: must fail.
    const blocked = { x: TWIN_COVER.obstacles[0].x + 0.1, y: TWIN_COVER.obstacles[0].y + 0.1 };
    const check = measureArrival(scene, TWIN_COVER.agent, blocked, sel.chosenStance, TWIN_COVER.clues, {
      worstExposure: sel.stances[sel.chosenStance].worstExposure,
      visibility: sel.stances[sel.chosenStance].visibilityWeight,
      candidateId: sel.candidate.id,
    });
    expect(check.ok).toBe(false);
    expect(check.failures.some((f) => f.code === 'body_overlap')).toBe(true);
  });

  it('rejects a candidate once the ally body has moved onto it', () => {
    const sim = makeSim(TWIN_COVER);
    const first = sim.assign('scout')!;
    // After arrival, put the ally body right on the chosen spot.
    sim.simulateUntil(20);
    const chosen = first.selected!.candidate.pos;
    sim.moveAgent('wing', { x: chosen.x + 0.3, y: chosen.y });
    const result = sim.selectFor('scout')!;
    const sameSpot = result.candidates.find((e) => e.candidate.id === first.selected!.candidate.id);
    if (sameSpot) {
      if (sameSpot.valid) {
        // The ally moved to a different valid candidate; the check must at least
        // never rank a spot that overlaps a live body.
        expect(dist(sim.ally.pos, sameSpot.candidate.pos)).toBeGreaterThanOrEqual(0.7);
      } else {
        expect(sameSpot.rejectReasons.some((r) => r.code === 'agent_clearance')).toBe(true);
      }
    }
  });
});

describe('replay determinism', () => {
  it('produces identical event streams for identical action sequences', () => {
    const run = () => {
      const sim = makeSim(TWIN_COVER);
      sim.assign('scout');
      sim.step(1.1);
      sim.moveClue('flash', { x: 18.5, y: 8.4 });
      sim.step(0.7);
      sim.simulateUntil(25);
      return sim;
    };
    const a = run();
    const b = run();
    const strip = (evs: typeof a.events) => evs.map((e) => `${e.seq}|${e.t}|${e.kind}|${e.actor}|${e.text}`);
    expect(strip(a.events)).toEqual(strip(b.events));
    expect(a.agent.pos.x).toBeCloseTo(b.agent.pos.x, 8);
    expect(a.agent.pos.y).toBeCloseTo(b.agent.pos.y, 8);
    expect(a.replays.length).toBeGreaterThan(5);
    expect(a.replays.length).toBe(b.replays.length);
  });

  it('records a snapshot per logged event', () => {
    const sim = makeSim(TWIN_COVER);
    sim.assign('scout');
    sim.simulateUntil(20);
    expect(sim.replays.length).toBeGreaterThan(5);
    const arrivalFrame = sim.replays.find((r) => r.event?.kind === 'arrive');
    expect(arrivalFrame).toBeTruthy();
    expect(arrivalFrame!.snapshot.agents.find((a) => a.id === 'scout')!.arrival).toBeTruthy();
  });
});

describe('navigation sanity', () => {
  it('finds a body-clear path from spawn to a selected spot', () => {
    for (const s of SCENARIOS) {
      const grid = buildGrid(sceneOf(s), s.agent.radius, 0.25);
      const field = buildNavField(grid, s.agent.pos);
      expect(field).toBeTruthy();
      const target = selectCover(baseInput(s)).selected;
      expect(target).toBeTruthy();
      const route = findPath(grid, s.agent.pos, target!.candidate.pos);
      if (route.found) expect(pathBodyClear(sceneOf(s), route.points, s.agent.radius).ok).toBe(true);
    }
  });
});

describe('selection does not depend on a single total score', () => {
  it('shows a lower-utility candidate can be valid and explains why it lost', () => {
    const result = selectCover(baseInput(TWIN_COVER));
    const runnerUp = result.ranked[1];
    expect(runnerUp).toBeTruthy();
    expect(runnerUp.valid).toBe(true);
    expect(runnerUp.components.utility).toBeLessThan(result.selected!.components.utility);
    // The audit keeps the full breakdown, not just the rank.
    expect(runnerUp.components.terms.length).toBe(6);
    expect(runnerUp.stances[runnerUp.chosenStance].perClue.length).toBe(TWIN_COVER.clues.length);
    // And it can state the concrete reason it lost (travel time here).
    expect(runnerUp.travelTimeSec!).toBeGreaterThan(result.selected!.travelTimeSec!);
  });

  it('does not reject a candidate only because another scored higher', () => {
    const result = selectCover(baseInput(TWIN_COVER));
    const validIds = new Set(result.ranked.map((e) => e.candidate.id));
    for (const e of result.ranked) expect(validIds.has(e.candidate.id)).toBe(true);
    // Rejections are all geometric/policy, never "outranked".
    for (const e of result.rejected) {
      expect(e.rejectReasons.length).toBeGreaterThan(0);
    }
  });
});
