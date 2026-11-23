import type { AgentRuntime, Scenario, ThreatClue } from '../kernel/types';
import { describeClueSource } from '../kernel/exposure';

export function CluesPanel({
  scenario,
  clues,
  showHidden,
  onToggleHidden,
}: {
  scenario: Scenario;
  clues: ThreatClue[];
  showHidden: boolean;
  onToggleHidden: (v: boolean) => void;
}) {
  return (
    <section className="panel">
      <h3>Known threat clues</h3>
      <p className="small muted">Only this list enters the selection input. Drag the coloured hostile dot on the map to move the clue.</p>
      <ul className="clue-list">
        {clues.map((c) => (
          <li key={c.id}>
            <span className={`dot ${c.source}`} />
            <div>
              <b>{c.label}</b>
              <div className="small muted">
                {describeClueSource(c.source)} · ({c.pos.x.toFixed(1)}, {c.pos.y.toFixed(1)}) · conf {Math.round(c.confidence * 100)}% ·
                ±{c.uncertainty.toFixed(1)} m · {c.ageSec.toFixed(0)} s old
              </div>
            </div>
          </li>
        ))}
        {clues.length === 0 && <li className="muted small">none</li>}
      </ul>
      <label className="check">
        <input type="checkbox" checked={showHidden} onChange={(e) => onToggleHidden(e.target.checked)} />
        <span>
          Show hidden hostiles (admin overlay, <b>not</b> used by the kernel)
        </span>
      </label>
      {showHidden && (
        <ul className="clue-list hidden-list">
          {scenario.hostiles
            .filter((h) => h.hidden)
            .map((h) => (
              <li key={h.id}>
                <span className="dot hidden" />
                <div>
                  <b>{h.label}</b>
                  <div className="small muted">
                    ground truth ({h.pos.x.toFixed(1)}, {h.pos.y.toFixed(1)}) · drawn dashed only when this overlay is on
                  </div>
                </div>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

export function AgentPanel({ scout, ally, selected }: { scout: AgentRuntime; ally: AgentRuntime; selected: string | null }) {
  return (
    <section className="panel">
      <h3>Characters</h3>
      <AgentCard a={scout} selected={selected} />
      <AgentCard a={ally} selected={null} />
    </section>
  );
}

function AgentCard({ a, selected }: { a: AgentRuntime; selected: string | null }) {
  const statusLabel: Record<AgentRuntime['status'], string> = {
    idle: 'ready',
    transition: 'changing stance',
    moving: 'in transit',
    inCover: 'in cover',
    failed: 'failed',
  };
  return (
    <div className={`agent-card ${a.status}`}>
      <div className="agent-head">
        <span className="swatch" style={{ background: a.spec.color }} />
        <b>{a.spec.name}</b>
        <span className={`badge ${a.status}`}>{statusLabel[a.status]}</span>
      </div>
      <div className="small">
        ({a.pos.x.toFixed(2)}, {a.pos.y.toFixed(2)}) · {a.stance} · goal {a.goal?.candidateId ?? '—'}
        {selected && selected === a.goal?.candidateId && <span className="muted"> · committed</span>}
      </div>
      {a.failureNote && <div className="small bad-t">failure: {a.failureNote}</div>}
      {a.arrival && (
        <div className={`arrival ${a.arrival.ok ? 'ok' : 'bad'}`}>
          <b>{a.arrival.ok ? 'Arrival verified' : 'Arrival failed'}</b>
          <div className="small">
            measured worst exposure {(a.arrival.measured.worstExposure * 100).toFixed(0)}% vs predicted{' '}
            {(a.arrival.predictedWorstExposure * 100).toFixed(0)}%
          </div>
          <div className="small muted">{a.arrival.matchesPrediction ? 'within one body probe' : 'mismatch recorded'}</div>
          {a.arrival.failures.map((f, i) => (
            <div key={i} className="small bad-t">
              {f.code}: {f.detail}
            </div>
          ))}
          {a.arrival.notes.map((n, i) => (
            <div key={i} className="small muted">
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
