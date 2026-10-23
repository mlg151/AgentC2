const { AsyncLocalStorage } = require('node:async_hooks');
const { fingerprint } = require('./centcom-contract.cjs');

// This context is private to an approved CENTCOM call chain. It follows nested
// service awaits so a changed SSH route cannot redirect a reviewed mutation.
const mutationContext = new AsyncLocalStorage();
const MUTATIONS = new Set(['create', 'configure', 'rename', 'worktree_launch', 'worktree_archive', 'oporder_sync', 'exercise_promote', 'flash_decide', 'diff_hunk', 'interrupt', 'stop']);
function assertDispatchScope(host, payload, settings) {
  const context = mutationContext.getStore();
  if (!context) return payload;
  const mutation = MUTATIONS.has(payload.action) || (['sitrep_source_preview', 'exercise_inspect'].includes(payload.action) && Boolean(payload.testCommand)) ||
    (payload.action === 'chat' && payload.request?.action === 'command') || (payload.action === 'github' && ['ready', 'close'].includes(payload.operation));
  if (!mutation) return payload;
  const reject = (message) => { throw Object.assign(new Error(message), { beforeMutation: true }); };
  const scope = context.directive?.binding?.evidence.authority;
  const expected = scope?.hosts.find((h) => h.id === host.id);
  if (!expected || fingerprint(expected) !== fingerprint(host)) reject('Reviewed host route changed before dispatch');
  if (fingerprint(scope.roe) !== fingerprint(settings.roe || null)) reject('Rules of Engagement changed before dispatch');
  if (scope.preset && fingerprint(scope.preset) !== fingerprint(settings.presets.find((p) => p.id === scope.preset.id) || null)) reject('Reviewed launch preset changed before dispatch');
  for (const preset of scope.presets || []) if (fingerprint(preset.value) !== fingerprint(settings.presets.find((item) => item.id === preset.id) || null)) reject('Reviewed contestant preset changed before dispatch');
  const current = context.authority();
  if (current.mode !== scope.mode || current.commander !== scope.commander) reject('CENTCOM authorization changed before dispatch');
  if (payload.action === 'worktree_archive') return { ...payload, expectedHeadCommit: context.directive.binding.evidence.operationEvidence.status.headCommit };
  if (payload.action === 'worktree_launch' && context.worktreeRecovery) {
    if (payload.operationId !== context.worktreeRecovery.operationId) reject('Worktree recovery target changed before dispatch');
    return { ...payload, expectedWorktreeRevision: context.worktreeRecovery.revision };
  }
  return payload;
}
module.exports = { mutationContext, assertDispatchScope };
