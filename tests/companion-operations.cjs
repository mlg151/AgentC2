const assert = require('node:assert/strict');
const { companionOperations } = require('../electron/companion-operations.cjs');

async function main() {
  const calls = [];
  const method = (name) => (...args) => { calls.push([name, ...args]); return name; };
  const service = new Proxy({
    store: { data: { settings: {}, workspace: { metadata: {} }, attention: [] } },
    exercises: new Proxy({}, { get: (_, name) => method(`exercise.${name}`) }),
    cleanup: { preview: () => ({ token: 'preview' }), execute: method('cleanup.execute'), state: method('cleanup.state') },
    terminals: { scrollRemote: method('scroll') },
  }, { get: (target, name) => target[name] || method(name) });
  const gateway = { service, bootstrap: () => ({ settings: {} }), status: method('remote.status'), configure: method('remote.configure'), pair: method('remote.pair'), revoke: method('remote.revoke'), tailscale: method('tailscale'), previewUrl: method('previewUrl') };
  const operations = companionOperations(gateway);
  const client = { id: 'web:fixture', admin: true };
  const record = { client, device: { id: 'device' } };
  assert.equal(operations['settings:save'].run(record, ['settings']), 'saveSettings');
  assert.deepEqual(calls.pop(), ['saveSettings', 'settings']);
  const ownerMethods = ['sitrep:preview', 'sitrep:launch', 'flash:decide', 'fault:interrupt-all', 'session:delete', 'diff:files', 'diff:detail', 'diff:hunk', 'terminal:scroll', 'image:upload'];
  for (const name of ownerMethods) {
    await operations[name].run(record, ['a', 'b', 'c']);
    assert.equal(calls.at(-1)[1], client, `${name} must retain device identity`);
  }
  assert.deepEqual(operations['state:get'].run(record, []), { settings: {} });
  for (const [name, operation] of Object.entries(operations)) {
    if (['state:get', 'cleanup:execute'].includes(name)) continue;
    await operation.run(record, ['a', 'b', 'c']);
    assert.equal(typeof operation.mutation, 'boolean', name);
  }
  await assert.rejects(async () => operations['cleanup:execute'].run(record, ['unknown', []]), /preview/i);
  const preview = await operations['cleanup:preview'].run(record, [{}]);
  await assert.rejects(async () => operations['cleanup:execute'].run({ ...record, device: { id: 'other' } }, [preview.token, []]), /preview/i);
  assert.equal(await operations['cleanup:execute'].run(record, [preview.token, ['key']]), 'cleanup.execute');
  assert.deepEqual(calls.at(-1), ['cleanup.execute', 'preview', ['key']]);
  console.log('PASS explicit companion operation routing, device identity, and cleanup preview isolation');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
