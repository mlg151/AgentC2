const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activeFleet } = require('../electron/centcom-fleet.cjs');
const name = 'hq-' + 'a'.repeat(12), key = `alpha/tmux:${name}`;
const unit = { key, id: name, hostId: 'alpha', kind: 'managed', managed: true, state: 'live' };
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
