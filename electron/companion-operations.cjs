// Explicit remote surface. Never dispatch arbitrary service or Electron methods.
function companionOperations(gateway) {
  const service = gateway.service;
  const previews = new Map();
  const read = (run) => ({ mutation: false, run });
  const write = (run) => ({ mutation: true, run });
  return {
    'peer-sync:status': read((_, args) => gateway.desktopHandlers.get('peer-sync:status')(...args)),
    'peer-sync:save': write((_, args) => gateway.desktopHandlers.get('peer-sync:save')(...args)),
    'peer-sync:pair': read((_, args) => gateway.desktopHandlers.get('peer-sync:pair')(...args)),
    'peer-sync:connect': write((_, args) => gateway.desktopHandlers.get('peer-sync:connect')(...args)),
    'peer-sync:revoke': write((_, args) => gateway.desktopHandlers.get('peer-sync:revoke')(...args)),
    'peer-sync:pull-tabs': write((_, args) => gateway.desktopHandlers.get('peer-sync:pull-tabs')(...args)),
    'updates:check': write((_, args) => gateway.desktopHandlers.get('updates:check')(...args)),
    'updates:state': read((_, args) => gateway.desktopHandlers.get('updates:state')(...args)),
    'updates:download': write((_, args) => gateway.desktopHandlers.get('updates:download')(...args)),
    'updates:install': write((_, args) => gateway.desktopHandlers.get('updates:install')(...args)),
    'overwatch:state': read((_, args) => gateway.desktopHandlers.get('overwatch:state')(...args)),
    'overwatch:undock': write((_, args) => gateway.desktopHandlers.get('overwatch:undock')(...args)),
    'overwatch:dock': write((_, args) => gateway.desktopHandlers.get('overwatch:dock')(...args)),
    'overwatch:select': read((_, args) => gateway.desktopHandlers.get('overwatch:select')(...args)),
    'github:request': write((_, args) => gateway.desktopHandlers.get('github:request')(...args)),
    'specops:list': read((_, args) => gateway.desktopHandlers.get('specops:list')(...args)),
    'specops:definition': read((_, args) => gateway.desktopHandlers.get('specops:definition')(...args)),
    'specops:configure': write((_, args) => gateway.desktopHandlers.get('specops:configure')(...args)),
    'specops:launch': write((_, args) => gateway.desktopHandlers.get('specops:launch')(...args)),
    'specops:control': write((_, args) => gateway.desktopHandlers.get('specops:control')(...args)),
    'centcom:state': read((_, args) => gateway.desktopHandlers.get('centcom:state')(...args)),
    'centcom:configure': write((_, args) => gateway.desktopHandlers.get('centcom:configure')(...args)),
    'centcom:start': write((_, args) => gateway.desktopHandlers.get('centcom:start')(...args)),
    'centcom:submit': write((_, args) => gateway.desktopHandlers.get('centcom:submit')(...args)),
    'centcom:interrupt': write((_, args) => gateway.desktopHandlers.get('centcom:interrupt')(...args)),
    'centcom:pause': write((_, args) => gateway.desktopHandlers.get('centcom:pause')(...args)),
    'centcom:reset': write((_, args) => gateway.desktopHandlers.get('centcom:reset')(...args)),
    'centcom:decide-directive': write((_, args) => gateway.desktopHandlers.get('centcom:decide-directive')(...args)),
    'centcom:decide-all-directives': write((_, args) => gateway.desktopHandlers.get('centcom:decide-all-directives')(...args)),
    'centcom:apply-automation': write((_, args) => gateway.desktopHandlers.get('centcom:apply-automation')(...args)),
    'session:rename': write((_, args) => gateway.desktopHandlers.get('session:rename')(...args)),
    'state:get': read(() => gateway.bootstrap()),
    'attention:ack': read((_, args) => service.acknowledge(...args)),
    'settings:save': write((_, [input]) => service.saveSettings(input)),
    'metadata:update': write((_, args) => service.updateMetadata(...args)),
    'oporder:preview': read((_, args) => service.previewOpOrder(...args)),
    'oporder:enroll': write((_, args) => service.enrollOpOrder(...args)),
    'sitrep:preview': read(({ client }, args) => service.previewSitrep(client, ...args)),
    'sitrep:launch': write(({ client }, args) => service.launchSitrep(client, ...args)),
    'exercise:list': read(() => service.exercises.list()),
    'exercise:capabilities': read((_, args) => service.exercises.capabilities(...args)),
    'exercise:create': write((_, args) => service.exercises.create(...args)),
    'exercise:retry': write((_, args) => service.exercises.launch(...args)),
    'exercise:cancel': write((_, args) => service.exercises.cancel(...args)),
    'exercise:complete': write((_, args) => service.exercises.markComplete(...args)),
    'exercise:inspect': read((_, args) => service.exercises.inspect(...args)),
    'exercise:preview': read((_, args) => service.exercises.preview(...args)),
    'exercise:promote': write((_, args) => service.exercises.promote(...args)),
    'flash:list': read(() => service.flashQueue()),
    'flash:decide': write(({ client }, args) => service.flashDecide(client, ...args)),
    'fault:interrupt-all': write(({ client }) => service.interruptFaults(client)),
    'fault:reset': write((_, args) => service.resetFault(...args)),
    'session:delete': write(({ client }, args) => service.deleteSession(client, ...args)),
    'cleanup:preview': read(async ({ device }, args) => {
      const preview = await service.cleanup.preview(...args);
      // A new preview replaces this device's prior preview, bounding memory.
      previews.set(device.id, preview.token);
      return preview;
    }),
    'cleanup:execute': write(({ device }, [token, keys]) => {
      if (previews.get(device.id) !== token || typeof token !== 'string') throw new Error('Obtain a cleanup preview on this device first');
      return service.cleanup.execute(token, keys);
    }),
    'cleanup:state': read(() => service.cleanup.state()),
    'terminal:previews': read((_, args) => service.terminalPreviews(...args)),
    'terminal:search': read((_, args) => service.searchHistory(...args)),
    'terminal:scroll': read(({ client }, args) => service.terminals.scrollRemote(client, ...args)),
    'image:upload': write(({ client }, [id, base64]) => service.uploadCompanionImage(client, id, base64)),
    'worktrees:list': read((_, args) => service.worktrees(...args)),
    'worktrees:archive': write((_, args) => service.archiveWorktree(...args)),
    'diff:files': read(({ client }, [input]) => service.diffRequest(client, input, 'diff_files')),
    'diff:detail': read(({ client }, [input]) => service.diffRequest(client, input, 'diff_detail')),
    'diff:hunk': write(({ client }, [input]) => service.diffRequest(client, input, 'diff_hunk')),
    'tunnel:list': read((_, args) => service.devUrls(...args)),
    'tunnel:open': read((record, args) => gateway.previewUrl(record, ...args)),
    'remote:status': read(() => gateway.status()),
    'remote:save': write((_, args) => gateway.configure(...args)),
    // Pairing links are one-use secrets: never persist their plaintext in the RPC ledger.
    'remote:pair': read(() => gateway.pair()),
    'remote:revoke': write((_, args) => gateway.revoke(...args)),
    'remote:tailscale': read(() => gateway.tailscale()),
  };
}

module.exports = { companionOperations };
