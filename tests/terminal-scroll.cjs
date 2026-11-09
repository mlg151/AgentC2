const assert = require('node:assert/strict');
const { scrollTerminal } = require('../electron/terminal-scroll.cjs');

async function scroll({ mode = '0', alternate = '0', provider = 'terminal', any = '0', button = '0', standard = '0', sgr = '0', width = '80', height = '24', direction = 'up', count = 10, pane = '%7' } = {}) {
  const calls = [];
  const active = await scrollTerminal(async (command) => {
    calls.push(command);
    return `${mode}|${pane}|${alternate}|${provider}|${any}|${button}|${standard}|${sgr}|${width}|${height}\n`;
  }, 'hq-123', direction, count);
  assert.match(calls.shift(), /^display-message -p -t hq-123 /);
  return { active, calls };
}
async function main() {
  await assert.rejects(scroll({ pane: 'unsafe-pane; kill-server' }), /Could not locate terminal pane/);
  assert.deepEqual(await scroll(), { active: true, calls: ['copy-mode -e -t %7', 'send-keys -t %7 -X -N 10 scroll-up'] });
  assert.deepEqual(await scroll({ mode: '1', direction: 'down' }), { active: true, calls: ['send-keys -t %7 -X -N 10 scroll-down'] });
  assert.deepEqual(await scroll({ direction: 'down' }), { active: false, calls: [] });
  assert.deepEqual(await scroll({ direction: 'latest' }), { active: false, calls: [] });
  assert.deepEqual(await scroll({ mode: '1', direction: 'latest' }), { active: false, calls: ['send-keys -t %7 -X cancel'] });
  for (const provider of ['codex', 'claude', 'terminal']) {
    assert.deepEqual(await scroll({ alternate: '1', mode: '1', provider, direction: 'latest' }), { active: false, calls: ['send-keys -t %7 -X cancel', ...(provider === 'terminal' ? [] : ['send-keys -t %7 C-End'])] });
  }
  for (const mouse of ['any', 'button', 'standard']) {
    for (const direction of ['up', 'down']) {
      const data = Buffer.from(`\x1b[<${direction === 'up' ? 64 : 65};40;8M`.repeat(4));
      assert.deepEqual(await scroll({ alternate: '1', sgr: '1', [mouse]: '1', direction }), { active: false, calls: [`send-keys -t %7 -H ${[...data].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`] });
    }
  }
  assert.deepEqual(await scroll({ alternate: '1', sgr: '1', any: '1', width: '0', height: '0', count: 1 }), { active: false, calls: ['send-keys -t %7 -H 1b 5b 3c 36 34 3b 31 3b 31 4d'] });
  for (const direction of ['up', 'down']) {
    for (const extra of [{}, { sgr: '1' }, { any: '1' }]) {
      assert.deepEqual(await scroll({ alternate: '1', direction, count: 45, ...extra }), { active: false, calls: [`send-keys -t %7 -N 3 ${direction === 'up' ? 'PPage' : 'NPage'}`] });
    }
  }
  assert.deepEqual(await scroll({ alternate: '1', height: '1', count: 0 }), { active: false, calls: ['send-keys -t %7 -N 1 PPage'] });
  const failure = new Error('tmux channel disconnected');
  await assert.rejects(scrollTerminal(() => Promise.reject(failure), 'hq-123', 'up', 10), (error) => error === failure);
  console.log('PASS normal/copy/alternate-buffer scroll state transitions, provider end navigation, every mouse protocol, exact wheel bytes, page bounds, unsafe pane rejection, and transport errors');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
