import { useEffect, useMemo, useRef, useState } from 'react';
import type { SimEvent } from '../kernel/engine';

const KIND_LABEL: Record<string, string> = {
  scenario: 'scenario',
  select: 'select',
  move_start: 'move',
  recompute: 'recompute',
  arrive: 'arrive',
  arrival_pass: 'arrival ✓',
  arrival_fail: 'arrival ✕',
  feedback: 'feedback',
  clue_move: 'clue',
  reservation_claim: 'reserve',
  reservation_release: 'release',
  stance: 'stance',
  note: 'note',
};

export function Timeline({
  events,
  cursor,
  onCursor,
  version,
}: {
  events: SimEvent[];
  cursor: number;
  onCursor: (i: number) => void;
  version: number;
}) {
  const [filter, setFilter] = useState<string>('all');
  const cursorRow = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    cursorRow.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, filter, version]);
  // events is mutated in place by the engine, so derive from its length and an
  // explicit version counter rather than the array identity.
  const filtered = useMemo(
    () => events.filter((e) => (filter === 'all' ? true : e.kind === filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, events.length, filter, version],
  );
  const kinds = useMemo(
    () => [...new Set(events.map((e) => e.kind))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events.length, version],
  );

  return (
    <section className="panel timeline">
      <div className="toolbar">
        <h3>Timeline &amp; replay</h3>
        <div className="toolbar-right">
          <button className="ghost" onClick={() => onCursor(0)} disabled={cursor === 0}>
            ⏮
          </button>
          <button className="ghost" onClick={() => onCursor(Math.max(0, cursor - 1))} disabled={cursor === 0}>
            ◀
          </button>
          <span className="muted small">
            {events.length === 0 ? '0 / 0' : `${cursor + 1} / ${events.length}`}
          </span>
          <button className="ghost" onClick={() => onCursor(Math.min(events.length - 1, cursor + 1))} disabled={cursor >= events.length - 1}>
            ▶
          </button>
          <button className="ghost" onClick={() => onCursor(events.length - 1)} disabled={cursor >= events.length - 1}>
            ⏭
          </button>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">all events</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ol className="event-list">
        {filtered.map((e) => {
          const idx = events.indexOf(e);
          return (
            <li
              key={e.seq}
              ref={idx === cursor ? cursorRow : undefined}
              className={`ev ${e.kind} ${idx === cursor ? 'current' : ''} ${idx > cursor ? 'future' : ''}`}
              onClick={() => onCursor(idx)}
            >
              <span className="ev-t">{e.t.toFixed(2)}s</span>
              <span className={`ev-kind ${e.kind}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span className="ev-actor">{e.actor}</span>
              <span className="ev-text">{e.text}</span>
            </li>
          );
        })}
        {filtered.length === 0 && <li className="muted small pad">no events</li>}
      </ol>
    </section>
  );
}
