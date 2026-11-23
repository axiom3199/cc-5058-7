import type {
  AgentSpec,
  ArrivalCheck,
  ArrivalMeasured,
  Candidate,
  CandidateEvaluation,
  ClueExposure,
  Policy,
  RejectReason,
  ReservationView,
  SceneGeometry,
  SelectionInput,
  SelectionResult,
  Stance,
  StanceEvaluation,
  ThreatClue,
  Vec2,
} from './types';
import {
  EPS,
  angleDiffDeg,
  dist,
  pointInRect,
  rectBoundaryDistance,
  round,
  inBoard,
  bearingDeg,
} from './geometry';
import {
  bodyOverlapObstacles,
  candidateProblem,
  describeClueSource,
  evaluateClueExposure,
  evaluateStance,
  faceName,
  clueWeight,
  FACE_MARGIN,
  STANCE_EYE,
  TRANSITION_DEPTH,
  TRANSITION_HALF_WIDTH,
  BODY_PROBES,
  exposureAt,
  rayVisible,
  adjacentCover,
  transitionClearance,
} from './exposure';
import { buildGrid, buildNavField, connectorClear, routeFromField, isFree, pathBodyClear, type NavGrid } from './navigation';
import { EXCLUSION_RADIUS } from './reservations';

export const DEFAULT_POLICY: Policy = {
  weights: { protection: 0.38, observation: 0.16, mobility: 0.2, clearance: 0.12, crowding: 0.06, watch: 0.08 },
  stanceMode: 'auto',
  maxWorstExposure: 0.5,
  stanceTolerance: 0.0,
  maxTravelSec: 14,
};

let selectionCounter = 0;

export function gridFor(scene: SceneGeometry, agent: AgentSpec): NavGrid {
  return buildGrid(scene, agent.radius, 0.25);
}

function stanceForPolicy(mode: Policy['stanceMode']): Stance {
  return mode === 'crouch' ? 'crouch' : 'stand';
}

export function chooseStance(
  policy: Policy,
  stances: Record<Stance, StanceEvaluation>,
): { stance: Stance; reason: string } {
  if (policy.stanceMode === 'stand' || policy.stanceMode === 'crouch') {
    return { stance: policy.stanceMode, reason: `policy pins ${policy.stanceMode} stance` };
  }
  const stand = stances.stand;
  const crouch = stances.crouch;
  const standOk = stand.worstExposure <= policy.maxWorstExposure && stand.worstExposure <= crouch.worstExposure + 1e-9;
  const crouchOk = crouch.worstExposure <= policy.maxWorstExposure;
  if (standOk) {
    return {
      stance: 'stand',
      reason: `stand: worst exposure ${(stand.worstExposure * 100).toFixed(0)}% ≤ crouch ${(crouch.worstExposure * 100).toFixed(0)}%, keeps normal walking speed`,
    };
  }
  if (crouchOk) {
    return {
      stance: 'crouch',
      reason: `crouch: standing would expose ${(stand.worstExposure * 100).toFixed(0)}% of the body; crouching drops that to ${(crouch.worstExposure * 100).toFixed(0)}%`,
    };
  }
  return {
    stance: stand.worstExposure <= crouch.worstExposure ? 'stand' : 'crouch',
    reason: `no stance meets the ${(policy.maxWorstExposure * 100).toFixed(0)}% exposure limit; using the least exposed one`,
  };
}

function normaliseUtility(
  values: { e: CandidateEvaluation }[],
): { minTravel: number; maxTravel: number } {
  let minTravel = Infinity;
  let maxTravel = 0;
  for (const { e } of values) {
    if (e.travelTimeSec !== null) {
      minTravel = Math.min(minTravel, e.travelTimeSec);
      maxTravel = Math.max(maxTravel, e.travelTimeSec);
    }
  }
  if (!Number.isFinite(minTravel)) minTravel = 0;
  if (maxTravel <= minTravel) maxTravel = minTravel + 1;
  return { minTravel, maxTravel };
}

function buildProsCons(
  e: Omit<CandidateEvaluation, 'pros' | 'cons'>,
  clues: ThreatClue[],
  scene: SceneGeometry,
): { pros: string[]; cons: string[] } {
  const pros: string[] = [];
  const cons: string[] = [];
  const chosen = e.stances[e.chosenStance];
  const other = e.stances[e.chosenStance === 'stand' ? 'crouch' : 'stand'];
  const coverObstacle = scene.obstacles.find((o) => o.id === e.candidate.obstacleId);

  if (coverObstacle) {
    if (coverObstacle.height >= 1.7) pros.push(`${coverObstacle.label ?? coverObstacle.id} is full height, so a standing body stays behind it`);
    else pros.push(`${coverObstacle.label ?? coverObstacle.id} is crouch height, so a crouched body stays behind it`);
  }

  for (const c of clues) {
    const ex = chosen.perClue.find((p) => p.clueId === c.id);
    if (!ex) continue;
    const label = `${describeClueSource(c.source)} ${c.label}`;
    if (ex.exposure <= 0.01) {
      pros.push(`${label} is fully hidden at ${c.pos.x.toFixed(1)},${c.pos.y.toFixed(1)} (${ex.distance.toFixed(1)} m away)`);
    } else if (ex.exposure >= 0.9) {
      cons.push(`${label} can see almost the whole body (${(ex.exposure * 100).toFixed(0)}%) from ${ex.distance.toFixed(1)} m`);
    } else {
      cons.push(`${label} sees ${(ex.exposure * 100).toFixed(0)}% of the body; ${ex.blockers.length ? `blocked by ${ex.blockers.join(', ')}` : 'only partly shielded'}`);
    }
    if (ex.worstExposure > ex.exposure + 0.05) {
      cons.push(`${label} could see more (${(ex.worstExposure * 100).toFixed(0)}%) if the clue is off by ${c.uncertainty.toFixed(1)} m`);
    }
    if (c.source === 'sound') {
      pros.push(`${label}: sound-only clue, so this line of sight is an inference, not confirmed`);
    }
  }

  if (chosen.openDirectionCount === 0) {
    cons.push('no unobstructed eye-height direction: cannot watch anything from here');
  } else if (chosen.openDirectionFraction < 0.25) {
    cons.push(`only ${chosen.openDirectionCount}/16 view directions are open`);
  } else if (chosen.openDirectionFraction > 0.6) {
    cons.push(`${chosen.openDirectionCount}/16 view directions open; likely exposed from several angles`);
  } else {
    pros.push(`${chosen.openDirectionCount}/16 view directions open, a balanced firing/observing arc`);
  }

  if (e.chosenStance === 'crouch') {
    if (other.worstExposure > chosen.worstExposure + 0.15) {
      pros.push(`standing here would expose ${(other.worstExposure * 100).toFixed(0)}%, so crouching is necessary`);
    }
    cons.push(`crouching costs speed (${(e.travelTimeSec ?? 0).toFixed(1)} s route) and limits head height to ${STANCE_EYE.crouch.toFixed(2)} m`);
  }

  if (e.travelTimeSec !== null) {
    if (e.travelTimeSec <= 2.5) pros.push(`short move: ${e.travelTimeSec.toFixed(1)} s from the current position`);
    else if (e.travelTimeSec >= 7) cons.push(`long move: ${e.travelTimeSec.toFixed(1)} s in the open or behind cover`);
    else pros.push(`move takes ${e.travelTimeSec.toFixed(1)} s`);
  }

  if (e.candidate.transitionMargin < 0.2) {
    cons.push(`tight stance-change space (${e.candidate.transitionMargin.toFixed(2)} m beyond the body)`);
  } else {
    pros.push(`room to stand up and crouch down (${e.candidate.transitionMargin.toFixed(2)} m spare)`);
  }

  if (e.reservationsNear.length > 0) {
    for (const r of e.reservationsNear) {
      cons.push(`${r.agentId} already holds a route to a spot ${r.distance.toFixed(1)} m away`);
    }
  }

  if (!e.routeClear) cons.push('route connector crosses cover even though the grid path looks open');
  return { pros, cons };
}

function evaluateCandidate(
  scene: SceneGeometry,
  grid: NavGrid,
  field: ReturnType<typeof buildNavField>,
  agent: AgentSpec,
  candidate: Candidate,
  clues: ThreatClue[],
  policy: Policy,
  reservations: ReservationView,
  failed: Set<string>,
  otherAgents: { id: string; name: string; pos: Vec2; radius: number }[],
): CandidateEvaluation {
  const rejectReasons: RejectReason[] = [];
  const problem = candidateProblem(candidate);
  if (!candidate.geometry.inBounds) rejectReasons.push({ code: 'out_of_bounds', detail: problem ?? 'outside board' });
  else if (!candidate.geometry.bodyClear) rejectReasons.push({ code: 'body_overlap', detail: problem ?? 'body overlap' });
  else if (!candidate.geometry.transitionClear) rejectReasons.push({ code: 'transition_space', detail: problem ?? 'no stance space' });
  else if (candidate.clearanceMargin < 0.02) rejectReasons.push({ code: 'low_clearance', detail: problem ?? 'thin margin' });

  const stances: Record<Stance, StanceEvaluation> = {
    stand: evaluateStance(scene, candidate.pos, 'stand', clues),
    crouch: evaluateStance(scene, candidate.pos, 'crouch', clues),
  };
  const picked = chooseStance(policy, stances);
  const chosen = stances[picked.stance];
  let path: Vec2[] = [];
  let pathLengthVal: number | null = null;
  let travelTimeSec: number | null = null;
  let reachable = false;
  let routeClear = false;

  if (field) {
    const route = routeFromField(grid, field, candidate.pos);
    if (route.found) {
      const conn = connectorClear(scene, route.points, agent.radius);
      const bodyOk = pathBodyClear(scene, route.points, agent.radius);
      routeClear = conn.ok && bodyOk.ok;
      if (routeClear) {
        reachable = true;
        path = route.points;
        pathLengthVal = round(route.length, 3);
        const speed = picked.stance === 'crouch' ? agent.crouchSpeed : agent.walkSpeed;
        travelTimeSec = round(route.length / speed, 3);
      } else {
        rejectReasons.push({ code: 'unreachable', detail: conn.ok ? 'route grazes cover' : conn.detail });
      }
    } else {
      rejectReasons.push({ code: 'unreachable', detail: 'no body-clear route from the current position' });
    }
  } else {
    rejectReasons.push({ code: 'unreachable', detail: 'start position has no free navigation cell' });
  }

  if (travelTimeSec !== null && travelTimeSec > policy.maxTravelSec) {
    rejectReasons.push({
      code: 'unreachable',
      detail: `route takes ${travelTimeSec.toFixed(1)} s, over the ${policy.maxTravelSec.toFixed(0)} s limit`,
    });
    reachable = false;
  }

  const held = reservations.ownerOf(candidate.pos, agent.id);
  const nearby = reservations.nearby(candidate.pos, agent.id);
  if (held) {
    rejectReasons.push({
      code: 'reserved',
      detail: `${held.agentId} has already committed to this spot (reservation v${held.version})`,
    });
  }

  for (const other of otherAgents) {
    if (other.id === agent.id) continue;
    const need = agent.radius + other.radius + 0.25;
    const d = dist(other.pos, candidate.pos);
    if (d < need) {
      rejectReasons.push({
        code: 'agent_clearance',
        detail: `${other.name} stands ${d.toFixed(2)} m away; this spot needs ${need.toFixed(2)} m for two bodies`,
      });
    }
  }

  if (failed.has(candidate.id)) {
    rejectReasons.push({ code: 'arrival_failed', detail: 'previous arrival test failed at this exact spot' });
  }

  if (chosen.worstExposure > policy.maxWorstExposure + 1e-9) {
    rejectReasons.push({
      code: 'exposure_limit',
      detail: `worst known-clue exposure ${(chosen.worstExposure * 100).toFixed(0)}% exceeds the ${(policy.maxWorstExposure * 100).toFixed(0)}% policy limit`,
    });
  }

  const valid = rejectReasons.length === 0;

  const crowding = nearby.length > 0 ? Math.min(1, nearby.reduce((s, r) => s + 1 / (1 + dist(r.pos, candidate.pos)), 0)) : 0;
  const base: Omit<CandidateEvaluation, 'pros' | 'cons'> = {
    candidate,
    valid,
    rejectReasons,
    reachable,
    path,
    pathLength: pathLengthVal,
    travelTimeSec,
    routeClear,
    stances,
    chosenStance: picked.stance,
    stanceReason: picked.reason,
    components: {
      protection: 0,
      observation: 0,
      mobility: 0,
      clearance: 0,
      crowding,
      observationArc: 0,
      watch: 0,
      utility: 0,
      terms: [],
    },
    rank: null,
    reservationsNear: nearby.map((r) => ({ agentId: r.agentId, distance: round(dist(r.pos, candidate.pos), 2) })),
  };
  const { pros, cons } = buildProsCons(base, clues, scene);
  return { ...base, pros, cons };
}

export function selectCover(input: SelectionInput): SelectionResult {
  const { scene, agent, clues, reservations, policy } = input;
  const failed = new Set(input.failedCandidateIds ?? []);
  const now = input.now ?? Date.now();
  const grid = gridFor(scene, agent);
  const field = buildNavField(grid, agent.pos);

  const candidateList = generateCandidatesFor(scene, agent);
  const otherAgents = input.otherAgents ?? [];
  const evaluations = candidateList.map((c) =>
    evaluateCandidate(scene, grid, field, agent, c, clues, policy, reservations, failed, otherAgents),
  );

  const validEntries = evaluations.filter((e) => e.valid);
  const { minTravel, maxTravel } = normaliseUtility(validEntries.map((e) => ({ e })));

  for (const e of evaluations) {
    const chosen = e.stances[e.chosenStance];
    const protection = 1 - chosen.worstExposure;
    const observation = chosen.openDirectionFraction;
    const mobility =
      e.travelTimeSec === null ? 0 : 1 - Math.max(0, Math.min(1, (e.travelTimeSec - minTravel) / (maxTravel - minTravel)));
    const clearance = Math.max(
      0,
      Math.min(1, (Math.min(e.candidate.clearanceMargin, e.candidate.transitionMargin) + 0.1) / 1.1),
    );
    const w = policy.weights;
    const closest = clues.slice().sort((a, b) => dist(a.pos, e.candidate.pos) - dist(b.pos, e.candidate.pos))[0];
    let watch = 0;
    if (closest) {
      const bearing = bearingDeg(e.candidate.pos, closest.pos);
      const openDirs = chosen.openDirections;
      let hit = 0;
      for (let i = 0; i < openDirs.length; i++) {
        if (!openDirs[i]) continue;
        const dirBearing = (i / openDirs.length) * 360;
        if (angleDiffDeg(dirBearing, bearing) <= 22.5) hit++;
      }
      const nearestOpen = (() => {
        let best = 180;
        for (let i = 0; i < openDirs.length; i++) {
          if (!openDirs[i]) continue;
          const dirBearing = (i / openDirs.length) * 360;
          best = Math.min(best, angleDiffDeg(dirBearing, bearing));
        }
        return best;
      })();
      watch = Math.max(hit / 2, Math.max(0, 1 - nearestOpen / 90) * 0.6);
      watch = Math.min(1, watch);
    }
    e.components.observationArc = chosen.openDirectionFraction;
    e.components.watch = round(watch, 4);
    const terms: { name: keyof typeof w; weight: number; value: number; contribution: number }[] = [
      { name: 'protection', weight: w.protection, value: protection, contribution: w.protection * protection },
      { name: 'observation', weight: w.observation, value: observation, contribution: w.observation * observation },
      { name: 'mobility', weight: w.mobility, value: mobility, contribution: w.mobility * mobility },
      { name: 'clearance', weight: w.clearance, value: clearance, contribution: w.clearance * clearance },
      { name: 'crowding', weight: w.crowding, value: 1 - e.components.crowding, contribution: w.crowding * (1 - e.components.crowding) },
      { name: 'watch', weight: w.watch, value: watch, contribution: w.watch * watch },
    ];
    const utility = e.valid ? terms.reduce((s, t) => s + t.contribution, 0) : 0;
    e.components = {
      protection: round(protection, 4),
      observation: round(observation, 4),
      mobility: round(mobility, 4),
      clearance: round(clearance, 4),
      crowding: round(e.components.crowding, 4),
      observationArc: round(e.components.observationArc, 4),
      watch: round(e.components.watch, 4),
      utility: round(utility, 4),
      terms: terms.map((t) => ({ ...t, value: round(t.value, 4), contribution: round(t.contribution, 4) })),
    };
  }

  const ranked = validEntries
    .slice()
    .sort((a, b) => b.components.utility - a.components.utility || (a.travelTimeSec ?? 0) - (b.travelTimeSec ?? 0))
    .map((e, i) => {
      e.rank = i + 1;
      return e;
    });
  const rejected = evaluations.filter((e) => !e.valid);

  const summaryMap = new Map<RejectReason['code'], number>();
  for (const e of rejected) {
    for (const r of e.rejectReasons) summaryMap.set(r.code, (summaryMap.get(r.code) ?? 0) + 1);
  }
  const rejectionSummary = [...summaryMap.entries()].map(([code, count]) => ({ code, count }));

  const selected = ranked[0] ?? null;
  const rationale: string[] = [];
  if (selected) {
    const s = selected;
    rationale.push(
      `Selected ${s.candidate.obstacleId}/${faceName(s.candidate.face)} at (${s.candidate.pos.x.toFixed(2)}, ${s.candidate.pos.y.toFixed(2)}): utility ${s.components.utility.toFixed(3)} from ${s.components.terms.map((t) => `${t.name} ${t.contribution.toFixed(3)}`).join(' + ')}.`,
    );
    rationale.push(`Stance: ${s.stanceReason}.`);
    const chosen = s.stances[s.chosenStance];
    rationale.push(
      `Known clue exposure at ${s.chosenStance}: ${chosen.perClue.map((c) => `${c.clueId} ${(c.exposure * 100).toFixed(0)}%`).join(', ') || 'no clues supplied'}; limit ${(policy.maxWorstExposure * 100).toFixed(0)}%.`,
    );
    if (s.travelTimeSec !== null) rationale.push(`Route ${s.pathLength?.toFixed(2)} m, ${s.travelTimeSec.toFixed(2)} s; ${s.path.length} polyline points, connector and body-sweep verified.`);
    if (s.reservationsNear.length) rationale.push(`${s.reservationsNear.length} nearby reservation(s) discounted, not deleted.`);
  } else {
    rationale.push('No candidate passed every check. Rejected candidates and their individual reasons remain in the result set.');
  }
  const perCode = rejectionSummary.map((r) => `${r.code}×${r.count}`).join(', ');
  if (perCode) rationale.push(`Rejections by reason: ${perCode}. These are kept for audit, not collapsed into the total score.`);

  selectionCounter += 1;
  const result: SelectionResult = {
    id: `sel-${selectionCounter}`,
    agentId: agent.id,
    originPos: { ...agent.pos },
    createdAt: now,
    clues: clues.map((c) => ({ ...c, pos: { ...c.pos } })),
    clueInputNote:
      'Only the clue list passed in this input was evaluated. Hidden hostile positions are never read by the kernel; see the debug overlay for the ground truth comparison.',
    policy: { ...policy, weights: { ...policy.weights } },
    candidates: evaluations,
    ranked,
    rejected,
    selected,
    rejectionSummary,
    rationale,
    reservationVersion: reservations.version,
    hiddenHostileLeak: false,
  };
  return result;
}

// Re-exported lazily to avoid a circular import at module load time.
import { generateCandidates } from './exposure';
function generateCandidatesFor(scene: SceneGeometry, agent: AgentSpec): Candidate[] {
  return generateCandidates(scene, agent);
}

/**
 * Re-run the geometric checks at the position actually reached and compare the
 * measurement with what selection predicted. Failures are returned as data so
 * the UI can feed them back into the next selection instead of silently retrying.
 */
export function measureArrival(
  scene: SceneGeometry,
  agent: AgentSpec,
  pos: Vec2,
  stance: Stance,
  clues: ThreatClue[],
  prediction: {
    worstExposure: number;
    visibility: number;
    candidateId: string;
    clearanceMargin?: number;
    transitionMargin?: number;
  },
  otherAgents: { id: string; name: string; pos: Vec2; radius: number }[] = [],
): ArrivalCheck {
  const failures: { code: string; detail: string }[] = [];
  const notes: string[] = [];
  const cover = adjacentCover(scene, pos, agent.radius);

  // Clearance mirrors the candidate model: the cover face the body is pressed
  // against is what it hides behind, not an obstruction to itself.
  let clearanceMargin = Math.min(pos.x, pos.y, scene.board.w - pos.x, scene.board.h - pos.y) - agent.radius;
  let nearest = 'board edge';
  for (const o of scene.obstacles) {
    if (cover && o.id === cover.obstacle.id) continue;
    const d = rectBoundaryDistance(pos, o) - agent.radius;
    if (d < clearanceMargin) {
      clearanceMargin = d;
      nearest = o.id;
    }
  }
  if (!inBoard(scene.board, pos, agent.radius)) failures.push({ code: 'out_of_bounds', detail: 'body extends past the board edge' });
  const overlaps = bodyOverlapObstacles(scene, pos, agent.radius);
  if (overlaps.length) {
    failures.push({ code: 'body_overlap', detail: `body overlaps ${overlaps.map((o) => o.id).join(', ')}` });
  }

  let bestTransition: number;
  if (cover) {
    bestTransition = transitionClearance(scene, cover.obstacle, pos, cover.normal, agent.radius).d;
  } else {
    const normalCandidates = [
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    ];
    bestTransition = -Infinity;
    for (const n of normalCandidates) {
      let worst = Infinity;
      for (const off of [-TRANSITION_HALF_WIDTH, 0, TRANSITION_HALF_WIDTH]) {
        for (const dep of [0, TRANSITION_DEPTH]) {
          const p = {
            x: pos.x + -n.y * off + n.x * Math.max(0, dep - agent.radius),
            y: pos.y + n.x * off + n.y * Math.max(0, dep - agent.radius),
          };
          let d = Math.min(p.x, p.y, scene.board.w - p.x, scene.board.h - p.y);
          for (const o of scene.obstacles) {
            if (pointInRect(p, o)) d = -Infinity;
            d = Math.min(d, rectBoundaryDistance(p, o) - agent.radius);
          }
          worst = Math.min(worst, d);
        }
      }
      bestTransition = Math.max(bestTransition, worst);
    }
  }
  if (bestTransition < 0) {
    failures.push({ code: 'transition_space', detail: `no face with ${TRANSITION_DEPTH} m of stance-change room` });
  }

  const agentClearance = otherAgents
    .filter((o) => o.id !== agent.id)
    .map((o) => {
      const need = agent.radius + o.radius + 0.25;
      const d = dist(o.pos, pos);
      return { agentId: o.id, distance: round(d, 4), required: round(need, 4), ok: d >= need };
    });
  for (const c of agentClearance) {
    if (!c.ok) {
      failures.push({
        code: 'agent_clearance',
        detail: `${c.agentId} is within ${c.distance.toFixed(2)} m; ${c.required.toFixed(2)} m needed`,
      });
    }
  }

  const perClue = clues.map((c) => evaluateClueExposure(scene, pos, stance, c));
  let worstExposure = 0;
  let vis = 0;
  let weight = 0;
  for (let i = 0; i < clues.length; i++) {
    worstExposure = Math.max(worstExposure, perClue[i].exposure);
    const w = clueWeight(clues[i]);
    vis += perClue[i].exposure * w;
    weight += w;
  }
  const visibilityWeight = weight > 0 ? vis / weight : 0;
  const openDirs = 0;
  void openDirs;

  const measured: ArrivalMeasured = {
    pos: { ...pos },
    stance,
    clearanceMargin: round(clearanceMargin, 4),
    transitionMargin: round(bestTransition, 4),
    perClue,
    worstExposure: round(worstExposure, 4),
    visibilityWeight: round(visibilityWeight, 4),
    openDirectionFraction: 0,
    agentClearance,
  };

  const delta = Math.abs(round(worstExposure, 4) - prediction.worstExposure);
  const matchesPrediction = delta <= 1 / BODY_PROBES.length + 1e-9;
  if (!matchesPrediction) {
    notes.push(
      `Measured worst exposure ${(worstExposure * 100).toFixed(0)}% differs from predicted ${(prediction.worstExposure * 100).toFixed(0)}%; recording it so the next selection can reject this spot.`,
    );
    failures.push({
      code: 'arrival_mismatch',
      detail: `predicted ${(prediction.worstExposure * 100).toFixed(0)}%, measured ${(worstExposure * 100).toFixed(0)}%`,
    });
  } else {
    notes.push(`Measured worst exposure ${(worstExposure * 100).toFixed(0)}% matches the prediction within one body probe.`);
  }
  notes.push(`Nearest obstacle at arrival: ${nearest}, clearance ${clearanceMargin.toFixed(2)} m; stance-change room ${bestTransition.toFixed(2)} m.`);

  if (prediction.clearanceMargin !== undefined && Math.abs(clearanceMargin - prediction.clearanceMargin) > 0.15) {
    notes.push(
      `Clearance measured ${clearanceMargin.toFixed(2)} m vs predicted ${prediction.clearanceMargin.toFixed(2)} m (the prediction referenced a different nearest obstacle).`,
    );
  }
  if (prediction.transitionMargin !== undefined && Math.abs(bestTransition - prediction.transitionMargin) > 0.15) {
    failures.push({
      code: 'geometry_mismatch',
      detail: `stance-change room predicted ${prediction.transitionMargin.toFixed(2)} m, measured ${bestTransition.toFixed(2)} m at the cover face`,
    });
  }
  if (cover) notes.push(`Arrival is pressed against ${cover.obstacle.id}; its face is treated as the cover, not an obstruction.`);
  else notes.push('Arrival is not beside any cover obstacle.');

  return {
    ok: failures.length === 0,
    failures,
    measured,
    predictedWorstExposure: prediction.worstExposure,
    predictedVisibility: prediction.visibility,
    predictedClearance: prediction.clearanceMargin ?? clearanceMargin,
    predictedTransition: prediction.transitionMargin ?? bestTransition,
    coverObstacleId: cover?.obstacle.id ?? null,
    matchesPrediction,
    notes,
  };
}
