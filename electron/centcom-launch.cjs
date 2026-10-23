const { AsyncLocalStorage } = require('node:async_hooks');
const { mutationContext, assertDispatchScope } = require('./centcom-dispatch.cjs');

// Internal workflow provenance cannot be supplied through renderer launch input.
const workflowLaunch = new AsyncLocalStorage();
function launchPolicy() {
  const directive = mutationContext.getStore()?.directive;
  const authority = directive?.binding?.evidence?.authority;
  return authority ? structuredClone({ version: 1, directiveId: directive.id, authority }) : null;
}
function withLaunchPolicy(policy, details, action) {
  return workflowLaunch.run({ policy, details }, action);
}
function withoutLaunchContext(action) {
  return workflowLaunch.exit(() => mutationContext.exit(action));
}
function workflowReuse(run) {
  if (!run.worktree?.path) return undefined;
  return { operationId: run.id, predecessors: run.visits.filter((visit) => visit.completion && visit.turnId && visit.name && visit.sessionId).map((visit) => ({ sessionKey: `${run.hostId}/tmux:${visit.name}`, chatSessionId: visit.sessionId, turnId: visit.turnId })) };
}

function createLaunchGuard({ service, evidence, authority, legacyPolicy = () => null }) {
  const hosts = new Map();
  async function run(input, dispatch) {
    const workflow = workflowLaunch.getStore();
    const policy = workflow?.policy || launchPolicy() || legacyPolicy(workflow?.details);
    if (!policy) return dispatch(); // Existing desktop launches are outside C2.
    const hostId = input.hostId || service.store.data.settings.hosts.find((host) => host.enabled)?.id;
    const previous = hosts.get(hostId) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => held);
    hosts.set(hostId, queued);
    await previous.catch(() => {});
    try {
      if (policy.version !== 1) throw Object.assign(new Error('Unknown workflow launch authorization; review the mission again'), { beforeMutation: true, launchPolicy: policy });
      const current = mutationContext.getStore();
      const context = current || { directive: { binding: { evidence: { authority: policy.authority } } }, authority };
      return await mutationContext.run(context, async () => {
        const host = service.store.data.settings.hosts.find((item) => item.id === hostId);
        if (!host?.enabled) throw Object.assign(new Error('Launch host is unavailable'), { beforeMutation: true });
        // The production remote dispatcher repeats this after its own awaits.
        assertDispatchScope(service.store.data.settings.hosts.find((item) => item.id === hostId) || { id: hostId }, { action: 'create' }, service.store.data.settings);
        const admission = await evidence.admission({ hostId, cwd: input.cwd, worktree: input.worktree }, { reuse: workflow?.details?.reuse });
        const reviewedUnknown = Boolean(current?.directive?.approvedAt) && admission.unknowns.every((reason) => current.directive.binding.evidence.admissionUnknowns?.includes(reason));
        if (admission.status === 'blocked' || (admission.status === 'unknown' && !reviewedUnknown)) {
          throw Object.assign(new Error('Launch admission requires review: ' + [...admission.blockers, ...admission.unknowns].join('; ')), { beforeMutation: true, admission });
        }
        // Approval is scoped to the current call. A persisted workflow policy
        // never carries an indefinite exemption for unknown future headroom.
        assertDispatchScope(service.store.data.settings.hosts.find((item) => item.id === hostId) || { id: hostId }, { action: 'create' }, service.store.data.settings);
        try { return await dispatch(); }
        finally {
          // Refresh assignments before allowing another C2 launch on this host,
          // including a dispatch whose result was lost or became uncertain.
          await service.inventory().catch(() => {});
        }
      });
    } finally {
      release();
      if (hosts.get(hostId) === queued) hosts.delete(hostId);
    }
  }
  return { run };
}

module.exports = { launchPolicy, withLaunchPolicy, withoutLaunchContext, workflowReuse, createLaunchGuard };
