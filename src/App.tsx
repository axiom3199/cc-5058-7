import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SCENARIOS, scenarioById } from './kernel/scenarios';
import { Simulation, clonePolicy } from './kernel/engine';
import type { Policy, Scenario, SelectionResult, Stance, Vec2 } from './kernel/types';
import { DEFAULT_POLICY } from './kernel/selection';
import { BoardCanvas, type Overlays } from './components/BoardCanvas';
import { CandidateTable, CandidateDetail } from './components/CandidateTable';
import { CluesPanel, AgentPanel } from './components/Panels';
import { Timeline } from './components/Timeline';
import { buildReplayFile, downloadJson } from './ui/replay';

const SPEEDS = [0, 0.25, 0.5, 1, 2, 4];

export default function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [sim, setSim] = useState(() => new Simulation(scenarioById(SCENARIOS[0].id)));
  const [tick, setTick] = useState(0);
  const [policy, setPolicy] = useState<Policy>(() => clonePolicy(DEFAULT_POLICY));
  const [overlays, setOverlays] = useState<Overlays>({
    candidates: true,
    rejected: false,
    rays: true,
    probes: false,
    route: true,
    heights: true,
    labels: true,
    hidden: false,
    clearance: false,
  });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null); // null = live
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);

  const scenario: Scenario = sim.scenario;
  const selection: SelectionResult | null = sim.latestSelection(scenario.agent.id);
  const selectedId = pickedId ?? selection?.selected?.candidate.id ?? null;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const resetScenario = useCallback(
    (id: string) => {
      const next = new Simulation(scenarioById(id), { policy });
      setSim(next);
      setScenarioId(id);
      setCursor(null);
      setPickedId(null);
      setPlaying(false);
      refresh();
    },
    [policy, refresh],
  );

  const run = useCallback(
    (fn: (s: Simulation) => void) => {
      try {
        fn(sim);
        setCursor(null);
        refresh();
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sim, refresh],
  );

  // animation loop
  useEffect(() => {
    if (!playing) {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      return;
    }
    last.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last.current) / 1000) * speed;
      last.current = now;
      if (dt > 0) {
        sim.step(dt);
        setTick((t) => t + 1);
      }
      const busy = Object.values(sim.agents).some((a) => a.status === 'moving' || a.status === 'transition');
      if (!busy) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed, sim]);

  const view = useMemo(() => {
    // Which snapshot to render: live state or a replay frame.
    if (cursor === null) {
      return {
        live: true,
        scout: sim.agent,
        ally: sim.ally,
        selection,
        failed: sim.failedFor(sim.agent.id),
      };
    }
    const frame = sim.replays[Math.min(cursor, sim.replays.length - 1)];
    if (!frame) return { live: true, scout: sim.agent, ally: sim.ally, selection, failed: sim.failedFor(sim.agent.id) };
    const agents = frame.snapshot.agents;
    const scoutSnap = agents.find((a) => a.id === scenario.agent.id)!;
    const allySnap = agents.find((a) => a.id === scenario.ally.id)!;
    const sel = frame.snapshot.selections.filter((s) => s.agentId === scenario.agent.id).slice(-1)[0] ?? selection;
    return {
      live: false,
      scout: { ...sim.agent, pos: scoutSnap.pos, stance: scoutSnap.stance, status: scoutSnap.status, goal: scoutSnap.goal, arrival: scoutSnap.arrival, failureNote: scoutSnap.failureNote, path: scoutSnap.path },
      ally: { ...sim.ally, pos: allySnap.pos, stance: allySnap.stance, status: allySnap.status },
      selection: sel,
      failed: frame.snapshot.failedCandidates[scenario.agent.id] ?? [],
    };
  }, [cursor, sim, tick, selection, scenario.agent.id, scenario.ally.id]);

  const candidateSet = view.selection?.candidates ?? [];
  const hoverEval = candidateSet.find((e) => e.candidate.id === hoverId) ?? null;
  const pickedEval = candidateSet.find((e) => e.candidate.id === selectedId) ?? null;
  const detailEval = hoverEval ?? pickedEval;

  const updatePolicy = (p: Policy) => {
    setPolicy(p);
    sim.setPolicy(p);
    refresh();
    setCursor(null);
  };

  const selectCoverNow = () => {
    run((s) => {
      s.assign(scenario.agent.id);
    });
    setPickedId(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Cover Selection Sandbox</h1>
          <span className="tag">fictional game model · not real-world tactics</span>
        </div>
        <div className="topbar-actions">
          <select value={scenarioId} onChange={(e) => resetScenario(e.target.value)}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={selectCoverNow}>
            Select cover
          </button>
          <button onClick={() => run((s) => { s.assign(scenario.ally.id); })}>Wing selects</button>
          <button onClick={() => run((s) => { s.toggleAllyAuto(); })}>
            {sim.allyAutoEnabled ? 'Wing auto ✓' : 'Wing auto'}
          </button>
        </div>
      </header>

      <div className="scenario-desc">
        <b>{scenario.name}.</b> {scenario.description}
        {scenario.notes.length > 0 && (
          <ul className="small">
            {scenario.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>

      {error && <div className="error">Kernel error: {error} — see console.</div>}

      <div className="layout">
        <aside className="col-left">
          <section className="panel">
            <h3>Playback</h3>
            <div className="btn-row">
              <button className={playing ? 'primary' : ''} onClick={() => { setCursor(null); setPlaying((p) => !p); }}>
                {playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button onClick={() => run((s) => { s.assign(scenario.agent.id); s.simulateUntil(40); })}>Resolve fully</button>
              <button className="ghost" onClick={() => setCursor(null)} disabled={cursor === null}>
                Live
              </button>
            </div>
            <div className="btn-row small muted">speed
              {SPEEDS.map((sp) => (
                <button key={sp} className={speed === sp ? 'on ghost' : 'ghost'} onClick={() => setSpeed(sp)} disabled={sp === 0}>
                  {sp}×
                </button>
              ))}
            </div>
            <div className="btn-row">
              <button onClick={() => run((s) => { if (!s.blockGoalWithAlly(scenario.agent.id)) throw new Error('Select cover first so there is a goal to block.'); })}>
                Park Wing on goal (test)
              </button>
              <button onClick={() => run((s) => { if (!s.agent.goal) throw new Error('No goal; select cover first.'); s.forceArrival(scenario.agent.id); })}>
                Force arrival check
              </button>
            </div>
            <div className="btn-row">
              <button onClick={() => resetScenario(scenarioId)}>Reset scenario</button>
              <button
                onClick={() =>
                  downloadJson(
                    `replay-${scenarioId}-${Date.now()}.json`,
                    buildReplayFile(scenario, sim.policy, sim.replays, sim.events, sim.failedCandidates),
                  )
                }
                disabled={sim.replays.length === 0}
              >
                Export replay (JSON)
              </button>
            </div>
            <p className="tiny muted">
              A replay bundles the scenario, policy, every event and the snapshot live at that event, so a reviewer can step through the
              same frames offline.
            </p>
          </section>

          <CluesPanel
            scenario={scenario}
            clues={scenario.clues}
            showHidden={overlays.hidden}
            onToggleHidden={(v) => setOverlays({ ...overlays, hidden: v })}
          />

          <AgentPanel scout={view.scout} ally={view.ally} selected={selectedId} />

          <section className="panel">
            <h3>Overlays</h3>
            <div className="overlay-grid">
              {(Object.keys(overlays) as (keyof Overlays)[]).map((k) => (
                <label key={k} className="check">
                  <input
                    type="checkbox"
                    checked={overlays[k]}
                    onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })}
                  />
                  <span>{k}</span>
                </label>
              ))}
            </div>
            <p className="small muted">
              “rays” are eye-height lines to each clue from the character. “probes” adds body-height samples for the inspected candidate.
              “hidden” is an admin ground-truth overlay and never changes the selection input.
            </p>
          </section>
        </aside>

        <main className="col-map">
          <BoardCanvas
            scenario={scenario}
            scoutPos={view.scout.pos}
            scoutStance={view.scout.stance}
            scoutStatus={view.scout.status}
            allyPos={view.ally.pos}
            allyStance={view.ally.stance}
            candidateSet={candidateSet}
            selectedId={selectedId}
            hoverId={hoverId}
            path={view.scout.path ?? []}
            arrival={view.scout.arrival ?? null}
            failedIds={view.failed}
            overlays={overlays}
            onDragScout={(p) => {
              if (!view.live) return;
              run((s) => { s.moveAgent(scenario.agent.id, p); s.preview(scenario.agent.id); });
            }}
            onDragAlly={(p) => {
              if (!view.live) return;
              run((s) => { s.moveAgent(scenario.ally.id, p); });
            }}
            onDragHostile={(id, p) => {
              if (!view.live) return;
              run((s) => s.setHostileClueFromHostile(id, p));
            }}
            onPickCandidate={(id) => setPickedId(id)}
          />
          {!view.live && <div className="replay-banner">Replay frame — drag disabled. Press Live to resume.</div>}
          <ReasoningPanel selection={view.selection} hoverEval={hoverEval} />
        </main>

        <aside className="col-right">
          <section className="panel">
            <h3>Candidate evaluation</h3>
            <p className="small muted">
              Ranked by an additive utility, but every rejected row keeps its individual reasons and the detail view keeps per-clue percentages,
              both stances and the raw geometry. A high total never hides a failure.
            </p>
            <CandidateTable
              selection={view.selection}
              selectedId={selectedId}
              failed={view.failed}
              onHover={setHoverId}
              onSelect={setPickedId}
            />
          </section>
          <section className="panel">
            <h3>Inspector</h3>
            {detailEval ? <CandidateDetail e={detailEval} /> : <p className="muted small">Hover or pick a candidate.</p>}
          </section>
          <PolicyPanel policy={policy} onChange={updatePolicy} />
        </aside>
      </div>

      <Timeline
        events={sim.events}
        version={tick}
        cursor={cursor === null ? sim.events.length - 1 : cursor}
        onCursor={(i) => {
          setPlaying(false);
          setCursor(i >= sim.events.length - 1 ? null : i);
        }}
      />
      <footer className="footer small muted">
        This is a simplified two-dimensional game model. It is not a tactical or real-world guide. The cover numbers are only
        valid inside this fictional sandbox.
      </footer>
    </div>
  );
}

function ReasoningPanel({ selection, hoverEval }: { selection: SelectionResult | null; hoverEval: SelectionResult['candidates'][number] | null }) {
  return (
    <section className="panel reasoning">
      <h3>Selection result</h3>
      {selection ? (
        <>
          <p className="tiny muted">
            {selection.id} · evaluated from ({selection.originPos.x.toFixed(2)}, {selection.originPos.y.toFixed(2)}) at t={selection.createdAt.toFixed(2)}s ·
            reservation book v{selection.reservationVersion}. Recomputes in transit re-plan from the live position and appear here as they happen.
          </p>
          <div className="rationale">
            {selection.rationale.map((r, i) => (
              <p key={i} className="small">
                {r}
              </p>
            ))}
          </div>
          <div className="result-grid">
            <div>
              <h5>Selected</h5>
              {selection.selected ? (
                <p className="small">
                  <b>{selection.selected.candidate.id}</b> · {selection.selected.chosenStance} ·{' '}
                  {selection.selected.travelTimeSec?.toFixed(2)} s · utility {selection.selected.components.utility.toFixed(3)}
                </p>
              ) : (
                <p className="small bad-t">none — all candidates rejected</p>
              )}
            </div>
            <div>
              <h5>Rejection summary</h5>
              {selection.rejectionSummary.length === 0 ? (
                <p className="small good-t">none</p>
              ) : (
                <ul className="small">
                  {selection.rejectionSummary.map((r) => (
                    <li key={r.code}>
                      {r.code} × {r.count}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="tiny muted">{selection.clueInputNote}</p>
          {hoverEval ? <p className="tiny muted">hovering candidate detail is shown in the Inspector.</p> : null}
        </>
      ) : (
        <p className="muted small">Run “Select cover” to populate the audit table.</p>
      )}
    </section>
  );
}

function PolicyPanel({ policy, onChange }: { policy: Policy; onChange: (p: Policy) => void }) {
  const setWeight = (name: keyof Policy['weights'], v: number) =>
    onChange({ ...policy, weights: { ...policy.weights, [name]: v } });
  return (
    <section className="panel">
      <h3>Policy</h3>
      <label className="row">
        <span>max worst exposure</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={policy.maxWorstExposure}
          onChange={(e) => onChange({ ...policy, maxWorstExposure: Number(e.target.value) })}
        />
        <b>{Math.round(policy.maxWorstExposure * 100)}%</b>
      </label>
      <label className="row">
        <span>stance</span>
        <select value={policy.stanceMode} onChange={(e) => onChange({ ...policy, stanceMode: e.target.value as Policy['stanceMode'] })}>
          <option value="auto">auto</option>
          <option value="stand">pin stand</option>
          <option value="crouch">pin crouch</option>
        </select>
      </label>
      <label className="row">
        <span>max travel</span>
        <input
          type="range"
          min={2}
          max={30}
          step={1}
          value={policy.maxTravelSec}
          onChange={(e) => onChange({ ...policy, maxTravelSec: Number(e.target.value) })}
        />
        <b>{policy.maxTravelSec}s</b>
      </label>
      <details>
        <summary className="small">utility weights</summary>
        {(Object.keys(policy.weights) as (keyof Policy['weights'])[]).map((k) => (
          <label className="row" key={k}>
            <span>{k}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={policy.weights[k]}
              onChange={(e) => setWeight(k, Number(e.target.value))}
            />
            <b>{policy.weights[k].toFixed(2)}</b>
          </label>
        ))}
      </details>
    </section>
  );
}
