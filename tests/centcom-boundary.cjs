const assert = require('node:assert/strict');
const { LIMITS, fingerprint, redact, bounded, parseCentcomEnvelope } = require('../electron/centcom-contract.cjs');
const { activeFleet, commanderIdentity } = require('../electron/centcom-fleet.cjs');
const { outputSchema, automationOutputSchema } = require('../electron/centcom-output.cjs');
const { validate, automationSchema } = require('../electron/centcom-schema.cjs');
const { readHistory, summarizeAction } = require('../electron/centcom-history.cjs');
const envelope = (value) => '```agentc2-c2\n' + JSON.stringify(value) + '\n```';

for (const value of [undefined, null, false, 1, {}, '', ' \n', 'ordinary response']) assert.equal(parseCentcomEnvelope(value), null);
assert.match(parseCentcomEnvelope('```agentc2-c2\n{}').error, /Unterminated/);
assert.match(parseCentcomEnvelope(envelope({}) + envelope({})).error, /Exactly one/);
assert.match(parseCentcomEnvelope('```agentc2-c2\n' + ' '.repeat(LIMITS.envelopeBytes + 1) + '\n```').error, /byte limit/);
assert.match(parseCentcomEnvelope('```agentc2-c2\n{bad}\n```').error, /Malformed JSON/);
for (const value of [null, [], 1, {}, { version: 2 }]) assert.match(parseCentcomEnvelope(envelope(value)).error, /version/);
const minimal = parseCentcomEnvelope(envelope({ version: 1 }));
assert.deepEqual(minimal, { version: 1, rationale: '', diagnostics: [], queries: [], directives: [], automations: [] });
const rationale = parseCentcomEnvelope(envelope({ version: 1, rationale: 'x'.repeat(2001), unknown: true }));
assert.equal(rationale.rationale.length, 2000);
assert.deepEqual(rationale.diagnostics.map((item) => item.code), ['truncated', 'invalid_field']);
assert.equal(parseCentcomEnvelope(envelope({ version: 1, rationale: 42 })).rationale, '');
assert.equal(parseCentcomEnvelope(envelope({ version: 1 }).replaceAll('\n', '\r\n')).version, 1);
for (const collection of ['queries', 'directives', 'automations']) {
  assert.equal(parseCentcomEnvelope(envelope({ version: 1, [collection]: {} })).diagnostics[0].code, 'invalid_collection');
  const base = { kind: collection === 'automations' ? 'preset' : 'fleet.inspect', id: 'fixture' };
  const valid = [base, { ...base, id: undefined }, ...(collection === 'automations' ? [{ ...base, evidence: ['Reviewed fixture evidence'], payload: {} }] : [{ ...base, kind: undefined, type: 'fleet.inspect', params: {}, preconditions: {} }, { ...base, type: base.kind }])];
  for (const request of valid) {
    const parsed = parseCentcomEnvelope(envelope({ version: 1, [collection]: [request] }));
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed[collection].length, 1);
  }
  const malformed = [null, [], 1, {}, { ...base, kind: 1 }, { ...base, kind: 'one', type: 'two' },
    ...[0, '', '\0', 'x'.repeat(201)].map((id) => ({ ...base, id })),
    { ...base, params: [] }, { ...base, preconditions: [] }, { ...base, arbitrary: true },
    ...['title', 'summary', 'rationale'].flatMap((key) => [{ ...base, [key]: 42 }, { ...base, [key]: 'x'.repeat(key === 'rationale' ? 2001 : 151) }]),
  ];
  for (const request of malformed) {
    const parsed = parseCentcomEnvelope(envelope({ version: 1, [collection]: [request] }));
    assert.equal(parsed[collection].length, 0);
    assert.equal(parsed.diagnostics[0].code, 'invalid_request');
  }
  const over = parseCentcomEnvelope(envelope({ version: 1, [collection]: Array.from({ length: LIMITS[collection] + 1 }, () => base) }));
  assert.equal(over[collection].length, LIMITS[collection]); assert.equal(over.diagnostics[0].code, 'over_limit');
}
for (const evidence of [{}, Array(11).fill('evidence'), [42], ['x'.repeat(2001)]]) {
  const parsed = parseCentcomEnvelope(envelope({ version: 1, automations: [{ kind: 'preset', evidence }] }));
  assert.equal(parsed.automations.length, 0); assert.match(parsed.diagnostics[0].message, /Evidence must contain/);
}
assert.equal(fingerprint({ z: [null, 2, { b: 2, a: 1 }], a: true }), fingerprint({ a: true, z: [null, 2, { a: 1, b: 2 }] }));
assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
assert.deepEqual(redact({ password: 'fixture', tokens: 2, tokenCount: 3, nested: [{ authorization: 'fixture', safe: true }] }), { password: '[REDACTED]', tokens: 2, tokenCount: 3, nested: [{ authorization: '[REDACTED]', safe: true }] });
assert.equal(redact('-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]');
for (const token of ['ghp_' + 'a'.repeat(20), 'github_pat_' + 'a'.repeat(20), 'sk-proj-' + 'a'.repeat(20), 'AKIA' + 'A'.repeat(16)]) assert.equal(redact(token), '[REDACTED TOKEN]');
assert.equal(redact('Bearer fixture password=fixture'), 'Bearer [REDACTED] password=[REDACTED]');
assert.equal(bounded(undefined), undefined); assert.equal(bounded(null), null);
assert.equal(bounded('exact', Buffer.byteLength(JSON.stringify('exact'))), 'exact');
assert.equal(bounded('🧪'.repeat(LIMITS.resultBytes)).truncated, true);
assert.equal(bounded({ secret: 'fixture' }).secret, '[REDACTED]');
assert.match(bounded('x'.repeat(100), 20).reason, /byte limit/);
assert.throws(() => outputSchema('unknown-operation'), /Missing output contract/);
assert.throws(() => automationOutputSchema('unknown-kind'), /Unknown automation output/);
assert.throws(() => automationSchema('unknown-kind'), /Unknown automation schema/);
assert.throws(() => validate({ $ref: '#/$defs/unknown' }, {}), /Unresolved schema reference/);
assert.equal(validate({ not: { const: 1 } }, 2), 2);
assert.deepEqual(validate({ type: 'object' }, { upstream: 'permitted extension' }), { upstream: 'permitted extension' });
assert.throws(() => validate({ type: 'array', uniqueItems: true }, ['same', 'same']), /duplicate items/);
assert.deepEqual(validate({ type: 'object', propertyNames: { pattern: '^safe_' } }, { safe_key: true }), { safe_key: true });
assert.throws(() => validate({ type: 'object', propertyNames: { pattern: '^safe_' } }, { unsafe: true }), /Malformed input property/);
assert.equal(readHistory({ outcomeSequence: 0, outcomes: [] }).retainedFrom, 1);
assert.equal(summarizeAction({ kind: 'sitrep.handoff', params: {}, result: { hostId: 'alpha' } }).handoff.destination.key, undefined);
const legacy = { outcomeSequence: 1, outcomes: [{ collection: 'directive', sequence: 1, serverId: 'legacy', outcomeId: 'old', status: 'completed' }] };
assert.equal(readHistory(legacy).unknownMetadata, 1, 'Legacy outcomes without source records retain explicit uncertainty');
const incomplete = { ...legacy, outcomes: [{ ...legacy.outcomes[0], action: { operation: 'unit.send', scope: {}, targets: [], coverage: 'bound' } }] };
assert.deepEqual(readHistory(incomplete, { view: 'patterns' }).entries, [], 'Absent scope fingerprints cannot establish an observed repeated pattern');

assert.equal(commanderIdentity(null), null);
assert.equal(commanderIdentity({ hostId: 'alpha', name: 'hq-' + 'a'.repeat(12) }).key, 'alpha/tmux:hq-' + 'a'.repeat(12));
const missing = activeFleet();
assert.deepEqual(missing.sessions, []); assert.equal(missing.inventory, undefined); assert.deepEqual(missing.flash(), []);
const name = 'hq-' + 'a'.repeat(12), key = `alpha/tmux:${name}`;
const unit = { key, name, hostId: 'alpha', kind: 'managed', managed: true, state: 'live', providerSessionId: 'native-fixture' };
const fleet = activeFleet({ hosts: [{ id: 'alpha', connected: true }], sessions: [unit] }, ['saved-legacy-id']);
assert.equal(fleet.find(name), unit); assert.equal(fleet.find('native-fixture', 'alpha'), unit);
assert.equal(fleet.clean({ key, name }).key, key);
assert.equal(fleet.clean('saved-legacy-id'), '[Excluded session]');
assert.equal(fleet.clean('hq-' + 'b'.repeat(12)), '[Excluded session]');
assert.deepEqual(fleet.flash(), []);
console.log('PASS envelope admission limits and diagnostics, malformed collections/requests/evidence, canonical fingerprints, nested/inline credential redaction, byte bounds, missing schema rejection, and fleet identity/default boundaries');
