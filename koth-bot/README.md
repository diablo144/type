# koth-bot — autonomous battler for the "pkmn showdown" KOTH ladder

Request-driven heuristic Pokémon AI (singles + doubles, gens 1–9) with a team
for every ladder format, a self-play test harness, and a KOTH lobby client
whose protocol was reversed from the shipped web client (no guessing).

## Status

- `src/ai.js` — heuristic battle AI. Self-play: **42/42 games decisive,
  0 choice errors, 0 exceptions** across 21 formats x2 (AI vs random driver,
  ~3.5s total).
- `teams/` — 54/54 KOTH config formats covered (37 validator-LEGAL, 2
  bring-limited but legal, 15 unknown-to-local-sim but sanity-checked).
- `src/koth-client.js` + `src/main.js` — lobby client + bot loop. Protocol
  reversed from the shipped SolidJS bundle (`/assets/index-RInX2HYp.js`, read
  in full): same endpoints, same 1.5s lobby poll, same battle socket as the
  browser.
- `test/adapter.js` — adapter proof: canonicalizer units + error-retry +
  result/log-dedup + **live drills** where `KothBattle` drives p1 against
  `@pkmn/sim` p2 through KOTH-shaped snapshots (gen9ou, gen6vgc2015,
  gen91v1, gen1ou — all wire choices accepted verbatim, 0 sim errors).

## Setup

```sh
cd koth-bot
npm install   # @pkmn/sim, @pkmn/dex, @pkmn/protocol, @pkmn/client, @smogon/calc, ws
node --version  # needs >= 18 (fetch + ESM)
```

## Auth

The ladder uses rCTF OAuth in the browser. The bot reuses your session cookie:

1. Sign in at the KOTH site in your browser.
2. Open DevTools → Application → Cookies for the site.
3. Copy the session cookie into `KOTH_COOKIE` (full `name=value` header).

```sh
export KOTH_COOKIE='paste-name=value-here'
# export KOTH_SERVER='https://koth.z0d1ak.org'   # default
```

Every request carries `Origin` (the server rejects origin-less calls) plus the
cookie. On `invalid_session` the bot exits — re-sign-in and refresh the cookie.

## Run

```sh
# Full bot loop (roster -> queue -> accept -> battle -> requeue, survives format wipes)
node src/main.js

# Lobby smoke test: boot + roster submit + queue join, then leave + exit
node src/main.js --once
```

Useful scripts:

```sh
node src/sniff.js                 # read-only: config/me/queue/ladder shapes
node src/sniff.js --probe         # + join/poll/immediate-reject/leave walk
node src/validate.js [formatId...]   # legality check of teams/ (null = legal)
node test/selfplay.js [games] [fmt]  # AI-vs-random self-play, e.g. `node test/selfplay.js 3 gen6vgc2015`
node test/adapter.js              # KOTH adapter proof (units + live sim drills)
VERBOSE=1 node test/selfplay.js 1 gen9ou   # show every choice + error
REQ=1 node test/selfplay.js 1 gen6vgc2015  # show every request summary
```

## Lobby + battle protocol (reversed from the web client)

Boot: `GET /api/config`, then `GET /api/me` + `GET /api/queue` every 1.5s
(queue state is authoritative for occupancy/match). Roster: `PUT /api/team
{exportText}` while idle (200 echoes `{exportText}`; illegal rosters come
back `{error, problems[]}`). Queue: `POST`/`DELETE /api/queue`; matches
accept via `POST /api/matches/{id}/accept|reject` inside the 30s window.

Battles: `GET /api/matches/{id}` snapshot, then WS `/ws/battle/{id}`
(cookie + Origin). Client sends `{type:"choose", choice, requestId}` once per
request (`{type:"forfeit"}` to concede); server pushes snapshots or
`{type:"error"}`. Snapshot `request` is a raw sim request and `log` is raw
protocol; `status=done` carries `result{winner, endReason, eloAfter}`. On
socket drop: re-GET, reconnect with 500ms·2^fails backoff (≤5s).

Wire canonicalizations (see `canonicalizeChoice`): preview `team 1, 2` →
`team 12`; doubles foe targets take an explicit sign (`move 1 +2`). The web
client only emits `terastallize`; the bot also tries mega/ultra/zmove/dynamax
once per request and strips them on the first server error for that request.

## Architecture

```
teams/*.txt        54 format teams (Showdown export format, 6 mons each)
teams/index.js     formatId -> team file + bring-limit trims (1v1 -> 3, 2v2 -> 4)
src/validate.js    TeamValidator harness (also importable: validateTeamExport)
src/tracker.js     battle-log state tracker (positions, boosts, foe HP fracs,
                   weather/terrain/screens/TR, abilities, moves seen, ...)
src/ai.js          BattleAI.decide(request, tracker, rejected) -> choiceString
src/koth-client.js HTTP lobby + Showdown-protocol session + KOTH snapshot adapter
src/main.js        bot loop: config -> roster -> queue -> battle -> requeue
src/sniff.js       read-only server inspector (+ --probe queue walk)
test/selfplay.js   self-play harness (AI p1 vs random p2, BattleStreams)
test/adapter.js    adapter proof (units + live sim drills through snapshots)
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
- KOTH wire ⇄ sim verified in `side.choose()`: `/\s(?:-|\+)?[1-3]$/` target
  regex means the sim consumes signed `move 1 +2` verbatim — the server
  almost surely passes choices straight through (all gimmick suffixes parse
  server-side candidates too, hence try-then-strip rather than never-try).

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

- `roster rejected: <error>` — the server prints `problems[]`; fix the team
  file for that format and rerun (roster submits are idle-only).
- `AUTH LOST (invalid_session)` — cookie expired; re-sign-in in the browser
  and refresh `KOTH_COOKIE`.
- `choice error` spam in battle logs — the bot recovers via rejected-set
  re-decide; persistent storms mean a new request shape — capture it with
  `REQ=1` in self-play and extend `decideActions`.
- `iter-cap` in self-play — the 30k-iteration backstop tripped; with `VERBOSE=1`
  the `SPIN` line shows per-side counts and last chunks.
- `match snapshot 409` — match cancelled or still needs acceptance; the bot
  requeues automatically.
