# Cover Selection Sandbox

A small, deterministic **cover-selection kernel** plus a graphical sandbox and a replay log, built for a *fictional* game board. A character standing in a reachable area proposes candidate cover spots from the level geometry, scores them against the threat clues it currently knows, picks one, and then actually walks there. The spot it reaches is measured again, and any failure is fed back into the next selection.

> **This is a simplified two-dimensional game model.** It is not tactical or real-world advice. Every number in the UI is only valid inside the fictional boards shipped here.

---

## Run it

```bash
npm install
npm run dev        # graphical sandbox  → http://localhost:5173
npm test           # 45 kernel + replay tests
npm run build      # type-checked production bundle
```

### Graphical entry point (primary)

Open **http://localhost:5173** after `npm run dev`. The map is the main surface:

1. Choose a scenario in the top bar.
2. Press **Select cover** — the kernel evaluates every candidate and fills the *Candidate evaluation* table.
3. Press **Play** or **Resolve fully** to watch the character walk to the chosen spot.
4. Click any candidate row (or a candidate dot on the map) to inspect it in the *Inspector*.
5. Click any row in the **Timeline** to replay the exact frame that was live at that event.
6. Drag the **Scout**, the **Wing**, or a *visible* hostile on the map to re-run selection live.
7. **Export replay (JSON)** writes the scenario, policy, every event and its snapshot to disk.

### Command line (auxiliary only)

The CLI reuses the same kernel and is deliberately secondary to the graphics.

```bash
npm run cover -- --list
npm run cover -- --scenario twin-cover
npm run cover -- --scenario multi-height --simulate
npm run cover -- --scenario twin-cover --clue flash 18.5 8.4 --uncertainty 0.3
npm run cover -- --all
npm run cover -- --scenario sealed-pocket --json
```

`--simulate` moves the character and prints the arrival verification. The graphical sandbox is the reference interface; the CLI exists for scripting and quick inspection.

---

## What the kernel does

The pipeline lives in `src/kernel/`:

```
geometry.ts     rectangles, ray/AABB entry tests, bearing maths
sceneQuery.ts   unified scene query interface (spatial-query-v2)
exposure.ts     candidate generation + height-aware occlusion sampling
navigation.ts   clearance grid, Dijkstra field, route verification
reservations.ts spatial claims that survive recomputation
selection.ts    the evaluator, stance choice, arrival measurement
engine.ts       deterministic simulation, replay capture, feedback loop
```

### Spatial query migration (spatial-query-v2)

All sightline / occlusion reads go through the unified scene query interface in
`sceneQuery.ts`, which replaced the old "poke rectangle math directly" backend.
The query boundary is explicit:

- **layer masks** — a query names the layers it reads (`LAYER_COVER`,
  `LAYER_SOLID`); an obstacle answers on the layers its flags allow.
- **hit normals** — every hit carries the outward face normal; a ray starting
  inside a solid reports the exit face (a back face) with `fromInside` set.
- **heights** — every hit carries the obstacle's top height.

The backend endpoint has **first-hit semantics**: a thin wall reports only the
first intersection along the travel direction. The read layer reconstructs the
occupied segment from **bidirectional queries** — a two-cast opposing-ray merge
when both ends name the same obstacle (its full applicable scope), otherwise a
surface walk from the far end that pairs exit faces with entry faces, repairs
shared faces between touching solids, and flags overlapping geometry as
inexact instead of guessing. Height is evaluated **across the whole occupied
segment** (`min(z_enter, z_exit)`), so a descending ray that dips below a wall
top inside the footprint is occluded — the legacy entry-only check called it
visible.

`verifyQueryEquivalence` replays a deterministic ray battery (board sweep plus
the exact candidate×clue×stance×probe rays a selection evaluates) through both
the legacy (`spatial-query-v1`) and migrated models and reports every
disagreement, so a non-equivalent map is caught by data. On the shipped boards
the selection rays show **zero lost occlusions**; the only differences are
one-directional refinements (added descending-ray blockers, removed
boundary-touch false positives). Failed-candidate records written by an older
backend are **invalidated, not trusted**, at selection time and surfaced in the
result panel / CLI. Clearance and pathing predicates are unchanged.

### 1. Candidates come from geometry, not markers

Candidates are generated on the four faces of each **cover** obstacle, one body-radius away from the face, at several posts along it. A candidate must pass three measured checks before it can score:

- **body clearance** — the body disc may not overlap another obstacle or the board edge,
- **stance-change room** — a lateral sweep (the room to stand up / crouch down) must be clear,
- **route body sweep** — every leg of the path is sampled; the body may never clip cover.

Decorative `markers` and `cover: false` props never produce candidates. The "chalk X by the wall" in scenario 01 is drawn but cannot become cover.

### 2. Occlusion is sampled per body height

A sightline is blocked only if it crosses an obstacle **below that obstacle's top**. Six body probes (0.15 m … 1.75 m) are cast from the observer's eye height (1.62 m standing, 0.92 m crouched). This is why a 1.15 m half-wall hides a crouched body but not a standing one, while a 2.3 m wall hides both. Exposure is reported as a fraction of the target body still visible, per clue.

An adjacent wall is **not** treated as cover from every direction: a candidate on the face pointing at the threat measures ~100% even though it touches cover (see scenario 01, north crate).

### 3. Evaluation uses known clues only

The selector receives a `clues` array (seen / heard / last-known, with confidence, age and positional uncertainty). Hidden hostiles are never passed to it. The debug overlay draws hidden hostiles and the **ground-truth sightline** so you can see, honestly, when the character is still exposed to something it never knew about — the model does not cheat by reading them.

### 4. Arrival is measured, and failures feed back

When the character reaches a spot, `measureArrival` recomputes clearance, stance-change room, per-clue exposure and squad-body clearance **at the position actually reached**, and compares it with the prediction. Mismatches and failures are written into the event log and added to that character's failed-candidate list; the next selection rejects them with an explicit `arrival_failed` / `geometry_mismatch` reason. Press **Park Wing on goal (test)** to occupy a committed spot and watch the scout reject it (`agent_clearance`) and re-target.

### 5. Reservations survive recomputation

While a character is in transit it holds a reservation on its goal. Periodic mid-route recomputes — and clue drags — re-plan **from the live position** and keep the same reservation, so a second character cannot claim the spot in the meantime. The reservation is released only on arrival. The *Timeline* shows `reserve` / `recompute` / `release` events in order.

---

## The scenarios (test cases)

| id | what it exercises |
|----|-------------------|
| `twin-cover` | Two stacks occlude the muzzle flash **identically**; they differ only in arrival time. Both stay in the audit table; the closer one wins. Mid-route recompute keeps the claim. |
| `multi-height` | 2.3 m wall vs 1.15 m half-wall vs 0.55 m barrier. The half-wall spot is only valid **crouched**; the low barrier is not cover at all. |
| `diagonal` | Contact on a diagonal bearing; faces parallel to the threat stay exposed, so the selector cannot "hide beside" cover it is not behind. |
| `sealed-pocket` | A fully enclosed ring yields **unreachable** inner-face candidates, and a 0.95 m gap fits the body centre but not the stance sweep. Both are rejected with named reasons, not silently dropped. |

---

## Interpreting the result area

The right-hand panel is built so that **no single total hides a failure**:

- The table lists *all* candidates — valid and rejected — with a per-clue protection bar.
- Expanding a row shows every utility term multiplied out, both stances' per-clue exposure, the raw clearance and transition measurements, the pros/cons, and each individual rejection with its own code and message.
- The rejection summary is by reason (`exposure_limit`, `unreachable`, `transition_space`, `body_overlap`, `agent_clearance`, …), not collapsed into a score.
- A candidate is never rejected merely for scoring lower — it is rejected for a named geometric or policy reason. Lower-ranked valid candidates remain visible with their utility, travel time and why they lost.

Overlays: **rays** = eye-height lines to each clue; **probes** = body-height samples for the inspected candidate; **hidden** = admin ground truth (never an input); **clearance** = stance-change rings.

---

## Determinism & replay

The simulation is fixed-tick and seeded only by user actions, so the same action script yields the same event stream and frames (`tests/replay.test.ts` asserts this). The captured frames are what the *Timeline* scrubs through. Exported JSON bundles the scenario, policy, events and snapshots; the format is plain data so it can be inspected or diffed.

---

## Scope and limits

- 2-D board with vertical height only for occlusion; no terrain, no projectile physics, no suppression, no time-of-flight of sight.
- Clue uncertainty is sampled on a small ring, not a probability distribution; confidence and age are simple weights.
- The squad model is two characters and a repulsion radius; there is no formation or role logic.
- Route cost is path length × stance speed; there is no acceleration, stamina or door handling.
- Everything is tuned to be legible in a browser demo, not to imitate any real system. **Do not use it as tactical guidance.**

## Layout

```
src/kernel/    selection core (pure TS, unit-tested, no DOM)
src/components/  React panels, canvas map, timeline
src/ui/        canvas drawing + replay export helpers
tests/         kernel and replay tests
```
