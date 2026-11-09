import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, pluginTools, PLUGINS } from '../api/plugins.js';

test('calculator handles precedence, powers, percent and functions', () => {
  assert.equal(calculate('(1200*0.15)+sqrt(81)'), 189);
  assert.equal(calculate('2^10'), 1024);
  assert.equal(calculate('2^3^2'), 512);
  assert.equal(calculate('15% * 80'), 12);
  assert.equal(calculate('-3 + 4*2'), 5);
  assert.equal(calculate('1,000 / 8'), 125);
  assert.ok(Math.abs(calculate('pi') - Math.PI) < 1e-12);
});

test('calculator rejects anything that is not math', () => {
  assert.throws(() => calculate('process.exit()'));
  assert.throws(() => calculate('constructor'));
  assert.throws(() => calculate('1 +'));
  assert.throws(() => calculate('1/0'));
  assert.throws(() => calculate('x'.repeat(400)));
});

test('pluginTools returns only enabled, known plug-ins in tool-loop shape', async () => {
  assert.deepEqual(pluginTools(undefined), []);
  assert.deepEqual(pluginTools(['nope']), []);
  const tools = pluginTools(['calculator', 'clock']);
  assert.deepEqual(tools.map((t) => t.name), ['calculator', 'world_clock']);
  for (const t of tools) {
    assert.equal(typeof t.run, 'function');
    assert.equal(t.inputSchema.type, 'object');
    assert.match(t.label, / · /);
  }
  assert.equal(await tools[0].run({ expression: '6*7' }), '6*7 = 42');
  assert.match(await tools[1].run({ timezone: 'Mars/Base' }), /Unknown time zone/);
  assert.equal(PLUGINS.length, 6);
});

test('read_url refuses private addresses', async () => {
  const [reader] = pluginTools(['reader'], {});
  await assert.rejects(reader.run({ url: 'http://127.0.0.1/admin' }));
  await assert.rejects(reader.run({ url: 'https://10.0.0.1/' }));
});
