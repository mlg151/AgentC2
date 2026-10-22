// Uses the real view and ownership service with a deterministic worker fixture.
// No SSH host, credentials, or external model requests are used.
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const { Chats } = require('../electron/chat.cjs');
const { contract } = require('../electron/chat-protocol.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const id = 'chat-0123456789abcdef0123456789abcdef';
const timestamp = '2026-10-22T12:00:00.000Z';
const caps = { provider: 'codex', version: '0.163.0 fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((name) => [name, ['streaming','history','resume','interrupt','approvals','questions'].includes(name)])) };
const session = { id, canStop: true, provider: 'codex', providerSessionId: 'native-fixture', title: 'Mission review', cwd: '/workspace/agentc2', roeProfile: 'gated', state: 'idle', activeTurnId: null, createdAt: timestamp, updatedAt: timestamp, capabilities: caps };
const rows = [], pending = [], receipts = new Map(), commands = [], views = new Map(), errors = [];
let delay = false, drop = false, accepted = 0, sequence = 0, retainedFrom = 1;
function append(type, data, itemId = null) { rows.push({ protocolVersion: 1, sessionId: id, sequence: ++sequence, timestamp, provider: 'codex', providerSessionId: 'native-fixture', turnId: 'turn-fixture', itemId, type, data }); }
for (let i = 0; i < 210; i++) append('provider.event', { method: 'fixture', payload: {} });
append('message.completed', { role: 'assistant', text: '## Review complete\nThe worker keeps running when you detach.\n\n| Check | Result |\n| --- | --- |\n| Replay | Verified |\n| Control | Scoped |\n\n```typescript\nawait chat.ready(cursor);\n```\n\n[Documentation](https://example.com/docs)\n\n<script>window.qaXss = 1</script>\n[bad](javascript:alert(1)) ![remote](https://example.invalid/pixel.png)' }, 'intro');
append('tool.started', { name: 'git diff --stat', input: '{"cwd":"/workspace/agentc2"}' }, 'tool');
append('tool.completed', { name: 'git diff --stat', output: '3 files changed, 42 insertions(+)', isError: false }, 'tool');
append('turn.completed', { outcome: 'completed', detail: 'Review the changes before merging.' });
const chats = new Chats({ resolveHost: () => 'fixture', interval: 50, emit: (client, event, value) => { const page = views.get(client); if (page && !page.isClosed()) void page.evaluate(({ event, value }) => window.dispatchEvent(new CustomEvent(event, { detail: value })), { event, value }).catch(() => {}); }, remote: async (_host, request) => {
  if (request.action === 'history') {
    const selected = rows.filter((row) => row.sequence > request.after).slice(0, request.limit);
    return { session: structuredClone(session), events: structuredClone(selected), cursor: selected.at(-1)?.sequence || Math.max(request.after, retainedFrom - 1), latestCursor: sequence, retainedFrom, truncated: request.after < retainedFrom - 1, hasMore: rows.some((row) => row.sequence > (selected.at(-1)?.sequence || Math.max(request.after, retainedFrom - 1))), pendingRequests: structuredClone(pending), pendingCommands: [] };
  }
  if (request.action === 'prune') { assert.equal(session.state, 'stopped'); rows.splice(0); retainedFrom = sequence + 1; return { pruned: true }; }
  if (request.action === 'receipt') { if (!receipts.has(request.commandId)) throw new Error('No receipt recorded'); return receipts.get(request.commandId); }
  if (request.action === 'command') {
    const command = request.command; commands.push(command);
    if (delay) await new Promise((resolve) => setTimeout(resolve, 200));
    if (drop) throw new Error('Disconnected before acknowledgement');
    if (!receipts.has(command.commandId)) {
      accepted++;
      if (command.operation === 'send') {
        append('message.completed', { role: 'user', text: command.payload.text }, 'user-' + command.commandId);
        append('message.delta', { text: 'Streamed ' }, 'reply-' + command.commandId);
        append('message.completed', { role: 'assistant', text: 'Streamed final answer' }, 'reply-' + command.commandId);
      } else if (command.operation === 'respond') {
        assert.equal(command.payload.turnId, 'turn-fixture'); assert.equal(command.payload.itemId, pending[0].itemId);
        pending.splice(0); session.state = 'idle';
        append('request.resolved', { requestId: command.payload.requestId, state: 'resolved', decision: command.payload.decision || 'answered' });
      }
      receipts.set(command.commandId, { commandId: command.commandId, sessionId: id, state: 'completed', result: {}, error: null });
    }
    return receipts.get(command.commandId);
  }
  throw new Error('Unexpected operation');
} });
async function poll(check, label) { for (let i=0;i<60;i++) { if (await check()) return; await new Promise((resolve)=>setTimeout(resolve,50)); } throw new Error(label); }
function request(type, data) {
  session.state = 'waiting'; session.activeTurnId = 'turn-fixture';
  pending.push({ requestId: data.requestId, turnId: 'turn-fixture', itemId: 'request-item', state: 'pending', type, data }); append(type, data, 'request-item');
}
(async () => {
  let server, browser;
  const directory = process.env.AGENTC2_QA_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-chat-ui-'));
  try {
    server = await createServer({ root: path.resolve(__dirname, '..'), server: { port: 0, strictPort: false, host: '127.0.0.1' } }); await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    async function pageFor(client, viewport) {
      const context = await browser.newContext({ viewport }); const page = await context.newPage(); views.set(client.id,page);
      page.on('pageerror', (error)=>errors.push(error.message)); page.on('console',(message)=>{if(message.type()==='error') errors.push(message.text());});
      await context.route('https://**/*', (route) => { errors.push('Unexpected remote request: '+route.request().url()); return route.abort(); });
      await page.exposeFunction('invoke', (method,...args) => chats[method](client,...args));
      await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/chat-ui.html`);
      await page.getByRole('heading',{name:'Review complete'}).waitFor(); return page;
    }
    const desktop = await pageFor({id:'desktop',name:'Desktop'}, {width:1280,height:900});
    assert.equal(await desktop.title(),'AgentC2 Chat QA');
    assert.equal(await desktop.locator('a[href^="javascript"]').count(),0); assert.equal(await desktop.locator('img').count(),0); assert.equal(await desktop.evaluate(()=>window.qaXss),undefined);
    await desktop.getByText('git diff --stat',{exact:true}).click(); await desktop.getByText('3 files changed, 42 insertions(+)').waitFor();
    delay = true; await desktop.getByRole('textbox',{name:'Message to agent'}).fill('Review lifecycle\nPreserve the command ID');
    await desktop.getByRole('button',{name:'Send',exact:true}).click();
    await desktop.getByText('Streamed final answer',{exact:true}).waitFor(); await poll(async()=>await desktop.getByRole('button',{name:'Send',exact:true}).count()===1,'Submission receipt stuck');
    assert.equal(await desktop.getByText('Streamed final answer',{exact:true}).count(),1); assert.equal(commands.length,1); delay=false;
    await desktop.getByRole('button',{name:'Load earlier managed messages'}).click();
    request('approval.requested',{requestId:'approval-one',action:'Run a protected command',detail:'{"command":"git status --short","cwd":"/workspace/agentc2"}'});
    await desktop.getByRole('button',{name:'Allow once'}).waitFor();
    fs.mkdirSync(directory,{recursive:true}); await desktop.screenshot({path:path.join(directory,'desktop-chat.png')});
    await desktop.getByRole('button',{name:'Allow once'}).click(); await poll(()=>pending.length===0,'Approval not resolved');
    const phone = await pageFor({id:'phone',name:'QA phone'},{width:390,height:844});
    await phone.getByRole('button',{name:'Take control'}).click(); await poll(async()=>await desktop.getByText('QA phone has control').count()===1,'Desktop ownership not updated');
    assert.equal(await desktop.getByRole('textbox',{name:'Message to agent'}).isDisabled(),true);
    request('question.requested',{requestId:'question-one',questions:[{id:'q0',question:'Which validation should run?',options:['Focused checks','Full suite'],multiple:false}]});
    await phone.getByLabel('Full suite',{exact:true}).check(); await phone.screenshot({path:path.join(directory,'phone-chat.png')});
    await phone.getByRole('button',{name:'Send answers'}).click(); await poll(()=>pending.length===0,'Question not resolved');
    assert.deepEqual(commands.at(-1).payload.answers,[{questionId:'q0',answers:['Full suite']}]);
    await phone.getByRole('button',{name:'Detach',exact:true}).click();
    await desktop.getByRole('button',{name:'Take control'}).click();
    drop=true; await desktop.getByRole('textbox',{name:'Message to agent'}).fill('Unacknowledged action'); await desktop.getByRole('button',{name:'Send',exact:true}).click();
    await desktop.getByRole('button',{name:'Retry same action'}).waitFor(); const before=commands.length;
    await new Promise((resolve)=>setTimeout(resolve,300)); assert.equal(commands.length,before,'UI automatically resubmitted');
    const retryId=commands.at(-1).commandId; drop=false; await desktop.getByRole('button',{name:'Retry same action'}).click();
    await poll(()=>accepted===4,'Explicit retry did not settle'); assert.equal(commands.at(-1).commandId,retryId);
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile page overflows horizontally');
    await desktop.getByText('Transcript storage', { exact: true }).click();
    assert.equal(await desktop.getByRole('button', { name: 'Remove managed transcript', exact: true }).isDisabled(), true);
    session.state = 'stopped'; session.canStop = false;
    await poll(async () => await desktop.getByRole('button', { name: 'Remove managed transcript', exact: true }).isEnabled(), 'Stopped transcript removal unavailable');
    desktop.once('dialog', (dialog) => dialog.accept());
    await desktop.getByRole('button', { name: 'Remove managed transcript', exact: true }).click();
    await desktop.getByText('Earlier transcript content was removed under the retention policy.').waitFor();
    assert.equal(await desktop.getByText('Streamed final answer', { exact: true }).count(), 0);
    assert.equal(receipts.get(retryId).state, 'completed', 'Pruning removed a deduplication receipt');
    await phone.getByRole('button', { name: 'Attach chat', exact: true }).click();
    await phone.getByText('Earlier transcript content was removed under the retention policy.').waitFor();
    assert.equal(await phone.getByText('Streamed final answer', { exact: true }).count(), 0);
    assert.deepEqual(errors,[]); console.log(`PASS desktop/mobile Markdown, streaming identity, history, request decisions, ownership, safe content, delayed acknowledgements, and explicit deduplicated retry. Screenshots: ${directory}`);
  } finally { chats.closeAll(); await browser?.close(); await server?.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1;});
