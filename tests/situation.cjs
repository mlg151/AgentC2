// Pure invariants shared by workspace navigation and command dispatch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { validateWorkspace } = require('../electron/config.cjs');
function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}
const { situationFor, updateSituation, openInPane, closeWorkspaceTab, assignCallsigns, unitState } = load('workspace');
const { normalizeBinding, resolvedBinding, bindingMatches, validateShortcuts } = load('commands');
const a = 'default/tmux:hq-123', b = 'secondary/tmux:hq-123';
let workspace = validateWorkspace({ tabs: [a, b], selectedKey: a, splitKey: b, metadata: {} });
assert.equal(situationFor(workspace).anchorKey, a);
assert.equal(situationFor(workspace).targetKey, b);
const saved = structuredClone(workspace);
workspace = openInPane(workspace, 'default/tmux:hq-456');
assert.equal(workspace.situation.anchorKey, a);
assert.equal(workspace.situation.targetKey, 'default/tmux:hq-456');
assert.deepEqual(saved.tabs, [a, b], 'Opening a new target must not mutate the previous workspace');
workspace = updateSituation(workspace, { focusedPane: 'anchor' });
assert.equal(workspace.selectedKey, a);
assert.equal(workspace.splitKey, workspace.situation.targetKey);
workspace = openInPane(workspace, a);
assert.equal(workspace.situation.targetKey, 'default/tmux:hq-456');
for (let i = 0; i < 50; i++) workspace = openInPane(workspace, `default/tmux:hq-${1000 + i}`);
assert.equal(workspace.tabs.length, 40);
assert.ok(workspace.tabs.includes(a), 'Cycling must retain the anchor at the tab limit');
const promoted = closeWorkspaceTab(workspace, a);
assert.equal(promoted.situation.anchorKey, workspace.situation.targetKey);
assert.equal(promoted.situation.targetKey, null);
assert.equal(updateSituation(workspace, { targetKey: a }).situation.targetKey, null);
const sessions = Array.from({ length: 105 }, (_, i) => ({ key: `default/tmux:hq-${1000 + i}`, kind: 'managed' }));
workspace = assignCallsigns(validateWorkspace({ tabs: [], metadata: {} }), [{ key: a, kind: 'managed' }, { key: b, kind: 'managed' }]);
workspace = assignCallsigns(workspace, sessions);
assert.equal(Object.keys(workspace.situation.callsigns).length, 99);
assert.equal(new Set(Object.values(workspace.situation.callsigns)).size, 99);
assert.notEqual(workspace.situation.callsigns[a], workspace.situation.callsigns[b]);
const before = structuredClone(workspace.situation.callsigns);
workspace = assignCallsigns(workspace, [...sessions].reverse());
assert.deepEqual(workspace.situation.callsigns, before, 'Refresh order and missing units must not reassign callsigns');
assert.equal(assignCallsigns(workspace, [{ key: 'default/codex:saved', kind: 'conversation' }]), workspace);
assert.deepEqual(validateWorkspace(workspace).situation.callsigns, before);
const filteredWorkspace = assignCallsigns(validateWorkspace({ tabs: [], metadata: {}, situation: { ...workspace.situation, callsigns: { 'default/process:external': '01' } } }), [
  { key: a, kind: 'managed' }, { key: b, kind: 'managed', stale: true },
  { key: 'default/process:external', kind: 'unmanaged' },
  { key: 'default/tmux:external', kind: 'external-tmux' },
  { key: 'default/codex:background', kind: 'background' },
  { key: 'default/codex:history', kind: 'conversation' },
]);
assert.deepEqual(filteredWorkspace.situation.callsigns, { [a]: '01', [b]: '02' }, 'Only managed sessions get callsigns; old external callsigns must be released');
assert.equal(unitState({ kind: 'managed', state: 'live' }, []).code, 'LIVE');
assert.equal(unitState({ kind: 'managed', state: 'live', stale: true, exitCode: 1 }, []).code, 'UNKNOWN');
assert.equal(unitState({ key: a }, [{ sessionKey: a, kind: 'input', confidence: 'confirmed', acknowledged: false }]).code, 'HALT');
for (const [chatState, code] of [['starting', 'UNKNOWN'], ['unknown', 'UNKNOWN'], ['idle', 'STBY'], ['running', 'ENG'], ['waiting', 'HALT'], ['stopped', 'STBY'], ['failed', 'FAULT']]) {
  assert.equal(unitState({ key: a, transport: 'chat', chatState, state: 'live' }, [{ sessionKey: a, kind: 'input', confidence: 'confirmed', acknowledged: false }]).code, code, `Structured ${chatState} must override old attention and generic process hints`);
}
assert.equal(normalizeBinding('option+control+j'), 'Ctrl+Alt+J');
assert.equal(resolvedBinding('Primary+K', true), 'Meta+K');
assert.equal(resolvedBinding('Primary+K', false), 'Ctrl+K');
for (const invalid of ['J', 'Ctrl+Ctrl+J', 'Primary+Meta+K', 'Ctrl+unknown']) assert.throws(() => normalizeBinding(invalid));
assert.throws(() => validateShortcuts({ cycleNext: 'Ctrl+K' }, false), /conflicts/);
assert.throws(() => validateShortcuts({ cycleNext: 'Cmd+K' }, true), /conflicts/);
assert.equal(validateShortcuts({ cycleNext: '' }, false).cycleNext, '');
const event = { code: 'KeyJ', key: '∆', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, getModifierState: () => false };
assert.ok(bindingMatches(event, 'Alt+J', true), 'Option characters must still match physical navigation keys');
assert.ok(!bindingMatches({ ...event, isComposing: true }, 'Alt+J', true));
assert.ok(!bindingMatches({ ...event, getModifierState: () => true }, 'Alt+J', true));
assert.ok(!bindingMatches({ ...event, shiftKey: true }, 'Alt+J', false));
console.log('PASS Situation Room migration, independent panes, immutable navigation, stable scoped callsigns/overflow, truthful states, and cross-platform shortcut validation');
