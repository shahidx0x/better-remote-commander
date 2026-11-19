import { test } from 'node:test';
import assert from 'node:assert/strict';

const { listTools } = await import('../dist/dispatcher.js');
const { TOOL_CHOICES, addToolChoice } = await import('../dist/tool-routing.js');
const definitions = listTools();
const byName = new Map(definitions.map(t => [t.name, t]));

test('ALL advertised agent tools have unique, actionable WHEN / USE INSTEAD rules', () => {
  assert.equal(definitions.length, 82, 'keep the explicit coverage count intentional');
  assert.equal(byName.size, definitions.length, 'no duplicate tool names');
  assert.deepEqual(Object.keys(TOOL_CHOICES).sort(), [...byName.keys()].sort(),
    'a new/removed public tool requires updating the routing catalog');
  for (const tool of definitions) {
    const route = TOOL_CHOICES[tool.name];
    assert.ok(route?.use.length >= 25, tool.name + ' lacks a meaningful use-case');
    assert.ok(route?.instead.length >= 25, tool.name + ' lacks an alternative/non-use case');
    assert.ok(tool.description.startsWith('USE WHEN: ' + route.use + '\nUSE INSTEAD: '),
      tool.name + ' has stale or incorrect routing description');
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', tool.name + ' lacks a schema');
    assert.ok(tool.description.length <= 7500, tool.name + ' description is too large for efficient discovery');
  }
  assert.throws(() => addToolChoice({ name: 'invented_tool', description: 'x' }), /Missing MCP tool choice rule/);
});

test('confusing neighboring tools are differentiated without claiming unsupported evidence', () => {
  const cases = [
    ['read_multiple_files', /2\+ already-known files/i, /start_search/i],
    ['read_file', /ONE known file/i, /read_multiple_files/i],
    ['read_code_file', /SHA-256/i, /read_code_ranges/i],
    ['read_code_ranges', /multiple KNOWN line ranges/i, /read_multiple_files/i],
    ['batch_tools', /INDEPENDENT different/i, /read_multiple_files/i],
    ['workspace_batch', /MULTIPLE hash-checked file edits/i, /batch_tools/i],
    ['run_command', /ONE-SHOT command/i, /start_process/i],
    ['start_process', /long-running or interactive/i, /run_command/i],
    ['code_diagnostics', /syntax parsing/i, /compiler/i],
    ['find_references', /lexical identifier reference CANDIDATES/i, /semantic language-server/i],
    ['test_impact', /candidate affected tests/i, /actual test execution/i],
    ['discover_checks', /Discover existing manifest-defined/i, /execute them/i],
    ['run_project_checks', /execute selected manifest-backed/i, /verify_project/i],
    ['docker_inventory', /actual existing Docker/i, /docker_inspect/i],
    ['read_images', /resized previews/i, /image editing/i],
    ['worker_tasks', /ONLY when the AI host actually provides/i, /spawns LLM workers/i],
    ['worker_patch', /proposed hash-checked changes/i, /directly write/i],
    ['worker_integrate', /preview, apply and verify/i, /workspace_batch/i],
  ];
  for (const [name, use, alternative] of cases) {
    const rule = TOOL_CHOICES[name];
    assert.match(rule.use, use, name + ': use-case');
    assert.match(rule.instead, alternative, name + ': alternative');
  }
  for (const name of ['project_context','context_pack','code_graph','code_outline','find_symbols','related_files','language_capabilities']) {
    assert.ok(byName.has(name) && byName.get(name).description.startsWith('USE WHEN: '));
  }
  assert.match(TOOL_CHOICES['find_references'].caveat, /may appear/i);
  assert.match(TOOL_CHOICES['code_diagnostics'].caveat, /never a passing typecheck/i);
  assert.match(TOOL_CHOICES['docker_inventory'].caveat, /UNKNOWN/i);
  assert.match(TOOL_CHOICES['worker_patch'].caveat, /does not apply/i);
});

test('tool descriptions lead with actionable next calls and enforce discovery budgets', () => {
  const required=['read_file','read_multiple_files','read_code_file','write_file','workspace_batch','run_parallel','get_job','worker_tasks'];
  for(const name of required){
    const desc=byName.get(name)?.description;
    assert.ok(desc?.includes('HOW / NEXT:'),name+' missing executable next-step guidance');
    assert.ok(desc.length<=3000,name+' oversized tool discovery description');
  }
  assert.match(byName.get('read_file').description,/PDF|pages/);
  assert.match(byName.get('write_file').description,/chunk/);
  assert.match(byName.get('run_parallel').description,/wait_jobs/);
  const total=definitions.reduce((n,x)=>n+x.description.length,0);
  assert.ok(total<61500,'the model-facing tool descriptions regressed: '+total);
  const advertisedBytes=Buffer.byteLength(JSON.stringify(definitions),'utf8');
  assert.ok(advertisedBytes<112500,'tool catalog metadata grew unexpectedly: '+advertisedBytes);
});

test('the tool-routing helper changes descriptions ONLY, not names, schema or access annotations', () => {
  const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' } } };
  const annotations = { readOnlyHint: true };
  const original = { name: 'read_file', description: 'Read one file.', inputSchema: schema, annotations };
  const modified = addToolChoice(original);
  assert.equal(modified.name, original.name);
  assert.strictEqual(modified.inputSchema, schema);
  assert.strictEqual(modified.annotations, annotations);
  assert.equal(original.description, 'Read one file.', 'source definitions remain unmodified');
  assert.match(modified.description, /DETAILS: Read one file\./);
});
