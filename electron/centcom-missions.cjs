const { LIMITS, fingerprint, redact } = require('./centcom-contract.cjs');
const { bundled, ref, validate } = require('./centcom-schema.cjs');

const planSchema = bundled(ref('missionPlan'));
const copy = (value) => JSON.parse(JSON.stringify(redact(value)));
const keyFor = (hostId, name) => /^hq-[a-f0-9]{12}$/.test(name || '') ? `${hostId}/tmux:${name}` : null;
const unique = (items, key, label) => {
  const values = items.map((item) => item[key]);
  if (new Set(values).size !== values.length) throw new Error(`Duplicate mission ${label}`);
};

function createMissions({ state, service, persist, inventory, isCommander }) {
  const find = (id) => state.coordination.find((record) => record.id === id);
  function prepare({ id, expectedRevision, plan }) {
    validate(planSchema, plan, planSchema.$defs, 'mission plan');
    if (Buffer.byteLength(JSON.stringify(plan)) > LIMITS.coordinationPlanBytes) throw new Error('Mission plan exceeds 24,000 bytes; split independent missions');
    const previous = find(id);
    if ((previous?.revision || null) !== expectedRevision) throw Object.assign(new Error('Mission revision changed; inspect and propose again'), { beforeMutation: true });
    if (!previous && state.coordination.length >= LIMITS.coordinationRecords) throw new Error('At most 100 coordination records can be retained');
    unique(plan.links, 'key', 'link key'); unique(plan.owners, 'sessionKey', 'owner'); unique(plan.dependencies, 'linkKey', 'dependency');
    for (const field of ['acceptanceCriteria', 'blockers', 'nextActions']) unique(plan[field], 'id', field);
    const links = new Set(plan.links.map((link) => link.key));
    const checkLinks = (keys) => { for (const key of keys) if (!links.has(key)) throw new Error(`Unknown mission link: ${key}`); };
    for (const item of [...plan.owners, ...plan.acceptanceCriteria, ...plan.blockers, ...plan.nextActions]) checkLinks(item.linkKeys);
    for (const dependency of plan.dependencies) checkLinks([dependency.linkKey, ...dependency.requires]);
    const edges = new Map(plan.dependencies.map((item) => [item.linkKey, item.requires]));
    const visited = new Set(), visiting = new Set();
    const visit = (key) => {
      if (visiting.has(key)) throw new Error('Mission dependencies contain a cycle');
      if (visited.has(key)) return;
      visiting.add(key); for (const child of edges.get(key) || []) visit(child); visiting.delete(key); visited.add(key);
    };
    for (const key of links) visit(key);
    const evidenceIds = new Set();
    for (const item of [...plan.dependencies, ...plan.acceptanceCriteria]) {
      if (item.status === 'claimed_satisfied' && !item.evidenceOutcomeIds.length) throw new Error('Claimed satisfaction requires cited outcomes; citations do not independently verify acceptance');
      for (const outcomeId of item.evidenceOutcomeIds) evidenceIds.add(outcomeId);
    }
    if (evidenceIds.size > LIMITS.coordinationEvidence) throw new Error('At most 50 distinct outcome citations per mission');
    const evidence = [...evidenceIds].map((outcomeId) => {
      const row = state.outcomes.find((item) => item.outcomeId === outcomeId);
      if (!row) throw new Error('Cited outcome is unavailable or expired; inspect fresh evidence');
      return copy({ id: outcomeId, outcomeId, serverId: row.serverId, clientRequestId: row.clientRequestId || null, collection: row.collection, status: row.status,
        recordedAt: row.recordedAt, facts: row.facts || null,
        artifact: row.result?.path && row.result?.revision ? { path: row.result.path, revision: row.result.revision, truncated: Boolean(row.result.truncated) } : null,
        interpretation: 'Observed source receipt only; relevance and project acceptance are unverified.' });
    });
    const content = { plan: copy(plan), evidence };
    if (Buffer.byteLength(JSON.stringify(content)) > LIMITS.coordinationRecordBytes) throw new Error('Mission and cited evidence exceed 64,000 bytes; narrow the citations');
    const record = { id, ...content, revision: fingerprint(content), createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
    return record;
  }
  function update(input) {
    let record;
    try { record = prepare(input); } catch (error) { error.beforeMutation = true; throw error; }
    state.coordination = [...state.coordination.filter((item) => item.id !== input.id), record];
    persist();
    return summary(coordinated(record));
  }
  function coordinated(record) {
    return { id: `coordination:${record.id}`, kind: 'coordination', title: record.plan.title, state: 'planned', revision: record.revision, sourceUpdatedAt: record.updatedAt,
      source: 'Reviewed CENTCOM coordination record. Content is commander-supplied; claims and citations do not verify project acceptance.',
      ...record.plan, evidence: record.evidence, jobs: [], artifacts: record.plan.links.filter((link) => link.kind === 'artifact'), projectAcceptance: 'unverified' };
  }
  function nativeSpecops(run) {
    const jobs = (run.visits || []).map((visit) => ({ id: visit.id, stage: visit.stage, sessionKey: keyFor(run.hostId, visit.name), chatSessionId: visit.sessionId || null,
      outcome: visit.outcome || 'unknown', providerCompletion: visit.completion?.outcome || 'unverified', commandId: visit.sendId || null,
      artifactId: visit.output ? `specops:${run.id}:visit:${visit.id}` : null }));
    const links = [{ key: 'mission', kind: 'mission', externalId: run.id, hostId: run.hostId, repository: run.repository }, ...(run.sourceLinks || [])];
    if (run.publication && !Array.isArray(run.publication) && run.publication.number) links.push({ key: 'published-pr', kind: 'pr', externalId: String(run.publication.number), repository: run.repo, revision: run.publication.headRefOid || null });
    for (const job of jobs) links.push({ key: `job-${job.id}`, kind: 'job', externalId: job.id });
    const artifacts = (run.visits || []).filter((visit) => visit.output).map((visit) => ({ id: `specops:${run.id}:visit:${visit.id}`, jobId: visit.id, revision: fingerprint(visit.output),
      source: 'SPECOPS stage output; use specops.inspect for bounded content', outcome: visit.outcome, projectAcceptance: 'unverified' }));
    for (const artifact of artifacts) links.push({ key: artifact.id, kind: 'artifact', externalId: artifact.id, revision: artifact.revision });
    return { id: `specops:${run.id}`, kind: 'specops', title: run.workflow?.name || run.id, state: run.state, sourceUpdatedAt: run.updatedAt || null,
      source: 'Persisted SPECOPS run and configured routing. Stage completion is not independent project acceptance.', links, jobs, artifacts,
      owners: jobs.filter((job) => job.sessionKey).map((job) => ({ id: job.id, sessionKey: job.sessionKey, linkKeys: ['mission', `job-${job.id}`], role: job.stage })),
      dependencies: (run.workflow?.stages || []).map((stage) => ({ id: stage.id, stage: stage.id, next: stage.next || null, transitions: stage.transitions || {}, evidence: 'configured_routing' })),
      acceptanceCriteria: [{ id: 'project-acceptance', status: 'unverified', text: 'Read the linked issue requirements and add explicit criteria in a coordination record.' }],
      blockers: run.state === 'halted' ? [{ id: 'halt', text: run.error || 'Mission halted', evidence: 'observed_run_state' }] : [],
      nextActions: ['completed', 'cancelled'].includes(run.state) ? [] : [{ id: 'stage', stage: run.pendingStage || run.stage, evidence: 'configured_routing', text: run.state === 'halted' ? 'Inspect the halt and stage evidence before proposing recovery.' : 'Observe the current stage and its configured transition.' }],
      evidence: [], projectAcceptance: 'unverified', revision: fingerprint(run) };
  }
  function nativeExercise(run) {
    const jobs = (run.contestants || []).map((item) => ({ id: item.id, sessionKey: keyFor(run.hostId, item.name), provider: item.provider, state: item.state,
      explicitCompletion: Boolean(item.markedComplete), evidence: item.evidence || null }));
    const artifacts = jobs.filter((job) => job.evidence).map((job) => ({ id: `exercise:${run.id}:job:${job.id}`, jobId: job.id, revision: job.evidence.revision, evidence: job.evidence, projectAcceptance: 'unverified' }));
    return { id: `exercise:${run.id}`, kind: 'exercise', title: run.title, state: run.state, revision: fingerprint(run), sourceUpdatedAt: null,
      source: 'Persisted exercise contestants and verification receipts. Passing a command does not independently prove all project criteria.',
      links: [{ key: 'mission', kind: 'mission', externalId: run.id, hostId: run.hostId, repository: run.repository }, ...jobs.map((job) => ({ key: job.id, kind: 'job', externalId: job.id })), ...artifacts.map((artifact) => ({ key: artifact.id, kind: 'artifact', externalId: artifact.id, revision: artifact.revision }))],
      owners: jobs.filter((job) => job.sessionKey).map((job) => ({ id: job.id, sessionKey: job.sessionKey, linkKeys: ['mission', job.id] })), jobs,
      artifacts,
      dependencies: jobs.map((job) => ({ id: job.id, stage: 'promotion', requires: ['completion', 'revision-bound verification'], evidence: 'configured_policy' })),
      acceptanceCriteria: [{ id: 'test', text: run.testCommand || 'No verification command configured', status: 'unverified', evidence: 'configured_test_command' }],
      blockers: (run.contestants || []).filter((item) => item.error).map((item) => ({ id: item.id, text: item.error, evidence: 'observed_launch_error' })),
      nextActions: ['cancelled', 'promoted'].includes(run.state) ? [] : [{ id: 'verification', text: 'Inspect contestants and collect revision-bound verification before promotion.', evidence: 'configured_policy' }],
      evidence: [], projectAcceptance: 'unverified' };
  }
  async function records() {
    const inv = await inventory();
    const visible = (key) => !isCommander(key?.split('/')[0], key) && !(service.store.data.deletedSessions || []).includes(key);
    const all = [...state.coordination.map(coordinated), ...(service.specops?.list() || []).map(nativeSpecops), ...(service.exercises?.list() || []).map(nativeExercise)];
    for (const record of all) {
      const hiddenJobs = new Set(record.jobs.filter((job) => job.sessionKey && !visible(job.sessionKey)).map((job) => job.id));
      record.jobs = record.jobs.filter((job) => !hiddenJobs.has(job.id));
      record.artifacts = record.artifacts.filter((artifact) => !hiddenJobs.has(artifact.jobId || artifact.id));
      record.links = record.links.filter((link) => !(link.kind === 'job' && hiddenJobs.has(link.externalId)) && !(link.kind === 'artifact' && [...hiddenJobs].some((id) => link.externalId.endsWith(`:visit:${id}`) || link.externalId.endsWith(`:job:${id}`))));
      record.dependencies = record.dependencies.filter((dependency) => !hiddenJobs.has(dependency.id));
      record.owners = record.owners.filter((owner) => visible(owner.sessionKey)).map((owner) => {
        const unit = inv.sessions?.find((item) => item.key === owner.sessionKey);
        return { ...owner, id: owner.id || owner.sessionKey, observation: unit ? { state: unit.state, chatState: unit.chatState || 'unknown', startedAt: unit.startedAt || null, processId: unit.processId || null, sourceUpdatedAt: unit.updatedAt || null } : { state: 'unavailable' },
          control: 'Historical responsibility is not mutation authority; reinspect the active fleet.' };
      });
    }
    return copy(all);
  }
  function summary(record) {
    return { id: record.id, kind: record.kind, title: record.title, state: record.state, revision: record.revision, sourceUpdatedAt: record.sourceUpdatedAt,
      projectAcceptance: record.projectAcceptance, source: record.source,
      counts: Object.fromEntries(['links', 'owners', 'dependencies', 'acceptanceCriteria', 'blockers', 'nextActions', 'jobs', 'artifacts', 'evidence'].map((key) => [key, record[key].length])) };
  }
  function page(entries, input, metadata = {}) {
    const after = input.after ?? '', limit = input.limit ?? 20;
    if (typeof after !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid mission page cursor or limit');
    const sorted = entries.map((entry, index) => ({ ...entry, id: entry.id || entry.key || entry.linkKey || String(index) })).filter((entry) => entry.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const result = { ...metadata, entries: [], cursor: after, hasMore: false, capturedAt: new Date().toISOString() };
    for (const entry of sorted.slice(0, limit)) {
      let item = entry;
      if (Buffer.byteLength(JSON.stringify(item)) > 6000) item = { id: entry.id, partial: true, reason: 'Entry exceeds the result budget; inspect its source operation and revision.' };
      if (result.entries.length && Buffer.byteLength(JSON.stringify({ ...result, entries: [...result.entries, item] })) > 10000) break;
      result.entries.push(item);
    }
    result.cursor = result.entries.at(-1)?.id || after; result.hasMore = sorted.length > result.entries.length;
    return result;
  }
  async function read(input = {}) {
    const rows = (await records()).filter((record) => (!input.kind || record.kind === input.kind) && (!input.sessionKey || record.owners.some((owner) => owner.sessionKey === input.sessionKey)) &&
      (!(input.linkKind || input.linkId) || record.links.some((link) => (!input.linkKind || link.kind === input.linkKind) && (!input.linkId || link.externalId === input.linkId))));
    return page(rows.map(summary), input, { consistency: 'Live source snapshot; inspect a selected revision before making decisions.' });
  }
  async function inspect(input) {
    const record = (await records()).find((item) => item.id === input.id);
    if (!record) throw new Error('Mission record is unavailable');
    if (input.revision && input.revision !== record.revision) throw new Error('Mission revision changed; read the new snapshot');
    const section = input.section || 'summary';
    return page(section === 'summary' ? [summary(record)] : record[section], input, { missionId: record.id, revision: record.revision, section, source: record.source,
      projectAcceptance: 'unverified', consistency: 'Supply revision while paging; live ownership observations remain subject to change.' });
  }
  return { read, inspect, update, validate: prepare, revision: (id) => find(id)?.revision || null };
}

module.exports = { createMissions };
