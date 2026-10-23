// JSON Schema draft 2020-12 subset used by the commander boundary. The same
// schemas are published and executed; service validators still enforce live
// references, revision checks, and provider-specific invariants.
const str = (maxLength = 4096, minLength = 0, extra = {}) => ({ type: 'string', minLength, maxLength, pattern: '^[^\\u0000]*$', ...extra });
const choice = (...values) => ({ type: 'string', enum: values });
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const bool = { type: 'boolean' };
const arr = (items, maxItems = 100, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const provider = choice('codex', 'claude', 'antigravity', 'opencode');
const roe = choice('full', 'gated', 'provider-default');
const id = str(80, 1, { pattern: '^[a-zA-Z0-9_-]{1,80}$' });
const workId = str(32, 32, { pattern: '^[a-f0-9]{32}$' });
const revision = str(64, 64, { pattern: '^[a-f0-9]{64}$' });
const workflowId = str(60, 1, { pattern: '^[a-z][a-z0-9_-]{0,59}$' });
const rank = choice('flag_officer', 'officer', 'enlisted');
const defs = {
  host: obj({ id, kind: choice('ssh', 'local'), name: str(100), target: str(255), port: int(1, 65535), enabled: bool, autoForward: bool }, ['id', 'name', 'enabled']),
  loopBreaker: obj({ enabled: bool, autoInterrupt: bool, threshold: int(2, 20), windowMinutes: int(1, 120), cooldownMinutes: int(1, 1440) }, []),
  preset: obj({ id, name: str(100), provider, command: str(4096, 1), args: str(), cwd: str(), instructions: str(20000), fullPermissions: bool,
    roeProfile: choice('', ...roe.enum), attentionHooks: bool, hostId: str(80), loopBreaker: ref('loopBreaker') }, ['id', 'name', 'provider', 'command']),
  roe: obj({ version: { const: 1 }, hostDefaults: { type: 'object', additionalProperties: roe } }),
  mcp: obj({ name: id, transport: choice('stdio', 'http'), providers: { ...arr(provider, 4, 1), uniqueItems: true }, command: str(500), args: arr(str(500), 40), url: str(1000),
    env: { ...arr(str(200, 1, { pattern: '^[A-Z_][A-Z0-9_]*$' }), 30), uniqueItems: true }, headers: { type: 'object', propertyNames: str(80, 1, { pattern: '^[A-Za-z0-9-]{1,80}$' }), additionalProperties: str(200, 1, { pattern: '^[A-Z_][A-Z0-9_]*$' }) } }, ['name', 'transport']),
  oporder: obj({ version: { const: 1 }, id, hostId: id, repository: str(4096, 1, { pattern: '^/' }), enabled: bool, instructions: str(40000),
    overrides: obj({ codex: str(20000), claude: str(20000), antigravity: str(20000) }, []), mcp: arr(ref('mcp'), 30) }, ['version', 'id', 'hostId', 'repository']),
  settings: obj({ hosts: arr(ref('host'), 30, 1), presets: arr(ref('savedPreset'), 100), roe: ref('roe'), opOrders: arr(ref('oporder'), 50) }, []),
  worktree: obj({ operationId: workId, repository: str(4096, 1), baseRef: str(200, 1), slug: str(40, 1, { pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }) }),
  assignment: obj({ operationId: workId, repository: str(4096, 1), baseRef: str(200, 1), slug: str(40, 1, { pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }) }, []),
  contestant: obj({ provider, presetId: id, roeProfile: roe }, ['provider']),
  answer: obj({ questionId: str(200, 1), answers: arr(str(10000), 20) }),
  stage: obj({ id: workflowId, profile: workflowId, rank, role: choice('planner', 'reviewer', 'implementer'), allow_write: bool, prompt_template: str(8000, 1), next: str(60, 1),
    transitions: obj({ on_approve: str(60, 1), on_deny: str(60, 1), on_complete: str(60, 1), on_fault: str(60, 1) }, []) }, ['id', 'profile', 'rank', 'role', 'prompt_template']),
  workflow: obj({ version: { const: 1 }, id: workflowId, name: str(100, 1), trigger: choice('github_issue', 'github_repo'), completion_action: nullable(choice('ready_pr', 'close_verified')),
    max_loop_retries: int(0, 10), max_steps: int(1, 100), max_budget_usd: nullable({ type: 'number', exclusiveMinimum: 0 }), stages: arr(ref('stage'), 20, 1) }, ['version', 'id', 'name', 'trigger', 'max_loop_retries', 'max_steps', 'stages']),
  profile: obj({ id: workflowId, name: str(100, 1), provider: choice('codex', 'claude', 'antigravity'), model: str(200, 1), ranks: arr(rank, 3, 1) }),
  specops: obj({ version: { const: 1 }, profiles: arr(ref('profile'), 100, 1), workflows: arr(ref('workflow'), 100) }, ['profiles', 'workflows']),
  triggers: obj({ onLoopFault: bool, onSpecopsHalt: bool, onUnitFailed: bool, onFlashTraffic: bool, onUnitCompleted: bool, onDependencyChange: bool,
    cooldownSeconds: int(10, 3600), maxAutoTurnsPerHour: int(1, 100), fallbackSeconds: { anyOf: [{ const: 0 }, int(600, 86400)] } }, []),
  preconditions: obj(Object.fromEntries(['sessionKey', 'state', 'processId', 'startedAt', 'turnId', 'revision', 'stage'].map((key) => [key, str(1000, 1)])), []),
};
const automationPayloads = { preset: ref('preset'), oporder: obj({ order: ref('oporder'), revision }, ['order']), specops_workflow: ref('workflow'), centcom_trigger: ref('triggers') };
defs.savedPreset = { ...defs.preset, required: [...defs.preset.required, 'args', 'cwd', 'instructions'] };
defs.host.anyOf = [{ properties: { kind: { const: 'local' } }, required: ['kind'] }, { required: ['target', 'port'] }];
defs.mcp.oneOf = [
  { properties: { transport: { const: 'stdio' }, command: str(500, 1), url: { const: '' }, headers: obj({}, []) }, required: ['command'] },
  { properties: { transport: { const: 'http' }, url: str(1000, 1, { pattern: '^https://[^\\s@/?#]+(?:/[^?#]*)?$' }), command: { const: '' }, args: arr(str(), 0), env: arr(str(), 0) }, required: ['url'] },
];

function validate(schema, value, definitions = defs, location = 'input') {
  const fail = (reason) => { throw Object.assign(new Error(`Malformed ${location}: ${reason}`), { code: 'invalid_schema' }); };
  if (schema.$ref) {
    const target = definitions[schema.$ref.replace('#/$defs/', '')];
    if (!target) throw new Error(`Unresolved schema reference: ${schema.$ref}`);
    return validate(target, value, definitions, location);
  }
  if (schema.const !== undefined && value !== schema.const) fail(`expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join(', ')}`);
  for (const mode of ['anyOf', 'oneOf']) if (schema[mode]) {
    const matches = schema[mode].filter((part) => { try { validate(part, value, definitions, location); return true; } catch { return false; } }).length;
    if (mode === 'anyOf' ? !matches : matches !== 1) fail(`expected ${mode === 'oneOf' ? 'exactly one' : 'a'} supported shape`);
  }
  if (schema.not) { let matches = true; try { validate(schema.not, value, definitions, location); } catch { matches = false; } if (matches) fail('forbidden field combination'); }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type);
    if (!matches) fail(`expected ${types.join(' or ')}`);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed() || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))) fail('invalid text or length');
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity))) fail('outside allowed range');
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) fail('invalid item count');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail('duplicate items');
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, definitions, `${location}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) validate(schema.propertyNames, key, definitions, `${location} property`);
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(schema.properties[key], item, definitions, `${location}.${key}`);
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, item, definitions, `${location}.${key}`);
    }
  }
  return value;
}

function operationInput(operation, parameters, target) {
  const fields = { ...(target === 'session' ? { sessionKey: 'string?', key: 'string?', name: 'string?', hostId: 'string?', chatSessionId: 'string?' } : {}), ...parameters };
  const properties = Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, type.startsWith('string') ? str() : type === 'nullable' ? nullable(str(300, 1)) : { type: type.replace('?', '') }]));
  const schema = obj(properties, Object.keys(fields).filter((key) => !fields[key].endsWith('?')));
  const patch = (values) => Object.assign(properties, values);
  if (properties.hostId) properties.hostId = id;
  if (properties.provider) properties.provider = provider;
  if (properties.roeProfile) properties.roeProfile = roe;
  if (operation === 'unit.create') patch({ provider: choice(...provider.enum, 'terminal'), transport: choice('chat', 'terminal'), model: str(200), title: str(100), instructions: str(20000), worktree: ref('worktree'), launchId: workId });
  if (['unit.send', 'unit.steer'].includes(operation)) patch({ text: str(200000, 1), expectedTurnId: str(200, 1) });
  if (operation === 'chat.respond') { patch({ requestId: str(200, 1), turnId: nullable(str(200, 1)), itemId: nullable(str(200, 1)), decision: choice('allow', 'deny'), answers: arr(ref('answer'), 20, 1) }); schema.oneOf = [{ required: ['decision'], not: { required: ['answers'] } }, { required: ['answers'], not: { required: ['decision'] } }]; }
  if (operation === 'unit.search') patch({ keys: arr(str(300, 1), 200), query: str(1000, 1) });
  if (operation === 'unit.rename') patch({ title: str(100, 1) });
  if (operation === 'flash.decide') patch({ decision: choice('allow', 'deny') });
  if (operation === 'specops.control') patch({ action: choice('resume', 'retry', 'cancel') });
  if (operation === 'specops.configure') patch({ yaml: str(200000, 1, { contentMediaType: 'application/yaml', contentSchema: ref('specops'), description: 'YAML matching SPECOPS profiles and workflows; reuse context.read definitions. Live profile references and graph reachability are validated before save.' }) });
  if (operation === 'exercise.control') { patch({ action: choice('retry', 'cancel', 'complete', 'promote') }); schema.anyOf = [{ properties: { action: choice('retry', 'cancel') } }, { properties: { action: { const: 'complete' } }, required: ['contestantId'] }, { properties: { action: { const: 'promote' } }, required: ['contestantId', 'revision'] }]; }
  if (operation === 'exercise.create') patch({ title: str(100, 1), prompt: str(12000, 1), baseRef: str(200, 1), testCommand: str(500), contestants: arr(ref('contestant'), 3, 2) });
  if (operation === 'diff.hunk') patch({ operation: choice('stage', 'revert') });
  if (operation.startsWith('sitrep.')) { if (properties.testCommand) properties.testCommand = operation === 'sitrep.inspect' ? { const: '' } : str(500); }
  if (operation === 'sitrep.handoff') patch({ objective: str(2000, 1), summary: str(4000, 1), nextSteps: str(2000), title: str(100), slug: str(40, 1, { pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }), operationId: workId });
  if (operation === 'configuration.save') patch({ settings: ref('settings') });
  if (operation.startsWith('oporder.')) patch({ order: ref('oporder'), ...(properties.revision ? { revision } : {}) });
  if (operation === 'admission.check') patch({ worktree: ref('assignment') });
  if (operation === 'units.list') patch({ provider, classification: choice('managed', 'external', 'saved'), execution: choice('executing', 'waiting', 'idle', 'stopped', 'failed', 'unknown'), limit: int(1, 50) });
  if (operation === 'context.read') patch({ section: choice('definitions', 'presets', 'oporders', 'notes', 'handoffs'), limit: int(1, 50) });
  if (operation === 'outcomes.read') patch({ collection: choice('directive', 'automation', 'approval', 'audit', 'diagnostic', 'query', 'provider'), after: int(0, Number.MAX_SAFE_INTEGER), limit: int(1, 50) });
  if (operation === 'capabilities.support') patch({ provider: choice(...provider.enum, 'terminal'), transport: choice('chat', 'terminal'), limit: int(1, 50) });
  if (operation === 'capabilities.read') patch({ schema: choice('input', 'output') });
  if (operation === 'artifact.read') patch({ operationId: workId, revision, offset: int(0, 256000), limit: int(1, 16000) });
  if (['automation.validate', 'automation.preview'].includes(operation)) schema.oneOf = Object.entries(automationPayloads).map(([kind, payload]) => ({ properties: { kind: { const: kind }, payload } }));
  if (operation.startsWith('github.')) {
    patch({ repo: str(200, 3, { pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' }), issue: int(1, 999999999), number: int(1, 999999999), query: str(500),
      headCommit: str(64, 40, { pattern: '^[a-f0-9]{40,64}$' }), evidence: obj({ commit: str(64, 40, { pattern: '^[a-f0-9]{40,64}$' }), summary: str(4000, 10) }) });
    if (operation === 'github.issue') schema.required.push('issue');
    if (['github.pr', 'github.ready', 'github.close'].includes(operation)) schema.required.push('number');
    if (operation === 'github.ready') schema.required.push('headCommit');
    if (operation === 'github.close') schema.required.push('repository', 'updatedAt', 'evidence');
  }
  return schema;
}

function bundled(schema) {
  const needed = {};
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const name = value.$ref.replace('#/$defs/', '');
      if (!Object.hasOwn(needed, name)) { needed[name] = defs[name]; visit(defs[name]); }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema, ...(Object.keys(needed).length ? { $defs: needed } : {}) };
}

function automationSchema(kind) {
  if (!Object.hasOwn(automationPayloads, kind)) throw new Error('Unknown automation schema');
  return bundled(obj({ id: str(200, 1), kind: { const: kind }, title: str(150, 1), rationale: str(2000, 1), evidence: arr(str(2000), 10), payload: automationPayloads[kind] }, ['kind', 'title', 'rationale', 'payload']));
}

module.exports = { defs, automationPayloads, operationInput, validate, bundled, automationSchema, str, choice, int, bool, arr, obj, ref, nullable };
