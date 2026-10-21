const crypto = require('node:crypto');

const ID = /^[a-f0-9]{32}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const PROVIDERS = new Set(['codex', 'claude', 'antigravity']);

function createExercises({ store, getHost, runRemote, createSession, beginLaunch, emit }) {
  const flights = new Set();
  const list = () => store.data.exercises || [];
  const capabilities = (hostId) => runRemote({ action: 'exercise_capabilities' }, getHost(hostId).id);
  function save(record) {
    const records = [record, ...list().filter((item) => item.id !== record.id)].slice(0, 50);
    store.save('exercises', records);
    emit('state:updated');
    return record;
  }
  function find(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid exercise ID');
    const record = list().find((item) => item.id === id);
    if (!record) throw new Error('Exercise is unavailable');
    return record;
  }
  function checkText(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}`);
    return value.trim();
  }
  async function create(input) {
    if (!input || !Array.isArray(input.contestants) || input.contestants.length < 2 || input.contestants.length > 3) throw new Error('Choose two or three contestants');
    const hostId = getHost(input.hostId).id;
    const repository = checkText(input.repository, 4096, 'repository');
    const baseRef = checkText(input.baseRef, 200, 'base ref');
    const title = checkText(input.title, 100, 'exercise title');
    const prompt = checkText(input.prompt, 12000, 'shared prompt');
    const testCommand = typeof input.testCommand === 'string' && input.testCommand.length <= 500 && !input.testCommand.includes('\0') ? input.testCommand.trim() : (() => { throw new Error('Invalid verification command'); })();
    const contestants = input.contestants.map((item, index) => {
      if (!item || !PROVIDERS.has(item.provider) || (item.presetId && !store.data.settings.presets.some((preset) => preset.id === item.presetId && preset.provider === item.provider)) || (item.roeProfile && !['full', 'gated', 'provider-default'].includes(item.roeProfile))) throw new Error('Invalid contestant launch configuration');
      return { id: crypto.randomBytes(16).toString('hex'), provider: item.provider, presetId: item.presetId || '', roeProfile: item.roeProfile || '', slug: `exercise-${index + 1}`, state: 'queued', name: '', error: '', markedComplete: false, evidence: null };
    });
    const base = await runRemote({ action: 'exercise_base', repository, baseRef }, hostId);
    if (!COMMIT.test(base.baseCommit)) throw new Error('Remote base is invalid');
    const record = save({ version: 1, id: crypto.randomBytes(16).toString('hex'), title, hostId, repository: base.repository, baseCommit: base.baseCommit, prompt, testCommand, contestants, state: 'launching', createdAt: Date.now(), promotion: null });
    return launch(record.id);
  }
  async function launch(id) {
    const record = find(id);
    if (flights.has(id)) throw new Error('Exercise launch is already in progress');
    if (record.state === 'cancelled' || record.promotion) throw new Error('Exercise cannot be relaunched');
    const pending = record.contestants.filter((item) => ['queued', 'failed', 'launching'].includes(item.state));
    flights.add(id);
    try {
    for (let index = 0; index < pending.length; index++) {
      if (record.state === 'cancelled') break;
      const item = pending[index];
        item.state = 'launching'; item.error = ''; save(record);
        const release = beginLaunch(record.hostId);
        try {
          const result = await createSession({ provider: item.provider, presetId: item.presetId || undefined, roeProfile: item.roeProfile || undefined, hostId: record.hostId, title: `${record.title} · ${item.provider}`, instructions: record.prompt, worktree: { operationId: item.id, repository: record.repository, baseRef: record.baseCommit, slug: item.slug } });
          item.name = result.name; item.state = 'launched';
        } catch (error) { item.state = 'failed'; item.error = String(error.message || error).slice(0, 500); }
        finally { release(); save(record); }
    }
    if (record.state !== 'cancelled') record.state = record.contestants.some((item) => item.state === 'failed') ? 'partial' : 'running';
    return save(record);
    } finally { flights.delete(id); }
  }
  function cancel(id) {
    const record = find(id);
    if (record.promotion) throw new Error('Promoted exercise cannot be cancelled');
    record.state = 'cancelled';
    return save(record);
  }
  async function inspect(id, contestantId, verify = false) {
    const record = find(id);
    const item = record.contestants.find((candidate) => candidate.id === contestantId && candidate.state === 'launched');
    if (!item) throw new Error('Contestant has not launched');
    const result = await runRemote({ action: 'exercise_inspect', operationId: item.id, baseCommit: record.baseCommit, testCommand: verify ? record.testCommand : '', markedComplete: item.markedComplete }, record.hostId);
    if (verify) {
      if (!item.markedComplete && result.active) throw new Error('Mark the contestant complete before verification');
      item.evidence = { revision: result.revision, test: result.test, verifiedAt: Date.now(), explicitCompletion: item.markedComplete || !result.active };
      save(record);
    }
    return { ...result, evidence: item.evidence && item.evidence.revision === result.revision ? item.evidence : null };
  }
  function markComplete(id, contestantId) {
    const record = find(id);
    const item = record.contestants.find((candidate) => candidate.id === contestantId && candidate.state === 'launched');
    if (!item) throw new Error('Contestant has not launched');
    item.markedComplete = true;
    return save(record);
  }
  async function preview(id, contestantId) {
    const record = find(id);
    const item = record.contestants.find((candidate) => candidate.id === contestantId && candidate.state === 'launched');
    if (!item || !item.evidence) throw new Error('Verify this contestant before promotion');
    if (record.testCommand && (item.evidence.test?.timedOut || item.evidence.test?.exitCode !== 0)) throw new Error('Verification did not pass');
    const result = await runRemote({ action: 'exercise_target_preview', operationId: item.id, baseCommit: record.baseCommit, revision: item.evidence.revision, target: record.repository }, record.hostId);
    return { ...result, contestantId, test: item.evidence.test };
  }
  async function promote(id, contestantId, revision) {
    const record = find(id);
    if (record.promotion) {
      if (record.promotion.contestantId === contestantId && record.promotion.revision === revision) return record;
      throw new Error('This exercise already has a promoted result');
    }
    const item = record.contestants.find((candidate) => candidate.id === contestantId && candidate.state === 'launched');
    if (!item?.evidence || item.evidence.revision !== revision) throw new Error('Verification is stale; review the winner again');
    if (record.testCommand && (item.evidence.test?.timedOut || item.evidence.test?.exitCode !== 0)) throw new Error('Verification did not pass; run or change the selected command before promotion');
    const result = await runRemote({ action: 'exercise_promote', operationId: item.id, baseCommit: record.baseCommit, revision, target: record.repository }, record.hostId);
    record.promotion = { contestantId, revision, ...result, at: Date.now() };
    record.state = 'promoted';
    return save(record);
  }
  return { list, capabilities, create, launch, cancel, inspect, markComplete, preview, promote };
}

module.exports = { createExercises };
