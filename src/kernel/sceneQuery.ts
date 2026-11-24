import type { Obstacle, SceneGeometry, Vec2 } from './types';
import { EPS, dist, segmentRectEntry } from './geometry';

/**
 * Unified scene query interface (spatial query migration, v2).
 *
 * Every sightline / occlusion query in the kernel goes through this module
 * instead of poking rectangle math directly. The interface makes three things
 * explicit at the query boundary:
 *
 *   - layer masks  — a query names the layers it reads (`LAYER_COVER`,
 *     `LAYER_SOLID`); an obstacle answers on the layers its flags allow.
 *   - hit normals  — every hit carries the outward face normal. A ray that
 *     starts inside a solid reports the *exit* face (a back face relative to
 *     the travel direction) with `fromInside` set.
 *   - heights      — every hit carries the obstacle's top height so the read
 *     layer can decide occlusion per body height.
 *
 * The backend endpoint (`SceneQueryBackend.raycast`) has first-hit semantics:
 * for a thin wall it reports only the first intersection along the travel
 * direction. The read layer (`SceneQueries`) therefore reconstructs the
 * occupied segment behind that first hit by firing the opposing ray and
 * merging the two — and, when more than one solid lies along the segment, by
 * walking the surfaces back to the origin. `verifyQueryEquivalence` replays
 * rays through both the legacy segment model and this reconstruction and
 * reports maps where the two contracts disagree.
 */

export const SPATIAL_QUERY_VERSION = 'spatial-query-v2';
/** Backend tag stamped on data written before this migration. */
export const LEGACY_QUERY_VERSION = 'spatial-query-v1';

export const LAYER_COVER = 1 << 0;
export const LAYER_SOLID = 1 << 1;
export const LAYER_ALL = LAYER_COVER | LAYER_SOLID;

export function layerMaskOf(o: Obstacle): number {
  return LAYER_SOLID | (o.cover ? LAYER_COVER : 0);
}

export interface RayHit {
  obstacleId: string;
  /** Distance from the ray origin in metres. */
  distance: number;
  point: Vec2;
  /**
   * Outward normal of the reported face. For `fromInside` hits this is the
   * exit face, so the normal points *along* the travel direction (back face).
   */
  normal: Vec2;
  /** Top height of the hit obstacle in metres. */
  height: number;
  /** True when the ray origin is inside the obstacle. */
  fromInside: boolean;
  /** True when the ray only grazes the obstacle (zero-width intersection). */
  grazing: boolean;
}

export interface SceneQueryBackend {
  /**
   * First intersection of the ray with any obstacle on `layerMask`, or null.
   * Thin walls report only their entry face; nothing behind the first hit is
   * visible to this endpoint.
   */
  raycast(origin: Vec2, dir: Vec2, maxDist: number, layerMask: number): RayHit | null;
}

/** Axis-aligned rectangle backend over the board's obstacle list. */
export class RectQueryBackend implements SceneQueryBackend {
  constructor(private scene: SceneGeometry) {}

  raycast(origin: Vec2, dir: Vec2, maxDist: number, layerMask: number = LAYER_ALL): RayHit | null {
    let best: RayHit | null = null;
    for (const o of this.scene.obstacles) {
      if ((layerMaskOf(o) & layerMask) === 0) continue;
      const hit = rayRectFirstHit(origin, dir, maxDist, o);
      if (!hit) continue;
      // On an exact distance tie (two solids share the face the ray is
      // standing on) prefer the solid that contains the origin: it is the
      // most local truth and keeps surface walks inside the right body.
      const tie = best && Math.abs(hit.distance - best.distance) <= 1e-9;
      if (!best || hit.distance < best.distance - 1e-9 || (tie && hit.fromInside && !best.fromInside)) {
        best = hit;
      }
    }
    return best;
  }
}

/** First-hit ray/AABB test with explicit face normals, distances in metres. */
export function rayRectFirstHit(origin: Vec2, dir: Vec2, maxDist: number, o: Obstacle): RayHit | null {
  const axes = [
    { p: origin.x, d: dir.x, min: o.x, max: o.x + o.w },
    { p: origin.y, d: dir.y, min: o.y, max: o.y + o.d },
  ];
  let tmin = 0;
  let tmax = maxDist;
  let enterAxis = 0;
  let enterSign = 0;
  let exitAxis = 0;
  let exitSign = 0;
  for (let i = 0; i < 2; i++) {
    const ax = axes[i];
    if (Math.abs(ax.d) < EPS) {
      if (ax.p <= ax.min || ax.p >= ax.max) return null;
      continue;
    }
    let t1 = (ax.min - ax.p) / ax.d;
    let t2 = (ax.max - ax.p) / ax.d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 >= tmin) {
      tmin = t1;
      enterAxis = i;
      enterSign = -Math.sign(ax.d);
    }
    if (t2 <= tmax) {
      tmax = t2;
      exitAxis = i;
      exitSign = Math.sign(ax.d);
    }
    if (tmin > tmax) return null;
  }
  const inside =
    origin.x > o.x && origin.x < o.x + o.w && origin.y > o.y && origin.y < o.y + o.d;
  if (inside) {
    // The first surface along the travel direction is the exit face.
    const normal: Vec2 = exitAxis === 0 ? { x: exitSign, y: 0 } : { x: 0, y: exitSign };
    return {
      obstacleId: o.id,
      distance: tmax,
      point: { x: origin.x + dir.x * tmax, y: origin.y + dir.y * tmax },
      normal,
      height: o.height,
      fromInside: true,
      grazing: false,
    };
  }
  // tmax <= 0: the ray only touches the surface at its origin and travels
  // away from the solid — that is not an intersection.
  if (tmax < EPS || tmin > maxDist) return null;
  const normal: Vec2 = enterAxis === 0 ? { x: enterSign, y: 0 } : { x: 0, y: enterSign };
  return {
    obstacleId: o.id,
    distance: tmin,
    point: { x: origin.x + dir.x * tmin, y: origin.y + dir.y * tmin },
    normal,
    height: o.height,
    fromInside: false,
    grazing: tmax - tmin < EPS,
  };
}

export interface OcclusionSpan {
  obstacleId: string;
  /** Fractions along origin→target, 0..1. */
  enterT: number;
  exitT: number;
  enterPoint: Vec2;
  exitPoint: Vec2;
  /** Outward face normals at entry and at exit (exit is a back face). */
  enterNormal: Vec2;
  exitNormal: Vec2;
  /** Top height of the occupying obstacle in metres. */
  height: number;
}

export interface OcclusionSegments {
  spans: OcclusionSpan[];
  /**
   * False when the surface walk could not pair every exit face with an entry
   * face of the same obstacle (overlapping or zero-gap-nested solids). Such
   * rays are exactly what `verifyQueryEquivalence` reports.
   */
  pairingsExact: boolean;
  /** True when the two-cast opposing-ray merge covered the whole segment. */
  mergedApplicable: boolean;
}

/** Step used to move a query origin off a just-reported face. */
const SURFACE_NUDGE = 1e-4;

/**
 * Read layer over the first-hit backend. Reconstructs occupied segments along
 * the ray's travel direction from bidirectional queries.
 */
export class SceneQueries {
  constructor(private backend: SceneQueryBackend) {}

  static over(scene: SceneGeometry): SceneQueries {
    return new SceneQueries(new RectQueryBackend(scene));
  }

  raycast(origin: Vec2, dir: Vec2, maxDist: number, layerMask: number = LAYER_ALL): RayHit | null {
    return this.backend.raycast(origin, dir, maxDist, layerMask);
  }

  /**
   * The cheap merge: one cast each way. Applicable only when both ends name
   * the same obstacle (or no obstacle at all) — that is the full scope in
   * which two opposing rays may be merged into one occupied segment.
   * Returns null when the segment is composite and the merge does not apply.
   */
  mergedSpan(origin: Vec2, target: Vec2, layerMask: number = LAYER_COVER): OcclusionSpan | null {
    const L = dist(origin, target);
    if (L < EPS) return null;
    const dir = { x: (target.x - origin.x) / L, y: (target.y - origin.y) / L };
    const fwd = this.backend.raycast(origin, dir, L, layerMask);
    if (!fwd) return null;
    const bwd = this.backend.raycast(target, { x: -dir.x, y: -dir.y }, L, layerMask);
    if (!bwd || bwd.obstacleId !== fwd.obstacleId) return null;
    return this.spanFromHits(origin, dir, L, fwd, bwd);
  }

  /**
   * All occupied segments along origin→target on `layerMask`, in travel
   * order. Reconstructed by the opposing-ray merge when it applies, otherwise
   * by walking the surfaces from the target back to the origin.
   */
  occlusionSpans(origin: Vec2, target: Vec2, layerMask: number = LAYER_COVER): OcclusionSegments {
    const L = dist(origin, target);
    if (L < EPS) return { spans: [], pairingsExact: true, mergedApplicable: true };
    const dir = { x: (target.x - origin.x) / L, y: (target.y - origin.y) / L };
    const fwd = this.backend.raycast(origin, dir, L, layerMask);
    if (!fwd) return { spans: [], pairingsExact: true, mergedApplicable: true };
    const bwd = this.backend.raycast(target, { x: -dir.x, y: -dir.y }, L, layerMask);
    if (bwd && bwd.obstacleId === fwd.obstacleId) {
      return {
        spans: [this.spanFromHits(origin, dir, L, fwd, bwd)],
        pairingsExact: true,
        mergedApplicable: true,
      };
    }
    return this.surfaceWalk(origin, dir, L, layerMask);
  }

  private spanFromHits(origin: Vec2, dir: Vec2, L: number, enter: RayHit, exit: RayHit): OcclusionSpan {
    const enterDist = enter.fromInside ? 0 : enter.distance;
    const exitDist = exit.fromInside ? L : L - exit.distance;
    return {
      obstacleId: enter.obstacleId,
      enterT: enterDist / L,
      exitT: exitDist / L,
      enterPoint: { x: origin.x + dir.x * enterDist, y: origin.y + dir.y * enterDist },
      exitPoint: { x: origin.x + dir.x * exitDist, y: origin.y + dir.y * exitDist },
      enterNormal: enter.normal,
      exitNormal: exit.normal,
      height: enter.height,
    };
  }

  /**
   * General reconstruction for composite segments. The forward cast cannot
   * step past the first hit (first-hit semantics), so the walk collects
   * surfaces from the far end: each backward cast finds the next exit face,
   * then a nudge inside the solid finds its matching entry face.
   *
   * Two read-layer repairs make the raw surface list pairable:
   *   - grazing contacts (zero-width intersections) become degenerate spans
   *     directly instead of entering the pairing;
   *   - where two solids share a face, the backend reports only one of the
   *     two coincident surfaces, so a run of two entry faces in a row means
   *     the second solid's exit face coincides with the first entry face and
   *     is synthesised there.
   */
  private surfaceWalk(origin: Vec2, dir: Vec2, L: number, layerMask: number): OcclusionSegments {
    const back = { x: -dir.x, y: -dir.y };
    const surfaces: { id: string; t: number; hit: RayHit }[] = [];
    const spans: OcclusionSpan[] = [];
    let exact = true;
    const pushSpan = (id: string, enterDist: number, exitDist: number, enterHit: RayHit, exitHit: RayHit) => {
      const eDist = Math.max(0, enterDist);
      spans.push({
        obstacleId: id,
        enterT: eDist / L,
        exitT: exitDist / L,
        enterPoint: { x: origin.x + dir.x * eDist, y: origin.y + dir.y * eDist },
        exitPoint: { x: origin.x + dir.x * exitDist, y: origin.y + dir.y * exitDist },
        enterNormal: enterHit.normal,
        exitNormal: exitHit.normal,
        height: exitHit.height,
      });
    };
    let cursorT = L;
    let guard = 0;
    while (cursorT > SURFACE_NUDGE && guard++ < 256) {
      const cursor = { x: origin.x + dir.x * cursorT, y: origin.y + dir.y * cursorT };
      const hit = this.backend.raycast(cursor, back, cursorT, layerMask);
      if (!hit) break;
      const t = cursorT - hit.distance;
      if (hit.grazing) {
        // Tangent contact: a zero-width occupied point, not a pairable face.
        pushSpan(hit.obstacleId, t, t, hit, hit);
      } else {
        surfaces.push({ id: hit.obstacleId, t, hit });
      }
      cursorT = t - SURFACE_NUDGE;
    }
    // Target inside a solid: the first surface found is its entry face, so
    // synthesise the exit face at the target itself.
    if (surfaces.length > 0 && surfaces[0].hit.fromInside) {
      surfaces.unshift({ id: surfaces[0].id, t: L, hit: { ...surfaces[0].hit, fromInside: false } });
    }
    // Shared faces: the walk records one surface per cast, so where solid B
    // touches solid A the face they share is reported once (as A's entry
    // face). Two recorded entry faces in a row therefore mean B's exit face
    // coincides with the first entry face — synthesise it there. B's exit
    // normal is A's entry normal mirrored across the shared plane.
    const paired: { id: string; t: number; hit: RayHit }[] = [];
    for (const s of surfaces) {
      const prev = paired[paired.length - 1];
      if (prev && prev.hit.fromInside && s.hit.fromInside && prev.id !== s.id) {
        paired.push({
          id: s.id,
          t: prev.t,
          hit: { ...s.hit, normal: { x: -s.hit.normal.x, y: -s.hit.normal.y }, fromInside: false },
        });
      }
      paired.push(s);
    }
    let i = 0;
    while (i < paired.length) {
      const far = paired[i];
      const near = paired[i + 1];
      if (near && near.id === far.id) {
        pushSpan(far.id, near.t, far.t, near.hit, far.hit);
        i += 2;
      } else if (!near && !far.hit.fromInside) {
        // Unpaired exit face at the end of the walk: the origin is inside
        // (or within a nudge of) this obstacle, so the occupied segment runs
        // back to the origin.
        pushSpan(far.id, 0, far.t, far.hit, far.hit);
        i += 1;
      } else {
        // Surfaces of two different solids interleave along the ray: the
        // geometry overlaps or nests, so per-obstacle attribution is ambiguous.
        const next = near ?? far;
        pushSpan(far.id, Math.max(0, next.t), far.t, next.hit, far.hit);
        exact = false;
        i += 1;
      }
    }
    spans.sort((a, b) => a.enterT - b.enterT);
    return { spans, pairingsExact: exact, mergedApplicable: false };
  }
}

export function sceneQueries(scene: SceneGeometry): SceneQueries {
  return SceneQueries.over(scene);
}

// ---------------------------------------------------------------------------
// Contract check: legacy segment model vs the migrated reconstruction.
// ---------------------------------------------------------------------------

export interface RaySpec {
  origin: Vec2;
  target: Vec2;
  fromHeight: number;
  toHeight: number;
  label?: string;
}

export interface QueryDiscrepancy {
  ray: RaySpec;
  kind: 'blocker-set' | 'pairing';
  legacyBlockers: string[];
  currentBlockers: string[];
  detail: string;
}

export interface QueryEquivalenceReport {
  label: string;
  queryBackend: string;
  checked: number;
  discrepancies: QueryDiscrepancy[];
  /** Rays whose surfaces could not be paired exactly (subset of discrepancies by kind 'pairing'). */
  inexactPairings: number;
  /** Rays where the two-cast opposing-ray merge applied. */
  mergedApplicable: number;
  /** Rays crossing at least one obstacle on the cover layer. */
  occluded: number;
}

/** Legacy occlusion model, kept verbatim as the migration reference. */
export function legacyRayBlockers(
  scene: SceneGeometry,
  from: Vec2,
  fromHeight: number,
  to: Vec2,
  toHeight: number,
): string[] {
  const blockers: string[] = [];
  for (const o of scene.obstacles) {
    if (!o.cover) continue;
    const top = o.height;
    if (top <= EPS) continue;
    const t = segmentRectEntry(from, to, o);
    if (t === null) continue;
    const z = fromHeight + (toHeight - fromHeight) * t;
    if (z < top - EPS) blockers.push(o.id);
  }
  return blockers.sort();
}

/** Migrated occlusion model: blockers of the reconstructed occupied segments. */
export function currentRayBlockers(
  scene: SceneGeometry,
  from: Vec2,
  fromHeight: number,
  to: Vec2,
  toHeight: number,
): { blockers: string[]; segments: OcclusionSegments } {
  const segments = sceneQueries(scene).occlusionSpans(from, to, LAYER_COVER);
  const blockers: string[] = [];
  for (const s of segments.spans) {
    const zEnter = fromHeight + (toHeight - fromHeight) * s.enterT;
    const zExit = fromHeight + (toHeight - fromHeight) * s.exitT;
    if (Math.min(zEnter, zExit) < s.height - EPS) blockers.push(s.obstacleId);
  }
  return { blockers: blockers.sort(), segments };
}

export function compareRayModels(scene: SceneGeometry, ray: RaySpec): QueryDiscrepancy | null {
  const legacy = legacyRayBlockers(scene, ray.origin, ray.fromHeight, ray.target, ray.toHeight);
  const current = currentRayBlockers(scene, ray.origin, ray.fromHeight, ray.target, ray.toHeight);
  if (!current.segments.pairingsExact) {
    return {
      ray,
      kind: 'pairing',
      legacyBlockers: legacy,
      currentBlockers: current.blockers,
      detail: 'exit/entry faces could not be paired one-to-one; the map has overlapping or nested solids along this ray',
    };
  }
  if (legacy.join('|') !== current.blockers.join('|')) {
    return {
      ray,
      kind: 'blocker-set',
      legacyBlockers: legacy,
      currentBlockers: current.blockers,
      detail: `legacy model sees [${legacy.join(', ') || 'none'}], migrated model sees [${current.blockers.join(', ') || 'none'}]`,
    };
  }
  return null;
}

const SWEEP_HEIGHTS: { from: number; to: number }[] = [
  { from: 1.62, to: 0.15 },
  { from: 1.62, to: 0.75 },
  { from: 1.62, to: 1.4 },
  { from: 1.62, to: 1.75 },
  { from: 0.92, to: 0.15 },
  { from: 0.92, to: 0.75 },
];

/**
 * Replay a battery of rays through both query contracts and report every
 * disagreement. The battery is whatever caller-supplied rays (e.g. the exact
 * candidate×clue rays a selection evaluated) plus, unless `sweep` is false, a
 * deterministic board sweep — so a non-equivalent map is caught by data, not
 * by inspection.
 */
export function verifyQueryEquivalence(
  scene: SceneGeometry,
  label: string,
  extraRays: RaySpec[] = [],
  opts: { sweep?: boolean } = {},
): QueryEquivalenceReport {
  const rays: RaySpec[] = [...extraRays];
  if (opts.sweep !== false) {
    const cols = 6;
    const rows = 5;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const origin = {
          x: ((gx + 0.5) / cols) * scene.board.w,
          y: ((gy + 0.5) / rows) * scene.board.h,
        };
        for (let d = 0; d < 8; d++) {
          const a = (d / 8) * Math.PI * 2;
          for (const len of [4, 9]) {
            for (const h of SWEEP_HEIGHTS) {
              rays.push({
                origin,
                target: { x: origin.x + Math.cos(a) * len, y: origin.y + Math.sin(a) * len },
                fromHeight: h.from,
                toHeight: h.to,
                label: `sweep(${gx},${gy},${d},${len})`,
              });
            }
          }
        }
      }
    }
  }
  const discrepancies: QueryDiscrepancy[] = [];
  let inexactPairings = 0;
  let mergedApplicable = 0;
  let occluded = 0;
  for (const ray of rays) {
    const current = currentRayBlockers(scene, ray.origin, ray.fromHeight, ray.target, ray.toHeight);
    if (current.segments.spans.length > 0) occluded++;
    if (current.segments.mergedApplicable && current.segments.spans.length > 0) mergedApplicable++;
    if (!current.segments.pairingsExact) inexactPairings++;
    const legacy = legacyRayBlockers(scene, ray.origin, ray.fromHeight, ray.target, ray.toHeight);
    if (!current.segments.pairingsExact) {
      discrepancies.push({
        ray,
        kind: 'pairing',
        legacyBlockers: legacy,
        currentBlockers: current.blockers,
        detail: 'exit/entry faces could not be paired one-to-one along this ray',
      });
    } else if (legacy.join('|') !== current.blockers.join('|')) {
      discrepancies.push({
        ray,
        kind: 'blocker-set',
        legacyBlockers: legacy,
        currentBlockers: current.blockers,
        detail: `legacy [${legacy.join(', ') || 'none'}] vs migrated [${current.blockers.join(', ') || 'none'}]`,
      });
    }
  }
  return {
    label,
    queryBackend: SPATIAL_QUERY_VERSION,
    checked: rays.length,
    discrepancies,
    inexactPairings,
    mergedApplicable,
    occluded,
  };
}
