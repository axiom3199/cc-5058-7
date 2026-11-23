import type { Policy, Scenario } from '../kernel/types';
import type { SimEvent, SimSnapshot } from '../kernel/engine';
import { DEFAULT_POLICY } from '../kernel/selection';

export interface ReplayFile {
  format: 'cover-selection-replay';
  version: 1;
  createdAt: string;
  scenario: Scenario;
  policy: Policy;
  /** Every engine event with the snapshot that was live when it fired. */
  frames: { index: number; event: SimEvent | null; snapshot: SimSnapshot }[];
  events: SimEvent[];
  failedCandidates: Record<string, string[]>;
  note: string;
}

export function buildReplayFile(
  scenario: Scenario,
  policy: Policy,
  frames: { index: number; event: SimEvent | null; snapshot: SimSnapshot }[],
  events: SimEvent[],
  failedCandidates: Record<string, string[]>,
): ReplayFile {
  return {
    format: 'cover-selection-replay',
    version: 1,
    createdAt: new Date().toISOString(),
    scenario,
    policy,
    frames,
    events,
    failedCandidates,
    note: 'Simplified fictional-game model. Replays are deterministic: replaying the same actions produces the same event stream.',
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
