const { defs, automationPayloads, str, choice, int, bool, arr, obj, ref, nullable, bundled } = require('./centcom-schema.cjs');
const json = ref('jsonValue');
const strings = arr(str(200000), 10000);
const number = { type: 'number' };
const record = (properties, required = []) => obj(properties, required, { additionalProperties: json });
const page = (items, cursor = str()) => record({ entries: arr(items, 50), cursor, hasMore: bool, retainedFrom: int(0, Number.MAX_SAFE_INTEGER), truncated: bool,
  capturedAt: str(), total: int(0, Number.MAX_SAFE_INTEGER), consistency: str() }, ['entries', 'cursor', 'hasMore']);
const partial = record({ truncated: { const: true }, originalBytes: int(0, Number.MAX_SAFE_INTEGER), reason: str(), preview: str(1000000) }, ['truncated', 'originalBytes', 'reason', 'preview']);
Object.assign(defs, {
  jsonValue: { description: 'Bounded JSON extension from an upstream adapter; inspect its source before interpreting it as task evidence.', anyOf: [{ type: ['null', 'boolean', 'string', 'number'] }, { type: 'array', items: ref('jsonValue') }, { type: 'object', additionalProperties: ref('jsonValue') }] },
  partial,
  observation: record({ status: choice('reported', 'unknown', 'unsupported', 'stale'), reason: str(), sampledAt: nullable({ type: ['number', 'string'] }) }, ['status']),
  receipt: record({ protocolVersion: { const: 1 }, commandId: str(), sessionId: str(), state: choice('accepted', 'dispatching', 'completed', 'failed', 'unknown'),
    result: nullable(record({ turnId: str() })), error: nullable(str()) }, ['commandId', 'state']),
  testEvidence: record({ command: str(), exitCode: nullable(int(-2147483648, 2147483647)), timedOut: bool, output: str(200000), outputTruncated: bool, durationMs: number, ranAt: number }, ['command', 'exitCode', 'timedOut', 'output']),
  worktreeRecord: record({ operationId: str(), repository: str(), baseRef: str(), baseCommit: str(), branch: str(), path: str(), name: str(), provider: str(), slug: str(), title: str(), state: str(),
    status: record({ exists: bool, active: bool, owned: bool, dirty: nullable(bool), merged: nullable(bool), headCommit: str() }) }, ['operationId', 'state']),
  launchResult: record({ name: str(), key: str(), chatSessionId: str(), hostId: str(), provider: str(), worktree: ref('worktreeRecord') }, ['name']),
  unitRecord: record({ id: str(), key: str(), hostId: str(), provider: str(), title: nullable(str()), classification: choice('managed', 'external', 'saved'), classifications: strings,
    execution: choice('executing', 'waiting', 'idle', 'stopped', 'failed', 'unknown'), state: str(), chatState: str(), cwd: nullable(str()), repository: nullable(str()), branch: nullable(str()), headCommit: nullable(str()), worktreeOperation: nullable(str()), roeProfile: str(),
    freshness: record({ status: str(), capturedAt: nullable({ type: ['number', 'string'] }), sourceUpdatedAt: nullable({ type: ['number', 'string'] }), startedAt: nullable({ type: ['number', 'string'] }) }),
    relationship: record({ providerSessionId: nullable(str()), chatSessionId: nullable(str()), representations: arr(record({ key: str(), classification: str(), processId: nullable({ type: ['string', 'number'] }), processRole: str(), startedAt: nullable({ type: ['number', 'string'] }), state: str() })) }),
    currentTask: record({ status: str(), text: str(200000), turnId: nullable(str()), sourceTimestamp: str(), reason: str() }),
    pendingRequests: { anyOf: [arr(record({ requestId: str(), turnId: nullable(str()), itemId: nullable(str()), type: str(), state: str(), data: json })), ref('observation')] },
    capabilities: json, control: record({ eligible: bool, reason: nullable(str()), ownership: ref('observation') }), journal: nullable(record({ cursor: number, latestCursor: number, retainedFrom: number, truncated: bool, events: arr(json, 500) })), notes: json, mission: json }, ['id', 'key', 'hostId', 'classification', 'execution']),
  outcomeFacts: record({ submission: str(), commandId: nullable(str()), sessionId: nullable(str()), providerTurnId: nullable(str()), providerTurnCompletion: str(), projectAcceptance: str() }),
  actionHistoryIndex: record({ operation: nullable(str()), coverage: choice('bound', 'legacy_or_unbound'), scopeFingerprint: str(),
    targets: arr(record({ key: str(), hostId: str(), chatSessionId: str(), processId: str(), startedAt: str(), worktreeOperation: str() }), 10), targetsTruncated: bool, displayTruncated: bool, scope: json,
    description: record({ text: nullable(str()), evidence: { const: 'commander_supplied_unverified' }, titleBasedSuggestions: { const: 'hypotheses_only' } }), handoff: nullable(json) }, ['operation', 'coverage', 'targets', 'scope', 'description']),
  historyAction: record({ sequence: int(1, Number.MAX_SAFE_INTEGER), outcomeId: str(), serverId: str(), clientRequestId: nullable(str()), recordedAt: number, status: str(), evidence: { const: 'observed_dispatch_state' }, facts: ref('outcomeFacts'), action: ref('actionHistoryIndex') }, ['sequence', 'outcomeId', 'serverId', 'status', 'evidence', 'action']),
  historyPattern: record({ id: str(), sequence: int(1, Number.MAX_SAFE_INTEGER), operation: str(), targets: arr(json, 10), scope: json, count: int(2, 2000), evidence: { const: 'observed_repeated_adapter_completion' },
    inference: str(), projectAcceptance: { const: 'unverified' }, sourceOutcomeIds: arr(str(), 10), sourceServerIds: arr(str(), 10), sourcesTruncated: bool }, ['id', 'sequence', 'operation', 'count', 'evidence', 'inference', 'projectAcceptance', 'sourceOutcomeIds', 'sourceServerIds']),
  coordinationSummary: record({ id: str(), kind: choice('coordination', 'specops', 'exercise'), title: str(), state: str(), revision: str(), sourceUpdatedAt: nullable(number), projectAcceptance: { const: 'unverified' }, source: str(), counts: { type: 'object', additionalProperties: int(0, 10000) } }, ['id', 'kind', 'title', 'state', 'revision', 'projectAcceptance', 'source', 'counts']),
  outcome: record({ outcomeId: str(), serverId: str(), clientRequestId: nullable(str()), collection: choice('directive', 'automation', 'approval', 'audit', 'diagnostic', 'query', 'provider'), sequence: int(1, Number.MAX_SAFE_INTEGER), recordedAt: number, status: str(),
    code: str(), message: str(), error: str(), turnId: nullable(str()), kind: str(), facts: ref('outcomeFacts'), record: json, result: json,
    decision: str(), actor: str(), bindingHash: nullable(str()) }, ['outcomeId', 'serverId', 'collection', 'sequence', 'recordedAt', 'status']),
  flashRecord: record({ id: str(), name: str(), provider: str(), hostId: str(), state: choice('pending', 'submitted', 'resolved', 'expired'), decision: nullable(choice('allow', 'deny')), tool: str(), action: str(), createdAt: number, expiresAt: number, connected: bool }, ['id', 'state']),
  faultRecord: record({ sessionKey: str(), status: str(), reason: str(), count: number, failures: arr(json), updatedAt: number, resetAt: number }, ['sessionKey', 'status']),
  attentionRecord: record({ id: str(), sessionKey: str(), kind: str(), title: str(), detail: str(), confidence: str(), acknowledged: bool }, ['id', 'sessionKey']),
  missionRecord: record({ id: str(), hostId: str(), repo: str(), repository: str(), sourceLinks: arr(ref('missionLink'), 1000), baseCommit: str(), state: str(), stage: str(), error: str(), workflow: ref('workflow'),
    visits: arr(record({ id: str(), stage: str(), name: str(), sessionId: str(), output: str(200000), outcome: str(), completion: json }), 100),
    costUsd: number, costKnown: bool, canResume: bool, canRetry: bool, worktree: nullable(ref('worktreeRecord')) }, ['id', 'hostId', 'state', 'stage', 'visits']),
  exerciseContestant: record({ id: str(), provider: str(), presetId: str(), roeProfile: str(), slug: str(), state: str(), name: str(), error: str(), markedComplete: bool,
    evidence: nullable(record({ revision: str(), test: nullable(ref('testEvidence')), verifiedAt: number, explicitCompletion: bool })) }, ['id', 'provider', 'state']),
  exerciseRecord: record({ version: { const: 1 }, id: str(), title: str(), hostId: str(), repository: str(), baseCommit: str(), prompt: str(12000), testCommand: str(), contestants: arr(ref('exerciseContestant'), 3), state: str(), createdAt: number,
    promotion: nullable(record({ contestantId: str(), revision: str(), target: str(), branch: str(), patchBytes: number, at: number })) }, ['id', 'hostId', 'state', 'contestants']),
  exerciseInspection: record({ operationId: str(), baseCommit: str(), branch: str(), path: str(), active: bool, headCommit: str(), revision: str(), patchBytes: number, patch: str(200000), patchTruncated: bool, untracked: strings, warnings: strings, test: nullable(ref('testEvidence')), evidence: json }, ['operationId', 'revision', 'active', 'test']),
  oporderPreview: record({ revision: str(), repository: str(), changes: arr(record({ path: str(), status: choice('create', 'update', 'remove', 'unchanged', 'conflict'), diff: str(200000), reason: str() }, ['path', 'status'])), unsupported: strings, ready: bool }, ['revision', 'changes', 'ready']),
  savedConfiguration: record({ hosts: arr(ref('host'), 30), presets: arr(ref('savedPreset'), 100), roe: ref('roe'), opOrders: arr(ref('oporder'), 50), notifications: bool, cleanup: arr(record({ hostId: str(), provider: str(), enabled: bool, days: number })) }),
  automationArtifact: { anyOf: [ref('savedPreset'), ref('workflow'), ref('oporder'), ref('triggers')] },
  automationReadback: record({ id: str(), state: str(), artifact: nullable(ref('automationArtifact')), revision: nullable(str()), matchesDraft: bool, enrollment: ref('oporderPreview') }, ['id', 'state', 'artifact', 'revision', 'matchesDraft']),
  automationPreview: record({ kind: str(), payload: json, before: nullable(ref('automationArtifact')), after: ref('automationArtifact'), baseRevision: str(), revision: str(), enrollment: nullable(ref('oporderPreview')), reviewRequired: { const: true } }, ['kind', 'payload', 'before', 'after', 'baseRevision', 'revision', 'reviewRequired']),
  automationRecord: record({ id: str(), clientRequestId: nullable(str()), kind: str(), title: str(), rationale: str(), evidence: strings, payload: json, preview: ref('automationPreview'), state: choice('proposed', 'applying', 'applied', 'dismissed', 'uncertain'), result: json, createdAt: number, appliedAt: nullable(number), error: str() }, ['id', 'kind', 'state']),
  devUrl: record({ url: str(), hostId: str(), port: number, status: choice('available', 'opening', 'ready', 'failed'), localUrl: nullable(str()), error: nullable(str()) }, ['url', 'status']),
  githubIssue: record({ number: number, title: str(), body: str(500000), url: str(), state: str(), updatedAt: str(), labels: arr(json) }, ['number', 'state']),
  githubPr: record({ number: number, title: str(), url: str(), state: str(), isDraft: bool, headRefOid: str(), headRefName: str(), baseRefName: str(), reviewDecision: nullable(str()), statusCheckRollup: arr(json) }, ['number', 'state', 'headRefOid']),
});

const schemas = {
  'capabilities.read': record({ version: { const: 1 }, authority: choice('gated', 'autonomous'), limits: record({ resultBytes: number, pageSize: number, queryHops: number, maxDirectivesPerTurn: number, maxBudgetUsd: nullable(number) }), operations: arr(record({ operation: str(), classification: str(), inputSchema: json, outputSchema: json, available: bool, unavailableReason: nullable(str()), schemaQuery: json, requirements: json }), 100), automationKinds: strings, automations: arr(json, 4), approval: json, support: json, spend: json }, ['version', 'authority', 'limits', 'operations']),
  'capabilities.support': page(record({ id: str(), hostId: str(), provider: str(), transport: choice('chat', 'terminal'), status: choice('supported', 'unsupported', 'unknown', 'unavailable'), reason: str(), connected: bool, enabled: bool, nativeVersion: nullable(str()), nativeFeatures: json, eligibleUnits: number, sessionKeys: strings, sessionKeysTruncated: bool, ownership: ref('observation'), approval: str() }, ['id', 'hostId', 'provider', 'transport', 'status', 'reason'])),
  'outcomes.read': page(ref('outcome'), int(0, Number.MAX_SAFE_INTEGER)),
  'history.read': record({ ...page({ anyOf: [ref('historyAction'), ref('historyPattern'), record({ sequence: int(1, Number.MAX_SAFE_INTEGER), partial: { const: true }, reason: str() }, ['sequence', 'partial', 'reason'])] }, int(0, Number.MAX_SAFE_INTEGER)).properties,
    through: int(0, Number.MAX_SAFE_INTEGER), view: choice('actions', 'patterns'), coverage: str(), unknownMetadata: int(0, 2000) }, ['entries', 'cursor', 'through', 'hasMore', 'retainedFrom', 'truncated', 'view', 'coverage', 'consistency']),
  'units.list': page({ anyOf: [ref('unitRecord'), ref('partial')] }),
  'missions.read': page(ref('coordinationSummary')),
  'mission.inspect': page(record({ id: str(), partial: bool, reason: str(), status: str(), source: str(), evidence: json, sessionKey: nullable(str()), linkKeys: strings, externalId: str(), kind: str(), revision: nullable(str()) }, ['id'])),
  'mission.update': ref('coordinationSummary'),
  'unit.inspect': ref('unitRecord'),
  'fleet.inspect': record({ hosts: arr(record({ id: str(), connected: bool })), sessions: arr(record({ key: str(), hostId: str(), provider: str(), state: str(), managed: bool })), attention: arr(ref('attentionRecord')), faults: arr(ref('faultRecord')), capturedAt: str() }, ['hosts', 'sessions']),
  'hosts.inspect': record({ hosts: arr(record({ id: str(), connected: bool, health: json, capabilities: json, headroom: record({ status: str(), memoryBytes: nullable(number), cpuPercent: nullable(number), scope: str(), limitsCoverage: str(), sampledAt: nullable(number) }), roe: str() }, ['id', 'connected', 'headroom'])), capturedAt: str() }, ['hosts', 'capturedAt']),
  'context.read': page(record({ id: str(), type: str(), name: str(), sessionKey: str(), project: str(), notes: str(20000), conflict: json }, ['id'])),
  'admission.check': record({ status: choice('admitted', 'unknown', 'blocked'), hostId: str(), blockers: strings, unknowns: strings, owners: arr(record({ key: str(), cwd: nullable(str()), worktreeOperation: nullable(str()), roeProfile: str() })), resources: json, policy: str(), capturedAt: str() }, ['status', 'hostId', 'blockers', 'unknowns', 'owners']),
  'artifact.read': obj({ path: str(), revision: str(), sizeBytes: number, text: str(16000), offset: number, nextOffset: number, truncated: bool, redacted: bool, offsets: str() }),
  'unit.search': record({ matches: arr(record({ key: str(), excerpt: str(), text: str(), title: str() })), searched: number, total: number, truncated: bool, errors: arr(json) }, ['matches', 'total']),
  'unit.create': ref('launchResult'),
  'unit.send': { anyOf: [ref('receipt'), obj({ delivery: { const: 'terminal_input_written' }, taskCompletion: { const: 'unverified' } })] },
  'unit.steer': ref('receipt'), 'chat.respond': ref('receipt'),
  'unit.interrupt': { anyOf: [ref('receipt'), obj({ name: str(), action: { const: 'interrupt' } })] },
  'unit.stop': { anyOf: [ref('receipt'), obj({ name: str(), action: { const: 'stop' } })] },
  'unit.delete': { type: 'null', description: 'Adapter returns no payload; the directive/audit status records completion or uncertainty.' },
  'unit.rename': str(100), 'unit.pin': bool,
  'attention.acknowledge': arr(ref('attentionRecord')), 'fault.reset': bool, 'fault.interrupt': ref('faultRecord'),
  'flash.list': arr(ref('flashRecord')), 'flash.decide': record({ id: str(), state: str(), decision: str(), duplicate: bool }, ['id', 'state', 'decision']),
  'specops.definition': record({ version: { const: 1 }, profiles: arr(ref('profile')), workflows: arr(ref('workflow')), yaml: str(200000), directory: str() }, ['profiles', 'workflows', 'yaml', 'directory']),
  'specops.inspect': ref('missionRecord'), 'specops.launch': ref('missionRecord'), 'specops.control': ref('missionRecord'),
  'exercise.list': arr(ref('exerciseRecord')), 'exercise.create': ref('exerciseRecord'), 'exercise.inspect': ref('exerciseInspection'), 'exercise.verify': ref('exerciseInspection'),
  'exercise.preview': record({ contestantId: str(), target: str(), branch: str(), headCommit: str(), revision: str(), patchBytes: number, paths: number, ready: bool, test: nullable(ref('testEvidence')) }, ['contestantId', 'revision', 'ready']),
  'exercise.complete': ref('exerciseRecord'), 'exercise.promote': ref('exerciseRecord'), 'exercise.control': ref('exerciseRecord'),
  'worktree.list': arr(ref('worktreeRecord')), 'worktree.archive': ref('worktreeRecord'),
  'diff.files': arr(obj({ id: str(), path: str(), staged: bool, unstaged: bool, untracked: bool })),
  'diff.detail': obj({ revision: str(), staged: arr(obj({ id: str(), text: str(200000), actionable: bool })), unstaged: arr(obj({ id: str(), text: str(200000), actionable: bool })), summary: str(), binary: bool, large: bool }),
  'diff.hunk': obj({ changed: bool }),
  'sitrep.inspect': record({ version: { const: 1 }, id: str(), source: record({ operationId: str(), name: str(), repository: str(), branch: str(), baseCommit: str(), headCommit: str(), path: str() }),
    target: obj({ ready: bool, reason: str(), repository: str() }), revision: str(), patchPreview: str(200000), patchPreviewTruncated: bool, patchBytes: number, untracked: strings, warnings: strings, test: nullable(ref('testEvidence')), ready: bool }, ['id', 'source', 'target', 'revision', 'ready']),
  'sitrep.handoff': ref('launchResult'), 'configuration.inspect': ref('savedConfiguration'), 'configuration.save': ref('savedConfiguration'),
  'oporder.preview': ref('oporderPreview'), 'oporder.enroll': ref('savedConfiguration'),
  'automation.validate': record({ kind: str(), payload: json, artifact: ref('automationArtifact'), before: nullable(ref('automationArtifact')), baseRevision: str() }, ['kind', 'payload', 'artifact', 'before', 'baseRevision']),
  'automation.preview': ref('automationPreview'), 'automation.read': ref('automationReadback'), 'automation.apply': ref('automationRecord'),
  'github.readiness': obj({ login: str(), repo: str(), defaultBranch: str(), permissions: { type: 'object', additionalProperties: bool } }),
  'github.issue': ref('githubIssue'), 'github.issues': arr(ref('githubIssue')), 'github.pr': ref('githubPr'), 'github.ready': ref('githubPr'),
  'github.close': obj({ number, state: { const: 'CLOSED' }, commit: str() }),
  'devurl.list': arr(ref('devUrl')), 'devurl.open': str(4096, 1, { description: 'Local forwarded development URL.' }),
};
schemas['specops.configure'] = schemas['specops.definition'];
schemas['sitrep.preview'] = schemas['sitrep.inspect'];
schemas['capabilities.read'] = { anyOf: [schemas['capabilities.read'], record({ version: { const: 1 }, operation: str(), automationKind: str(), schema: choice('input', 'output'), definition: str(), value: json, references: str() }, ['version', 'schema', 'definition', 'value'])] };
for (const operation of ['unit.resume', 'history.discover', 'history.cleanup']) schemas[operation] = { not: {}, description: 'Unsupported operation; returns a structured diagnostic, never a successful payload.' };

function outputSchema(operation) {
  if (!Object.hasOwn(schemas, operation)) throw new Error(`Missing output contract: ${operation}`);
  return bundled({ description: 'Successful adapter payload after redaction and bounds. Directive status and diagnostic correlation are in outcomes.read. Adapter extensions are bounded JSON; they do not establish task acceptance.',
    anyOf: [schemas[operation], ref('partial'), obj({ unavailable: str() })] });
}
function automationOutputSchema(kind) {
  if (!Object.hasOwn(automationPayloads, kind)) throw new Error('Unknown automation output schema');
  const artifact = ref(({ preset: 'savedPreset', specops_workflow: 'workflow', oporder: 'oporder', centcom_trigger: 'triggers' })[kind]);
  const preview = record({ kind: { const: kind }, payload: automationPayloads[kind], before: nullable(artifact), after: artifact, baseRevision: str(), revision: str(), enrollment: nullable(ref('oporderPreview')), reviewRequired: { const: true } }, ['kind', 'payload', 'before', 'after', 'baseRevision', 'revision', 'reviewRequired']);
  const result = record({ artifact, revision: str(), matchesDraft: bool, enrollment: ref('oporderPreview') }, ['artifact', 'revision', 'matchesDraft']);
  return bundled({ anyOf: [record({ ...defs.automationRecord.properties, kind: { const: kind }, payload: automationPayloads[kind], preview, result }, ['id', 'kind', 'state', 'payload']), ref('partial')] });
}
module.exports = { outputSchema, automationOutputSchema };
