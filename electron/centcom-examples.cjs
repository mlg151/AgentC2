const YAML = require('yaml');
const { AUTOMATION_KINDS, ENVELOPE_VERSION } = require('./centcom-contract.cjs');
const { automationSchema, validate } = require('./centcom-schema.cjs');
const { providers } = require('./chat-protocol.json');

// Illustrative values are deliberately independent of cached fleet evidence.
// The registry validates these inputs before publishing generated requests.
const host = 'observed-host';
const sessionKey = `${host}/tmux:hq-111111111111`;
const operationId = '1'.repeat(32);
const revision = '2'.repeat(64);
const commit = '3'.repeat(40);
const repository = '/observed/repository';
const profile = { id: 'example-worker', name: 'Observed worker profile', provider: 'codex', model: 'observed-model', ranks: ['officer'] };
const workflow = { version: 1, id: 'example-workflow', name: 'Reviewed planning workflow', trigger: 'github_issue', max_loop_retries: 2, max_steps: 6, max_budget_usd: null,
  stages: [{ id: 'plan', profile: profile.id, rank: 'officer', role: 'planner', prompt_template: 'Inspect {{repo}} issue {{issue_number}} and produce a plan with acceptance criteria.', next: 'COMPLETE' }] };
const order = { version: 1, id: 'example-order', hostId: host, repository, enabled: true, instructions: 'Reviewed repository instructions based on observed repeated actions.', overrides: {}, mcp: [] };
const preset = { id: 'example-preset', name: 'Reviewed Codex preset', provider: 'codex', command: 'codex', args: '', cwd: '', instructions: 'Use the observed task requirements.', fullPermissions: false, roeProfile: 'gated', attentionHooks: false };
const triggers = { onUnitCompleted: true, onDependencyChange: true, fallbackSeconds: 600 };
const automationInputs = { specops_workflow: workflow, oporder: { order }, preset, centcom_trigger: triggers };
const session = (input = {}) => ({ sessionKey, ...input });
const exercise = { id: operationId, contestantId: '4'.repeat(32) };
const sitrep = { operationId, sourceHostId: host, targetHostId: 'target-host', repository, testCommand: '' };
const github = { hostId: host, repo: 'observed-owner/observed-repository' };
const inputs = {
  'capabilities.read': [{ operation: 'unit.inspect', schema: 'input' }, { operation: 'unit.send', schema: 'output' }, { automationKind: 'specops_workflow' }],
  'capabilities.support': [{ operation: 'unit.send', hostId: host, provider: 'codex', transport: 'chat' }],
  'outcomes.read': [{ clientRequestId: 'request-from-prior-envelope', after: 0, limit: 20 }],
  'history.read': [{ view: 'actions', handoffsOnly: true, limit: 20 }, { view: 'patterns', operation: 'unit.send', limit: 10 }],
  'missions.read': [{ linkKind: 'issue', linkId: '1', limit: 20 }],
  'mission.inspect': [{ id: 'coordination:example-mission', section: 'acceptanceCriteria', limit: 20 }],
  'mission.update': [{ id: 'example-mission', expectedRevision: null, plan: { title: 'Reviewed issue assignment',
    links: [{ key: 'issue', kind: 'issue', externalId: '1', repository: 'observed-owner/observed-repository' }, { key: 'report', kind: 'artifact', externalId: 'report.txt', hostId: host, repository }],
    owners: [{ sessionKey, linkKeys: ['issue', 'report'] }], dependencies: [{ linkKey: 'issue', requires: ['report'], status: 'unknown', evidenceOutcomeIds: [] }],
    acceptanceCriteria: [{ id: 'report-verified', text: 'The report meets the reviewed issue criteria.', linkKeys: ['issue', 'report'], status: 'unverified', evidenceOutcomeIds: [] }],
    blockers: [], nextActions: [{ id: 'inspect-report', text: 'Inspect the artifact revision and verification evidence.', linkKeys: ['report'] }] } }],
  'fleet.inspect': [{}], 'units.list': [{ limit: 20 }], 'unit.inspect': [{ sessionKey }, { sessionKey, commandId: '11111111-2222-4333-8444-555555555555' }], 'hosts.inspect': [{ hostId: host }],
  'context.read': [{ section: 'definitions', limit: 20 }], 'admission.check': [{ hostId: host, cwd: repository }],
  'artifact.read': [{ hostId: host, operationId, path: 'report.txt', offset: 0, limit: 4000 }],
  'unit.search': [{ query: 'acceptance criteria', keys: [sessionKey] }],
  'unit.create': providers.map((provider) => ({ hostId: host, provider, transport: 'chat', title: 'Reviewed assignment', cwd: repository, instructions: 'Inspect the assigned issue and report evidence.', roeProfile: provider === 'opencode' ? 'provider-default' : 'gated' })),
  'unit.send': [session({ text: 'Report the current task, blockers, and acceptance evidence.' })],
  'unit.steer': [session({ text: 'Prioritize the reviewed acceptance criteria.', expectedTurnId: 'observed-provider-turn' })],
  'chat.respond': [session({ requestId: 'observed-request', turnId: 'observed-provider-turn', itemId: 'observed-item', decision: 'deny' }),
    session({ requestId: 'observed-request', turnId: 'observed-provider-turn', itemId: 'observed-item', answers: [{ questionId: 'observed-question', answers: ['Reviewed answer'] }] })],
  'unit.interrupt': [session()], 'unit.stop': [session()], 'unit.delete': [session()], 'unit.rename': [session({ title: 'Reviewed task title' })], 'unit.pin': [session({ pinned: true })],
  'attention.acknowledge': [session({ id: 'observed-attention-id' })], 'fault.reset': [session()], 'fault.interrupt': [session()],
  'flash.decide': [session({ id: operationId, decision: 'deny' })], 'flash.list': [{}], 'specops.definition': [{}],
  'specops.configure': [{ yaml: YAML.stringify({ version: 1, profiles: [profile], workflows: [workflow] }) }],
  'specops.inspect': [{ id: operationId }], 'specops.launch': [{ workflowId: workflow.id, hostId: host, repository, repo: github.repo, issue: 1, baseRef: 'main' }],
  'specops.control': [{ id: operationId, action: 'resume' }], 'exercise.list': [{}],
  'exercise.create': [{ hostId: host, repository, baseRef: 'main', title: 'Reviewed comparison', prompt: 'Implement the observed acceptance criteria in an isolated worktree.', testCommand: '', contestants: [{ provider: 'codex' }, { provider: 'claude' }] }],
  'exercise.inspect': [exercise], 'exercise.verify': [exercise], 'exercise.preview': [exercise], 'exercise.complete': [exercise], 'exercise.promote': [{ ...exercise, revision }], 'exercise.control': [{ id: operationId, action: 'retry' }],
  'worktree.list': [{ hostId: host }], 'worktree.archive': [{ hostId: host, operationId }],
  'diff.files': [session({ operationId })], 'diff.detail': [session({ operationId, fileId: 'observed-file-id' })], 'diff.hunk': [session({ operationId, fileId: 'observed-file-id', revision, hunkId: 'observed-hunk-id', operation: 'stage' })],
  'sitrep.inspect': [session(sitrep)], 'sitrep.preview': [session(sitrep)],
  'sitrep.handoff': [{ id: operationId, operationId: '5'.repeat(32), objective: 'Continue the reviewed assignment', summary: 'Observed changes and verification evidence', nextSteps: 'Complete the outstanding acceptance criteria', title: 'Reviewed handoff', slug: 'reviewed-handoff', provider: 'codex', roeProfile: 'gated' }],
  'configuration.inspect': [{}], 'configuration.save': [{ settings: {} }],
  'oporder.preview': [{ order }], 'oporder.enroll': [{ order, revision }],
  'automation.validate': [{ kind: 'centcom_trigger', payload: triggers }], 'automation.preview': [{ kind: 'preset', payload: preset }], 'automation.read': [{ id: 'observed-draft-id' }], 'automation.apply': [{ id: 'observed-draft-id' }],
  'github.readiness': [github], 'github.issue': [{ ...github, issue: 1 }], 'github.issues': [{ ...github, query: 'is:open is:issue' }], 'github.pr': [{ ...github, number: 1 }],
  'github.ready': [{ ...github, number: 1, headCommit: commit, expectedBranch: 'observed-branch' }],
  'github.close': [{ ...github, number: 1, repository, updatedAt: '2026-01-01T00:00:00Z', evidence: { commit, summary: 'Observed commit and test evidence meet the reviewed issue criteria.' } }],
  'devurl.list': [session()], 'devurl.open': [session({ url: 'http://127.0.0.1:3000/' })],
};

const guidance = 'Illustrative syntax, not a dispatch instruction. Replace all host, session, request, workflow/profile, repository, ID, revision, and evidence values with fresh inspected facts. Merge permanent configuration with existing definitions; preserve unrelated entries. Empty settings is a no-op example. A syntactically valid request can still be unavailable or require review.';
function operationExamples(entry) {
  if (!entry.handler) return [];
  if (!Object.hasOwn(inputs, entry.operation)) throw new Error(`Missing contract example: ${entry.operation}`);
  return inputs[entry.operation].map((input, index) => {
    validate(entry.inputSchema, input, entry.inputSchema.$defs, `example.${entry.operation}`);
    return { guidance, request: { id: `example-${entry.operation}-${index + 1}`, kind: `agentc2.${entry.classification}`,
      ...(entry.classification === 'action' ? { summary: entry.operation, rationale: 'Based on inspected target and task evidence.', ...(input.sessionKey ? { preconditions: { sessionKey: input.sessionKey } } : {}) } : {}),
      params: { operation: entry.operation, input: structuredClone(input) } } };
  });
}
function automationExamples(kind) {
  if (!AUTOMATION_KINDS.includes(kind) || !Object.hasOwn(automationInputs, kind)) throw new Error(`Missing automation contract example: ${kind}`);
  const request = { id: `example-${kind}`, kind, title: `Reviewed ${kind}`, rationale: 'Repeated observed actions justify a reusable configuration.', evidence: ['Replace with correlated outcome IDs and observed action evidence.'], payload: structuredClone(automationInputs[kind]) };
  const schema = automationSchema(kind);
  validate(schema, request, schema.$defs, `example.automation.${kind}`);
  return [{ guidance, request }];
}
function doctrineExample(catalog) {
  const request = (operation) => {
    const example = catalog.find((e) => e.operation === operation)?.examples?.[0]?.request;
    if (!example) throw new Error(`Doctrine operation is not in the implemented contract: ${operation}`);
    return example;
  };
  return { version: ENVELOPE_VERSION, rationale: 'Syntax illustration only; replace all scope and evidence values before submitting.',
    queries: [request('units.list')], directives: [request('unit.pin')], automations: AUTOMATION_KINDS.map((kind) => automationExamples(kind)[0].request) };
}

module.exports = { operationExamples, automationExamples, doctrineExample, guidance };
