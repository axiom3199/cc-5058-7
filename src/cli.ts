#!/usr/bin/env tsx
/**
 * Auxiliary CLI for the cover-selection kernel. The graphical sandbox
 * (`npm run dev`) is the primary interface; this only lets you inspect or
 * script a selection without a browser.
 */
import { SCENARIOS, scenarioById } from './kernel/scenarios';
import { ReservationBook } from './kernel/reservations';
import { DEFAULT_POLICY, selectCover, measureArrival } from './kernel/selection';
import { SCENARIOS as ALL } from './kernel/scenarios';
import { makeSim } from './kernel/engine';
import type { Policy } from './kernel/types';
import { faceName } from './kernel/exposure';

interface Args {
  scenario: string;
  json: boolean;
  all: boolean;
  simulate: boolean;
  clue?: { id: string; x: number; y: number };
  exposure?: number;
  stance: Policy['stanceMode'];
  maxExposure?: number;
  agent?: string;
  listScenarios: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: ALL[0].id,
    json: false,
    all: false,
    simulate: false,
    stance: 'auto',
    listScenarios: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scenario':
      case '-s':
        args.scenario = argv[++i];
        break;
      case '--all':
        args.all = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--simulate':
        args.simulate = true;
        break;
      case '--list':
        args.listScenarios = true;
        break;
      case '--clue':
        args.clue = { id: argv[++i], x: Number(argv[++i]), y: Number(argv[++i]) };
        break;
      case '--uncertainty':
        args.exposure = Number(argv[++i]);
        break;
      case '--stance':
        args.stance = argv[++i] as Policy['stanceMode'];
        break;
      case '--max-exposure':
        args.maxExposure = Number(argv[++i]);
        break;
      case '--agent':
        args.agent = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`Unknown flag ${a}`);
          args.help = true;
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Cover-selection CLI (auxiliary; the graphical sandbox is primary)

Usage: npm run cover -- [options]

  --scenario, -s <id>     scenario id (see --list)
  --all                   summarise every scenario
  --simulate              move the character and verify arrival
  --clue <id> <x> <y>     move a clue endpoint before selecting
  --uncertainty <m>       override uncertainty for the moved clue
  --stance <mode>         auto | stand | crouch
  --max-exposure <0..1>   override the exposure limit
  --json                  machine-readable selection result
  --list                  list scenario ids
  --help, -h              this message

The same selector drives the browser controls. Open the graphical sandbox with:
  npm run dev
  (then choose a scenario and press "Select cover"; see README for the entry point)
`);
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function runOne(id: string, args: Args): number {
  const scenario = scenarioById(id);
  if (args.clue) {
    const clue = scenario.clues.find((c) => c.id === args.clue!.id);
    if (!clue) {
      console.error(`No clue "${args.clue.id}" in ${id}. Available: ${scenario.clues.map((c) => c.id).join(', ')}`);
      return 2;
    }
    clue.pos = { x: args.clue.x, y: args.clue.y };
    clue.ageSec = 0;
    if (args.exposure !== undefined) clue.uncertainty = args.exposure;
    const hostile = scenario.hostiles.find((h) => h.clueId === clue.id);
    if (hostile && !hostile.hidden) hostile.pos = { ...clue.pos };
  }
  const policy: Policy = {
    ...DEFAULT_POLICY,
    stanceMode: args.stance,
    ...(args.maxExposure !== undefined ? { maxWorstExposure: args.maxExposure } : {}),
  };

  if (args.simulate) {
    const sim = makeSim(scenario, { policy });
    const sel = sim.assign(args.agent ?? scenario.agent.id);
    sim.simulateUntil(60);
    const a = sim.agents[args.agent ?? scenario.agent.id];
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            scenario: id,
            selected: sel?.selected?.candidate.id ?? null,
            stance: sel?.selected?.chosenStance ?? null,
            utility: sel?.selected?.components.utility ?? null,
            travelTimeSec: sel?.selected?.travelTimeSec ?? null,
            arrival: a.arrival,
            finalPos: a.pos,
            status: a.status,
            events: sim.events,
          },
          null,
          2,
        ),
      );
      return a.arrival?.ok === false ? 1 : 0;
    }
    console.log(`\n=== ${scenario.name} (${id}) — simulated ===`);
    reportSelection(sel);
    console.log(`\nFinal: ${a.spec.name} at (${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)}), ${a.stance}, status ${a.status}`);
    if (a.arrival) {
      console.log(`Arrival: ${a.arrival.ok ? 'PASS' : 'FAIL'} — measured worst exposure ${fmtPct(a.arrival.measured.worstExposure)} vs predicted ${fmtPct(a.arrival.predictedWorstExposure)} (${a.arrival.matchesPrediction ? 'matches' : 'differs'})`);
      for (const f of a.arrival.failures) console.log(`  failure ${f.code}: ${f.detail}`);
      for (const n of a.arrival.notes) console.log(`  note: ${n}`);
    }
    if (sim.failedFor(a.id).length) console.log(`Failed candidates fed back: ${sim.failedFor(a.id).join(', ')}`);
    console.log(`\nEvents: ${sim.events.length} (use the graphical timeline to replay them)`);
    return a.arrival && !a.arrival.ok ? 1 : 0;
  }

  const result = selectCover({
    scene: { board: scenario.board, obstacles: scenario.obstacles },
    agent: scenario.agent,
    clues: scenario.clues,
    reservations: new ReservationBook(),
    policy,
    otherAgents: [{ id: scenario.ally.id, name: scenario.ally.name, pos: scenario.ally.pos, radius: scenario.ally.radius }],
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.selected ? 0 : 1;
  }
  console.log(`\n=== ${scenario.name} (${id}) ===`);
  reportSelection(result);
  return result.selected ? 0 : 1;
}

function reportSelection(result: ReturnType<typeof selectCover> | null): void {
  if (!result) {
    console.log('No selection produced.');
    return;
  }
  console.log(`Candidates: ${result.candidates.length} total, ${result.ranked.length} valid, ${result.rejected.length} rejected`);
  console.log(`Query backend: ${result.queryBackend}`);
  if (result.invalidatedLegacyCandidateIds.length) {
    console.log(`Invalidated legacy failure records: ${result.invalidatedLegacyCandidateIds.join(', ')}`);
  }
  if (result.rejectionSummary.length) {
    console.log(`Rejections: ${result.rejectionSummary.map((r) => `${r.code}×${r.count}`).join(', ')}`);
  }
  const top = result.ranked.slice(0, 6);
  if (top.length) {
    console.log('\nRanked (valid):');
    for (const e of top) {
      const se = e.stances[e.chosenStance];
      console.log(
        `  ${String(e.rank).padStart(2)}. ${e.candidate.id.padEnd(16)} ${e.chosenStance.padEnd(6)} util ${e.components.utility.toFixed(3)}  travel ${e.travelTimeSec?.toFixed(2)}s  worst ${fmtPct(se.worstExposure)}  open ${se.openDirectionCount}/16`,
      );
      console.log(`      ${e.candidate.obstacleId} ${faceName(e.candidate.face)} face; terms: ${e.components.terms.map((t) => `${t.name}=${t.contribution.toFixed(3)}`).join(' ')}`);
    }
  } else {
    console.log('\nNo valid candidates.');
  }
  if (result.rejected.length) {
    console.log('\nRejected (first 8, with individual reasons):');
    for (const e of result.rejected.slice(0, 8)) {
      console.log(`  ✕ ${e.candidate.id.padEnd(16)} ${e.rejectReasons.map((r) => `${r.code}: ${r.detail}`).join(' | ')}`);
    }
  }
  console.log('\nRationale:');
  for (const r of result.rationale) console.log(`  - ${r}`);
  console.log(`\nClue input: ${result.clueInputNote}`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.listScenarios) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.name}`);
    return 0;
  }
  if (args.all) {
    let code = 0;
    for (const s of SCENARIOS) {
      code = Math.max(code, runOne(s.id, args));
    }
    return code;
  }
  if (!SCENARIOS.find((s) => s.id === args.scenario)) {
    console.error(`Unknown scenario "${args.scenario}". Use --list.`);
    return 2;
  }
  return runOne(args.scenario, args);
}

process.exitCode = main();
