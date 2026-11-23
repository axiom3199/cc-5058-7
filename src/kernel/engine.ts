import type {
  AgentRuntime,
  AgentSpec,
  ArrivalCheck,
  CandidateEvaluation,
  Policy,
  Reservation,
  Scenario,
  SelectionResult,
  Stance,
  ThreatClue,
  Vec2,
} from './types';
import { ReservationBook } from './reservations';
import { DEFAULT_POLICY, measureArrival, selectCover } from './selection';
import { buildGrid, pathBodyClear, pathLength } from './navigation';
import { clampToBoard, dist, round } from './geometry';
import { evaluateStance } from './exposure';

export type SimEventKind =
  | 'scenario'
  | 'select'
  | 'move_start'
  | 'recompute'
  | 'arrive'
  | 'arrival_pass'
  | 'arrival_fail'
  | 'feedback'
  | 'clue_move'
  | 'reservation_claim'
  | 'reservation_release'
  | 'stance'
  | 'note';

export interface SimEvent {
  seq: number;
  t: number;
  kind: SimEventKind;
  actor: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface AgentSnapshot {
  id: string;
  pos: Vec2;
  stance: Stance;
  status: AgentRuntime['status'];
  goal: AgentRuntime['goal'];
  arrival: ArrivalCheck | null;
  failureNote: string | null;
  path: Vec2[];
  distanceTravelled: number;
}

export interface SimSnapshot {
  t: number;
  agents: AgentSnapshot[];
  selections: SelectionResult[];
  reservations: Reservation[];
  failedCandidates: Record<string, string[]>;
  policy: Policy;
  clueVersion: number;
}

export interface SimOptions {
  policy?: Policy;
  allyAuto?: boolean;
}

export interface ReplayFrame {
  index: number;
  snapshot: SimSnapshot;
  event: SimEvent | null;
}

const TICK = 0.05;
const PRECISE_TICK = 0.01;
const RECOMPUTE_INTERVAL = 0.9;
const TRANSITION_TIME = 0.7;
const ARRIVAL_TOLERANCE = 0.06;

export class Simulation {
  scenario: Scenario;
  policy: Policy;
  t = 0;
  agents: Record<string, AgentRuntime>;
  reservations = new ReservationBook();
  selections: SelectionResult[] = [];
  events: SimEvent[] = [];
  failedCandidates: Record<string, string[]> = {};
  replays: { index: number; snapshot: SimSnapshot; event: SimEvent | null }[] = [];
  private seq = 0;
  private allyAuto: boolean;
  private lastRecompute = -Infinity;
  private clueVersion = 0;
  private movementAccumulator = 0;

  constructor(scenario: Scenario, opts: SimOptions = {}) {
    this.scenario = JSON.parse(JSON.stringify(scenario)) as Scenario;
    this.policy = clonePolicy(opts.policy ?? DEFAULT_POLICY);
    this.allyAuto = opts.allyAuto ?? false;
    this.agents = {
      [this.scenario.agent.id]: makeRuntime(this.scenario.agent),
      [this.scenario.ally.id]: makeRuntime(this.scenario.ally),
    };
    this.failedCandidates[this.scenario.agent.id] = [];
    this.log('scenario', 'system', `Loaded "${scenario.name}"`);
    this.capture(null);
  }

  get agent(): AgentRuntime {
    return this.agents[this.scenario.agent.id];
  }

  get ally(): AgentRuntime {
    return this.agents[this.scenario.ally.id];
  }

  get clueList(): ThreatClue[] {
    return this.scenario.clues.map((c) => ({ ...c, pos: { ...c.pos } }));
  }

  setPolicy(policy: Policy): void {
    this.policy = clonePolicy(policy);
    this.log('note', 'system', 'Policy updated');
    this.invalidateReplaysFrom('policy');
  }

  setAllyAuto(on: boolean): void {
    this.allyAuto = on;
  }

  get allyAutoEnabled(): boolean {
    return this.allyAuto;
  }

  toggleAllyAuto(): boolean {
    this.allyAuto = !this.allyAuto;
    this.log('note', 'system', `Wing auto-retarget ${this.allyAuto ? 'on' : 'off'}`);
    if (this.allyAuto && this.ally.status === 'idle') {
      this.assign(this.scenario.ally.id);
    }
    return this.allyAuto;
  }

  setStance(agentId: string, stance: Stance): void {
    const a = this.agents[agentId];
    if (!a) return;
    if (a.status === 'moving' && stance !== a.stance) {
      a.transitionRemaining = TRANSITION_TIME;
      a.status = 'transition';
    }
    a.stance = stance;
    this.log('stance', agentId, `${a.spec.name} switches to ${stance} stance`);
    this.invalidateReplaysFrom(`stance:${agentId}`);
  }

  failedFor(agentId: string): string[] {
    return (this.failedCandidates[agentId] ?? []).slice();
  }

  /** Move a clue endpoint (e.g. dragging the visible hostile) and recompute. */
  moveClue(clueId: string, pos: Vec2, opts: { uncertainty?: number } = {}): void {
    const clue = this.scenario.clues.find((c) => c.id === clueId);
    if (!clue) return;
    pos = clampToBoard(this.scenario.board, pos, 0.2);
    clue.pos = { ...pos };
    if (opts.uncertainty !== undefined) clue.uncertainty = opts.uncertainty;
    clue.ageSec = 0;
    const hostile = this.scenario.hostiles.find((h) => h.clueId === clueId);
    if (hostile && !hostile.hidden) hostile.pos = { ...pos };
    this.clueVersion += 1;
    this.log('clue_move', 'system', `${clue.label} clue moved to ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`);
    this.recomputeAll('clue moved');
    this.invalidateReplaysFrom(`clue:${clueId}`);
  }

  moveAgent(agentId: string, pos: Vec2): void {
    const a = this.agents[agentId];
    if (!a) return;
    pos = clampToBoard(this.scenario.board, pos, a.spec.radius + 0.1);
    a.pos = { ...pos };
    a.path = [];
    a.status = 'idle';
    a.arrival = null;
    a.goal = null;
    this.reservations.release(agentId);
    this.log('note', agentId, `${a.spec.name} repositioned by the user`);
    this.recomputeAll('agent repositioned');
    this.invalidateReplaysFrom(`move:${agentId}`);
  }

  setHostileClueFromHostile(hostileId: string, pos: Vec2): void {
    const h = this.scenario.hostiles.find((x) => x.id === hostileId);
    if (!h || h.hidden) return;
    h.pos = { ...pos };
    if (h.clueId) this.moveClue(h.clueId, pos);
  }

  /** Re-run selection for an agent without changing its current goal. */
  preview(agentId: string): SelectionResult | null {
    const result = this.selectFor(agentId);
    this.capture(null);
    return result;
  }

  /**
   * Test harness action: park the ally's body on the agent's committed goal.
   * The next periodic check or the arrival measurement then has to deal with a
   * genuinely occupied spot, exercising the failure-feedback path.
   */
  blockGoalWithAlly(agentId: string): boolean {
    const a = this.agents[agentId];
    const ally = this.ally;
    if (!a?.goal) {
      this.log('note', 'system', 'No committed goal to block; select cover first.');
      return false;
    }
    const goal = a.goal;
    ally.pos = { ...goal.pos };
    ally.path = [];
    ally.status = 'idle';
    ally.goal = null;
    this.log('note', ally.id, `${ally.spec.name} is parked on ${a.spec.name}'s goal ${goal.candidateId} (test harness).`);
    this.recomputeAgent(agentId, 'goal occupied by ally');
    this.capture(null);
    return true;
  }

  /** Force the arrival measurement at the current position, for inspection. */
  forceArrival(agentId: string): void {
    const a = this.agents[agentId];
    if (!a?.goal) return;
    a.pos = { ...a.goal.pos };
    this.completeArrival(a);
    this.capture(null);
  }

  selectFor(agentId: string, opts: { quiet?: boolean } = {}): SelectionResult | null {
    const a = this.agents[agentId];
    if (!a) return null;
    const result = selectCover({
      scene: {
        board: this.scenario.board,
        obstacles: this.scenario.obstacles,
      },
      // Plan from where the character is right now, not from its scenario spawn.
      agent: { ...a.spec, pos: { ...a.pos } },
      clues: this.clueList,
      reservations: this.reservations,
      policy: this.policy,
      failedCandidateIds: this.failedFor(agentId),
      otherAgents: Object.values(this.agents)
        .filter((o) => o.id !== agentId)
        .map((o) => ({ id: o.id, name: o.spec.name, pos: { ...o.pos }, radius: o.spec.radius })),
      now: this.t,
    });
    // Deterministic per-run id: replays must match action-for-action.
    result.id = `${agentId}-sel-${this.selections.length + 1}`;
    this.selections.push(result);
    if (opts.quiet) return result;
    const top = result.selected;
    this.log(
      'select',
      agentId,
      top
        ? `${a.spec.name} evaluates ${result.candidates.length} candidates: ${result.ranked.length} valid, ${result.rejected.length} rejected. Top: ${top.candidate.id} (utility ${top.components.utility.toFixed(3)}).`
        : `${a.spec.name} evaluates ${result.candidates.length} candidates and finds none valid. ${result.rejectionSummary
            .map((r) => `${r.code}×${r.count}`)
            .join(', ')}.`,
      { selectionId: result.id, selectedId: top?.candidate.id ?? null },
    );
    return result;
  }

  /** Start or restart a selection move for an agent. */
  assign(agentId: string): SelectionResult | null {
    const a = this.agents[agentId];
    if (!a) return null;
    const result = this.selectFor(agentId);
    if (!result || !result.selected) {
      a.status = 'failed';
      a.failureNote = 'no valid cover candidate';
      return result;
    }
    this.beginMove(agentId, result.selected, result);
    return result;
  }

  recomputeAll(reason: string): void {
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      if (id === this.scenario.ally.id && !this.allyAuto) continue;
      if (a.status === 'moving' || a.status === 'transition' || a.status === 'inCover') {
        this.recomputeAgent(id, reason);
      }
    }
    this.capture(null);
  }

  private recomputeAgent(agentId: string, reason: string): void {
    const a = this.agents[agentId];
    const result = this.selectFor(agentId, { quiet: true });
    if (!result) return;
    if (!result.selected) {
      a.status = 'failed';
      a.failureNote = `no valid candidate after ${reason}`;
      this.log('note', agentId, `${a.spec.name}: no valid candidate after ${reason}; keeping current spot pending feedback`);
      return;
    }
    const currentGoalId = a.goal?.candidateId ?? null;
    if (a.status === 'inCover' && currentGoalId === result.selected.candidate.id) {
      return;
    }
    const changed = currentGoalId !== result.selected.candidate.id;
    if (a.status === 'moving' && !changed && a.goal) {
      // Same destination: refresh route and keep the reservation.
      const route = this.routeFor(agentId, result.selected);
      if (route) {
        a.path = route.points;
        a.pathCursor = 0;
        a.goal.stance = result.selected.chosenStance;
        this.log('recompute', agentId, `${a.spec.name} recomputes mid-route to ${a.goal.candidateId} and keeps the claim (${reason}).`);
      }
      return;
    }
    this.log(
      'recompute',
      agentId,
      `${a.spec.name} recomputes after ${reason}: ${changed ? `switches from ${currentGoalId ?? 'none'} to ${result.selected.candidate.id}` : `confirms ${result.selected.candidate.id}`}.`,
    );
    this.beginMove(agentId, result.selected, result);
  }

  private routeFor(agentId: string, evaluation: CandidateEvaluation): { points: Vec2[]; length: number } | null {
    const a = this.agents[agentId];
    if (evaluation.path.length < 2) return null;
    const check = pathBodyClear(
      { board: this.scenario.board, obstacles: this.scenario.obstacles },
      evaluation.path,
      a.spec.radius,
    );
    if (!check.ok) return null;
    return { points: evaluation.path, length: pathLength(evaluation.path) };
  }

  private beginMove(agentId: string, evaluation: CandidateEvaluation, result: SelectionResult): void {
    const a = this.agents[agentId];
    const goalPos = evaluation.candidate.pos;
    this.reservations.claim(agentId, evaluation.candidate.id, goalPos, this.t);
    const current = this.reservations.get(agentId);
    a.goal = {
      candidateId: evaluation.candidate.id,
      obstacleId: evaluation.candidate.obstacleId,
      pos: { ...goalPos },
      stance: evaluation.chosenStance,
      selectionId: result.id,
    };
    a.arrival = null;
    a.failureNote = null;
    a.path = evaluation.path.map((p) => ({ ...p }));
    a.pathCursor = 0;
    a.status = a.stance === evaluation.chosenStance ? 'moving' : 'transition';
    a.transitionRemaining = a.stance === evaluation.chosenStance ? 0 : TRANSITION_TIME;
    this.log(
      'reservation_claim',
      agentId,
      `${a.spec.name} reserves ${evaluation.candidate.id} at ${goalPos.x.toFixed(2)}, ${goalPos.y.toFixed(2)} (v${current?.version ?? '?'}).`,
      { candidateId: evaluation.candidate.id },
    );
    this.log(
      'move_start',
      agentId,
      `${a.spec.name} moves to ${evaluation.candidate.id} (${evaluation.candidate.obstacleId} ${evaluation.candidate.face} face), ${evaluation.travelTimeSec?.toFixed(2)} s, ${evaluation.chosenStance} stance.`,
      { candidateId: evaluation.candidate.id, path: a.path },
    );
  }

  private pushArrivalFailure(agentId: string, detail: string): void {
    const a = this.agents[agentId];
    if (!a?.goal) return;
    const list = this.failedCandidates[agentId] ?? [];
    if (!list.includes(a.goal.candidateId)) list.push(a.goal.candidateId);
    this.failedCandidates[agentId] = list;
    this.log('feedback', agentId, `${a.spec.name}: candidate ${a.goal.candidateId} added to the failed list (${detail}).`);
  }

  /** Advance the simulation by dt seconds, recording a replay snapshot on every event. */
  step(dt: number): void {
    let remaining = dt;
    const maxSteps = 4000;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < maxSteps) {
      const precise =
        Object.values(this.agents).some((a) => a.status === 'transition' || (a.status === 'moving' && a.path.length > 0)) ||
        this.agents[this.scenario.agent.id].status === 'moving';
      const tick = precise ? PRECISE_TICK : TICK;
      const advance = Math.min(tick, remaining);
      this.tick(advance);
      remaining -= advance;
    }
    this.capture(null);
  }

  private tick(dt: number): void {
    this.t = round(this.t + dt, 4);
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      if (a.status === 'transition') {
        a.transitionRemaining = Math.max(0, a.transitionRemaining - dt);
        if (a.transitionRemaining <= 1e-9) {
          a.status = a.goal ? 'moving' : 'idle';
        }
        continue;
      }
      if (a.status === 'moving' && a.goal) {
        this.advanceAlongPath(a, dt);
      }
    }
  }

  private advanceAlongPath(a: AgentRuntime, dt: number): void {
    let budget = dt * (a.stance === 'crouch' ? a.spec.crouchSpeed : a.spec.walkSpeed);
    const start = { ...a.pos };
    while (budget > 1e-9 && a.pathCursor < a.path.length) {
      const target = a.path[a.pathCursor];
      const d = dist(a.pos, target);
      if (d <= budget) {
        a.pos = { ...target };
        a.distanceTravelled += d;
        budget -= d;
        a.pathCursor += 1;
      } else {
        const t = budget / d;
        a.pos = { x: a.pos.x + (target.x - a.pos.x) * t, y: a.pos.y + (target.y - a.pos.y) * t };
        a.distanceTravelled += budget;
        budget = 0;
      }
    }
    if (dist(start, a.pos) > 1e-9) {
      // Mid-route recompute trigger; keeps the reservation in place.
      this.movementAccumulator += dist(start, a.pos);
      if (this.movementAccumulator >= a.spec.walkSpeed * RECOMPUTE_INTERVAL) {
        this.movementAccumulator = 0;
        if (this.t - this.lastRecompute >= RECOMPUTE_INTERVAL) {
          this.lastRecompute = this.t;
          this.recomputeAgent(a.id, 'periodic mid-route check');
        }
      }
    }
    const goal = a.goal!;
    if (dist(a.pos, goal.pos) <= ARRIVAL_TOLERANCE || (a.pathCursor >= a.path.length && dist(a.pos, goal.pos) < 0.35)) {
      a.pos = { ...goal.pos };
      this.completeArrival(a);
    }
  }

  private completeArrival(a: AgentRuntime): void {
    const goal = a.goal!;
    const selection = this.selections.find((s) => s.id === goal.selectionId) ?? this.selections[this.selections.length - 1];
    const predicted = selection?.selected;
    const stanceEval = evaluateStance(
      { board: this.scenario.board, obstacles: this.scenario.obstacles },
      a.pos,
      goal.stance,
      this.clueList,
    );
    const predictedWorst = predicted?.stances[goal.stance]?.worstExposure ?? stanceEval.worstExposure;
    const predictedVisibility = predicted?.stances[goal.stance]?.visibilityWeight ?? stanceEval.visibilityWeight;
    const check = measureArrival(
      { board: this.scenario.board, obstacles: this.scenario.obstacles },
      a.spec,
      a.pos,
      goal.stance,
      this.clueList,
      {
        worstExposure: predictedWorst,
        visibility: predictedVisibility,
        candidateId: goal.candidateId,
        clearanceMargin: predicted?.candidate.clearanceMargin,
        transitionMargin: predicted?.candidate.transitionMargin,
      },
      Object.values(this.agents)
        .filter((o) => o.id !== a.id)
        .map((o) => ({ id: o.id, name: o.spec.name, pos: { ...o.pos }, radius: o.spec.radius })),
    );
    a.arrival = check;
    a.status = check.ok ? 'inCover' : 'failed';
    a.failureNote = check.ok ? null : check.failures.map((f) => `${f.code}: ${f.detail}`).join('; ');
    a.goal = null;
    a.path = [];
    a.pathCursor = 0;
    this.reservations.release(a.id);
    this.log(
      'reservation_release',
      a.id,
      `${a.spec.name} releases the claim on ${goal.candidateId} after arrival.`,
    );
    this.log('arrive', a.id, `${a.spec.name} reaches ${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)} in ${goal.stance} stance.`, {
      pos: { ...a.pos },
    });
    if (check.ok) {
      this.log('arrival_pass', a.id, `Arrival verified: ${check.notes.join(' ')}`);
    } else {
      this.log('arrival_fail', a.id, `Arrival failed: ${a.failureNote}`);
      this.pushArrivalFailure(a.id, a.failureNote ?? 'arrival verification failed');
      this.log('feedback', a.id, `Feedback queued; the next selection for ${a.spec.name} rejects ${goal.candidateId}.`);
      this.recomputeAgent(a.id, 'arrival failure feedback');
    }
    if (a.status === 'inCover' && this.allyAuto && a.id === this.agent.id) {
      this.recomputeAgent(this.scenario.ally.id, 'agent arrived');
    }
  }

  /** Speed up a full deterministic resolution for export. */
  simulateUntil(timeout = 60): void {
    const start = this.t;
    while (this.t - start < timeout) {
      const busy = Object.values(this.agents).some(
        (a) => a.status === 'moving' || a.status === 'transition' || (this.allyAuto && a.id === this.scenario.ally.id && a.status === 'idle'),
      );
      if (!busy) break;
      this.step(0.05);
    }
  }

  capture(event: SimEvent | null): void {
    this.replays.push({ index: this.replays.length, snapshot: this.snapshot(), event });
  }

  private invalidateReplaysFrom(reason: string): void {
    // Keep past frames for replay; only the live cursor is affected in the UI.
    void reason;
  }

  snapshot(): SimSnapshot {
    return {
      t: this.t,
      agents: Object.values(this.agents).map((a) => ({
        id: a.id,
        pos: { ...a.pos },
        stance: a.stance,
        status: a.status,
        goal: a.goal ? { ...a.goal, pos: { ...a.goal.pos } } : null,
        arrival: a.arrival,
        failureNote: a.failureNote,
        path: a.path.map((p) => ({ ...p })),
        distanceTravelled: a.distanceTravelled,
      })),
      selections: this.selections.slice(),
      reservations: this.reservations.snapshot(),
      failedCandidates: JSON.parse(JSON.stringify(this.failedCandidates)),
      policy: clonePolicy(this.policy),
      clueVersion: this.clueVersion,
    };
  }

  private log(kind: SimEventKind, actor: string, text: string, data?: Record<string, unknown>): void {
    this.seq += 1;
    const ev: SimEvent = { seq: this.seq, t: round(this.t, 2), kind, actor, text, data };
    this.events.push(ev);
    if (kind !== 'recompute' && kind !== 'reservation_claim' && kind !== 'reservation_release') {
      this.capture(ev);
    }
  }

  latestSelection(agentId: string): SelectionResult | null {
    for (let i = this.selections.length - 1; i >= 0; i--) {
      if (this.selections[i].agentId === agentId) return this.selections[i];
    }
    return null;
  }
}

function makeRuntime(spec: AgentSpec): AgentRuntime {
  return {
    id: spec.id,
    spec: { ...spec, pos: { ...spec.pos } },
    pos: { ...spec.pos },
    stance: spec.stance,
    status: 'idle',
    path: [],
    pathCursor: 0,
    goal: null,
    transitionRemaining: 0,
    distanceTravelled: 0,
    arrival: null,
    failureNote: null,
  };
}

export function clonePolicy(p: Policy): Policy {
  return { ...p, weights: { ...p.weights } };
}

export function policyPreset(): Policy {
  return clonePolicy(DEFAULT_POLICY);
}

export function makeSim(scenario: Scenario, opts?: SimOptions): Simulation {
  return new Simulation(scenario, opts);
}
