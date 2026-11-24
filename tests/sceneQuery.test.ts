import { describe, expect, it } from 'vitest';
import {
  LAYER_COVER,
  LAYER_SOLID,
  LEGACY_QUERY_VERSION,
  RectQueryBackend,
  SPATIAL_QUERY_VERSION,
  SceneQueries,
  currentRayBlockers,
  layerMaskOf,
  legacyRayBlockers,
  rayRectFirstHit,
  sceneQueries,
  verifyQueryEquivalence,
  type RaySpec,
} from '../src/kernel/sceneQuery';
import { SCENARIOS, TWIN_COVER, MULTI_HEIGHT, SEALED_POCKET, scenarioById } from '../src/kernel/scenarios';
import { BODY_PROBES, STANCE_EYE, generateCandidates } from '../src/kernel/exposure';
import { makeSim } from '../src/kernel/engine';
import { selectCover, DEFAULT_POLICY } from '../src/kernel/selection';
import { ReservationBook } from '../src/kernel/reservations';
import type { Obstacle, SceneGeometry, Vec2 } from '../src/kernel/types';

function box(id: string, x: number, y: number, w: number, d: number, height: number, cover = true): Obstacle {
  return { id, x, y, w, d, height, kind: 'wall', cover };
}

function sceneOf(...obstacles: Obstacle[]): SceneGeometry {
  return { board: { w: 24, h: 16 }, obstacles };
}

const sceneOfScenario = (s: typeof TWIN_COVER): SceneGeometry => ({ board: s.board, obstacles: s.obstacles });

/** The exact rays a selection evaluates: every candidate × clue × stance eye × body probe. */
function selectionRays(s: typeof TWIN_COVER): RaySpec[] {
  const scene = sceneOfScenario(s);
  const candidates = generateCandidates(scene, s.agent);
  const rays: RaySpec[] = [];
  for (const c of candidates) {
    for (const clue of s.clues) {
      for (const stance of ['stand', 'crouch'] as const) {
        for (const h of BODY_PROBES) {
          rays.push({
            origin: c.pos,
            target: clue.pos,
            fromHeight: STANCE_EYE[stance],
            toHeight: h,
            label: `${c.id}/${clue.id}/${stance}/${h}`,
          });
        }
      }
    }
  }
  return rays;
}

describe('unified scene query interface', () => {
  it('answers only on the layers the query asks for', () => {
    const scene = sceneOf(box('solid-prop', 4, -1, 1, 2, 2.0, false), box('cover-wall', 8, -1, 1, 2, 2.0, true));
    const q = sceneQueries(scene);
    const origin: Vec2 = { x: 0, y: 0 };
    const dir: Vec2 = { x: 1, y: 0 };

    const coverHit = q.raycast(origin, dir, 20, LAYER_COVER);
    expect(coverHit?.obstacleId).toBe('cover-wall');

    const solidHit = q.raycast(origin, dir, 20, LAYER_SOLID);
    expect(solidHit?.obstacleId).toBe('solid-prop');

    expect(layerMaskOf(scene.obstacles[0]) & LAYER_COVER).toBe(0);
    expect(layerMaskOf(scene.obstacles[0]) & LAYER_SOLID).not.toBe(0);
    expect(layerMaskOf(scene.obstacles[1]) & LAYER_COVER).not.toBe(0);
  });

  it('reports explicit face normals, including the back face from inside', () => {
    const wall = box('wall', 4, -1, 1, 2, 2.0);
    // Front face: ray travelling +x hits the west face, normal (-1, 0).
    const front = rayRectFirstHit({ x: 0, y: 0 }, { x: 1, y: 0 }, 20, wall);
    expect(front?.fromInside).toBe(false);
    expect(front?.normal).toEqual({ x: -1, y: 0 });
    expect(front?.distance).toBeCloseTo(4, 9);
    // Back face: ray starting inside the solid reports the exit face, whose
    // normal points along the travel direction.
    const back = rayRectFirstHit({ x: 4.5, y: 0 }, { x: 1, y: 0 }, 20, wall);
    expect(back?.fromInside).toBe(true);
    expect(back?.normal).toEqual({ x: 1, y: 0 });
    expect(back?.distance).toBeCloseTo(0.5, 9);
    // Vertical faces.
    const south = rayRectFirstHit({ x: 4.5, y: 4 }, { x: 0, y: -1 }, 20, wall);
    expect(south?.normal).toEqual({ x: 0, y: 1 });
  });

  it('carries obstacle height on every hit', () => {
    const wall = box('half', 4, -1, 1, 2, 1.15);
    const hit = rayRectFirstHit({ x: 0, y: 0 }, { x: 1, y: 0 }, 20, wall);
    expect(hit?.height).toBe(1.15);
  });

  it('reports only the first intersection for thin walls and reconstructs the occupied segment from both directions', () => {
    const thin = box('thin', 5, -1, 0.05, 2, 2.2);
    const scene = sceneOf(thin, box('far', 9, -1, 1, 2, 2.2));
    const q = sceneQueries(scene);
    const origin: Vec2 = { x: 0, y: 0 };
    const target: Vec2 = { x: 12, y: 0 };

    // Endpoint semantics: first hit only; nothing behind the thin wall is reported.
    const first = q.raycast(origin, { x: 1, y: 0 }, 12, LAYER_COVER);
    expect(first?.obstacleId).toBe('thin');
    expect(first?.distance).toBeCloseTo(5, 6);

    // Read layer: the occupied segment of the thin wall is rebuilt along the
    // travel direction — entry from the forward cast, exit (a back face) from
    // the opposing cast — and the second wall gets its own segment.
    const segments = q.occlusionSpans(origin, target, LAYER_COVER);
    expect(segments.pairingsExact).toBe(true);
    expect(segments.spans.map((s) => s.obstacleId)).toEqual(['thin', 'far']);
    const [thinSpan, farSpan] = segments.spans;
    expect(thinSpan.enterPoint.x).toBeCloseTo(5, 6);
    expect(thinSpan.exitPoint.x).toBeCloseTo(5.05, 6);
    expect(thinSpan.enterNormal).toEqual({ x: -1, y: 0 });
    expect(thinSpan.exitNormal).toEqual({ x: 1, y: 0 });
    expect(farSpan.enterPoint.x).toBeCloseTo(9, 6);
    expect(farSpan.exitPoint.x).toBeCloseTo(10, 6);
  });

  it('merges opposing rays only when both ends name the same obstacle', () => {
    const one = sceneOf(box('solo', 5, -1, 1, 2, 2.0));
    const two = sceneOf(box('a', 5, -1, 1, 2, 2.0), box('b', 9, -1, 1, 2, 2.0));
    const origin: Vec2 = { x: 0, y: 0 };
    const target: Vec2 = { x: 12, y: 0 };

    const merged = sceneQueries(one).mergedSpan(origin, target, LAYER_COVER);
    expect(merged).not.toBeNull();
    expect(merged!.obstacleId).toBe('solo');
    expect(merged!.enterPoint.x).toBeCloseTo(5, 6);
    expect(merged!.exitPoint.x).toBeCloseTo(6, 6);

    // Two solids along the ray: the merge does not apply, the walk takes over.
    expect(sceneQueries(two).mergedSpan(origin, target, LAYER_COVER)).toBeNull();
    const segments = sceneQueries(two).occlusionSpans(origin, target, LAYER_COVER);
    expect(segments.mergedApplicable).toBe(false);
    expect(segments.spans.map((s) => s.obstacleId)).toEqual(['a', 'b']);

    // No obstacle at all: nothing to merge, nothing occupied.
    const clear = sceneQueries(sceneOf()).occlusionSpans({ x: 0, y: 5 }, { x: 12, y: 5 }, LAYER_COVER);
    expect(clear.spans).toEqual([]);
  });

  it('evaluates height across the occupied segment, not only at entry', () => {
    // A descending ray that clears the wall top at entry but dips below it
    // inside the wall's footprint is occluded — the legacy entry-only model
    // called this visible.
    const scene = sceneOf(box('mid', 4, -1, 2, 2, 1.0));
    const origin: Vec2 = { x: 0, y: 0 };
    const target: Vec2 = { x: 10, y: 0 };
    const legacy = legacyRayBlockers(scene, origin, 1.62, target, 0.15);
    const current = currentRayBlockers(scene, origin, 1.62, target, 0.15);
    expect(legacy).toEqual([]);
    expect(current.blockers).toEqual(['mid']);
    // A flat ray above the top stays visible under both models.
    expect(currentRayBlockers(scene, origin, 1.62, target, 1.62).blockers).toEqual([]);
    // A flat ray below the top is blocked under both models.
    expect(currentRayBlockers(scene, origin, 0.9, target, 0.9).blockers).toEqual(['mid']);
    expect(legacyRayBlockers(scene, origin, 0.9, target, 0.9)).toEqual(['mid']);
  });
});

describe('contract check: legacy vs migrated query models', () => {
  it('keeps the selection contract on the exact selection rays: legacy occlusions are preserved, refinements are additive only', () => {
    for (const s of SCENARIOS) {
      const report = verifyQueryEquivalence(sceneOfScenario(s), s.id, selectionRays(s), { sweep: false });
      expect(report.queryBackend).toBe(SPATIAL_QUERY_VERSION);
      expect(report.checked).toBeGreaterThan(0);
      expect(report.occluded).toBeGreaterThan(0);
      expect(report.mergedApplicable).toBeGreaterThan(0);
      expect(report.inexactPairings).toBe(0);
      // The migrated model evaluates height across the whole occupied
      // segment, so it may report blockers the legacy entry-only check
      // missed (descending rays dipping below a wall top) — but it never
      // loses an occlusion the legacy model saw on a selection ray.
      for (const d of report.discrepancies) {
        expect(d.kind).toBe('blocker-set');
        expect(d.legacyBlockers.every((b) => d.currentBlockers.includes(b))).toBe(true);
      }
    }
  });

  it('sweeps the shipped boards and finds only documented blocker-set refinements, never pairing failures', () => {
    for (const s of SCENARIOS) {
      const report = verifyQueryEquivalence(sceneOfScenario(s), s.id, selectionRays(s));
      expect(report.checked).toBeGreaterThan(1000);
      expect(report.occluded).toBeGreaterThan(0);
      expect(report.mergedApplicable).toBeGreaterThan(0);
      expect(report.inexactPairings).toBe(0);
      for (const d of report.discrepancies) {
        expect(d.kind).toBe('blocker-set');
        // Every difference is one-directional: either the migrated model
        // adds blockers (descending-ray refinement) or drops them
        // (boundary-touch false positives) — never both on the same ray.
        const additive = d.legacyBlockers.every((b) => d.currentBlockers.includes(b));
        const removal = d.currentBlockers.every((b) => d.legacyBlockers.includes(b));
        expect(additive !== removal).toBe(true);
      }
    }
  });

  it('flags a map where the two models disagree (descending ray through a wall top)', () => {
    const scene = sceneOf(box('mid', 4, -1, 2, 2, 1.0));
    const report = verifyQueryEquivalence(scene, 'non-equivalent', [
      { origin: { x: 0, y: 0 }, target: { x: 10, y: 0 }, fromHeight: 1.62, toHeight: 0.15, label: 'down-ray' },
    ]);
    const kinds = report.discrepancies.map((d) => d.kind);
    expect(kinds).toContain('blocker-set');
    const hit = report.discrepancies.find((d) => d.ray.label === 'down-ray');
    expect(hit).toBeTruthy();
    expect(hit!.legacyBlockers).toEqual([]);
    expect(hit!.currentBlockers).toEqual(['mid']);
  });

  it('flags overlapping solids as inexact pairings instead of guessing', () => {
    const scene = sceneOf(box('a', 0, -1, 2, 2, 2.0), box('b', 1, -1, 2, 2, 2.0));
    const segments = sceneQueries(scene).occlusionSpans({ x: -2, y: 0 }, { x: 5, y: 0 }, LAYER_COVER);
    expect(segments.pairingsExact).toBe(false);
    const report = verifyQueryEquivalence(scene, 'overlap', [
      { origin: { x: -2, y: 0 }, target: { x: 5, y: 0 }, fromHeight: 1.62, toHeight: 0.15, label: 'overlap-ray' },
    ]);
    expect(report.inexactPairings).toBeGreaterThan(0);
    expect(report.discrepancies.some((d) => d.kind === 'pairing')).toBe(true);
  });
});

describe('selection runs the migrated query path', () => {
  it('stamps every result with the query backend version', () => {
    const result = selectCover({
      scene: sceneOfScenario(TWIN_COVER),
      agent: TWIN_COVER.agent,
      clues: TWIN_COVER.clues,
      reservations: new ReservationBook(),
      policy: DEFAULT_POLICY,
    });
    expect(result.queryBackend).toBe(SPATIAL_QUERY_VERSION);
    expect(result.invalidatedLegacyCandidateIds).toEqual([]);
    expect(result.selected).toBeTruthy();
  });

  it('invalidates legacy failed-candidate records instead of trusting them', () => {
    const sim = makeSim(TWIN_COVER, { legacyFailedCandidates: { scout: ['twin-n/w/0'] } });
    const result = sim.selectFor('scout')!;
    expect(result.invalidatedLegacyCandidateIds).toEqual(['twin-n/w/0']);
    // The legacy record is not applied as an arrival_failed rejection…
    const row = result.candidates.find((e) => e.candidate.id === 'twin-n/w/0')!;
    expect(row.rejectReasons.some((r) => r.code === 'arrival_failed')).toBe(false);
    // …it is dropped from the live store…
    expect(sim.failedFor('scout')).toEqual([]);
    // …and the invalidation is surfaced in the event log and the rationale.
    expect(sim.events.some((e) => e.kind === 'note' && e.text.includes(LEGACY_QUERY_VERSION))).toBe(true);
    expect(result.rationale.join(' ')).toContain('Invalidated 1 failed-candidate record');
    // A second selection has nothing left to invalidate.
    const again = sim.selectFor('scout')!;
    expect(again.invalidatedLegacyCandidateIds).toEqual([]);
  });

  it('keeps arrival feedback records under the current backend', () => {
    const sim = makeSim(TWIN_COVER);
    sim.assign('scout');
    sim.simulateUntil(30);
    expect(sim.agent.status).toBe('inCover');
    for (const id of sim.failedFor('scout')) {
      const record = sim.failedCandidates['scout'].find((r) => r.id === id)!;
      expect(record.backend).toBe(SPATIAL_QUERY_VERSION);
    }
  });
});

describe('character behaviour scenarios on the migrated path', () => {
  it('runs every shipped sample to arrival on the new query path', () => {
    for (const s of SCENARIOS) {
      const sim = makeSim(scenarioById(s.id));
      const sel = sim.assign('scout')!;
      expect(sel.queryBackend).toBe(SPATIAL_QUERY_VERSION);
      sim.simulateUntil(40);
      expect(sim.agent.status).toBe('inCover');
      expect(sim.agent.arrival?.ok).toBe(true);
      expect(sim.agent.arrival?.matchesPrediction).toBe(true);
    }
  });

  it('re-evaluates candidates and stance when the enemy clue moves, keeping the interaction intact', () => {
    const sim = makeSim(scenarioById('multi-height'));
    const first = sim.assign('scout')!;
    const firstTop = first.selected!;
    expect(firstTop.candidate.obstacleId).toBe('tall-wall');
    expect(firstTop.chosenStance).toBe('stand');
    sim.simulateUntil(40);
    expect(sim.agent.status).toBe('inCover');

    // Drag the visible hostile due south: the tall wall no longer hides the
    // character, and a half-height obstacle becomes the crouch-height answer.
    sim.moveAgent('scout', { x: 3.5, y: 7.0 });
    sim.setHostileClueFromHostile('hv-1', { x: 10.5, y: 13.2 });
    const second = sim.assign('scout')!;
    expect(second.queryBackend).toBe(SPATIAL_QUERY_VERSION);
    const top = second.selected!;
    // The answer is computed, not scripted: the utility picks a crouch-height
    // obstacle (hides a crouched body, not a standing one) and the stance to
    // match — which exact half-height cover wins is the utility's call.
    expect(top.chosenStance).toBe('crouch');
    const chosenObstacle = MULTI_HEIGHT.obstacles.find((o) => o.id === top.candidate.obstacleId)!;
    expect(chosenObstacle.height).toBeGreaterThanOrEqual(STANCE_EYE.crouch);
    expect(chosenObstacle.height).toBeLessThan(STANCE_EYE.stand);
    // Candidate evaluation is real measurement: with the clue moved south,
    // the tall wall's exposed faces measure stand exposure above the policy
    // limit and are rejected by the exposure limit, and the winner's crouch
    // exposure to the moved clue is measured low.
    const tallRows = second.candidates.filter((e) => e.candidate.obstacleId === 'tall-wall');
    expect(tallRows.length).toBeGreaterThan(0);
    const exposed = tallRows.filter((e) => e.rejectReasons.some((r) => r.code === 'exposure_limit'));
    expect(exposed.length).toBeGreaterThan(0);
    for (const e of exposed) {
      expect(Math.max(e.stances.stand.worstExposure, e.stances.crouch.worstExposure)).toBeGreaterThan(
        second.policy.maxWorstExposure,
      );
    }
    const muzzle = top.stances.crouch.perClue.find((c) => c.clueId === 'muzzle')!;
    expect(muzzle.exposure).toBeLessThan(0.2);

    sim.simulateUntil(40);
    expect(sim.agent.status).toBe('inCover');
    expect(sim.agent.stance).toBe('crouch');
    expect(sim.agent.arrival?.ok).toBe(true);
  });

  it('surfaces anomalies through the selection interface, not silently', () => {
    const sim = makeSim(scenarioById('sealed-pocket'));
    const result = sim.assign('scout')!;
    // The sealed ring's inner faces stay unreachable and named as such.
    const unreachable = result.rejected.filter((e) => e.rejectReasons.some((r) => r.code === 'unreachable'));
    expect(unreachable.length).toBeGreaterThan(0);
    expect(result.rejectionSummary.some((r) => r.code === 'unreachable')).toBe(true);
    expect(result.rejectionSummary.some((r) => r.code === 'transition_space')).toBe(true);
    sim.simulateUntil(40);
    expect(sim.agent.status).toBe('inCover');
  });
});
