# koth-bot — autonomous battler for the "pkmn showdown" KOTH ladder

Request-driven heuristic Pokémon AI (singles + doubles, gens 1–9) with a team
for every ladder format, a self-play test harness, and a KOTH lobby client.

## Status

- `src/ai.js` — heuristic battle AI. Self-play: **21/21 games decisive,
  0 choice errors, 0 exceptions** across gen9ou / gen6vgc2015 / gen9doublesou /
  gen1ou / gen4ou / gen9ubers / gen3ou (AI vs random driver, ~2.5s total).
- `teams/` — 54/54 KOTH config formats covered (37 validator-LEGAL, 2
  bring-limited but legal, 15 unknown-to-local-sim but sanity-checked).
- `src/koth-client.js` + `src/main.js` — lobby client + bot loop. Battle
  protocol is complete (Showdown standard); lobby HTTP routes are best-guess
  one-liners — confirm from one DevTools recording (see below).

## Setup

```sh
cd koth-bot
npm install   # @pkmn/sim, @pkmn/dex, @pkmn/protocol, @pkmn/client, @smogon/calc, ws
node --version  # needs >= 18 (fetch + ESM)
```

## Auth token

The ladder uses rCTF OAuth in the browser. The bot reuses your session:

1. Sign in at the KOTH site in your browser.
2. Open DevTools → Application → Cookies (or LocalStorage) for the site.
3. Copy the session/token value into `KOTH_TOKEN`
   (or the full cookie header into `KOTH_COOKIE`).

```sh
export KOTH_TOKEN='paste-here'
# export KOTH_SERVER='https://koth.z0d1ak.org'   # default
```

## Run

```sh
# Lobby smoke test: config + roster submit + queue join, then exit
node src/main.js --once

# Full bot loop (queue -> battle -> requeue, survives format wipes)
node src/main.js
```

Useful scripts:

```sh
node src/validate.js [formatId...]   # legality check of teams/ (null = legal)
node test/selfplay.js [games] [fmt]  # AI-vs-random self-play, e.g. `node test/selfplay.js 3 gen6vgc2015`
VERBOSE=1 node test/selfplay.js 1 gen9ou   # show every choice + error
REQ=1 node test/selfplay.js 1 gen6vgc2015  # show every request summary
```

## Wiring the lobby (one-time, ~10 minutes)

`src/koth-client.js` has a `PROTOCOL` block at the top with every guessed
route. To finalize:

1. Open the KOTH site with DevTools → Network, join the queue in the browser.
2. Note the real requests for: **roster submit, queue join/leave, seat accept,
   battle socket URL**.
3. Replace the corresponding `PROTOCOL` entries (each is one line).
4. Override `KothClient.findSeat()` if seats arrive over WS instead of HTTP.

The battle driver itself needs no changes: it speaks standard Showdown battle
protocol (`|request|` → `/choose …`, `|error|` retry, `/timer on`).

## Architecture

```
teams/*.txt        54 format teams (Showdown export format, 6 mons each)
teams/index.js     formatId -> team file + bring-limit trims (1v1 -> 3, 2v2 -> 4)
src/validate.js    TeamValidator harness (also importable: validateTeamExport)
src/tracker.js     battle-log state tracker (positions, boosts, foe HP fracs,
                   weather/terrain/screens/TR, abilities, moves seen, ...)
src/ai.js          BattleAI.decide(request, tracker, rejected) -> choiceString
src/koth-client.js HTTP lobby + Showdown-protocol battle session
src/main.js        bot loop: config -> roster -> queue -> battle -> requeue
test/selfplay.js   self-play harness (AI p1 vs random p2, BattleStreams)
```

`decide()` never throws (falls back to `safeFallback`, then sim `default`) and
runs in ~0–4ms — far inside the 60s turn clock.

## Battle-protocol findings (all verified against @pkmn/sim)

Request-driven bots must handle all of these; this bot does:

- First decision point is team preview (`request.teamPreview`), except gen 1
  (no preview — first request is a move request).
- The sim omits `requestType`/`rqid` over BattleStreams; detect preview / move /
  forceSwitch / wait from the request shape instead.
- An invalid choice yields `|error|[Invalid choice] …` on your stream with **no
  new request** — re-decide the SAME request with a rejected-set, don't wait.
- Error chunks may bundle a fresh `|request|` — split and keep it, don't drop.
- Mid-turn wait-requests (`{"wait":true}`, e.g. while the opponent pivots)
  require **silence**: sending anything (even `default`) errors.
- Mid-turn single-slot prompts (`{forceSwitch:[true,false]}`, no `active`)
  take a **single** action; extra actions error.
- After battle end, stream `read()` resolves immediately with `''` — exclude
  ended streams from `Promise.race` or they starve it (100% CPU spin).
- Fainted slots may be offered moves with no `forceSwitch` (nothing left to
  switch to): those slots must get `pass`.
- Doubles switches must target distinct bench mons; forced switches are
  decided before voluntary ones so they claim first.
- `pass` doesn't count toward "more choices than unfainted"; targeting a
  fainted foe position auto-retargets (no error).
- Foe HP in player view is fraction-only (48ths/`|switch|`, percent/`|-damage|`);
  never assume exact foe HP — the AI scale-detects `poke.maxhp`.
- Singles: never attach targets (`move 1 1` works for most moves but is
  illegal for some, e.g. Shadow Force). Doubles: single-target moves need a
  live foe position; spread/self moves take none.
- Random-move moves (`randomNormal`, e.g. Outrage) take no target; locked-move
  and gen-1 `Fight` requests list moves without `pp` — those must still be
  picked (`pp === 0` explicitly means unusable; absent `pp` means "must pick").

## Format notes

- `gen91v1` / `gen92v2doubles` files ship 6 mons for the shared roster and are
  trimmed at runtime to the bring limit (3 / 4, best-first ordering).
- Formats unknown to local `@pkmn/sim` (other-mods, Champions, Platinum)
  can't be machine-validated here; their teams are best-effort legal and the
  server is authoritative. `main.js` submits even when local validation can't
  run, and logs server rejections.
- If the operator switches formats mid-run, `main.js` detects it on the next
  loop pass, resubmits the roster for the new format, and requeues.

## Troubleshooting

- `roster submit failed (http 404/…)` — fix the `PROTOCOL` route guesses from
  DevTools (see "Wiring the lobby").
- `choice error` spam in battle logs — the bot recovers via rejected-set
  re-decide; persistent storms mean a new request shape — capture it with
  `REQ=1` in self-play and extend `decideActions`.
- `iter-cap` in self-play — the 30k-iteration backstop tripped; with `VERBOSE=1`
  the `SPIN` line shows per-side counts and last chunks.
