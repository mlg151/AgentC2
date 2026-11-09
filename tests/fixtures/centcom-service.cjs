const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../../electron/service.cjs');
const { defaults } = require('../../electron/centcom.cjs');
const { isolatedChatSsh, poll } = require('./isolated-chat-ssh.cjs');

async function centcomService(directory) {
  const ssh = await isolatedChatSsh(directory), priorPath = process.env.PATH;
  process.env.PATH = ssh.env.PATH;
  const service = createService({ directory: path.join(directory, 'desktop'), home: ssh.home });
  service.store.save('settings', { ...service.store.data.settings, hosts: [ssh.host] });
  const config = defaults(); config.model = 'fixture'; config.triggers.fallbackSeconds = 0;
  for (const key of Object.keys(config.triggers)) if (key.startsWith('on')) config.triggers[key] = false;
  service.centcom.configure(config);
  const repository = path.join(ssh.home, 'repository'); fs.mkdirSync(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repository, 'evidence.txt'), 'Base artifact\n'); git('add', '.'); git('commit', '-qm', 'Base');
  git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
  const covered = new Set(); let sequence = 0;
  async function submit(envelope) {
    fs.writeFileSync(path.join(ssh.home, 'centcom-plan.json'), JSON.stringify(['```agentc2-c2\n' + JSON.stringify({ version: 1, ...envelope }) + '\n```']));
    return service.centcom.submit('Run the isolated adapter verification step.');
  }
  async function query(operation, input = {}) {
    const id = `query-${++sequence}`;
    await submit({ queries: [{ id, kind: 'agentc2.query', params: { operation, input } }] });
    const result = service.centcom.outcomes({ collection: 'query', clientRequestId: id }).entries.findLast((item) => item.status === 'ok');
    assert.ok(result, `${operation}: ${JSON.stringify(service.centcom.outcomes({ clientRequestId: id }))}`);
    assert.ok(!result.result?.unavailable, `${operation}: ${JSON.stringify(result.result)}`);
    covered.add(operation); console.log(`PASS actual adapter ${operation}`);
    return result.result;
  }
  async function stage(operation, input) {
    const id = `action-${++sequence}`;
    const state = await submit({ directives: [{ id, kind: 'agentc2.action', summary: `Verify ${operation}`, params: { operation, input } }] });
    const record = state.directives.find((item) => item.clientRequestId === id);
    assert.equal(record?.state, 'pending', `${operation}: ${JSON.stringify(record)}`);
    assert.ok(!record.validationError, `${operation}: ${record.validationError}`);
    return record;
  }
  async function decide(record, decision = 'approve') {
    const state = await service.centcom.decideDirective(record.id, decision);
    return state.directives.find((item) => item.id === record.id);
  }
  async function action(operation, input) {
    const result = await decide(await stage(operation, input));
    assert.ok(['completed', 'uncertain'].includes(result.state) && !result.error, `${operation}: ${JSON.stringify(result)}`);
    if (result.result?.commandId) {
      const receipt = await poll(async () => {
        const receipt = await service.chats.request('default', 'receipt', { commandId: result.result.commandId });
        return ['completed', 'failed', 'unknown'].includes(receipt.state) && receipt;
      }, `${operation} native receipt did not settle`);
      assert.equal(receipt.state, 'completed', `${operation}: ${JSON.stringify(receipt)}`);
      result.nativeReceipt = receipt;
    }
    covered.add(operation); console.log(`PASS actual adapter ${operation}`);
    return result;
  }
  return { ...ssh, service, repository, git, submit, query, action, stage, decide, covered,
    assertCoverage(suite) { assert.deepEqual([...covered].sort(), require('./centcom-adapter-coverage.json')[suite], 'Every declared adapter must finish its actual-service verification'); },
    close() { service.centcom.dispose(); service.specops.dispose(); service.chats.closeAll(); service.terminals.closeAll(); service.tunnels.closeAll(); ssh.close(); process.env.PATH = priorPath; } };
}
module.exports = { centcomService };
