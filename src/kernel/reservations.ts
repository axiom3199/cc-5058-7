import type { Reservation, Vec2 } from './types';
import { cellKey, dist } from './geometry';

export const CELL_SIZE = 1.0;
export const EXCLUSION_RADIUS = 0.6;

/**
 * Spatial claims held by characters that are already moving. A claim is keyed by
 * a coarse cell plus the exact goal point, and it survives recomputation so a
 * second character cannot plan into space a mover has already committed to.
 */
export class ReservationBook {
  private byAgent = new Map<string, Reservation>();
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }

  claim(agentId: string, candidateId: string, pos: Vec2, now: number): Reservation {
    const existing = this.byAgent.get(agentId);
    if (existing && existing.candidateId === candidateId && dist(existing.pos, pos) < 1e-6) {
      return existing;
    }
    this.versionCounter += 1;
    const r: Reservation = {
      agentId,
      candidateId,
      pos: { ...pos },
      cellKey: cellKey(pos, CELL_SIZE),
      version: this.versionCounter,
      createdAt: now,
    };
    this.byAgent.set(agentId, r);
    return r;
  }

  release(agentId: string): boolean {
    if (!this.byAgent.delete(agentId)) return false;
    this.versionCounter += 1;
    return true;
  }

  ownerOf(pos: Vec2, excludeAgentId?: string): Reservation | null {
    const k = cellKey(pos, CELL_SIZE);
    for (const r of this.byAgent.values()) {
      if (excludeAgentId && r.agentId === excludeAgentId) continue;
      if (r.cellKey === k) return r;
      if (dist(r.pos, pos) < EXCLUSION_RADIUS) return r;
    }
    return null;
  }

  /** Also report claimants in adjacent cells whose goal point is within the exclusion radius. */
  nearby(pos: Vec2, excludeAgentId?: string): Reservation[] {
    const out: Reservation[] = [];
    for (const r of this.byAgent.values()) {
      if (excludeAgentId && r.agentId === excludeAgentId) continue;
      if (dist(r.pos, pos) < EXCLUSION_RADIUS * 2.2) out.push(r);
    }
    return out;
  }

  snapshot(): Reservation[] {
    return [...this.byAgent.values()].map((r) => ({ ...r, pos: { ...r.pos } }));
  }

  get(agentId: string): Reservation | null {
    const r = this.byAgent.get(agentId);
    return r ? { ...r, pos: { ...r.pos } } : null;
  }

  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }
}
