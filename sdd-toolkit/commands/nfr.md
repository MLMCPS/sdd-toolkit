---
description: Compile non-functional requirements into the two things that enforce them — standing constraints in the knowledge layer, and blocking pipeline gates
argument-hint: (no args) to check · `apply` to write docs/CONSTRAINTS.md · `gates <path>` to emit the pipeline block
model: haiku
---

Route the project's NFRs: **$ARGUMENTS**

NFRs are the requirements most likely to be agreed and then lost. They do not
decompose into user stories — a story breakdown flattens them into prose that
nothing checks. They decompose into exactly two things: a **standing constraint**
the author reads while writing every spec, and a **blocking pipeline gate**.

## Run it

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/nfr-compile.mjs                       # check only
node ${CLAUDE_PLUGIN_ROOT}/scripts/nfr-compile.mjs --apply               # write docs/CONSTRAINTS.md
node ${CLAUDE_PLUGIN_ROOT}/scripts/nfr-compile.mjs --gates ci/nfr-gates.yml
```

Reads `docs/NFRS.md` — a markdown table, so a change to what is in force reviews
in a pull request like anything else — falling back to `nfrs.json`.

## The three things it refuses, and how to explain each

**No machine-checkable threshold.** "The API shall be performant" cannot become a
gate, so it cannot be enforced, so it will be lost. Do not soften this: ask the
user for the metric, operator and value. If they genuinely cannot name one, the
honest move is to delete the NFR rather than keep a requirement nothing can fail.

**Flattened into an acceptance criterion.** An NFR id appearing inside an AC is
the exact failure mode — at that point it has stopped being enforced and become a
sentence. Point at the spec and criterion, and move it back out.

**Named by a spec but defined nowhere.** Worse than unrouted: the spec claims a
constraint that does not exist. Either add it to `docs/NFRS.md` or remove the
reference.

## After a successful `--apply`

Say which constraint ids changed — the script reports exactly that, and reports
nothing when the write was a no-op. Do not claim an update that did not happen.

Mention that the next `/spec` on an affected repo will carry these constraints
into the new spec automatically, so nobody has to remember they exist.

## Close

If any NFR was refused, the project is not enforcing what it thinks it is. Lead
with that count, not with the ones that compiled.
