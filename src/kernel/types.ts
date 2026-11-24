export interface Vec2 {
  x: number;
  y: number;
}

export type Stance = 'stand' | 'crouch';

export type ObstacleKind = 'wall' | 'crate' | 'halfWall' | 'pillar' | 'barrier';

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  height: number;
  kind: ObstacleKind;
  label?: string;
  /** Perimeter walls and decorative props are not used as cover sources. */
  cover?: boolean;
}

export interface BoardBounds {
  w: number;
  h: number;
}

export interface SceneGeometry {
  board: BoardBounds;
  obstacles: Obstacle[];
}

export type ClueSource = 'sighting' | 'sound' | 'lastKnown';

export interface ThreatClue {
  id: string;
  label: string;
  source: ClueSource;
  pos: Vec2;
  /** 0..1; used as a weight, never as proof. */
  confidence: number;
  /** metres of positional uncertainty around pos */
  uncertainty: number;
  ageSec: number;
}

export interface Hostile {
  id: string;
  label: string;
  pos: Vec2;
  radius: number;
  /** Hidden hostiles are drawn only in the admin overlay and never given to the kernel. */
  hidden: boolean;
  /** Clue updated when this hostile is dragged; hidden hostiles have none. */
  clueId?: string;
}

export interface DecorativeMarker {
  id: string;
  pos: Vec2;
  label: string;
}

export interface AgentSpec {
  id: string;
  name: string;
  pos: Vec2;
  radius: number;
  standHeight: number;
  crouchHeight: number;
  walkSpeed: number;
  crouchSpeed: number;
  stance: Stance;
  color: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  board: BoardBounds;
  obstacles: Obstacle[];
  agent: AgentSpec;
  ally: AgentSpec;
  clues: ThreatClue[];
  hostiles: Hostile[];
  markers: DecorativeMarker[];
  notes: string[];
}

export type Face = 'n' | 'e' | 's' | 'w';

export interface Candidate {
  id: string;
  obstacleId: string;
  face: Face;
  pos: Vec2;
  /** Outward from the obstacle; the character stands on this side. */
  normal: Vec2;
  /** Measured, not assumed: body clearance to the nearest obstacle or board edge. */
  clearanceMargin: number;
  /** Measured space for a stand <-> crouch transition. */
  transitionMargin: number;
  nearestObstacleId: string | null;
  geometry: {
    inBounds: boolean;
    bodyClear: boolean;
    transitionClear: boolean;
  };
}

export interface ClueExposure {
  clueId: string;
  bearingDeg: number;
  distance: number;
  /** Fraction (0..1) of the target body visible at the clue's nominal position. */
  exposure: number;
  /** Worst exposure across the clue's uncertainty samples (equals nominal when uncertainty is 0). */
  worstExposure: number;
  blockedFraction: number;
  observable: boolean;
  perHeight: { height: number; visible: boolean; blockers: string[] }[];
  samples: Vec2[];
  blockers: string[];
  samplePositions: Vec2[];
  worstTarget: Vec2;
}

export interface StanceEvaluation {
  stance: Stance;
  perClue: ClueExposure[];
  worstExposure: number;
  uncertaintyWorstExposure: number;
  meanExposure: number;
  /** Weighted by clue confidence and recency; 0..1. */
  visibilityWeight: number;
  totalClueWeight: number;
  /** Eye-height rays probed in 16 compass directions; true = unobstructed. */
  openDirections: boolean[];
  openDirectionCount: number;
  openDirectionFraction: number;
  probeDistance: number;
  eyeHeight: number;
}

export interface RejectReason {
  code:
    | 'out_of_bounds'
    | 'body_overlap'
    | 'transition_space'
    | 'unreachable'
    | 'reserved'
    | 'arrival_failed'
    | 'exposure_limit'
    | 'low_clearance'
    | 'agent_clearance';
  detail: string;
}

export interface PolicyWeights {
  /** Occlusion against known clues. */
  protection: number;
  /** Situational awareness (open eye-height directions). */
  observation: number;
  /** Travel cost. */
  mobility: number;
  /** Body and stance-change room. */
  clearance: number;
  /** Squad crowding penalty. */
  crowding: number;
  /** Watching the known threat bearing specifically. */
  watch: number;
}

export type StanceMode = 'auto' | 'stand' | 'crouch';

export interface Policy {
  weights: PolicyWeights;
  stanceMode: StanceMode;
  /** Candidates whose nominal worst-clue exposure exceeds this are rejected outright. */
  maxWorstExposure: number;
  /** Auto-stance tolerance: a stance under this worst exposure is acceptable at the nominal clue position. */
  stanceTolerance: number;
  maxTravelSec: number;
}

export interface UtilityComponents {
  /** 1 - worst exposure across known clues; larger is safer. */
  protection: number;
  /** Weighted known-clue observability; larger means better information. */
  observation: number;
  /** 1 - normalised travel time. */
  mobility: number;
  /** Normalised body/transition clearance headroom. */
  clearance: number;
  /** Penalty for sharing a reservation cell with another agent, 0..1 higher = more crowded. */
  crowding: number;
  /** Fraction of 16 eye-height directions with a clear view at this spot. */
  observationArc: number;
  /** Fraction of 16 directions that look toward the nearest known clue. */
  watch: number;
  utility: number;
  terms: { name: keyof PolicyWeights; weight: number; value: number; contribution: number }[];
}

export interface CandidateEvaluation {
  candidate: Candidate;
  valid: boolean;
  rejectReasons: RejectReason[];
  reachable: boolean;
  path: Vec2[];
  pathLength: number | null;
  travelTimeSec: number | null;
  routeClear: boolean;
  stances: Record<Stance, StanceEvaluation>;
  chosenStance: Stance;
  stanceReason: string;
  components: UtilityComponents;
  rank: number | null;
  pros: string[];
  cons: string[];
  reservationsNear: { agentId: string; distance: number }[];
}

export interface Reservation {
  agentId: string;
  candidateId: string;
  pos: Vec2;
  cellKey: string;
  version: number;
  createdAt: number;
}

export interface ReservationView {
  ownerOf(pos: Vec2, excludeAgentId?: string): Reservation | null;
  nearby(pos: Vec2, excludeAgentId?: string): Reservation[];
  snapshot(): Reservation[];
  readonly version: number;
}

export interface SelectionInput {
  scene: SceneGeometry;
  agent: AgentSpec;
  clues: ThreatClue[];
  reservations: ReservationView;
  policy: Policy;
  failedCandidateIds?: string[];
  /**
   * Failure records written by an older spatial query backend. They are never
   * applied as rejections; the selector invalidates them and reports them on
   * the result so the feedback loop can re-measure under the current backend.
   */
  legacyFailedCandidateIds?: string[];
  /** Other characters' bodies; a cover spot must leave room for the squad too. */
  otherAgents?: { id: string; name: string; pos: Vec2; radius: number }[];
  now?: number;
}

export interface SelectionResult {
  id: string;
  agentId: string;
  /** Position the evaluator planned from (the live position on recompute). */
  originPos: Vec2;
  createdAt: number;
  clues: ThreatClue[];
  clueInputNote: string;
  policy: Policy;
  candidates: CandidateEvaluation[];
  ranked: CandidateEvaluation[];
  rejected: CandidateEvaluation[];
  selected: CandidateEvaluation | null;
  rejectionSummary: { code: RejectReason['code']; count: number }[];
  rationale: string[];
  reservationVersion: number;
  hiddenHostileLeak: boolean;
  /** Spatial query backend that produced this result (see sceneQuery.ts). */
  queryBackend: string;
  /** Legacy failure records invalidated on input because they predate queryBackend. */
  invalidatedLegacyCandidateIds: string[];
}

export interface AgentClearance {
  agentId: string;
  distance: number;
  required: number;
  ok: boolean;
}

export interface ArrivalMeasured {
  pos: Vec2;
  stance: Stance;
  clearanceMargin: number;
  transitionMargin: number;
  perClue: ClueExposure[];
  worstExposure: number;
  visibilityWeight: number;
  openDirectionFraction: number;
  agentClearance: AgentClearance[];
}

export interface ArrivalCheck {
  ok: boolean;
  failures: { code: string; detail: string }[];
  measured: ArrivalMeasured;
  predictedWorstExposure: number;
  predictedVisibility: number;
  predictedClearance: number;
  predictedTransition: number;
  coverObstacleId: string | null;
  /** True when measured worst exposure differs from prediction by <= 1/6 (one body probe). */
  matchesPrediction: boolean;
  notes: string[];
}

export interface AgentRuntime {
  id: string;
  spec: AgentSpec;
  pos: Vec2;
  stance: Stance;
  status: 'idle' | 'transition' | 'moving' | 'inCover' | 'failed';
  path: Vec2[];
  pathCursor: number;
  goal: {
    candidateId: string;
    obstacleId: string;
    pos: Vec2;
    stance: Stance;
    selectionId: string;
  } | null;
  transitionRemaining: number;
  distanceTravelled: number;
  arrival: ArrivalCheck | null;
  failureNote: string | null;
}
