import type { Policy, Scenario } from '../kernel/types';
import type { FailedCandidateRecord, SimEvent, SimSnapshot } from '../kernel/engine';
import { DEFAULT_POLICY } from '../kernel/selection';
import { SPATIAL_QUERY_VERSION } from '../kernel/sceneQuery';

export interface ReplayFile {
  format: 'cover-selection-replay';
  /** 2 = failed candidates carry the spatial query backend that measured them. */
  version: 2;
  /** Spatial query migration this replay was written with. */
  spatialQuery: string;
  createdAt: string;
  scenario: Scenario;
  policy: Policy;
  /** Every engine event with the snapshot that was live when it fired. */
  frames: { index: number; event: SimEvent | null; snapshot: SimSnapshot }[];
  events: SimEvent[];
  failedCandidates: Record<string, FailedCandidateRecord[]>;
  note: string;
}

export function buildReplayFile(
  scenario: Scenario,
  policy: Policy,
  frames: { index: number; event: SimEvent | null; snapshot: SimSnapshot }[],
  events: SimEvent[],
  failedCandidates: Record<string, FailedCandidateRecord[]>,
): ReplayFile {
  return {
    format: 'cover-selection-replay',
    version: 2,
    spatialQuery: SPATIAL_QUERY_VERSION,
    createdAt: new Date().toISOString(),
    scenario,
    policy,
    frames,
    events,
    failedCandidates,
    note: 'Simplified fictional-game model. Replays are deterministic: replaying the same actions produces the same event stream. Failed-candidate records are tagged with the spatial query backend that measured them; records from older backends are invalidated, not trusted, on import.',
  };
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function sanitisePolicy(p: Policy | undefined): Policy {
  if (!p) return DEFAULT_POLICY;
  return { ...DEFAULT_POLICY, ...p, weights: { ...DEFAULT_POLICY.weights, ...(p.weights ?? {}) } };
}
