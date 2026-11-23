import type {
  AgentSpec,
  Candidate,
  ClueExposure,
  ClueSource,
  Face,
  Obstacle,
  SceneGeometry,
  Stance,
  StanceEvaluation,
  ThreatClue,
  Vec2,
} from './types';
import {
  EPS,
  STAND_STANCE_HEIGHT,
  CROUCH_STANCE_HEIGHT,
  bearingDeg,
  bodyOverlap,
  compassName,
  dist,
  faceName,
  faceNormal,
  inBoard,
  pointInRect,
  rectBoundaryDistance,
  rectCorners,
  segmentRectEntry,
  sub,
  round,
} from './geometry';

export const STANCE_HEIGHT: Record<Stance, number> = {
  stand: STAND_STANCE_HEIGHT,
  crouch: CROUCH_STANCE_HEIGHT,
};

/** Eye height used for sightline sampling in this simplified model. */
export const STANCE_EYE: Record<Stance, number> = {
  stand: 1.62,
  crouch: 0.92,
};

/** Body-height samples used to decide how much of a target is visible. */
export const BODY_PROBES = [0.15, 0.45, 0.75, 1.05, 1.4, 1.75];

export const NEAR_CLIP = 0.3;
export const TRANSITION_DEPTH = 0.9;
export const TRANSITION_HALF_WIDTH = 0.55;
export const PROBE_DIRECTIONS = 16;
export const PROBE_DISTANCE = 7;
export const CLUE_SAMPLES = 3;
export const FACE_MARGIN = 0.02;

interface PointClearance {
  d: number;
  id: string | null;
}

function nearestClearance(scene: SceneGeometry, p: Vec2, ignoreId: string): PointClearance {
  let d = Math.min(p.x, p.y, scene.board.w - p.x, scene.board.h - p.y);
  let id: string | null = null;
  for (const o of scene.obstacles) {
    if (o.id === ignoreId) continue;
    const d0 = rectBoundaryDistance(p, o);
    if (d0 < d) {
      d = d0;
      id = o.id;
    }
  }
  return { d, id };
}

/** A body disc may not overlap a cover obstacle that is itself useful as cover. */
export function bodyOverlapObstacles(scene: SceneGeometry, p: Vec2, r: number): Obstacle[] {
  return bodyOverlap(scene, p, r);
}

/**
 * Space the character needs to stand up / crouch down away from the cover
 * face. Samples the lateral sweep across [±halfWidth] and the depth the body
 * disc occupies during the transition.
 */
export function transitionClearance(
  scene: SceneGeometry,
  obstacle: Obstacle,
  pos: Vec2,
  normal: Vec2,
  radius: number,
): PointClearance & { blocker: string | null } {
  let worst = Infinity;
  let blocker: string | null = null;
  const tangent = { x: -normal.y, y: normal.x };
  for (const off of [-TRANSITION_HALF_WIDTH, 0, TRANSITION_HALF_WIDTH]) {
    for (const dep of [0, TRANSITION_DEPTH]) {
      const p = {
        x: pos.x + tangent.x * off + normal.x * Math.max(0, dep - radius),
        y: pos.y + tangent.y * off + normal.y * Math.max(0, dep - radius),
      };
      const edge = Math.min(p.x, p.y, scene.board.w - p.x, scene.board.h - p.y);
      if (!inBoard(scene.board, p, 0)) {
        if (edge < worst) {
          worst = edge;
          blocker = 'board edge';
        }
      }
      for (const o of scene.obstacles) {
        if (o.id !== obstacle.id && pointInRect(p, o)) {
          worst = -Infinity;
          blocker = o.id;
        }
      }
      if (pointInRect(p, obstacle)) {
        // The cover face itself is allowed; only the space beyond the face matters.
        continue;
      }
      for (const o of scene.obstacles) {
        if (o.id === obstacle.id) continue;
        const d = rectBoundaryDistance(p, o) - radius;
        if (d < worst) {
          worst = d;
          blocker = o.id;
        }
      }
      if (edge < worst) {
        worst = edge;
        blocker = 'board edge';
      }
    }
  }
  return { d: worst, id: blocker, blocker };
}

export function generateCandidates(scene: SceneGeometry, agent: AgentSpec): Candidate[] {
  const out: Candidate[] = [];
  const r = agent.radius;
  for (const o of scene.obstacles) {
    if (!o.cover) continue;
    if (o.height + EPS < CROUCH_STANCE_HEIGHT) continue;
    const c = rectCorners(o);
    const faces: { face: Face; a: Vec2; b: Vec2; normal: Vec2 }[] = [
      { face: 'n', a: c[0], b: c[1], normal: { x: 0, y: -1 } },
      { face: 'e', a: c[1], b: c[2], normal: { x: 1, y: 0 } },
      { face: 's', a: c[2], b: c[3], normal: { x: 0, y: 1 } },
      { face: 'w', a: c[3], b: c[0], normal: { x: -1, y: 0 } },
    ];
    for (const f of faces) {
      const faceLen = dist(f.a, f.b);
      if (faceLen < 2 * r) continue;
      const tang = { x: (f.b.x - f.a.x) / faceLen, y: (f.b.y - f.a.y) / faceLen };
      const usable = faceLen - 2 * r;
      const count = Math.max(1, Math.floor(usable / 0.75) + 1);
      for (let i = 0; i < count; i++) {
        const s = count === 1 ? faceLen / 2 : r + (usable * i) / (count - 1);
        const base = { x: f.a.x + tang.x * s, y: f.a.y + tang.y * s };
        const pos = {
          x: base.x + f.normal.x * (r + FACE_MARGIN),
          y: base.y + f.normal.y * (r + FACE_MARGIN),
        };
        const clear = nearestClearance(scene, pos, o.id);
        const trans = transitionClearance(scene, o, pos, f.normal, r);
        const overlaps = bodyOverlap(scene, pos, r);
        out.push({
          id: `${o.id}/${f.face}/${i}`,
          obstacleId: o.id,
          face: f.face,
          pos,
          normal: f.normal,
          clearanceMargin: clear.d - r,
          transitionMargin: trans.d,
          nearestObstacleId: clear.id,
          geometry: {
            inBounds: inBoard(scene.board, pos, 0),
            bodyClear: overlaps.length === 0,
            transitionClear: trans.d >= 0,
          },
        });
      }
    }
  }
  return out;
}

export function candidateProblem(candidate: Candidate): string | null {
  if (!candidate.geometry.inBounds) return 'position leaves the board';
  if (!candidate.geometry.bodyClear) return 'body overlaps an obstacle or board edge';
  if (!candidate.geometry.transitionClear) return 'not enough room to stand up or crouch down';
  if (candidate.clearanceMargin < 0.02) return 'body clearance is below 0.02 m';
  return null;
}

export function clueWeight(clue: ThreatClue): number {
  const recency = 1 / (1 + Math.max(0, clue.ageSec) / 20);
  return Math.max(0.02, Math.min(1, clue.confidence)) * recency;
}

export function uncertaintySamples(clue: ThreatClue): Vec2[] {
  if (clue.uncertainty <= 1e-6) return [clue.pos];
  const out: Vec2[] = [clue.pos];
  for (let i = 0; i < CLUE_SAMPLES; i++) {
    const a = (i / CLUE_SAMPLES) * Math.PI * 2 + Math.PI / CLUE_SAMPLES;
    out.push({
      x: clue.pos.x + Math.cos(a) * clue.uncertainty,
      y: clue.pos.y + Math.sin(a) * clue.uncertainty,
    });
  }
  return out;
}

/**
 * Height-aware sightline: the ray starts at the observer's eye and ends at a
 * body probe height on the target. An obstacle blocks only when the ray passes
 * into the obstacle below the obstacle's top height. This is what makes a
 * 1.1 m half-wall hide a crouched observer but not a standing one, and what
 * prevents a purely 2-D "wall along the line" shortcut.
 */
export function rayVisible(
  scene: SceneGeometry,
  from: Vec2,
  fromHeight: number,
  to: Vec2,
  toHeight: number,
  ignoreIds: string[] = [],
): { visible: boolean; blockers: string[]; firstT: number | null } {
  const blockers: string[] = [];
  let firstT: number | null = null;
  for (const o of scene.obstacles) {
    if (!o.cover) continue;
    if (ignoreIds.includes(o.id)) continue;
    const top = o.height;
    if (top <= EPS) continue;
    const t = segmentRectEntry(from, to, o);
    if (t === null) continue;
    const z = fromHeight + (toHeight - fromHeight) * t;
    if (z < top - EPS) {
      blockers.push(o.id);
      if (firstT === null || t < firstT) firstT = t;
    }
  }
  return { visible: blockers.length === 0, blockers, firstT };
}

export function exposureAt(
  scene: SceneGeometry,
  pos: Vec2,
  stance: Stance,
  target: Vec2,
): { exposure: number; perHeight: { height: number; visible: boolean; blockers: string[] }[]; blockers: string[] } {
  const eye = STANCE_EYE[stance];
  const perHeight: { height: number; visible: boolean; blockers: string[] }[] = [];
  const blockerSet = new Set<string>();
  let visibleCount = 0;
  for (const h of BODY_PROBES) {
    const r = rayVisible(scene, pos, eye, target, h);
    perHeight.push({ height: h, visible: r.visible, blockers: r.blockers });
    if (r.visible) visibleCount++;
    for (const b of r.blockers) blockerSet.add(b);
  }
  return {
    exposure: visibleCount / BODY_PROBES.length,
    perHeight,
    blockers: [...blockerSet].sort(),
  };
}

export function evaluateClueExposure(
  scene: SceneGeometry,
  pos: Vec2,
  stance: Stance,
  clue: ThreatClue,
): ClueExposure {
  const nominal = exposureAt(scene, pos, stance, clue.pos);
  const samples = uncertaintySamples(clue);
  let worst = nominal.exposure;
  let worstTarget = clue.pos;
  const samplePositions: Vec2[] = [];
  const blockerSet = new Set(nominal.blockers);
  for (const s of samples) {
    // Sample the target position itself AND the observer's line from a target
    // displaced around the nominal point, so a line of sight that grazes cover
    // at the exact clue but opens up nearby is reported as the worst case.
    const targets: Vec2[] = [s, { x: pos.x + (s.x - pos.x), y: pos.y + (s.y - pos.y) }];
    for (const t of targets) {
      const r = exposureAt(scene, pos, stance, t);
      for (const b of r.blockers) blockerSet.add(b);
      if (r.exposure > worst + 1e-9) {
        worst = r.exposure;
        worstTarget = s;
      }
    }
    samplePositions.push(s);
  }
  // Near clip: if the target is basically on top of the observer, report full exposure.
  if (dist(pos, clue.pos) < NEAR_CLIP) {
    return {
      clueId: clue.id,
      bearingDeg: round(bearingDeg(pos, clue.pos), 1),
      distance: round(dist(pos, clue.pos), 2),
      exposure: 1,
      worstExposure: 1,
      blockedFraction: 0,
      observable: true,
      perHeight: BODY_PROBES.map((h) => ({ height: h, visible: true, blockers: [] })),
      samples,
      blockers: [],
      samplePositions,
      worstTarget,
    };
  }
  return {
    clueId: clue.id,
    bearingDeg: round(bearingDeg(pos, clue.pos), 1),
    distance: round(dist(pos, clue.pos), 2),
    exposure: round(nominal.exposure, 4),
    worstExposure: round(Math.max(worst, nominal.exposure), 4),
    blockedFraction: round(1 - nominal.exposure, 4),
    observable: nominal.exposure >= 0.2,
    perHeight: nominal.perHeight,
    samples,
    blockers: [...blockerSet],
    samplePositions,
    worstTarget,
  };
}

export function probeOpenDirections(
  scene: SceneGeometry,
  pos: Vec2,
  stance: Stance,
  distance = PROBE_DISTANCE,
): { open: boolean[]; rayTargets: Vec2[] } {
  const eye = STANCE_EYE[stance];
  const open: boolean[] = [];
  const rayTargets: Vec2[] = [];
  for (let i = 0; i < PROBE_DIRECTIONS; i++) {
    const a = (i / PROBE_DIRECTIONS) * Math.PI * 2;
    const target = { x: pos.x + Math.cos(a) * distance, y: pos.y + Math.sin(a) * distance };
    rayTargets.push(target);
    // Probe the direction at eye height; visible means this direction can be watched.
    const r = rayVisible(scene, pos, eye, target, eye);
    open.push(r.visible);
  }
  return { open, rayTargets };
}

export function evaluateStance(
  scene: SceneGeometry,
  pos: Vec2,
  stance: Stance,
  clues: ThreatClue[],
): StanceEvaluation {
  const perClue = clues.map((c) => evaluateClueExposure(scene, pos, stance, c));
  const totalClueWeight = clues.reduce((s, c) => s + clueWeight(c), 0);
  let worst = 0;
  let uncertaintyWorst = 0;
  let visNum = 0;
  for (let i = 0; i < clues.length; i++) {
    const w = clueWeight(clues[i]);
    worst = Math.max(worst, perClue[i].exposure);
    uncertaintyWorst = Math.max(uncertaintyWorst, perClue[i].worstExposure);
    visNum += perClue[i].exposure * w;
  }
  const probe = probeOpenDirections(scene, pos, stance);
  const openCount = probe.open.filter(Boolean).length;
  return {
    stance,
    perClue,
    worstExposure: round(worst, 4),
    uncertaintyWorstExposure: round(uncertaintyWorst, 4),
    meanExposure: round(totalClueWeight > 0 ? visNum / totalClueWeight : 0, 4),
    visibilityWeight: round(totalClueWeight > 0 ? visNum / totalClueWeight : 0, 4),
    totalClueWeight: round(totalClueWeight, 4),
    openDirections: probe.open,
    openDirectionCount: openCount,
    openDirectionFraction: round(openCount / PROBE_DIRECTIONS, 4),
    probeDistance: PROBE_DISTANCE,
    eyeHeight: STANCE_EYE[stance],
  };
}

export function describeClueSource(s: ClueSource): string {
  switch (s) {
    case 'sighting':
      return 'seen';
    case 'sound':
      return 'heard';
    case 'lastKnown':
      return 'last known';
  }
}

export function describeCover(obstacle: Obstacle): string {
  const h = obstacle.height.toFixed(2);
  if (obstacle.height < CROUCH_STANCE_HEIGHT) return `low (${h} m): too low to hide a body`;
  if (obstacle.height < STAND_STANCE_HEIGHT) return `crouch-height (${h} m): hides a crouched body`;
  return `full-height (${h} m): hides a standing body`;
}

/**
 * Find the cover face a body at p is pressed against, if any, and return its
 * outward normal. Used by the arrival measurement so it measures the same
 * clearance model selection predicted (the adjacent cover face is the thing you
 * hide behind, not an obstruction).
 */
export function adjacentCover(
  scene: SceneGeometry,
  p: Vec2,
  radius: number,
): { obstacle: Obstacle; normal: Vec2 } | null {
  let best: { obstacle: Obstacle; d: number } | null = null;
  for (const o of scene.obstacles) {
    if (!o.cover) continue;
    const d = rectBoundaryDistance(p, o);
    if (d <= radius + 0.12 && (!best || d < best.d)) best = { obstacle: o, d };
  }
  if (!best) return null;
  const c = { x: best.obstacle.x + best.obstacle.w / 2, y: best.obstacle.y + best.obstacle.d / 2 };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const normal = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 0, y: 0 } : { x: 0, y: Math.sign(dy) || 0 };
  return { obstacle: best.obstacle, normal };
}

export function compassFromNormal(normal: Vec2): string {
  return compassName(sub({ x: 0, y: 0 }, normal));
}

export { faceName, faceNormal };
