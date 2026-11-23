import type { SceneGeometry, Vec2 } from './types';
import {
  EPS,
  add,
  clamp,
  dist,
  pointInRect,
  rectBoundaryDistance,
  scale,
  sub,
  inBoard,
} from './geometry';

export interface NavGrid {
  cell: number;
  cols: number;
  rows: number;
  radius: number;
  blocked: Uint8Array;
  scene: SceneGeometry;
}

export function buildGrid(scene: SceneGeometry, radius: number, cell = 0.25): NavGrid {
  const cols = Math.max(2, Math.ceil(scene.board.w / cell));
  const rows = Math.max(2, Math.ceil(scene.board.h / cell));
  const blocked = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const p = cellCenter(scene, gx, gy, cell);
      blocked[gy * cols + gx] = isFree(scene, p, radius) ? 0 : 1;
    }
  }
  return { cell, cols, rows, radius, blocked, scene };
}

export function cellCenter(_scene: SceneGeometry, gx: number, gy: number, cell: number): Vec2 {
  return { x: (gx + 0.5) * cell, y: (gy + 0.5) * cell };
}

export function isFree(scene: SceneGeometry, p: Vec2, radius: number): boolean {
  if (!inBoard(scene.board, p, radius)) return false;
  for (const o of scene.obstacles) {
    if (pointInRect(p, o)) return false;
    if (rectBoundaryDistance(p, o) < radius - 1e-6) return false;
  }
  return true;
}

export function worldToGrid(grid: NavGrid, p: Vec2): { gx: number; gy: number } {
  return {
    gx: clamp(Math.floor(p.x / grid.cell), 0, grid.cols - 1),
    gy: clamp(Math.floor(p.y / grid.cell), 0, grid.rows - 1),
  };
}

export function gridToWorld(grid: NavGrid, gx: number, gy: number): Vec2 {
  return cellCenter(grid.scene, gx, gy, grid.cell);
}

function idx(grid: NavGrid, gx: number, gy: number): number {
  return gy * grid.cols + gx;
}

export function navBlocked(grid: NavGrid, gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= grid.cols || gy >= grid.rows) return true;
  return grid.blocked[idx(grid, gx, gy)] === 1;
}

export function nearestFree(
  grid: NavGrid,
  p: Vec2,
  maxRings = 10,
): { gx: number; gy: number; pos: Vec2; snapped: number } | null {
  const { gx, gy } = worldToGrid(grid, p);
  if (!navBlocked(grid, gx, gy)) return { gx, gy, pos: gridToWorld(grid, gx, gy), snapped: 0 };
  for (let r = 1; r <= maxRings; r++) {
    let best: { gx: number; gy: number; pos: Vec2; d: number } | null = null;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = gx + dx;
        const ny = gy + dy;
        if (navBlocked(grid, nx, ny)) continue;
        const pos = gridToWorld(grid, nx, ny);
        const d = dist(pos, p);
        if (!best || d < best.d) best = { gx: nx, gy: ny, pos, d };
      }
    }
    if (best) return { gx: best.gx, gy: best.gy, pos: best.pos, snapped: best.d };
  }
  return null;
}

const DIAG = Math.SQRT2;

export interface PathResult {
  found: boolean;
  cells: { gx: number; gy: number }[];
  points: Vec2[];
  length: number;
  snappedStart: number;
  snappedGoal: number;
}

export function findPath(grid: NavGrid, start: Vec2, goal: Vec2): PathResult {
  const s = nearestFree(grid, start);
  const g = nearestFree(grid, goal);
  if (!s || !g) {
    return { found: false, cells: [], points: [], length: Infinity, snappedStart: Infinity, snappedGoal: Infinity };
  }
  const N = grid.cols * grid.rows;
  const gScore = new Float64Array(N).fill(Infinity);
  const fScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const startI = idx(grid, s.gx, s.gy);
  const goalI = idx(grid, g.gx, g.gy);

  const heuristic = (gx: number, gy: number) => {
    const dx = Math.abs(gx - g.gx);
    const dy = Math.abs(gy - g.gy);
    return (dx + dy) + (DIAG - 2) * Math.min(dx, dy);
  };

  // simple binary heap
  const heap: { i: number; f: number }[] = [];
  const push = (i: number, f: number) => {
    heap.push({ i, f });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].f <= heap[c].f) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): { i: number; f: number } | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };

  gScore[startI] = 0;
  fScore[startI] = heuristic(s.gx, s.gy);
  push(startI, fScore[startI]);

  const deltas = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, DIAG],
    [1, -1, DIAG],
    [-1, 1, DIAG],
    [-1, -1, DIAG],
  ];

  while (heap.length) {
    const cur = pop()!;
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    if (cur.i === goalI) break;
    const cgx = cur.i % grid.cols;
    const cgy = Math.floor(cur.i / grid.cols);
    for (const [dx, dy, cost] of deltas) {
      const nx = cgx + dx;
      const ny = cgy + dy;
      if (navBlocked(grid, nx, ny)) continue;
      if (dx !== 0 && dy !== 0) {
        // no corner cutting through blocked orthogonal neighbours
        if (navBlocked(grid, cgx + dx, cgy) || navBlocked(grid, cgx, cgy + dy)) continue;
      }
      const ni = idx(grid, nx, ny);
      if (closed[ni]) continue;
      const tentative = gScore[cur.i] + cost;
      if (tentative + 1e-9 < gScore[ni]) {
        gScore[ni] = tentative;
        fScore[ni] = tentative + heuristic(nx, ny);
        came[ni] = cur.i;
        push(ni, fScore[ni]);
      }
    }
  }

  if (!closed[goalI] || gScore[goalI] === Infinity) {
    return { found: false, cells: [], points: [], length: Infinity, snappedStart: s.snapped, snappedGoal: g.snapped };
  }

  const cells: { gx: number; gy: number }[] = [];
  let walk = goalI;
  while (walk !== -1) {
    cells.push({ gx: walk % grid.cols, gy: Math.floor(walk / grid.cols) });
    if (walk === startI) break;
    walk = came[walk];
  }
  cells.reverse();
  const raw = cells.map((c) => gridToWorld(grid, c.gx, c.gy));
  raw[0] = start;
  raw[raw.length - 1] = goal;
  const points = simplifyPath(grid.scene, raw, grid.radius);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  return { found: true, cells, points, length, snappedStart: s.snapped, snappedGoal: g.snapped };
}

/** Clearance-aware segment test by dense sampling of the swept body. */
export function segmentBodyClear(
  scene: SceneGeometry,
  a: Vec2,
  b: Vec2,
  radius: number,
  samples = 48,
): boolean {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = add(a, scale(sub(b, a), t));
    if (!isFree(scene, p, radius)) return false;
  }
  return true;
}

export function segmentBodyDistance(scene: SceneGeometry, a: Vec2, b: Vec2, radius: number, samples = 48): number {
  let worst = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = add(a, scale(sub(b, a), t));
    let d = Math.min(p.x, p.y, scene.board.w - p.x, scene.board.h - p.y);
    for (const o of scene.obstacles) {
      if (pointInRect(p, o)) return 0;
      d = Math.min(d, rectBoundaryDistance(p, o));
    }
    worst = Math.min(worst, d - radius);
  }
  return worst;
}

export function simplifyPath(scene: SceneGeometry, points: Vec2[], radius: number): Vec2[] {
  if (points.length <= 2) return points.slice();
  const out: Vec2[] = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    for (; j > i + 1; j--) {
      if (segmentBodyClear(scene, points[i], points[j], radius, 40)) break;
    }
    out.push(points[j]);
    i = j;
  }
  return out;
}

/** Verify every leg of a route keeps the body clear. */
export function pathBodyClear(scene: SceneGeometry, points: Vec2[], radius: number): { ok: boolean; leg: number; pos?: Vec2 } {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    for (let s = 0; s <= 64; s++) {
      const p = add(a, scale(sub(b, a), s / 64));
      if (!isFree(scene, p, radius)) return { ok: false, leg: i - 1, pos: p };
    }
  }
  return { ok: true, leg: -1 };
}

export function pathLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export interface NavField {
  dist: Float64Array;
  came: Int32Array;
  startCell: number;
  startPos: Vec2;
  snappedStart: number;
  reachableCells: number;
}

/**
 * One Dijkstra pass from the agent's position. Candidate goals then only need
 * a lookup and a back-walk, which keeps a 100+ candidate scan cheap.
 */
export function buildNavField(grid: NavGrid, start: Vec2): NavField | null {
  const s = nearestFree(grid, start);
  if (!s) return null;
  const N = grid.cols * grid.rows;
  const distArr = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const startI = idx(grid, s.gx, s.gy);
  const heap: { i: number; f: number }[] = [];
  const push = (i: number, f: number) => {
    heap.push({ i, f });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].f <= heap[c].f) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): { i: number; f: number } | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const deltas = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, DIAG],
    [1, -1, DIAG],
    [-1, 1, DIAG],
    [-1, -1, DIAG],
  ];
  distArr[startI] = 0;
  push(startI, 0);
  let reachable = 0;
  while (heap.length) {
    const cur = pop()!;
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    reachable++;
    const cgx = cur.i % grid.cols;
    const cgy = Math.floor(cur.i / grid.cols);
    for (const [dx, dy, cost] of deltas) {
      const nx = cgx + dx;
      const ny = cgy + dy;
      if (navBlocked(grid, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (navBlocked(grid, cgx + dx, cgy) || navBlocked(grid, cgx, cgy + dy))) {
        continue;
      }
      const ni = idx(grid, nx, ny);
      if (closed[ni]) continue;
      const tentative = distArr[cur.i] + cost;
      if (tentative + 1e-9 < distArr[ni]) {
        distArr[ni] = tentative;
        came[ni] = cur.i;
        push(ni, tentative);
      }
    }
  }
  return { dist: distArr, came, startCell: startI, startPos: start, snappedStart: s.snapped, reachableCells: reachable };
}

export interface FieldRoute {
  found: boolean;
  cells: { gx: number; gy: number }[];
  points: Vec2[];
  length: number;
  snappedGoal: number;
}

export function routeFromField(grid: NavGrid, field: NavField, goal: Vec2): FieldRoute {
  const g = nearestFree(grid, goal);
  if (!g) {
    return { found: false, cells: [], points: [], length: Infinity, snappedGoal: Infinity };
  }
  const goalI = idx(grid, g.gx, g.gy);
  if (!Number.isFinite(field.dist[goalI])) {
    return { found: false, cells: [], points: [], length: Infinity, snappedGoal: g.snapped };
  }
  const cells: { gx: number; gy: number }[] = [];
  let walk = goalI;
  let guard = 0;
  while (walk !== -1 && guard++ < grid.cols * grid.rows) {
    cells.push({ gx: walk % grid.cols, gy: Math.floor(walk / grid.cols) });
    if (walk === field.startCell) break;
    walk = field.came[walk];
  }
  cells.reverse();
  if (cells.length === 0 || idx(grid, cells[0].gx, cells[0].gy) !== field.startCell) {
    return { found: false, cells: [], points: [], length: Infinity, snappedGoal: g.snapped };
  }
  const points = cells.map((c) => gridToWorld(grid, c.gx, c.gy));
  points[0] = field.startPos;
  points[points.length - 1] = goal;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  return { found: true, cells, points, length, snappedGoal: g.snapped };
}

/**
 * Connector check: the grid path itself is free by construction, but the exact
 * start and goal points may sit between cells close to cover. Verify both legs.
 */
export function connectorClear(
  scene: SceneGeometry,
  points: Vec2[],
  radius: number,
): { ok: boolean; detail: string } {
  if (points.length < 2) return { ok: true, detail: 'single point' };
  const checks: { label: string; a: Vec2; b: Vec2 }[] = [];
  if (points.length >= 2) checks.push({ label: 'start connector', a: points[0], b: points[1] });
  if (points.length >= 2) checks.push({ label: 'goal connector', a: points[points.length - 2], b: points[points.length - 1] });
  for (const c of checks) {
    if (!segmentBodyClear(scene, c.a, c.b, radius, 32)) {
      return { ok: false, detail: `${c.label} crosses cover or a board edge` };
    }
  }
  return { ok: true, detail: 'connectors clear' };
}

export { EPS };

