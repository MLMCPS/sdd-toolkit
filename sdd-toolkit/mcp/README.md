# sdd-toolkit MCP server

The **deterministic** half of the toolkit, exposed over MCP so any client — Claude Code, Cursor, a
custom agent, a CI script — can use it without a model in the loop.

Everything here is **read-only**. No tool writes, moves, or deletes anything.

## Why only these four

The plugin's value is its agents, skills, and hooks. None of those have an MCP equivalent: MCP
can't spawn a subagent with its own tool allowlist and model, and it can't register a
`SessionStart` or `PreToolUse` hook. Rebuilding the toolkit as an MCP server would throw away the
adversarial reviewers and both hooks.

What *does* port cleanly is the computation — the parts that read files and return facts, where a
model adds nothing:

| Tool | Answers |
|------|---------|
| `estate_lookup` | Who produces/consumes this contract? (from `docs/ESTATE.md`) |
| `knowledge_check` | Do the docs still match the code — every `file:line`, link, and shard? |
| `spec_list` | What specs exist, at what status, with how many criteria met? |
| `spec_next_number` | What's the next free spec number **across all branches**? |

Templates are also served as resources under `sdd://templates/…`.

`estate_lookup` returns `present: false` with an explicit note when the repo has no estate index.
That distinction is the whole point: "no index" is not "no consumers", and a false all-clear on a
cross-service change is worse than no answer, because it gets believed.

## Run it

```bash
node sdd-server.mjs --root /path/to/the/repo     # stdio transport; --root defaults to cwd
```

No dependencies and no install step — stdio MCP is newline-delimited JSON-RPC 2.0, implemented
directly here for the same reason `scripts/validate-plugin.mjs` has no dependencies: nothing in this
repo is ever installed before it runs. The two `package.json` files exist only to *publish* — they
declare no dependencies and there is no `node_modules`.

## Sharing it with a team

**First, the honest bit:** you cannot ship JavaScript to someone's machine and prevent them
reading it. `node_modules` is source, and even a compiled single-executable can be unpacked. So
pick based on what you're actually solving:

| Goal | Do this | Cost |
|---|---|---|
| Teammates get **only these four tools** | `@mlmcps/sdd-mcp` npm package (below) | Public on npmjs — anyone can read the package source |
| Teammates get the **whole toolkit**, without repo access | `@mlmcps/sdd-toolkit` npm package as the marketplace source | Public on npmjs; updates arrive on tag, not on merge |
| Teammates get the whole toolkit **and** the repo | Private repo + `/plugin marketplace add` | They can clone everything, history included |
| Genuinely no readable source | Single executable (`node --experimental-sea-config`, `bun build --compile`) | Per-platform builds; unpackable anyway |

**Hosting it remotely does not work for this server** — and the reason is worth knowing. Every tool
here answers questions about *the repo the caller is sitting in*. A remotely hosted server would
inspect files on the server, not on the teammate's laptop, so it would return answers about the
wrong repo. This server is local by design, not by omission.

### Public npm package (recommended)

The package ships **only** `mcp/`, `scripts/lib/`, and the one CI module it imports — ~18KB, zero
dependencies, no agents, no commands, no templates. Since 0.19.0 it is **public on npmjs.org under
MIT**, so a teammate needs no token, no registry config, and no access to this repo. The repo itself
stays private; `files[]` is what keeps the rest of it out of the tarball.

```bash
# you, once per release — normally CI does this on a tag
npm publish                       # publishConfig points at registry.npmjs.org, access public
```

Teammates configure nothing. In any repo they work in, `.mcp.json`:

```json
{
  "mcpServers": {
    "sdd-toolkit": {
      "command": "npx",
      "args": ["-y", "@mlmcps/sdd-mcp", "--root", "."]
    }
  }
}
```

That file is safe to commit — it names a package, not a path on anyone's laptop.

## Wire it into a repo

Copy `../templates/mcp/.mcp.json` to that repo's root as `.mcp.json`, set the absolute path, and
commit it — project-scoped config, so the whole team gets it. Or register it per-user:

```bash
claude mcp add sdd-toolkit -- node /abs/path/to/sdd-toolkit/mcp/sdd-server.mjs --root .
```

Verify with `/mcp` in Claude Code; the four tools should be listed.

## How updates reach people

Which mechanism applies depends on how they got it — and the first case is the one most teams
should be in, because it has no separate update step at all.

**Installed as part of the plugin** (Claude Code users). The bundled `.mcp.json` resolves through
`${CLAUDE_PLUGIN_ROOT}`, so the server is *inside* the plugin: when the marketplace updates the
plugin, the server comes with it. With `autoUpdate: true` that's automatic on the next launch —
restart Claude to pick it up. **There is nothing extra to publish or install.** If your whole team
uses Claude Code, you do not need the npm package.

**Installed from npm** (Cursor, custom agents, CI, or people who shouldn't get the whole plugin):

| `.mcp.json` args | Update behaviour | Use when |
|---|---|---|
| `["-y", "@mlmcps/sdd-mcp@0.19.0", …]` | **Pinned.** Everyone runs exactly what you tested; bumping is a commit teammates can review. | A team — recommended |
| `["-y", "@mlmcps/sdd-mcp", …]` | Resolves the latest at launch, so a new session can silently change versions. | Solo, or you want the newest always |

Servers start per session, so either way a **restart** is what applies an update — nothing hot-reloads.

**Which version is actually running?** Version skew across a team is the predictable failure here
(one stale npx cache, one freshly-updated plugin, two different answers). Ask it directly:

```bash
npx @mlmcps/sdd-mcp --version     # or: node .../mcp/sdd-server.mjs --version
```

It prints the version *and the resolved file path*, so "which copy is this" is answerable in one
line. The same version is reported in the MCP handshake, and the repo's validator keeps all five
places it's written from drifting.

## Relationship to the plugin

They compose — install both. The plugin gives you the loop (`/spec` → … → `/pr`), the agents, and
the hooks; this gives every tool the same facts underneath. `knowledge_check` shares one
implementation with the CI gate in `../templates/ci/knowledge-check.mjs`, imported rather than
copied, so the two can't drift apart.
