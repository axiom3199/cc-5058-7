import type { Obstacle, SceneGeometry, Vec2 } from './types';

export const EPS = 1e-9;
export const MIN_STAND_HEIGHT = 1.7;
export const STAND_STANCE_HEIGHT = 1.8;
export const CROUCH_STANCE_HEIGHT = 1.0;

export function v(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  if (l < EPS) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

export function obstacleCenter(o: Obstacle): Vec2 {
  return { x: o.x + o.w / 2, y: o.y + o.d / 2 };
}

export function obstacleMaxExtent(o: Obstacle): number {
  return Math.max(o.w, o.d);
}

/** Distance from p to the rectangle (0 when inside). */
export function rectDistance(p: Vec2, o: Obstacle): number {
  const dx = Math.max(o.x - p.x, 0, p.x - (o.x + o.w));
  const dy = Math.max(o.y - p.y, 0, p.y - (o.y + o.d));
  return Math.hypot(dx, dy);
}

export function pointInRect(p: Vec2, o: Obstacle, inset = 0): boolean {
  return (
    p.x > o.x + inset &&
    p.x < o.x + o.w - inset &&
    p.y > o.y + inset &&
    p.y < o.y + o.d - inset
  );
}

export function segmentHitRect(a: Vec2, b: Vec2, o: Obstacle): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let tmin = 0;
  let tmax = 1;
  const axes: { p: number; d: number; min: number; max: number }[] = [
    { p: a.x, d: dx, min: o.x, max: o.x + o.w },
    { p: a.y, d: dy, min: o.y, max: o.y + o.d },
  ];
  for (const ax of axes) {
    if (Math.abs(ax.d) < EPS) {
      if (ax.p <= ax.min || ax.p >= ax.max) return false;
    } else {
      let t1 = (ax.min - ax.p) / ax.d;
      let t2 = (ax.max - ax.p) / ax.d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin >= tmax) return false;
    }
  }
  return tmax > EPS && tmin < 1 - EPS;
}

/** Ray/segment parameter of the first entry into the rectangle, if any. */
export function segmentRectEntry(a: Vec2, b: Vec2, o: Obstacle): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let tmin = 0;
  const tmaxInit = 1;
  let tmax = tmaxInit;
  const axes: { p: number; d: number; min: number; max: number }[] = [
    { p: a.x, d: dx, min: o.x, max: o.x + o.w },
    { p: a.y, d: dy, min: o.y, max: o.y + o.d },
  ];
  for (const ax of axes) {
    if (Math.abs(ax.d) < EPS) {
      if (ax.p <= ax.min || ax.p >= ax.max) return null;
    } else {
      let t1 = (ax.min - ax.p) / ax.d;
      let t2 = (ax.max - ax.p) / ax.d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0 || tmin > 1) return null;
  return tmin;
}

export function rectCorners(o: Obstacle): Vec2[] {
  return [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.d },
    { x: o.x, y: o.y + o.d },
  ];
}

/** Distance from p to a rectangle's boundary (0 if inside). */
export function rectBoundaryDistance(p: Vec2, o: Obstacle): number {
  const dx = Math.max(o.x - p.x, 0, p.x - (o.x + o.w));
  const dy = Math.max(o.y - p.y, 0, p.y - (o.y + o.d));
  return Math.hypot(dx, dy);
}

/** Point-to-segment distance. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), EPS), 0, 1);
  return dist(p, add(a, scale(ab, t)));
}

/** Minimum distance between segment AB and segment CD. */
export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = cross(sub(b, a), sub(c, a));
  const o2 = cross(sub(b, a), sub(d, a));
  const o3 = cross(sub(d, c), sub(a, c));
  const o4 = cross(sub(d, c), sub(b, c));
  const s = (x: number) => (Math.abs(x) < EPS ? 0 : Math.sign(x));
  return s(o1) * s(o2) < 0 && s(o3) * s(o4) < 0;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function faceNormal(face: 'n' | 'e' | 's' | 'w'): Vec2 {
  switch (face) {
    case 'n':
      return { x: 0, y: -1 };
    case 'e':
      return { x: 1, y: 0 };
    case 's':
      return { x: 0, y: 1 };
    case 'w':
      return { x: -1, y: 0 };
  }
}

export function faceName(face: 'n' | 'e' | 's' | 'w'): string {
  switch (face) {
    case 'n':
      return 'north';
    case 'e':
      return 'east';
    case 's':
      return 'south';
    case 'w':
      return 'west';
  }
}

export function compassName(d: Vec2): string {
  const ang = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const idx = Math.round(((ang + 360) % 360) / 45) % 8;
  return dirs[idx];
}

export function bearingDeg(from: Vec2, to: Vec2): number {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** True when sight line from eye at a to b is clear of all cover-relevant obstacles taller than h. */
export function sightlineBlocked(
  scene: SceneGeometry,
  a: Vec2,
  b: Vec2,
  height: number,
  ignoreObstacleIds: string[] = [],
): { blocked: boolean; blockers: string[]; firstT: number | null } {
  const blockers: string[] = [];
  let firstT: number | null = null;
  for (const o of scene.obstacles) {
    if (!o.cover) continue;
    if (ignoreObstacleIds.includes(o.id)) continue;
    if (o.height + EPS < height) continue;
    const t = segmentRectEntry(a, b, o);
    if (t !== null) {
      blockers.push(o.id);
      if (firstT === null || t < firstT) firstT = t;
    }
  }
  return { blocked: blockers.length > 0, blockers, firstT };
}

/** Is point p inside any solid obstacle for a body of radius r? */
export function bodyOverlap(scene: SceneGeometry, p: Vec2, r: number): Obstacle[] {
  return scene.obstacles.filter((o) => pointInRect(p, o) || rectDistance(p, o) < r - 0.001);
}

export function inBoard(board: { w: number; h: number }, p: Vec2, r: number): boolean {
  return p.x >= r && p.y >= r && p.x <= board.w - r && p.y <= board.h - r;
}

export function cellKey(p: Vec2, cellSize = 1.0): string {
  return `${Math.floor(p.x / cellSize)}:${Math.floor(p.y / cellSize)}`;
}

export function keyForCell(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

export function clampToBoard(board: { w: number; h: number }, p: Vec2, r: number): Vec2 {
  return { x: clamp(p.x, r, board.w - r), y: clamp(p.y, r, board.h - r) };
}
