import { useState } from 'react';
import type { CandidateEvaluation, SelectionResult } from '../kernel/types';
import { faceName } from '../kernel/exposure';

interface Props {
  selection: SelectionResult | null;
  selectedId: string | null;
  failed: string[];
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

type Filter = 'all' | 'valid' | 'rejected';

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function CandidateTable({ selection, selectedId, failed, onHover, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  if (!selection) return <p className="muted">No selection yet. Use “Select cover” to run the kernel.</p>;

  const rows = [...selection.ranked, ...selection.rejected].filter((e) =>
    filter === 'all' ? true : filter === 'valid' ? e.valid : !e.valid,
  );

  return (
    <div className="cand-wrap">
      <div className="toolbar">
        <span className="muted">
          {selection.ranked.length} valid / {selection.rejected.length} rejected / {selection.candidates.length} total
        </span>
        <div className="seg">
          {(['all', 'valid', 'rejected'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="cand-head">
        <span>#</span>
        <span>candidate</span>
        <span>stance</span>
        <span>prot</span>
        <span title="worst exposure if the clue is off by its uncertainty">edge</span>
        <span>travel</span>
        <span title="minimum of body clearance and stance-change room">room</span>
        <span>util</span>
      </div>
      <div className="cand-list">
        {rows.map((e) => (
          <CandidateRow
            key={e.candidate.id}
            e={e}
            selected={e.candidate.id === selectedId}
            failed={failed.includes(e.candidate.id)}
            expanded={open === e.candidate.id}
            onHover={onHover}
            onSelect={onSelect}
            onToggle={() => setOpen(open === e.candidate.id ? null : e.candidate.id)}
          />
        ))}
        {rows.length === 0 && <p className="muted pad">No candidates in this filter.</p>}
      </div>
    </div>
  );
}

function CandidateRow(props: {
  e: CandidateEvaluation;
  selected: boolean;
  failed: boolean;
  expanded: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onToggle: () => void;
}) {
  const { e, selected, failed, expanded } = props;
  const stanceEval = e.stances[e.chosenStance];
  const worst = stanceEval.worstExposure;
  const prot = 1 - worst;
  return (
    <div
      className={`cand-row ${selected ? 'sel' : ''} ${e.valid ? '' : 'bad'} ${failed ? 'failed' : ''}`}
      onMouseEnter={() => props.onHover(e.candidate.id)}
      onMouseLeave={() => props.onHover(null)}
      onClick={() => props.onSelect(e.candidate.id)}
    >
      <div className="cand-main">
        <span className="rank">{e.rank ?? (e.valid ? '·' : '✕')}</span>
        <span className="cand-id" title={`${e.candidate.obstacleId} ${faceName(e.candidate.face)} face, post ${e.candidate.id.split('/').pop()}`}>
          {e.candidate.obstacleId}
          <small className="post">
            {e.candidate.face}#{e.candidate.id.split('/').pop()}
          </small>
          {failed && <small className="flag">failed</small>}
        </span>
        <span className={`stance ${e.chosenStance}`}>{e.chosenStance === 'stand' ? 'stand' : 'crouch'}</span>
        <span className="bar-cell" title={`nominal worst exposure ${pct(worst)}`}>
          <span className="bar">
            <span className="fill" style={{ width: `${Math.round(prot * 100)}%`, background: prot > 0.6 ? '#4ade80' : prot > 0.3 ? '#facc15' : '#f87171' }} />
          </span>
          <small>{pct(prot)}</small>
        </span>
        <span className={`edge ${stanceEval.uncertaintyWorstExposure > 0.5 ? 'bad-t' : stanceEval.uncertaintyWorstExposure > 0.15 ? 'warn-t' : ''}`}>
          {pct(stanceEval.uncertaintyWorstExposure)}
        </span>
        <span>{e.travelTimeSec === null ? '—' : `${e.travelTimeSec.toFixed(1)}s`}</span>
        <span>{Math.min(e.candidate.clearanceMargin, e.candidate.transitionMargin).toFixed(2)}</span>
        <span className="util">{e.valid ? e.components.utility.toFixed(3) : '—'}</span>
        <button
          className="expand"
          onClick={(ev) => {
            ev.stopPropagation();
            props.onToggle();
          }}
          aria-label="details"
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded && <CandidateDetail e={e} />}
    </div>
  );
}

export function CandidateDetail({ e }: { e: CandidateEvaluation }) {
  const stanceEval = e.stances[e.chosenStance];
  return (
    <div className="detail">
      <div className="detail-cols">
        <div>
          <h5>Why this stance</h5>
          <p className="small">{e.stanceReason}</p>
          <h5>Per-clue measurement ({e.chosenStance})</h5>
          <p className="tiny muted">
            “visible” is exposure at the clue's nominal point; “worst” is the highest exposure found around its ±uncertainty ring. The policy
            limit applies to the nominal value, so a spot can be valid and still show a high edge case — that is listed, not hidden.
          </p>
          <table className="mini">
            <thead>
              <tr>
                <th>clue</th>
                <th>dist</th>
                <th>bearing</th>
                <th>visible</th>
                <th>worst</th>
                <th>blockers</th>
              </tr>
            </thead>
            <tbody>
              {stanceEval.perClue.map((c) => (
                <tr key={c.clueId}>
                  <td>{c.clueId}</td>
                  <td>{c.distance.toFixed(1)} m</td>
                  <td>{c.bearingDeg.toFixed(0)}°</td>
                  <td className={c.exposure > 0.5 ? 'bad-t' : 'good-t'}>{pct(c.exposure)}</td>
                  <td>{pct(c.worstExposure)}</td>
                  <td>{c.blockers.join(', ') || '—'}</td>
                </tr>
              ))}
              {stanceEval.perClue.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    no clues supplied
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="small muted">
            Body probes at heights {[0.15, 0.45, 0.75, 1.05, 1.4, 1.75].join(', ')} m. Eye at{' '}
            {stanceEval.eyeHeight.toFixed(2)} m. {stanceEval.openDirectionCount}/16 eye-height directions open.
          </p>
        </div>
        <div>
          <h5>Utility breakdown</h5>
          <table className="mini">
            <tbody>
              {e.components.terms.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.weight.toFixed(2)} ×</td>
                  <td>{t.value.toFixed(3)}</td>
                  <td>= {t.contribution.toFixed(3)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>utility</td>
                <td />
                <td />
                <td>= {e.components.utility.toFixed(3)}</td>
              </tr>
            </tbody>
          </table>
          <h5>Geometry</h5>
          <ul className="small">
            <li>body clearance {e.candidate.clearanceMargin.toFixed(3)} m (nearest: {e.candidate.nearestObstacleId ?? 'board edge'})</li>
            <li>stance-change room {e.candidate.transitionMargin.toFixed(3)} m</li>
            <li>route {e.pathLength === null ? 'none' : `${e.pathLength.toFixed(2)} m`}, {e.path.length} points, connector verified: {String(e.routeClear)}</li>
            {e.reservationsNear.map((r) => (
              <li key={r.agentId}>reservation near: {r.agentId} at {r.distance.toFixed(2)} m</li>
            ))}
          </ul>
          <h5>Rejections</h5>
          {e.rejectReasons.length === 0 ? (
            <p className="small good-t">none</p>
          ) : (
            <ul className="small bad-t">
              {e.rejectReasons.map((r, i) => (
                <li key={i}>
                  <b>{r.code}</b>: {r.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="detail-cols">
        <div>
          <h5>Pros</h5>
          <ul className="small good-t">
            {e.pros.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
            {e.pros.length === 0 && <li className="muted">none measured</li>}
          </ul>
        </div>
        <div>
          <h5>Cons</h5>
          <ul className="small bad-t">
            {e.cons.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
            {e.cons.length === 0 && <li className="muted">none measured</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
