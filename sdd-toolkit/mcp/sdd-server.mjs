#!/usr/bin/env node
// sdd-toolkit MCP server — the DETERMINISTIC half of the toolkit, exposed to any MCP client.
//
//   node sdd-server.mjs [--root <repo path>]     (stdio transport; --root defaults to cwd)
//
// Why this exists alongside the plugin: the parts that are pure computation over a repo's files
// are useful to *any* agent in any tool, and shouldn't need a model to run. Those are the tools.
// The commands are exposed too, as MCP prompts (see below), with the agents they delegate to
// inlined into them. Skills and hooks have no MCP equivalent at all — those stay Claude Code,
// and so does the real subagent execution the plugin gets.
//
// Everything is READ-ONLY. No tool writes, moves, or deletes anything. Writing is the plugin's
// job, where a human is in the loop to approve it.
//
// No dependencies, by the same convention as scripts/validate-plugin.mjs — the MCP SDK would
// mean a package.json and node_modules in a repo that deliberately has neither. stdio MCP is
// newline-delimited JSON-RPC 2.0, which is short enough to implement honestly.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runChecks } from '../templates/ci/knowledge-check.mjs';
import { listSpecs as parseSpecs, analyze } from '../scripts/lib/specs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag !== -1 ? argv[rootFlag + 1] : process.cwd();

// Version skew is the predictable failure of distributing this: one teammate on a stale npx
// cache, another on a fresh plugin update, both reporting different answers. Make "what am I
// actually running?" a one-liner rather than an archaeology exercise.
const VERSION = '0.21.0';
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`sdd-mcp ${VERSION}  (${fileURLToPath(import.meta.url)})`);
  process.exit(0);
}

const abs = (p) => join(ROOT, p);
const git = (...a) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

// --- docs/ESTATE.md parsing -------------------------------------------------
// The estate index is markdown tables under `### Synchronous` / `### Asynchronous` /
// `### Shared data` headings. Column meaning depends on which table a row is in.

const SECTION_SHAPES = {
  sync: ['caller', 'callee', 'via', 'what', 'evidence'],
  async: ['contract', 'producer', 'consumer', 'notes', 'evidence'],
  shared: ['contract', 'owner', 'usedBy', 'notes'],
};

function parseEstate() {
  if (!existsSync(abs('docs/ESTATE.md'))) return { present: false, edges: [], services: [] };

  const lines = readFileSync(abs('docs/ESTATE.md'), 'utf8').split('\n');
  const edges = [];
  const services = [];
  let section = null;

  const cells = (line) =>
    line.split('|').slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, ''));
  const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(line.trim());
  // A row is unresolved if it's a placeholder or was never confirmed against the peer's code.
  const unresolved = (row) => /_TBD_|\(inferred\)/i.test(row);

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const h = line.toLowerCase();
      // "asynchronous" contains "synchronous" — test the longer one first or every event
      // table is parsed with the sync column shape.
      if (h.includes('service registry')) section = 'registry';
      else if (h.includes('asynchronous')) section = 'async';
      else if (h.includes('synchronous')) section = 'sync';
      else if (h.includes('shared')) section = 'shared';
      else if (line.startsWith('## ')) section = null;
      continue;
    }
    if (!section || !line.startsWith('|') || isSeparator(line)) continue;

    const c = cells(line);
    if (c.length < 2) continue;
    // Skip header rows and the template's placeholder rows.
    const first = c[0].toLowerCase();
    if (['service', 'caller', 'event / queue / topic', 'shared thing', 'event / queue (fifo)'].includes(first)) continue;
    if (/^<.*>$/.test(c[0])) continue;

    if (section === 'registry') {
      services.push({ service: c[0], owns: c[1] ?? '', stack: c[2] ?? '', doc: c[3] ?? '', unresolved: unresolved(line) });
      continue;
    }

    const shape = SECTION_SHAPES[section];
    const edge = { kind: section, unresolved: unresolved(line) };
    shape.forEach((k, i) => { edge[k] = c[i] ?? ''; });
    edges.push(edge);
  }

  return { present: true, edges, services };
}

// --- specs ------------------------------------------------------------------

// Parsing lives in scripts/lib/specs.mjs so the dashboard generator and this server agree on
// what a spec says. Mapped to this tool's field names, which are part of its published contract.
function listSpecs() {
  return parseSpecs(ROOT).map((s) => ({
    file: s.file,
    number: s.id,
    slug: s.slug,
    title: s.title,
    status: s.status,                      // the canonical lifecycle word, or null
    rawStatus: s.rawStatus,                // what the cell literally holds
    statusIsCanonical: s.statusIsCanonical,
    branch: s.branch,
    ticket: s.ticket,
    acceptanceCriteria: { total: s.acTotal, checked: s.acChecked },
    archived: s.archived,
  }));
}

function nextSpecNumber() {
  // Every branch, not just the working tree — otherwise two people speccing in parallel
  // both take the next number and collide at merge.
  const used = new Set();
  for (const s of listSpecs()) used.add(Number(s.number));

  const hasRemote = git('remote') !== '';
  let fetched = false;
  if (hasRemote) {
    try {
      execFileSync('git', ['-C', ROOT, 'fetch', '--quiet'], { stdio: 'ignore' });
      fetched = true;
    } catch {
      fetched = false; // offline, or no credentials — reported below, never silently assumed
    }
  }
  const historical = git(
    'log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A', '--', 'specs/[0-9]*',
  );
  for (const line of historical.split('\n')) {
    const m = basename(line.trim()).match(/^(\d{4})-/);
    if (m) used.add(Number(m[1]));
  }

  const max = used.size ? Math.max(...used) : 0;
  return {
    next: String(max + 1).padStart(4, '0'),
    highestUsed: used.size ? String(max).padStart(4, '0') : null,
    countUsed: used.size,
    scannedAllBranches: historical !== '',
    remoteChecked: fetched,
    warning: fetched ? null
      : hasRemote
        ? 'Remote exists but fetch failed (offline or no credentials) — branches you have not pulled were not counted, so a collision is possible.'
        : 'No git remote — only local branches were counted.',
  };
}

// --- tools ------------------------------------------------------------------

const TOOLS = [
  {
    name: 'estate_lookup',
    description:
      'Who consumes or produces a cross-service contract? Reads docs/ESTATE.md and returns the ' +
      'matching edges (sync HTTP/RPC calls, async events, shared data) with producers, consumers, ' +
      'and whether the row was confirmed against real code or is unverified. Call with no ' +
      'contract to list the whole index. Returns present:false if the repo has no estate index — ' +
      'that means "unknown", NOT "no consumers".',
    inputSchema: {
      type: 'object',
      properties: {
        contract: {
          type: 'string',
          description: 'Event name, endpoint, table, client, or service to match (substring, case-insensitive). Omit for everything.',
        },
      },
    },
  },
  {
    name: 'knowledge_check',
    description:
      'Verify the repo\'s knowledge layer (CLAUDE.md, docs/PATTERNS.md, docs/ARCHITECTURE.md, ' +
      'shards) still matches the code: every file:line reference resolves, doc links resolve, ' +
      'every shard is reachable from the router, docs are within budget. Mechanical only — no ' +
      'judgment about whether a documented pattern is still the right one.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          description: 'Optional git ref. If given, also reports when source changed and no doc did.',
        },
      },
    },
  },
  {
    name: 'spec_list',
    description:
      'List every spec under specs/ with its lifecycle status, acceptance-criteria progress, ' +
      'branch, and ticket. Includes specs/archive/ flagged as archived.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional filter: Draft | Approved | Implemented | Verified | Archived.',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'Return only the summary counts, omitting the per-spec rows. Use on repos with hundreds of specs.',
        },
      },
    },
  },
  {
    name: 'spec_next_number',
    description:
      'The next free spec number, computed across ALL git branches rather than the working ' +
      'tree, so parallel spec authoring does not collide. Fetches first when a remote exists ' +
      'and says so when it could not.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args = {}) {
  switch (name) {
    case 'estate_lookup': {
      const estate = parseEstate();
      if (!estate.present) {
        return {
          present: false,
          edges: [],
          note:
            'No docs/ESTATE.md in this repo. This means the cross-service contracts are UNKNOWN, ' +
            'not that there are none. Run /sdd-estate (sdd-toolkit) to build the index before ' +
            'concluding a change is safe.',
        };
      }
      const q = (args.contract ?? '').toLowerCase();
      const edges = q
        ? estate.edges.filter((e) => Object.values(e).some((v) => String(v).toLowerCase().includes(q)))
        : estate.edges;
      return {
        present: true,
        query: args.contract ?? null,
        matched: edges.length,
        totalEdges: estate.edges.length,
        unresolvedMatches: edges.filter((e) => e.unresolved).length,
        edges,
        services: estate.services,
        note: edges.some((e) => e.unresolved)
          ? 'Some matched rows are (inferred) or _TBD_ — never confirmed against the peer repo. Treat those as hypotheses.'
          : null,
      };
    }

    case 'knowledge_check': {
      const r = runChecks({ root: ROOT, base: args.base ?? null });
      if (r.empty) {
        return { ok: true, empty: true, note: 'No knowledge layer found (CLAUDE.md / docs/). Run /sdd-init.' };
      }
      return {
        ok: r.errors.length === 0,
        docsChecked: r.docs,
        refsChecked: r.refsChecked,
        errors: r.errors,
        warnings: r.warnings,
      };
    }

    case 'spec_list': {
      const all = parseSpecs(ROOT);
      const summary = analyze(all);
      let specs = listSpecs();
      if (args.status) {
        const want = String(args.status).toLowerCase();
        specs = specs.filter((s) => (s.status ?? '').toLowerCase() === want);
      }
      // The summary is what a caller usually needs on a repo with hundreds of specs — it lets
      // a client answer "what's the state?" without rendering every row.
      return {
        count: specs.length,
        summary: {
          total: summary.total,
          active: summary.active,
          byStatus: summary.byStatus,
          withoutLifecycleWord: summary.unknownStatus,
          acceptanceCriteria: { total: summary.acTotal, checked: summary.acChecked },
          duplicateIds: summary.duplicateIds.map((d) => d.id),
          needsAttention: summary.attention.length,
        },
        specs: args.summaryOnly ? undefined : specs,
      };
    }

    case 'spec_next_number':
      return nextSpecNumber();

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// --- resources: the plugin's templates --------------------------------------

function listResources() {
  const out = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
      else if (f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.yml')) {
        out.push({
          uri: `sdd://templates/${prefix}${f}`,
          name: `${prefix}${f}`,
          description: 'sdd-toolkit template',
          mimeType: f.endsWith('.md') ? 'text/markdown' : 'text/plain',
        });
      }
    }
  };
  walk(join(HERE, '..', 'templates'), '');
  return out;
}

function readResource(uri) {
  const rel = uri.replace(/^sdd:\/\/templates\//, '');
  if (rel.includes('..')) throw new Error('invalid resource uri');
  const path = join(HERE, '..', 'templates', rel);
  if (!existsSync(path)) throw new Error(`no such resource: ${uri}`);
  return readFileSync(path, 'utf8');
}

// --- prompts: the plugin's slash commands ------------------------------------
// commands/ is the plugin's other half, and it is already the shape of an MCP prompt: YAML
// frontmatter (description, argument-hint) over a markdown body with a $ARGUMENTS placeholder.
// Exposing it here is what lets a non-Claude-Code client run /spec, /code and the rest.
//
// The client namespaces these, so `spec` arrives as `/mcp__sdd-toolkit__spec`, not `/spec`.
// That is the client's doing and cannot be opted out of.
//
// Agents have NO MCP equivalent, and several commands delegate real work to one. Rather than
// let those steps silently no-op, any agent a command names in bold is appended to the prompt
// as an appendix — so a client without subagents still gets the instructions. It runs them
// inline, losing the isolated context, tool restrictions and parallelism the plugin gets.
// /spec-fanout degrades the most; it is parallel-by-design.

const COMMANDS_DIR = join(HERE, '..', 'commands');
const AGENTS_DIR = join(HERE, '..', 'agents');

// Deliberately not a YAML parser. Every key in commands/ and agents/ is a flat `key: scalar`
// on one line; anything richer would be a new convention, not a parsing problem.
function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

// Commands name an agent in bold prose: "Spawn the **sdd-spec-reviewer** agent on the file".
// Match that rather than inventing a machine-readable field the plugin does not use, so the
// two halves cannot drift apart.
function agentAppendix(body) {
  if (!existsSync(AGENTS_DIR)) return '';
  const parts = [];
  for (const f of readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.md')).sort()) {
    const slug = basename(f, '.md');
    if (!body.includes(`**${slug}**`)) continue;
    const { body: agentBody } = parseFrontmatter(readFileSync(join(AGENTS_DIR, f), 'utf8'));
    parts.push(`### Agent: ${slug}\n\n${agentBody.trim()}`);
  }
  if (!parts.length) return '';
  return [
    '\n\n---\n',
    '## Inlined agent instructions',
    '',
    'The steps above delegate to subagents. This client has no subagent mechanism, so each',
    'referenced agent is reproduced below — follow its instructions inline, in the same order',
    'the steps call for, keeping its stated scope and restrictions.',
    '',
    parts.join('\n\n'),
  ].join('\n');
}

let PROMPTS = null;
function loadPrompts() {
  if (PROMPTS) return PROMPTS;
  PROMPTS = [];
  if (!existsSync(COMMANDS_DIR)) return PROMPTS;
  for (const f of readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md')).sort()) {
    const name = basename(f, '.md');
    const { meta, body } = parseFrontmatter(readFileSync(join(COMMANDS_DIR, f), 'utf8'));
    PROMPTS.push({
      name,
      description: meta.description ?? `sdd-toolkit /${name}`,
      hint: meta['argument-hint'] ?? '',
      takesArgs: body.includes('$ARGUMENTS'),
      body,
    });
  }
  return PROMPTS;
}

// Never `required: true`. Four commands take no arguments at all, and a client that blocks on
// a required field it cannot fill turns a working prompt into a dead menu entry.
function listPrompts() {
  return loadPrompts().map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.takesArgs
      ? [{ name: 'arguments', description: p.hint || 'arguments for this command', required: false }]
      : [],
  }));
}

function getPrompt(name, args) {
  const p = loadPrompts().find((x) => x.name === name);
  if (!p) throw new Error(`no such prompt: ${name}`);
  const given = typeof args?.arguments === 'string' ? args.arguments.trim() : '';
  const text = p.body.split('$ARGUMENTS').join(given) + agentAppendix(p.body);
  return {
    description: p.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

// --- JSON-RPC over stdio ----------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  const { id, method, params } = msg;
  // Notifications have no id and take no response.
  if (id === undefined) return;

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'sdd-toolkit', version: VERSION },
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: TOOLS });

      case 'tools/call': {
        const result = callTool(params?.name, params?.arguments ?? {});
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }

      case 'resources/list':
        return ok(id, { resources: listResources() });

      case 'prompts/list':
        return ok(id, { prompts: listPrompts() });

      case 'prompts/get':
        return ok(id, getPrompt(params?.name, params?.arguments ?? {}));

      case 'resources/read':
        return ok(id, {
          contents: [{ uri: params?.uri, mimeType: 'text/markdown', text: readResource(params?.uri) }],
        });

      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    // A tool that throws is a tool error, not a protocol error — report it as content so the
    // client can show it, rather than killing the session.
    if (method === 'tools/call') {
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
    return fail(id, -32603, e.message);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      fail(null, -32700, 'parse error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
