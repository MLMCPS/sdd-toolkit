<!--
  Seed file for the PUBLIC mirror repo (MLMCPS/sdd-toolkit). Copy this in as that repo's
  README.md once, by hand. The release workflow replaces only .claude-plugin/, sdd-toolkit/
  and LICENSE, so this file survives every mirror push and is safe to edit there.

  This file lives under .github/ so it ships in neither npm package.
-->

# sdd-toolkit

A Claude Code plugin for spec-driven development in any stack — a stack-aware coding agent, an
evidence-gated spec lifecycle, and a knowledge layer that stays honest about drift.

**This repository is generated.** It is a release mirror of a private development repo, carrying
the plugin and its marketplace manifest and nothing else. Issues and pull requests here will not be
seen — it is pushed to, never merged into.

## Install

```
/plugin marketplace add MLMCPS/sdd-toolkit
/plugin install sdd-toolkit@ace-tools
```

Restart Claude Code, then type `/sdd-` to confirm the commands are there.

To enable it for everyone who clones a repo, commit this as `.claude/settings.json` in that repo:

```json
{
  "extraKnownMarketplaces": {
    "ace-tools": {
      "source": { "source": "github", "repo": "MLMCPS/sdd-toolkit" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "sdd-toolkit@ace-tools": true }
}
```

## Start here

`/sdd-init` in an existing repo. It reads the codebase and writes `CLAUDE.md`, `docs/PATTERNS.md`,
`docs/ARCHITECTURE.md`, and `specs/` from what is actually there. Everything else assumes those
exist. Then the loop:

```
/spec <ticket> → /spec-review → /spec-advance … Approved
              → /spec-build → /spec-verify → /spec-advance … Verified
              → /pr → merge → /spec-advance … Archived
```

`/code` and `/fix` are the short paths for changes that don't warrant a spec.

Full documentation: [`sdd-toolkit/README.md`](sdd-toolkit/README.md) ·
changes: [`sdd-toolkit/CHANGELOG.md`](sdd-toolkit/CHANGELOG.md)

## Also on npm

| Package | For |
|---|---|
| [`@mlmcps/sdd-mcp`](https://www.npmjs.com/package/@mlmcps/sdd-mcp) | The read-only MCP server — Cursor, VS Code, CI, custom agents. Four tools, zero dependencies. |
| [`@mlmcps/sdd-toolkit`](https://www.npmjs.com/package/@mlmcps/sdd-toolkit) | This plugin as an npm package, for vendored or air-gapped installs. |

Claude Code users need neither — the MCP server is bundled inside the plugin and updates with it.

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

## License

MIT — see [LICENSE](LICENSE).
