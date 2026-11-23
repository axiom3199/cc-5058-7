import type { AgentSpec, Obstacle, Scenario } from './types';

const scout = (pos: { x: number; y: number }, color = '#7dd3fc'): AgentSpec => ({
  id: 'scout',
  name: 'Scout',
  pos,
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.0,
  walkSpeed: 3.0,
  crouchSpeed: 1.5,
  stance: 'stand',
  color,
});

const wing = (pos: { x: number; y: number }): AgentSpec => ({
  id: 'wing',
  name: 'Wing',
  pos,
  radius: 0.35,
  standHeight: 1.75,
  crouchHeight: 0.95,
  walkSpeed: 2.8,
  crouchSpeed: 1.4,
  stance: 'stand',
  color: '#fca5a5',
});

function crates(
  id: string,
  x: number,
  y: number,
  w: number,
  d: number,
  height: number,
  label: string,
  kind: Obstacle['kind'] = 'crate',
  cover = true,
): Obstacle {
  return { id, x, y, w, d, height, kind, label, cover };
}

export const TWIN_COVER: Scenario = {
  id: 'twin-cover',
  name: '01 · Twin cover, unequal walk',
  description:
    'Two identical full-height crate stacks sit symmetrically across the known muzzle flash, so they hide the same body height. The north stack is much closer to Scout. The kernel must prefer it on arrival time while keeping both cover options visible in the audit table.',
  board: { w: 24, h: 16 },
  obstacles: [
    crates('twin-n', 10.0, 3.0, 2.6, 1.2, 1.9, 'North crate stack', 'crate'),
    crates('twin-s', 10.0, 11.8, 2.6, 1.2, 1.9, 'South crate stack', 'crate'),
    crates('divider', 13.6, 7.2, 2.2, 1.4, 1.05, 'Low divider', 'halfWall'),
    crates('pillar', 17.2, 4.8, 1.0, 1.0, 2.4, 'Concrete pillar', 'pillar'),
    crates('inner-wall', 19.0, 10.0, 0.7, 4.0, 2.2, 'Interior wall', 'wall'),
    crates('low-cart', 6.0, 13.4, 1.8, 0.7, 0.5, 'Low cart (no cover)', 'barrier', false),
  ],
  agent: scout({ x: 4.0, y: 5.0 }),
  ally: wing({ x: 3.0, y: 11.0 }),
  clues: [
    {
      id: 'flash',
      label: 'Muzzle flash',
      source: 'sighting',
      pos: { x: 20.0, y: 8.0 },
      confidence: 0.9,
      uncertainty: 0.5,
      ageSec: 2,
    },
    {
      id: 'boots',
      label: 'Boots on gravel',
      source: 'sound',
      pos: { x: 16.0, y: 2.5 },
      confidence: 0.45,
      uncertainty: 1.4,
      ageSec: 6,
    },
  ],
  hostiles: [
    { id: 'hv-1', label: 'Sentinel (seen)', pos: { x: 20.0, y: 8.0 }, radius: 0.35, hidden: false, clueId: 'flash' },
    { id: 'hv-2', label: 'Lurker (never revealed)', pos: { x: 15.0, y: 14.4 }, radius: 0.35, hidden: true },
  ],
  markers: [
    { id: 'marker-wall', pos: { x: 18.6, y: 12.0 }, label: 'Chalk X on the interior wall — decorative, not cover' },
    { id: 'marker-crate', pos: { x: 11.3, y: 2.4 }, label: 'Spray mark on north stack' },
  ],
  notes: [
    'Symmetry is intentional: both stacks block the same body probes at the muzzle-flash bearing.',
    'The chalk mark by the wall is drawn as a marker only and never becomes a candidate.',
  ],
};

export const MULTI_HEIGHT: Scenario = {
  id: 'multi-height',
  name: '02 · Multi-height courtyard',
  description:
    'A 2.3 m wall hides a standing body, a 1.15 m half wall only hides a crouched one, and a 0.55 m barrier hides nothing. The selected stance and the exposure percentages change with the obstacle height, not with a marker.',
  board: { w: 22, h: 14 },
  obstacles: [
    crates('tall-wall', 9.0, 4.0, 2.8, 0.7, 2.3, 'Tall wall', 'wall'),
    crates('half-wall', 9.0, 9.0, 2.8, 0.7, 1.15, 'Half wall', 'halfWall'),
    crates('low-barrier', 14.0, 6.5, 2.6, 0.7, 0.55, 'Low barrier (no cover)', 'barrier', false),
    crates('half-crate', 6.5, 10.6, 1.5, 1.5, 1.35, 'Chest-height crate', 'crate'),
    crates('pillar', 15.5, 11.6, 0.9, 0.9, 2.35, 'Pillar', 'pillar'),
  ],
  agent: scout({ x: 3.5, y: 7.0 }),
  ally: wing({ x: 3.0, y: 3.0 }),
  clues: [
    {
      id: 'muzzle',
      label: 'Rifle muzzle',
      source: 'sighting',
      pos: { x: 18.0, y: 7.0 },
      confidence: 0.85,
      uncertainty: 0.4,
      ageSec: 1,
    },
    {
      id: 'whistle',
      label: 'Whistle',
      source: 'sound',
      pos: { x: 12.0, y: 2.0 },
      confidence: 0.4,
      uncertainty: 1.5,
      ageSec: 8,
    },
  ],
  hostiles: [
    { id: 'hv-1', label: 'Marksman', pos: { x: 18.0, y: 7.0 }, radius: 0.35, hidden: false, clueId: 'muzzle' },
    { id: 'hv-2', label: 'Flanker', pos: { x: 14.5, y: 12.8 }, radius: 0.35, hidden: true },
  ],
  markers: [{ id: 'marker-low', pos: { x: 14.0, y: 7.6 }, label: 'Tape by the low barrier — not cover' }],
  notes: [
    'The low barrier is solid for pathing but excluded as a cover source because its height is under the crouched body height.',
    'Crouching behind the half wall should measure 0% at the muzzle clue while standing there measures much more.',
  ],
};

export const DIAGONAL: Scenario = {
  id: 'diagonal',
  name: '03 · Diagonal approach',
  description:
    'The only contact is on a diagonal bearing across a chain of boxes. Candidate faces are evaluated along that diagonal; a face parallel to the threat can still leave the body visible at its bearing.',
  board: { w: 20, h: 20 },
  obstacles: [
    crates('diag-a', 7.5, 11.5, 2.2, 2.2, 1.9, 'Crate A', 'crate'),
    crates('diag-b', 11.0, 7.5, 2.2, 2.2, 1.9, 'Crate B', 'crate'),
    crates('rail', 9.5, 9.5, 1.8, 0.5, 0.6, 'Low rail (no cover)', 'barrier', false),
    crates('pillar', 14.5, 4.5, 1.0, 1.0, 2.4, 'Pillar', 'pillar'),
  ],
  agent: scout({ x: 3.5, y: 16.5 }),
  ally: wing({ x: 6.0, y: 17.5 }),
  clues: [
    {
      id: 'diag-contact',
      label: 'Diagonal contact',
      source: 'sighting',
      pos: { x: 16.5, y: 3.5 },
      confidence: 0.9,
      uncertainty: 0.3,
      ageSec: 3,
    },
    {
      id: 'far-noise',
      label: 'Far noise',
      source: 'sound',
      pos: { x: 4.0, y: 3.0 },
      confidence: 0.35,
      uncertainty: 2.0,
      ageSec: 9,
    },
  ],
  hostiles: [{ id: 'hv-1', label: 'Diagonal sentry', pos: { x: 16.5, y: 3.5 }, radius: 0.35, hidden: false, clueId: 'diag-contact' }],
  markers: [],
  notes: ['The diagonal bearing means a north or west face can be shielded while an east face is fully exposed.'],
};

export const SEALED_POCKET: Scenario = {
  id: 'sealed-pocket',
  name: '04 · Sealed pocket & narrow gap',
  description:
    'A fully enclosed ring of walls produces cover candidates the character cannot reach. A 0.95 m gap fits the body centre but not the stance-change sweep. Both must be rejected with explicit reasons instead of quietly disappearing.',
  board: { w: 18, h: 14 },
  obstacles: [
    crates('ring-n', 7.0, 4.0, 5.0, 0.6, 2.2, 'Ring north', 'wall'),
    crates('ring-s', 7.0, 9.4, 5.0, 0.6, 2.2, 'Ring south', 'wall'),
    crates('ring-w', 7.0, 4.6, 0.6, 4.8, 2.2, 'Ring west', 'wall'),
    crates('ring-e', 11.4, 4.6, 0.6, 4.8, 2.2, 'Ring east', 'wall'),
    crates('gap-a', 3.2, 6.2, 1.4, 1.4, 1.6, 'Gap crate A', 'crate'),
    crates('gap-b', 3.2, 8.55, 1.4, 1.4, 1.6, 'Gap crate B', 'crate'),
  ],
  agent: scout({ x: 2.4, y: 7.0 }),
  ally: wing({ x: 2.4, y: 2.6 }),
  clues: [
    {
      id: 'window',
      label: 'Window contact',
      source: 'sighting',
      pos: { x: 16.0, y: 7.0 },
      confidence: 0.8,
      uncertainty: 0.6,
      ageSec: 2,
    },
  ],
  hostiles: [{ id: 'hv-1', label: 'Window sentry', pos: { x: 16.0, y: 7.0 }, radius: 0.35, hidden: false, clueId: 'window' }],
  markers: [{ id: 'marker-ring', pos: { x: 9.5, y: 7.0 }, label: 'Chalk mark inside the sealed ring — unreachable' }],
  notes: [
    'Ring walls are legitimate cover from outside; their inner faces are unreachable and must show an unreachable rejection.',
    'The 0.95 m gap fits a 0.70 m body diameter but not the ±0.55 m stance sweep.',
  ],
};

export const SCENARIOS: Scenario[] = [TWIN_COVER, MULTI_HEIGHT, DIAGONAL, SEALED_POCKET];

export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s)) as Scenario;
}

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario ${id}`);
  return cloneScenario(s);
}
