// Tests for the MCP server's protocol surface, driven the way a client drives it: spawn the
// process, write newline-delimited JSON-RPC to stdin, read the replies. There is nothing to
// import — the server is a script that owns stdio the moment it loads — so a subprocess is the
// honest unit here, and it also catches the failure a unit test would miss: the server not
// starting at all.
//
// Run with: node --test sdd-toolkit/mcp/
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'sdd-server.mjs');

const INIT = {
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

// Every exchange re-initializes: the server holds no cross-request state worth preserving and a
// fresh process per case keeps one failure from cascading into the next.
function rpc(...requests) {
  const input = [INIT, ...requests].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const out = execFileSync('node', [SERVER, '--root', HERE], { input, encoding: 'utf8' });
  const byId = new Map();
  for (const line of out.trim().split('\n')) {
    const msg = JSON.parse(line);
    byId.set(msg.id, msg);
  }
  return byId;
}

describe('prompts', () => {
  let list;
  before(() => {
    list = rpc({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }).get(1).result.prompts;
  });

  test('the server advertises the prompts capability', () => {
    const caps = rpc().get(0).result.capabilities;
    assert.ok(caps.prompts, 'a client that sees no prompts capability never calls prompts/list');
  });

  test('every command file is exposed as a prompt', () => {
    assert.ok(list.length >= 18, `expected the whole commands/ dir, got ${list.length}`);
    for (const name of ['spec', 'spec-build', 'spec-verify', 'code', 'fix', 'sdd-init']) {
      assert.ok(list.some((p) => p.name === name), `missing prompt: ${name}`);
    }
  });

  test('descriptions come from the command frontmatter', () => {
    const spec = list.find((p) => p.name === 'spec');
    assert.match(spec.description, /spec-driven-development spec/);
  });

  test('a command with no $ARGUMENTS declares no arguments', () => {
    // Otherwise a client renders a required-looking field for a command that ignores it.
    assert.deepEqual(list.find((p) => p.name === 'sdd-init').arguments, []);
  });

  test('an argument is never required, so a client cannot block on it', () => {
    for (const p of list) {
      for (const a of p.arguments) assert.notEqual(a.required, true, `${p.name} would block`);
    }
  });

  test('prompts/get substitutes $ARGUMENTS', () => {
    const res = rpc({
      jsonrpc: '2.0', id: 1, method: 'prompts/get',
      params: { name: 'spec', arguments: { arguments: 'PAY-42 refunds' } },
    }).get(1).result;
    const text = res.messages[0].content.text;
    assert.match(text, /PAY-42 refunds/);
    assert.ok(!text.includes('$ARGUMENTS'), 'an unsubstituted placeholder reaches the model as literal text');
  });

  test('omitting arguments leaves no placeholder behind', () => {
    const text = rpc({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'spec' },
    }).get(1).result.messages[0].content.text;
    assert.ok(!text.includes('$ARGUMENTS'));
  });

  test('an agent a command names in bold is inlined', () => {
    // The client has no subagents; without this the delegation step silently does nothing.
    const text = rpc({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'spec' },
    }).get(1).result.messages[0].content.text;
    assert.match(text, /Inlined agent instructions/);
    assert.match(text, /### Agent: sdd-spec-reviewer/);
  });

  test('a command that delegates to nobody gets no appendix', () => {
    const text = rpc({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sdd-doctor' },
    }).get(1).result.messages[0].content.text;
    assert.ok(!text.includes('Inlined agent instructions'));
  });

  test('an unknown prompt is an error, not an empty prompt', () => {
    const msg = rpc({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'nope' } }).get(1);
    assert.ok(msg.error);
    assert.match(msg.error.message, /no such prompt/);
  });
});

describe('the existing surface still works', () => {
  test('tools/list is unchanged', () => {
    const names = rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).get(1).result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ['estate_lookup', 'knowledge_check', 'spec_list', 'spec_next_number']);
  });
});
