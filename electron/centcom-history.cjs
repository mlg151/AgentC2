const { fingerprint, redact } = require('./centcom-contract.cjs');

const string = (value, max = 300) => typeof value === 'string' ? redact(value).slice(0, max) : null;
const scopeFields = ['hostId', 'sourceHostId', 'targetHostId', 'repository', 'repo', 'cwd', 'id', 'operationId', 'contestantId', 'workflowId', 'issue', 'number'];

// Store a small, allowlisted index before the general outcome record is bounded.
// Prompts, native answers, settings, patches, and test output are deliberately
// absent. The original correlated outcome remains the source for further reads.
function summarizeAction(record) {
  let displayTruncated = false;
  const fields = (value, names) => Object.fromEntries(names.filter((key) => value?.[key] != null).map((key) => {
    const text = redact(String(value[key]));
    if (text.length > 300) displayTruncated = true;
    return [key, text.slice(0, 300)];
  }));
  const input = record.kind === 'agentc2.action' ? record.params?.input : record.params;
  const binding = record.binding?.evidence;
  const targets = (binding?.targets || []).map(({ identity }) => fields(identity, ['key', 'hostId', 'chatSessionId', 'processId', 'startedAt', 'worktreeOperation']));
  const scope = fields(input, scopeFields);
  const operation = record.canonicalOperation || (record.kind === 'agentc2.action' ? record.params?.operation : record.kind);
  const handoff = operation === 'sitrep.handoff' ? {
    preview: fields(binding?.operationEvidence, ['sourceHostId', 'targetHostId', 'name', 'operationId', 'repository', 'revision']),
    destination: { ...fields(input, ['operationId']), ...fields(record.result, ['hostId', 'name', 'key', 'chatSessionId']), ...fields(record.result?.worktree, ['repository', 'branch', 'path']) },
    claims: { evidence: 'commander_supplied_unverified', ...fields(input, ['objective', 'summary', 'nextSteps']) },
  } : null;
  if (handoff && !handoff.destination.key && handoff.destination.hostId && /^hq-[a-f0-9]{12}$/.test(handoff.destination.name || '')) {
    handoff.destination.key = `${handoff.destination.hostId}/tmux:${handoff.destination.name}`;
  }
  return { operation: string(operation), coverage: record.canonicalOperation && binding ? 'bound' : 'legacy_or_unbound',
    scopeFingerprint: fingerprint({ operation, targets: (binding?.targets || []).map((t) => t.identity),
      scope: Object.fromEntries(scopeFields.filter((key) => input?.[key] != null).map((key) => [key, input[key]])) }),
    targets: targets.slice(0, 10), targetsTruncated: targets.length > 10, scope, displayTruncated,
    description: { text: string(record.summary, 150), evidence: 'commander_supplied_unverified', titleBasedSuggestions: 'hypotheses_only' },
    handoff };
}

function readHistory(state, input = {}) {
  const { after = 0, through = state.outcomeSequence, limit = 20, view = 'actions', operation, hostId, sessionKey, handoffsOnly = false } = input;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after || through > state.outcomeSequence || !Number.isInteger(limit) || limit < 1 || limit > 50 || !['actions', 'patterns'].includes(view)) throw new Error('Invalid history cursor, snapshot, view, or limit');
  const latest = new Map();
  for (const outcome of state.outcomes) if (outcome.collection === 'directive' && outcome.sequence <= through) latest.set(outcome.serverId, outcome);
  const records = [...latest.values()].map((row) => ({
    sequence: row.sequence, outcomeId: row.outcomeId, serverId: row.serverId, clientRequestId: row.clientRequestId || null,
    recordedAt: row.recordedAt, status: row.status, evidence: 'observed_dispatch_state', facts: row.facts || { submission: 'unknown', providerTurnCompletion: 'unverified', projectAcceptance: 'unverified' },
    action: row.action?.scope && Array.isArray(row.action.targets) ? row.action : summarizeAction(row.record || {}),
  })).filter((row) => (!operation || row.action.operation === operation) && (!handoffsOnly || row.action.operation === 'sitrep.handoff') &&
    (!hostId || [row.action.scope.hostId, row.action.scope.sourceHostId, row.action.scope.targetHostId, ...row.action.targets.map((t) => t.hostId), row.action.handoff?.preview?.sourceHostId, row.action.handoff?.preview?.targetHostId].includes(hostId)) &&
    (!sessionKey || row.action.targets.some((t) => t.key === sessionKey) || row.action.handoff?.destination?.key === sessionKey));
  let entries = records;
  if (view === 'patterns') {
    const groups = new Map();
    for (const row of records) {
      if (row.status !== 'completed' || row.action.coverage !== 'bound' || row.action.targetsTruncated) continue;
      // Equality of operation and reviewed target scope is observed. Similarity
      // of tasks or suitability for automation is not established by that fact.
      const scope = { operation: row.action.operation, targets: row.action.targets, scope: row.action.scope };
      const key = row.action.scopeFingerprint;
      if (!key) continue;
      const group = groups.get(key) || { id: key, ...scope, sequence: 0, count: 0, evidence: 'observed_repeated_adapter_completion',
        displayTruncated: row.action.displayTruncated,
        inference: 'Reusable workflow suitability is a hypothesis requiring task and acceptance evidence. Titles are not grouping evidence.',
        projectAcceptance: 'unverified', sourceOutcomeIds: [], sourceServerIds: [] };
      group.count++;
      group.sequence = Math.max(group.sequence, row.sequence);
      // Lists are bounded; counts are distinct server requests, not state changes.
      if (group.sourceOutcomeIds.length < 10) { group.sourceOutcomeIds.push(row.outcomeId); group.sourceServerIds.push(row.serverId); }
      group.sourcesTruncated = group.count > group.sourceOutcomeIds.length;
      groups.set(key, group);
    }
    entries = [...groups.values()].filter((group) => group.count >= 2);
  }
  entries = entries.filter((row) => row.sequence > after).sort((a, b) => a.sequence - b.sequence);
  const retainedFrom = state.outcomes[0]?.sequence || 1;
  const result = { entries: [], cursor: after, through, hasMore: false, retainedFrom, truncated: retainedFrom > 1, view,
    coverage: 'Retained CENTCOM directive outcomes only. Other desktop actions and previews are not completed handoff history. Missing or expired records are unknown.',
    consistency: 'Pass through unchanged while paging this snapshot. Retention may still expire rows; truncated indicates incomplete lifetime history.',
    unknownMetadata: records.filter((row) => row.action.coverage !== 'bound').length };
  for (const row of entries.slice(0, limit)) {
    // Keep the entire page within the commander's persisted query-result budget.
    // A single large index is compacted without losing cursor or correlation.
    let item = redact(row);
    if (Buffer.byteLength(JSON.stringify(item)) > 5000) item = { ...Object.fromEntries(
      ['id', 'sequence', 'outcomeId', 'serverId', 'status', 'evidence', 'count', 'sourceOutcomeIds', 'sourceServerIds', 'sourcesTruncated'].filter((key) => row[key] !== undefined).map((key) => [key, row[key]])),
      partial: true, reason: 'History index exceeds the entry limit; read the source outcome.' };
    if (result.entries.length && Buffer.byteLength(JSON.stringify({ ...result, entries: [...result.entries, item] })) > 10000) break;
    result.entries.push(item);
  }
  result.cursor = result.entries.at(-1)?.sequence || after;
  result.hasMore = entries.length > result.entries.length;
  return result;
}

module.exports = { summarizeAction, readHistory };
