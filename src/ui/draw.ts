import type { Obstacle, Scenario, Stance, Vec2 } from '../kernel/types';
import { STANCE_EYE } from '../kernel/exposure';

export const BASE_PX = 30;
export const OBSTACLE_FILL: Record<string, string> = {
  wall: '#3f4a58',
  crate: '#7a5a35',
  halfWall: '#6d7a4a',
  pillar: '#545e6d',
  barrier: '#4d5259',
};

export function heightLabel(h: number): string {
  if (h >= 1.7) return 'full';
  if (h >= 1.0) return 'crouch';
  return 'none';
}

export function heightColor(h: number): string {
  if (h >= 1.7) return '#94a3b8';
  if (h >= 1.0) return '#a3b36a';
  return '#5b6068';
}

export const STANCE_COLOR: Record<Stance, string> = {
  stand: '#7dd3fc',
  crouch: '#fbbf24',
};

export function drawBoardBase(
  ctx: CanvasRenderingContext2D,
  scale: number,
  scenario: Scenario,
  showHeightTint: boolean,
  showLabels: boolean,
): void {
  const { board, obstacles } = scenario;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = '#14181d';
  ctx.fillRect(0, 0, board.w, board.h);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1 / scale;
  for (let x = 0; x <= board.w; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, board.h);
    ctx.stroke();
  }
  for (let y = 0; y <= board.h; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(board.w, y);
    ctx.stroke();
  }

  for (const o of obstacles) {
    drawObstacle(ctx, o, scale, showHeightTint, showLabels);
  }

  for (const m of scenario.markers) {
    drawMarker(ctx, m.pos, m.label, scale);
  }

  ctx.restore();
}

export function drawObstacle(
  ctx: CanvasRenderingContext2D,
  o: Obstacle,
  scale: number,
  showHeightTint: boolean,
  showLabels: boolean,
): void {
  ctx.fillStyle = OBSTACLE_FILL[o.kind] ?? '#555';
  ctx.globalAlpha = o.cover === false ? 0.45 : 1;
  ctx.fillRect(o.x, o.y, o.w, o.d);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = o.cover === false ? 'rgba(255,255,255,0.18)' : heightColor(o.height);
  ctx.lineWidth = (o.cover === false ? 0.06 : 0.1);
  ctx.strokeRect(o.x, o.y, o.w, o.d);

  if (showHeightTint) {
    const label = heightLabel(o.height);
    ctx.fillStyle = label === 'full' ? 'rgba(148,163,184,0.35)' : label === 'crouch' ? 'rgba(163,179,106,0.35)' : 'rgba(91,96,104,0.3)';
    if (label === 'full') ctx.fillRect(o.x, o.y, o.w, o.d);
    else if (label === 'crouch') {
      ctx.fillRect(o.x, o.y + o.d * 0.35, o.w, o.d * 0.65);
    } else {
      ctx.fillRect(o.x, o.y + o.d * 0.7, o.w, o.d * 0.3);
    }
  }

  if (o.cover === false) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.08;
    ctx.setLineDash([0.2, 0.18]);
    ctx.strokeRect(o.x, o.y, o.w, o.d);
    ctx.restore();
  }

  if (showLabels) {
    ctx.save();
    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    ctx.font = '0.32px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${o.height.toFixed(2)}m`, o.x + o.w / 2, o.y + o.d / 2);
    ctx.restore();
  }
}

export function drawMarker(ctx: CanvasRenderingContext2D, p: Vec2, label: string, scale: number): void {
  ctx.save();
  ctx.strokeStyle = '#e879f9';
  ctx.fillStyle = 'rgba(232,121,249,0.18)';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 0.13, p.y - 0.13);
  ctx.lineTo(p.x + 0.13, p.y + 0.13);
  ctx.moveTo(p.x + 0.13, p.y - 0.13);
  ctx.lineTo(p.x - 0.13, p.y + 0.13);
  ctx.stroke();
  ctx.restore();
  void label;
}

export function drawEyeRay(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  to: Vec2,
  stance: Stance,
  colour: string,
  scale: number,
  dashed = false,
): void {
  const eye = STANCE_EYE[stance];
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1 / scale, 0.025);
  if (dashed) ctx.setLineDash([0.25 / scale, 0.2 / scale]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
  void eye;
}

export function drawUnit(
  ctx: CanvasRenderingContext2D,
  p: Vec2,
  radius: number,
  colour: string,
  stance: Stance,
  label: string,
  scale: number,
  ring = false,
): void {
  ctx.save();
  // body disc
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = stance === 'crouch' ? '#fbbf24' : '#e2e8f0';
  ctx.lineWidth = (stance === 'crouch' ? 0.09 : 0.06);
  ctx.stroke();

  // stance glyph: inner circle size indicates silhouette height
  ctx.beginPath();
  ctx.arc(p.x, p.y, stance === 'crouch' ? radius * 0.45 : radius * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = stance === 'crouch' ? 'rgba(251,191,36,0.55)' : 'rgba(15,23,42,0.45)';
  ctx.fill();

  if (ring) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 0.22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(226,232,240,0.6)';
    ctx.lineWidth = 0.04;
    ctx.setLineDash([0.12, 0.1]);
    ctx.stroke();
  }

  ctx.fillStyle = '#0b1015';
  ctx.font = `0.28px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, p.x, p.y - radius - 0.28);
  ctx.restore();
  void scale;
}

export function drawPath(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  colour: string,
  scale: number,
): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.07;
  ctx.setLineDash([0.28, 0.18]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
  void scale;
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  to: Vec2,
  colour: string,
  width: number,
): void {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 0.28;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(ang - 0.4) * head, to.y - Math.sin(ang - 0.4) * head);
  ctx.lineTo(to.x - Math.cos(ang + 0.4) * head, to.y - Math.sin(ang + 0.4) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
