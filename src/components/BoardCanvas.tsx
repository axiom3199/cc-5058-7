import { useEffect, useRef, useState } from 'react';
import type {
  ArrivalCheck,
  CandidateEvaluation,
  Scenario,
  Stance,
  Vec2,
} from '../kernel/types';
import { STANCE_EYE, rayVisible, exposureAt } from '../kernel/exposure';
import { dist, round } from '../kernel/geometry';
import {
  BASE_PX,
  drawArrow,
  drawBoardBase,
  drawEyeRay,
  drawPath,
  drawUnit,
} from '../ui/draw';

export interface Overlays {
  candidates: boolean;
  rejected: boolean;
  rays: boolean;
  probes: boolean;
  route: boolean;
  heights: boolean;
  labels: boolean;
  hidden: boolean;
  clearance: boolean;
}

interface Props {
  scenario: Scenario;
  scoutPos: Vec2;
  scoutStance: Stance;
  scoutStatus: string;
  allyPos: Vec2;
  allyStance: Stance;
  candidateSet: CandidateEvaluation[];
  selectedId: string | null;
  hoverId: string | null;
  path: Vec2[];
  arrival: ArrivalCheck | null;
  failedIds: string[];
  overlays: Overlays;
  onDragScout: (p: Vec2) => void;
  onDragAlly: (p: Vec2) => void;
  onDragHostile: (hostileId: string, p: Vec2) => void;
  onPickCandidate: (id: string) => void;
}

type DragTarget = { kind: 'scout' | 'ally' | 'hostile'; id?: string } | null;

export function BoardCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [drag, setDrag] = useState<DragTarget>(null);
  const [cursorWorld, setCursorWorld] = useState<Vec2 | null>(null);

  const { scenario } = props;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const w = el.clientWidth;
      const s = Math.min(w / scenario.board.w, 620 / scenario.board.h);
      setScale(Math.max(18, s));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [scenario.board.w, scenario.board.h]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = scenario.board.w * scale;
    const h = scenario.board.h * scale;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx);
  });

  function draw(ctx: CanvasRenderingContext2D) {
    const o = props.overlays;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = '#0f1318';
    ctx.fillRect(0, 0, scenario.board.w, scenario.board.h);
    ctx.restore();

    drawBoardBase(ctx, scale, scenario, o.heights, o.labels);

    ctx.save();
    ctx.scale(scale, scale);

    // unreachable/valid candidate dots
    if (o.candidates || o.rejected) {
      for (const e of props.candidateSet) {
        const show = e.valid ? o.candidates : o.rejected;
        if (!show) continue;
        const p = e.candidate.pos;
        const isSel = e.candidate.id === props.selectedId;
        const isHover = e.candidate.id === props.hoverId;
        const failed = props.failedIds.includes(e.candidate.id);
        const worst = e.stances[e.chosenStance].worstExposure;
        const prot = 1 - worst;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isSel || isHover ? 0.2 : 0.12, 0, Math.PI * 2);
        if (failed) {
          ctx.fillStyle = '#ef4444';
        } else if (!e.valid) {
          ctx.fillStyle = 'rgba(248,113,113,0.55)';
        } else {
          const g = Math.round(160 + prot * 80);
          const r = Math.round(200 - prot * 120);
          ctx.fillStyle = `rgb(${r},${g},90)`;
        }
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 0.09;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 0.32, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // clearance rings for valid candidates
    if (o.clearance) {
      for (const e of props.candidateSet) {
        if (!e.valid) continue;
        const p = e.candidate.pos;
        ctx.beginPath();
        ctx.arc(p.x, p.y, scenario.agent.radius + Math.max(0, Math.min(0.8, e.candidate.transitionMargin)), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(96,165,250,0.22)';
        ctx.lineWidth = 0.03;
        ctx.stroke();
      }
    }

    // route
    if (o.route && props.path.length > 1) {
      drawPath(ctx, props.path, 'rgba(125,211,252,0.9)', scale);
    }

    // eye rays from scout position (or selected candidate) to each clue
    if (o.rays) {
      const origin = props.scoutPos;
      const stance = props.scoutStance;
      const fromH = STANCE_EYE[stance];
      for (const clue of scenario.clues) {
        const r = rayVisible(
          { board: scenario.board, obstacles: scenario.obstacles },
          origin,
          fromH,
          clue.pos,
          1.2,
        );
        drawEyeRay(ctx, origin, clue.pos, stance, r.visible ? 'rgba(248,113,113,0.8)' : 'rgba(74,222,128,0.65)', scale, !r.visible);
      }
    }

    // body probes for selected candidate
    if (o.probes && props.selectedId) {
      const sel = props.candidateSet.find((e) => e.candidate.id === props.selectedId);
      if (sel) {
        for (const clue of scenario.clues) {
          for (const h of [0.15, 0.75, 1.4]) {
            const r = rayVisible(
              { board: scenario.board, obstacles: scenario.obstacles },
              sel.candidate.pos,
              STANCE_EYE[sel.chosenStance],
              clue.pos,
              h,
            );
            const to = {
              x: sel.candidate.pos.x + (clue.pos.x - sel.candidate.pos.x) * 0.96,
              y: sel.candidate.pos.y + (clue.pos.y - sel.candidate.pos.y) * 0.96,
            };
            drawEyeRay(
              ctx,
              sel.candidate.pos,
              to,
              sel.chosenStance,
              r.visible ? 'rgba(253,224,71,0.75)' : 'rgba(45,212,191,0.5)',
              scale,
              true,
            );
          }
        }
      }
    }

    // clue arrows / markers
    for (const clue of scenario.clues) {
      const kind = clue.source;
      const colour = kind === 'sighting' ? '#f87171' : kind === 'sound' ? '#c084fc' : '#fb923c';
      ctx.beginPath();
      ctx.arc(clue.pos.x, clue.pos.y, 0.28, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0b1015';
      ctx.lineWidth = 0.05;
      ctx.stroke();
      // uncertainty ring
      if (clue.uncertainty > 0.05) {
        ctx.beginPath();
        ctx.arc(clue.pos.x, clue.pos.y, clue.uncertainty, 0, Math.PI * 2);
        ctx.setLineDash([0.15, 0.12]);
        ctx.strokeStyle = colour;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 0.04;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = '#f8fafc';
      ctx.font = '0.3px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(clue.label, clue.pos.x, clue.pos.y - 0.38);

      // bearing arrow from scout to clue
      if (props.scoutPos.x !== undefined) {
        drawArrow(ctx, props.scoutPos, clue.pos, kind === 'sighting' ? 'rgba(248,113,113,0.32)' : 'rgba(192,132,252,0.22)', 0.035);
      }
    }

    // hidden hostiles (admin)
    if (o.hidden) {
      for (const h of scenario.hostiles.filter((x) => x.hidden)) {
        ctx.beginPath();
        ctx.arc(h.pos.x, h.pos.y, h.radius + 0.25, 0, Math.PI * 2);
        ctx.setLineDash([0.12, 0.1]);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 0.06;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(239,68,68,0.35)';
        ctx.fill();
        ctx.fillStyle = '#fca5a5';
        ctx.font = '0.26px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(h.label, h.pos.x, h.pos.y + h.radius + 0.5);
      }
      // ground-truth sightlines from scout to hidden hostiles
      for (const h of scenario.hostiles.filter((x) => x.hidden)) {
        const ex = exposureAt(
          { board: scenario.board, obstacles: scenario.obstacles },
          props.scoutPos,
          props.scoutStance,
          h.pos,
        );
        drawEyeRay(
          ctx,
          props.scoutPos,
          h.pos,
          props.scoutStance,
          ex.exposure > 0.5 ? 'rgba(239,68,68,0.85)' : ex.exposure > 0 ? 'rgba(251,191,36,0.6)' : 'rgba(148,163,184,0.5)',
          scale,
          true,
        );
        const mid = { x: (props.scoutPos.x + h.pos.x) / 2, y: (props.scoutPos.y + h.pos.y) / 2 };
        ctx.fillStyle = ex.exposure > 0.5 ? '#f87171' : '#fbbf24';
        ctx.font = '0.3px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`TRUTH ${Math.round(ex.exposure * 100)}%`, mid.x, mid.y - 0.2);
      }
    }

    // ally + scout
    drawUnit(ctx, props.allyPos, scenario.ally.radius, scenario.ally.color, props.allyStance, scenario.ally.name, scale);
    drawUnit(
      ctx,
      props.scoutPos,
      scenario.agent.radius,
      scenario.agent.color,
      props.scoutStance,
      scenario.agent.name,
      scale,
      props.scoutStatus === 'moving' || props.scoutStatus === 'inCover',
    );

    // arrival marker
    if (props.arrival) {
      const a = props.arrival.measured;
      ctx.beginPath();
      ctx.arc(a.pos.x, a.pos.y, 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = props.arrival.ok ? '#4ade80' : '#ef4444';
      ctx.lineWidth = 0.07;
      ctx.stroke();
    }

    // cursor readout
    if (cursorWorld) {
      ctx.fillStyle = 'rgba(226,232,240,0.7)';
      ctx.font = '0.26px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${cursorWorld.x.toFixed(2)}, ${cursorWorld.y.toFixed(2)}`, 0.2, scenario.board.h - 0.2);
    }

    ctx.restore();
  }

  function toWorld(ev: React.PointerEvent<HTMLCanvasElement>): Vec2 {
    const rect = ev.currentTarget.getBoundingClientRect();
    // The canvas may be CSS-scaled (max-width:100%); map client pixels through
    // the displayed size rather than assuming the backing-store scale.
    const px = ((ev.clientX - rect.left) / rect.width) * scenario.board.w;
    const py = ((ev.clientY - rect.top) / rect.height) * scenario.board.h;
    return { x: round(px, 3), y: round(py, 3) };
  }

  function onPointerDown(ev: React.PointerEvent<HTMLCanvasElement>) {
    const p = toWorld(ev);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const clickR = 0.75;
    if (dist(p, props.scoutPos) <= clickR) {
      setDrag({ kind: 'scout' });
      return;
    }
    if (dist(p, props.allyPos) <= clickR) {
      setDrag({ kind: 'ally' });
      return;
    }
    for (const h of scenario.hostiles) {
      if (h.hidden) continue;
      if (dist(p, h.pos) <= clickR) {
        setDrag({ kind: 'hostile', id: h.id });
        return;
      }
    }
    // candidate picking
    let best: { id: string; d: number } | null = null;
    for (const e of props.candidateSet) {
      const d = dist(p, e.candidate.pos);
      if (d < 0.45 && (!best || d < best.d)) best = { id: e.candidate.id, d };
    }
    if (best) props.onPickCandidate(best.id);
  }

  function onPointerMove(ev: React.PointerEvent<HTMLCanvasElement>) {
    const p = toWorld(ev);
    setCursorWorld(p);
    if (!drag) return;
    if (drag.kind === 'scout') props.onDragScout(p);
    if (drag.kind === 'ally') props.onDragAlly(p);
    if (drag.kind === 'hostile' && drag.id) props.onDragHostile(drag.id, p);
  }

  function onPointerUp() {
    setDrag(null);
  }

  return (
    <div className="board-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setCursorWorld(null);
          setDrag(null);
        }}
        style={{ cursor: drag ? 'grabbing' : 'crosshair', touchAction: 'none', borderRadius: 8 }}
      />
      <div className="legend">
        <span><i className="sw scout" />Scout</span>
        <span><i className="sw ally" />Wing</span>
        <span><i className="sw cand" />valid candidate</span>
        <span><i className="sw rej" />rejected</span>
        <span><i className="sw clue" />clue</span>
        <span><i className="sw marker" />decorative marker</span>
        <span className="muted">drag characters and visible hostiles</span>
      </div>
      <div className="scale-note muted">1 square = 1 m · board {scenario.board.w}×{scenario.board.h} m</div>
      <span style={{ display: 'none' }}>{BASE_PX}</span>
    </div>
  );
}
