const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activeFleet, rosterInventory } = require('../electron/centcom-fleet.cjs');
const name = 'hq-' + 'a'.repeat(12), key = `alpha/tmux:${name}`;
const unit = { key, id: name, hostId: 'alpha', kind: 'managed', managed: true, state: 'live' };
const commander = { ...unit, key: 'alpha/tmux:hq-bbbbbbbbbbbb', id: 'hq-bbbbbbbbbbbb', title: 'Renamed commander' };
const legacy = { ...unit, key: 'alpha/tmux:hq-cccccccccccc', id: 'hq-cccccccccccc', transport: 'chat', title: 'CENTCOM // CODEX (fixture)', cwd: '/home/fixture/.cache/agentc2/centcom' };
const ordinary = { ...unit, title: 'CENTCOM // CODEX (fixture)', cwd: '/fixture/project', transport: 'chat' };
const roster = rosterInventory({ sessions: [ordinary, commander, legacy], attention: [{ sessionKey: key }, { sessionKey: legacy.key }], faults: [{ sessionKey: commander.key }] }, [{ hostId: 'alpha', name: commander.id, key: commander.key }]);
assert.deepEqual(roster.sessions, [ordinary], 'Current, retired, and legacy commanders must not enter the roster');
assert.deepEqual(roster.attention, [{ sessionKey: key }]);
assert.deepEqual(roster.faults, []);
assert.deepEqual(new Set(roster.internalSessionKeys), new Set([commander.key, legacy.key]));
assert.equal(activeFleet({ hosts: [{ id: 'alpha', connected: true }], sessions: [legacy] }).sessions.length, 0);
const fleet = activeFleet({ hosts: [{ id: 'alpha', connected: true }], sessions: [unit] });
for (const [input, expected] of [
  [key, key], [`(${key})`, `(${key})`], [`other/tmux:${name}`, '[Excluded session]'],
  [`prefix-${key}`, '[Excluded session]'], [`-${key}`, '[Excluded session]'],
  [`${key}\nunknown/tmux:hq-${'b'.repeat(12)}`, `${key}\n[Excluded session]`],
  ['a/b/tmux:external-unit', 'a/[Excluded session]'], ['plain text', 'plain text'],
  [`${name} extra`, `${name} extra`], ['chat-' + 'b'.repeat(32), '[Excluded session]'],
]) assert.equal(fleet.clean(input), expected);

// The old greedy prefix retried from every position in an unbroken word. Keep
// that regression in a disposable process so a failure cannot hang the runner.
const modulePath = path.resolve(__dirname, '../electron/centcom-fleet.cjs');
const program = `
const assert = require('node:assert/strict');
const { activeFleet } = require(process.argv[1]);
const fleet = activeFleet();
for (const value of ['x'.repeat(1000000), '-'.repeat(1000000), 'prefix-' + 'a'.repeat(1000000)]) assert.equal(fleet.clean(value), value);
assert.equal(fleet.clean('x'.repeat(1000000) + '/tmux:unknown'), '[Excluded session]');
console.log('PASS long plain evidence and unknown identity redaction');
`;
const result = spawnSync(process.execPath, ['-e', program, modulePath], { encoding: 'utf8', timeout: 10000, maxBuffer: 100000 });
assert.equal(result.error, undefined, 'Long plain metadata must not stall fleet identity redaction: ' + result.error);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /PASS long plain evidence/);
console.log('PASS fleet identity boundaries and linear-time long-word/hyphen evidence redaction with an isolated watchdog');
