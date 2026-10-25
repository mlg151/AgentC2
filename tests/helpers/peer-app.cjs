// Production service/main/preload; inventory is isolated from SSH and providers.
const serviceModule = require('../../electron/service.cjs');
const original = serviceModule.createService;
serviceModule.createService = (options) => {
  const service = original(options);
  const unit = { key: 'remote/tmux:hq-123456abcdef', id: 'hq-123456abcdef', title: 'Shared fixture mission', provider: 'codex', kind: 'managed', managed: true, state: 'exited', canAttach: false, canStop: false, cwd: '/fixture', hostId: 'remote', hostName: 'Shared host' };
  service.inventory = async () => {
    const value = { capturedAt: new Date().toISOString(), hosts: [{ id: 'remote', name: 'Shared host', connected: true }], sessions: [unit], attention: service.store.data.attention, faults: [] };
    service.events.emit('inventory:updated', value); return value;
  };
  service.health = async () => [];
  service.flashQueue = async () => [];
  service.cleanup.runDue = async () => {};
  return service;
};
require('../../electron/main.cjs');
