// Deterministic inventory only; exercise the production window, preload, and IPC.
const serviceModule = require('../../electron/service.cjs');
const original = serviceModule.createService;
serviceModule.createService = (options) => {
  const service = original(options);
  const units = Array.from({ length: 17 }, (_, index) => {
    const id = `hq-${String(index + 1).padStart(12, '0')}`;
    return { key: `default/tmux:${id}`, id, title: `Overwatch fixture ${index + 1}`, provider: 'codex', kind: 'managed', managed: true, state: 'exited', canAttach: false, canStop: false, cwd: '/fixture/project', branch: 'fixture-branch', hostId: 'default', hostName: 'Fixture host' };
  });
  service.inventory = async () => {
    const snapshot = { capturedAt: new Date().toISOString(), hosts: [{ id: 'default', name: 'Fixture host', connected: true }], sessions: units, attention: [], faults: [] };
    service.events.emit('inventory:updated', snapshot);
    return snapshot;
  };
  service.terminalPreviews = async (keys) => keys.map((key) => ({ key, text: 'Fixture task completed.\nTests: passing\nReady for review.', sampledAt: Date.now(), error: false }));
  service.health = async () => [];
  service.flashQueue = async () => [];
  service.cleanup.runDue = async () => {};
  return service;
};
require('../../electron/main.cjs');
