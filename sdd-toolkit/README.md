# sdd-toolkit

Spec-driven development toolkit packaged as a Claude Code plugin, so every repo and every
developer gets the same agents and commands. The agents are **stack-aware**: they detect the
project before editing and follow its conventions — Java/Spring (Maven/Gradle), React, and
Node backends (Express, NestJS), across MySQL, PostgreSQL, and MongoDB. (Originally built for
the `online.ace` microservice estate; works in standalone apps too.)

## Why use this (vs. just asking Claude)

Same model — the difference is what's wrapped around it. Default Claude Code re-learns your repo
every session, infers conventions on the fly, jumps straight to code, and reports "done" with the
human as the only check. This toolkit adds three things that change the outcome:

1. **Durable, learned memory** — `/sdd-init` studies the repo once and writes `CLAUDE.md` +
   `docs/PATTERNS.md` + `docs/ARCHITECTURE.md` with real `file:line` evidence. Every later task
   reads *your* conventions instead of re-guessing them, so output matches your codebase
   consistently across sessions and developers.
2. **Spec-before-code for non-trivial changes** — `/spec → review → /spec-build` puts the contract
   (API, data model, cross-module ripple) on paper for human approval **before** code exists, so
   the costly design errors get caught when they're a sentence to fix, not a rollback.
3. **Discipline baked in** — a test per acceptance criterion, adversarial review against the spec,
   "report real test results — never claim green," and tiered/sharded context so it stays cheap and
   usable on large, interlinked codebases.

| | Normal Claude Code | sdd-toolkit |
|---|---|---|
| Knows your conventions | Re-guesses each session | Learned once, remembered |
| Consistency across devs/repos | Varies per prompt | Same agents, format, specs |
| Non-trivial change | Code first, find issues in the diff | Contract approved on paper first |
| Verification | "Looks done" | Test per criterion + adversarial review |
| Large / coupled codebase | Context bloat | Lazy-loaded, sharded, bounded |
| Cost per task | Re-reads a lot | Thin index → only what's needed |

**The trade-off:** more upfront ceremony (write/approve a spec, run `/sdd-init` once, keep the docs
fresh) in exchange for consistency, fewer wrong-contract surprises, and an agent that knows your
code. Worth it for teams, multi-service estates, and long-lived codebases; **skip it** for one-line
fixes and throwaway scripts — use `/code` (or plain Claude) there. The payoff is real only if the
learned docs are accurate, which is why patterns carry `(inferred)` confidence markers and
`/sdd-init` flags them for a quick human review.

## Token cost (set expectations before running on a big repo)

The toolkit **front-loads** tokens to **cut** the per-task and rework tokens — so it pays off on
repeated work and costs more on one-offs.

**Spends more on:** `/sdd-init` (a one-time codebase scan — the most expensive single op, biggest on
large repos), the `/spec` phase (a doc before code), the per-task memory tax (`CLAUDE.md` + relevant
`docs/` loaded each coding task), and the multi-agent loop (author → developer → reviewer are
separate contexts — you're buying verification).

**Saves on:** re-exploration (reads a small index instead of grepping the repo every session — the
biggest recurring win on large repos), lazy/sharded loading (only the module a task touches, +1-hop
contracts; `file:line` refs not pasted code), and **rework** (knowing conventions + approving the
contract on paper means fewer thrown-away wrong implementations — pure wasted tokens otherwise).

| Scenario | Net vs. plain Claude |
|---|---|
| One-line fix via `/code` | ~Same (no spec; just the thin index) |
| Non-trivial change, repo already `init`-ed | **Lower** — saved exploration + rework beats the spec overhead |
| First change in a fresh repo (pay `/sdd-init`) | **Higher** that session; pays back over the next few |
| Large / interlinked codebase, ongoing | **Much lower per task** — sharding avoids context blowups |
| Throwaway script, one session | **Higher** — don't use the full loop |

**Keep it cheap:** use `/code` for small changes (don't spec a typo); run `/sdd-init` once per repo
and review, not casually; keep `docs/` within the ~200-line budgets (a bloated `PATTERNS.md` taxes
every task — `/sdd-refresh` prunes); shard large apps; skip the reviewer agent for low-risk changes.
Honest caveat: `/sdd-init` on a big repo is genuinely expensive — if you'll only ever make one change
there, you won't recoup it. The design assumes repeated work against the same codebase.

## What's inside

**Agents** (`agents/`)
- `coder` — senior-engineer coding agent; detects the stack, inspects before editing, smallest
  correct change, fixed `PLAN / FILES / IMPLEMENTATION / REVIEW / TESTS` output, asks instead of guessing.
- `sdd-spec-author` — turns a ticket into a reviewable spec under `specs/` (no code). Stops and
  returns blocking contract questions rather than guessing them or parking them in the document.
- `sdd-spec-reviewer` — adversarially reviews a **draft spec** before a human reads it (read-only,
  fresh context): contracts complete, criteria testable, ripple named.
- `sdd-developer` — implements ONE approved spec, test-first, strictly to its acceptance criteria.
  `/spec-build` spawns one per spec; several specs at once means one agent each in its own git
  worktree.
- `sdd-reviewer` — adversarially verifies an implementation against its spec (read-only). Run it
  with `/spec-verify`.
- `pr-author` — turns a completed spec + its diff into a PR title/body with the acceptance criteria
  as a checklist (read-only; doesn't open the PR). Run it with `/pr`.
- `sdd-scanner` — reads a codebase and returns a **capped findings block of `file:line` citations,
  never file contents**. `/sdd-init`, `/sdd-refresh` and `/sdd-estate` spawn several at once instead
  of reading source themselves, so the learn phase runs concurrently and the files it opens never
  land in the calling session's context.

**Commands** (`commands/`)
The loop: `/spec` → `/spec-review` → `/spec-advance Approved` → `/spec-build` → `/spec-verify` →
`/spec-advance Verified` → `/pr` → `/spec-advance Archived`.

- `/code <task>` — make a one-shot change with the `coder` agent (any language; detects the stack).
- `/fix <bug>` — the bug-shaped flow. A defect already has a contract; the code is just violating
  it, so a feature-shaped spec is wasted ceremony — but `/code` gives it no discipline at all. This
  is the middle path, and the discipline is one rule: **reproduce it with a failing test first.**
  Then root cause (stated, with evidence), smallest change, real verification, and a search for the
  same defect in sibling code paths. Escalates to `/spec` if the fix would change a contract.
- `/spec <ticket>` — draft a spec. Asks the blocking contract questions up front (batched, with
  recommendations), then self-reviews via `sdd-spec-reviewer` before handing you the draft — so your
  review is an approval, not a hole-hunt.
- `/spec-review <spec-file>` — run that adversarial pass on demand (for hand-written or heavily
  edited specs; `/spec` already does it).
- `/spec-build <spec-file>` — implement an approved spec.
- `/spec-verify <spec-file>` — the VERIFY gate: `sdd-reviewer` judges the implementation against the
  spec's acceptance criteria (fresh context, read-only) and runs the final-acceptance suite. This is
  what earns `Verified`. Complements `/code-review`, which checks the diff for bugs — run both.
- `/spec-advance <spec-file> [status]` — the **only** writer of a spec's Status, and every
  transition has to show its evidence: `Approved` needs the human's OK and no blocking question left
  in §8; `Implemented` needs every named test to exist on disk; `Verified` needs a clean
  `/spec-verify` plus a green full suite; `Archived` needs the branch merged, then `git mv`s the
  spec to `specs/archive/` (number kept). If the evidence isn't there it refuses — that's the point.
  Also records the spec's branch so `/sdd-status` stops guessing.
- `/pr <spec-file>` — spec + diff → PR title and body with the acceptance criteria as a review
  checklist (produces text; doesn't push or open the PR unless you ask).
- `/sdd-estate` — build/refresh `docs/ESTATE.md`: scans the peer repos and indexes the real
  cross-service edges (HTTP/RPC clients, event producers/consumers, shared data), citing `file:line`
  on both sides and marking anything unconfirmed `(inferred)`. Read-only outside this repo.
- `/sdd-impact [spec-file]` — **who breaks if this ships?** Detects changes to published contracts
  (event payloads, API shapes, shared tables, exported types), looks up the consumers in
  `docs/ESTATE.md`, classifies each as additive / sequenced / breaking, and gives the safe deploy
  order. If the estate index is empty it says so rather than reporting "nothing affected" — a false
  all-clear here is worse than no answer. Nothing else in the loop looks outside this repo.
- `/sdd-rollout <parent-dir>` — onboard a whole estate without spraying the expensive part. Surveys
  every repo mechanically first (free — no model), classifies each as init / adopt / refresh /
  review, orders them by cross-service surface so the repos that unlock `/sdd-impact` for their
  peers go first, then onboards **one at a time**. The first repo is an explicit calibration run:
  you review its output before repo two, so a systematic mistake gets fixed once instead of 17
  times. Ends by running `/sdd-estate`, which is the point of the whole exercise. Resumable — state
  is re-derived from disk each run, so there's no ledger to go stale.
- `/sdd-adopt` — for a repo that **already has** a hand-written `CLAUDE.md`, `docs/`, or its own
  RFC/ADR practice. Merges rather than overwrites: classifies every existing section into keep /
  merge / missing, never deletes human prose, maps the spec loop onto their existing process, and
  reports conflicts between their docs and the code without silently "fixing" them.
- `/sdd-init` — **learn the existing project, then scaffold it.** Studies the real codebase,
  extracts its code patterns, and auto-generates the Claude memory files (`CLAUDE.md` with a
  "Code patterns" section, `docs/PATTERNS.md`, `docs/ARCHITECTURE.md`), plus `specs/`,
  `docs/`, `.gitattributes`, and a committed `.claude/settings.json` that keeps AI attribution
  off the repo's commits and PRs for everyone who clones it.
- `/sdd-refresh` — re-learn the project and update those memory files after the code has drifted.
- `/sdd-doctor` — read-only health check of the knowledge layer (drift, broken refs, stale
  commands); recommends `/sdd-refresh` when needed.
- `/sdd-status` — dashboard of every spec: lifecycle status, acceptance-criteria progress, branch.

**Skills** (`skills/`) — procedures that load only when they apply, so they cost nothing when they
don't.
- `knowledge-retrieval` — navigating a sharded knowledge layer, the 1-hop dependency closure for
  interlinked modules, and designing a change that crosses a module or service boundary (both sides
  of the contract, deploy order, compatibility). Loads on demand; the always-needed retrieval ladder
  stays in the repo's `CLAUDE.md`, because it has to be known before you know you need it.

**Hooks** (`hooks/`) — active on install, no setup:
- **Knowledge-layer drift warning** (`SessionStart`) — one line when `CLAUDE.md`/`docs/` have fallen
  more than 30 source commits behind the code, silent otherwise. Drift is invisible and
  `/sdd-refresh` only runs when someone remembers it; this is the reminder. Tune with
  `SDD_DRIFT_THRESHOLD`.
- **Secret scan** (`PreToolUse` on Bash) — blocks a commit whose staged diff contains a likely AWS
  key, private key, Slack/GitHub token, JWT, or `secret=…` assignment. Added lines only, so removing
  a leaked key is never blocked. False positives: add a regex to `.claude/secret-allowlist.txt`.

Project-specific automation (format, lint, test) can't ship — the plugin can't know your commands —
so it stays opt-in in `templates/hooks/settings.hooks.example.json`.

**CI gate** (`templates/ci/`, seeded by `/sdd-init`) — `knowledge-check.mjs` fails a PR when a doc
asserts something no longer true: a `file:line` pointing at deleted code, a router row pointing at a
missing shard, a broken doc link. It also warns when a PR changes source and touches no doc. That's
the mechanical half of `/sdd-doctor`; the judgment half stays a human-run command. Adopting on a
repo with existing drift? Start with `--warn-only`, clear the backlog with `/sdd-refresh`, then drop
the flag — a gate that fails on day one gets disabled on day two.

**Dashboard generator** (`scripts/spec-dashboard.mjs`) — writes a **self-contained HTML page** of
every spec: lifecycle bars, acceptance-criteria completion, a needs-attention list ordered by
severity, duplicate spec numbers, and a searchable/filterable table. Crucially it also shows
**in-flight parallel work** — one row per git worktree joined to the spec it's building, with
branch, commits ahead, and whether the tree is dirty, so running four specs at once is four
labelled rows instead of four indistinguishable terminals. No CDN, no fonts, no network calls: the
page works offline and the spec data never leaves the machine that generated it.

```
node scripts/spec-dashboard.mjs --root /path/to/repo --open
```

**Lifecycle gate** (`scripts/spec-gate.mjs`) — the mechanical half of a `/spec-advance` transition,
done exactly instead of by re-reading: lifecycle ordering, leftover `<placeholder>` text, whether
every acceptance criterion is ticked, whether **every test file named in the §6 table exists on
disk**, and whether the recorded branch is merged. Prints `PASS` / `FAIL` / `MANUAL` per gate and
exits non-zero on any `FAIL`. It deliberately refuses to judge what a script can't witness — human
approval, whether a §8 question is blocking, whether the suite ran green — and marks those `MANUAL`,
because a `PASS` there would get believed. Read-only, no network calls.

```
node scripts/spec-gate.mjs specs/0001-foo.md --to Verified [--json]
```

**Survey script** (`scripts/survey-estate.mjs`) — read-only inventory of candidate repos: stack,
knowledge-layer state, spec count, 90-day activity, uncommitted changes, and cross-service edge
signals (event listeners, HTTP clients, contract files), ending in an init/adopt/refresh/review
recommendation per repo. Used by `/sdd-rollout`, but useful alone — it costs nothing and answers
"where do we even start?". No network calls.

**Repair script** (`scripts/fix-specs.mjs`) — for a repo that has been using `specs/` for a while,
run before adopting the newer commands. Renumbers duplicate spec numbers (taking the next free
number across **all** branches, `git mv` so history follows, rewriting exact filename references),
and moves prose out of `Status` into the canonical lifecycle word — **preserving the prose verbatim**
as a `> **Status note:**` under the header table, since that text is usually real information in the
wrong field. Dry run by default; `--apply` to write; refuses to apply over a dirty `specs/` so its
diff stays reviewable on its own. Idempotent. No network calls — it runs entirely on your machine.

**MCP server** (`mcp/`) — the deterministic half, for any MCP client (Cursor, a custom agent, CI),
read-only and dependency-free: `estate_lookup` (who produces/consumes a contract), `knowledge_check`
(do the docs still match the code), `spec_list`, `spec_next_number` (collision-safe across
branches), plus the templates as `sdd://` resources. The agents, skills, and hooks have no MCP
equivalent and stay in the plugin — see [mcp/README.md](mcp/README.md). `knowledge_check` imports
the CI gate's implementation rather than copying it, so the two can't drift.

**Templates** (`templates/`) — seeded/filled into each repo by `/sdd-init`: spec README/TEMPLATE/AGENTS,
`docs/` knowledge templates (PATTERNS, ARCHITECTURE, ESTATE), the CLAUDE.md fragment, `settings.json`
(committed attribution policy), optional `hooks/` automation examples, and `.gitattributes`.

## Install (per developer / per repo)

```
/plugin marketplace add MLMCPS/ace-claude-plugins
/plugin install sdd-toolkit@ace-tools
```

Or make it automatic for a repo by committing `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "ace-tools": { "source": { "source": "github", "repo": "MLMCPS/ace-claude-plugins" }, "autoUpdate": true }
  },
  "enabledPlugins": ["sdd-toolkit@ace-tools"]
}
```

Teammates who clone a repo with that file get the plugin installed automatically (after trusting
the workspace).

## First-time setup in a new service

```
/sdd-init        # learns THIS repo, then generates CLAUDE.md + docs/PATTERNS.md + docs/ARCHITECTURE.md, scaffolds specs/, .gitattributes, .claude/settings.json
/sdd-estate      # only if this repo is one service in a larger estate — indexes the cross-service contracts
```
Then use the loop: `/spec <ticket>` → review → `/spec-advance … Approved` →
`/spec-build specs/NNNN-*.md` → `/spec-verify` + `/code-review` → `/spec-advance … Verified` → `/pr`.

## Updating

Bump `version` in `.claude-plugin/plugin.json` and the marketplace entry, push. Repos with
`autoUpdate: true` pick it up; others run `/plugin marketplace update ace-tools`.
