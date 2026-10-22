// Actual SSH + tmux + detached worker, with only a local Codex protocol fixture.
// Every server, key, HOME, socket, repository, and provider process is disposable.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { createService } = require('../electron/service.cjs');
const root = path.resolve(__dirname, '..');
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
async function poll(check, label) { for(let i=0;i<100;i++){const result=await check();if(result)return result;await new Promise((resolve)=>setTimeout(resolve,100));}throw new Error(label); }
(async()=>{
  if(process.platform!=='linux' || !fs.existsSync('/usr/sbin/sshd')) { console.log('SKIP isolated SSH chat launch: Linux sshd is required'); return; }
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'a2-chat-ssh-')), originalPath=process.env.PATH;
  const home=path.join(directory,'home'), bin=path.join(directory,'bin'), remoteBin=path.join(directory,'remote-bin');
  for(const folder of [home,bin,remoteBin])fs.mkdirSync(folder,{mode:0o700});
  const script=(name,body)=>fs.writeFileSync(name,'#!/bin/sh\n'+body+'\n',{mode:0o700});
  let daemon,service,workerPid,app,browser,phoneProxy,fixtureServer;
  try {
    const listener=net.createServer();await new Promise((resolve)=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise((resolve)=>listener.close(resolve));
    const key=path.join(directory,'client-key'), hostKey=path.join(directory,'host-key');
    for(const file of [key,hostKey])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',file]);
    const knownHosts=path.join(directory,'known-hosts');fs.writeFileSync(knownHosts,`[127.0.0.1]:${port} ${fs.readFileSync(hostKey+'.pub','utf8')}`);
    const tmuxSocket=path.join(directory,'tmux.sock');script(path.join(remoteBin,'tmux'),`exec /usr/bin/tmux -S ${quote(tmuxSocket)} "$@"`);
    fs.copyFileSync(path.join(root,'tests/fixtures/codex-app-server.py'),path.join(remoteBin,'codex'));fs.chmodSync(path.join(remoteBin,'codex'),0o700);fs.writeFileSync(path.join(home,'settings.json'),'{}');
    const force=path.join(directory,'remote-command');script(force,`export HOME=${quote(home)}\nexport PATH=${quote(remoteBin+':/usr/local/bin:/usr/bin:/bin')}\nexport AGENTC2_CODEX_FIXTURE_DIR=${quote(home)}\nexec /bin/bash -c "$SSH_ORIGINAL_COMMAND"`);
    const config=path.join(directory,'sshd_config');fs.writeFileSync(config,`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${os.userInfo().username}\nForceCommand ${force}\n`);
    let diagnostics='';daemon=spawn('/usr/sbin/sshd',['-D','-e','-f',config]);daemon.stderr.on('data',(chunk)=>{diagnostics+=chunk;});
    await poll(async()=>{if(daemon.exitCode!==null)throw new Error(diagnostics);return new Promise((resolve)=>{const socket=net.connect(port,'127.0.0.1');socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));});},'Isolated sshd unavailable');
    script(path.join(bin,'ssh'),`exec /usr/bin/ssh -i ${quote(key)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${quote(knownHosts)} "$@"`);process.env.PATH=bin+':'+originalPath;
    service=createService({directory:path.join(directory,'desktop'),home});service.store.save('settings',{...service.store.data.settings,hosts:[{id:'default',name:'Isolated SSH fixture',target:os.userInfo().username+'@127.0.0.1',port,enabled:true}]});
    await service.chats.capabilities('default'); workerPid=(await service.chats.request('default','health')).pid;
    const repo=path.join(home,'repo');fs.mkdirSync(repo);execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Fixture']);
    fixtureServer=require('node:http').createServer((_request,response)=>response.end('AgentC2 structured tunnel fixture'));
    await new Promise((resolve)=>fixtureServer.listen(0,'127.0.0.1',resolve));
    const devUrl=`http://127.0.0.1:${fixtureServer.address().port}/preview?fixture=chat`;
    fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({devUrl}));
    const launch={provider:'codex',transport:'chat',launchId:crypto.randomBytes(16).toString('hex'),cwd:repo,title:'SSH structured fixture',instructions:'initial fixture prompt',roeProfile:'gated',hostId:'default'};
    const first=await service.create(launch),again=await service.create(launch);assert.equal(first.name,again.name);
    const desktop={id:'desktop',name:'Desktop'};
    const handle=await service.chats.open(desktop,first.chatSessionId,'default');
    await service.chats.ready(desktop,handle,0);
    let page=await poll(async()=>{const value=await service.chats.history(desktop,handle,0);return value.events.some((event)=>event.type==='turn.completed')&&value;},'Initial instructions were not executed');
    assert.equal(page.events.filter((event)=>event.type==='message.completed'&&event.data.role==='user').length,1,'Create retry duplicated initial instructions');
    const inventory=await service.inventory();const unit=inventory.sessions.find((item)=>item.id===first.name);assert.equal(unit.transport,'chat');assert.equal(unit.chatSessionId,first.chatSessionId);assert.equal(unit.providerSessionId,'native-thread');assert.equal(unit.telemetry.totalTokens,150);
    service.chats.close(desktop,handle); // No viewers remain; work must continue.
    const second=await service.chats.open(desktop,first.chatSessionId,'default');await service.chats.ready(desktop,second,0);
    await service.chats.submit(desktop,second,{protocolVersion:1,commandId:crypto.randomUUID(),operation:'send',sessionId:first.chatSessionId,payload:{text:'approval'}});
    page=await poll(async()=>{const value=await service.chats.history(desktop,second,0);return value.pendingRequests.length&&value;},'Approval missing over actual SSH');
    const pending=page.pendingRequests[0];await service.chats.submit(desktop,second,{protocolVersion:1,commandId:crypto.randomUUID(),operation:'respond',sessionId:first.chatSessionId,payload:{requestId:pending.requestId,turnId:pending.turnId,itemId:pending.itemId,decision:'allow'}});
    await poll(()=>fs.existsSync(path.join(home,'approved.txt')),'Approved fixture write not executed');
    await poll(async()=>{const value=await service.chats.history(desktop,second,0);return value.session.state==='idle';},'Approval turn did not finish');
    await service.chats.submit(desktop,second,{protocolVersion:1,commandId:crypto.randomUUID(),operation:'send',sessionId:first.chatSessionId,payload:{text:'dev-server'}});
    await poll(async()=>{const value=await service.chats.history(desktop,second,0);return value.session.state==='idle'&&value.events.some((event)=>event.type==='message.completed'&&event.data.text.includes(devUrl));},'Structured development URL not emitted');
    await service.chats.poll(service.chats.get(desktop,second).record);
    assert.equal(service.devUrls(unit.key)[0].url,devUrl);
    assert.throws(()=>service.openDevUrl({id:'unsubscribed'},unit.key,devUrl),/Open this connected chat/);
    const forwarded=await service.openDevUrl(desktop,unit.key,devUrl);
    assert.equal(await (await fetch(forwarded)).text(),'AgentC2 structured tunnel fixture');
    const isolated=await service.create({...launch,launchId:undefined,instructions:'',title:'Isolated worktree chat',worktree:{operationId:crypto.randomBytes(16).toString('hex'),repository:repo,baseRef:'HEAD',slug:'chat'}});
    assert.equal((await service.create({...launch,launchId:undefined,instructions:'',title:'Isolated worktree chat',worktree:{operationId:isolated.worktree.operationId,repository:repo,baseRef:'HEAD',slug:'chat'}})).name,isolated.name);
    const treeHandle=await service.chats.open(desktop,isolated.chatSessionId,'default');await service.chats.ready(desktop,treeHandle,0);
    await poll(async()=>(await service.chats.history(desktop,treeHandle,0)).session.state==='idle','Worktree chat not ready');
    // Exercise the actual Electron renderer against the same isolated SSH host.
    if(process.env.DISPLAY){
      const {_electron}=require('playwright-core');service.store.save('workspace',{tabs:[unit.key],selectedKey:unit.key,splitKey:null,metadata:{}});
      app=await _electron.launch({executablePath:require('electron'),args:['.',`--user-data-dir=${directory}/browser`],cwd:root,env:{...process.env,NODE_ENV:'production',AGENTC2_DATA_DIR:path.join(directory,'desktop')},timeout:60000});
      const rendered=await app.firstWindow(),errors=[];rendered.on('pageerror',(error)=>errors.push(error.message));
      await rendered.getByRole('textbox',{name:'Message to agent'}).waitFor({timeout:30000});
      await rendered.getByText('Fixture approved',{exact:true}).waitFor();assert.equal(await rendered.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[]);
      if(process.env.AGENTC2_QA_SCREENSHOT_DIR){fs.mkdirSync(process.env.AGENTC2_QA_SCREENSHOT_DIR,{recursive:true});await rendered.screenshot({path:path.join(process.env.AGENTC2_QA_SCREENSHOT_DIR,'electron-chat-ssh.png')});}
      await rendered.getByRole('textbox',{name:'Message to agent'}).fill('hold');
      await rendered.locator('.structured-chat').getByRole('button',{name:'Send',exact:true}).click();
      await poll(async()=>await rendered.getByRole('button',{name:'Interrupt',exact:true}).isEnabled(),'Desktop turn not interruptible');
      await rendered.getByRole('button',{name:'Interrupt',exact:true}).click();
      await rendered.getByText('Fixture interrupted',{exact:true}).waitFor();
      const listener=net.createServer();await new Promise((resolve)=>listener.listen(0,'127.0.0.1',resolve));const gatewayPort=listener.address().port;await new Promise((resolve)=>listener.close(resolve));
      const origin='https://agentc2-chat-qa.test.ts.net';
      await rendered.evaluate((config)=>window.agentHQ.saveRemote(config),{enabled:true,port:gatewayPort,url:origin,transport:'https'});
      const pair=await rendered.evaluate(()=>window.agentHQ.pairRemote());
      const {chromium}=require('playwright-core');
      browser=await chromium.launch({executablePath:process.env.AGENTC2_CHROMIUM||chromium.executablePath(),headless:true,args:['--no-sandbox']});
      const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      phoneProxy=await require('./fixtures/companion-proxy.cjs').companionProxy(context,origin,gatewayPort,errors);
      const phone=phoneProxy.page;await phone.goto(pair.url);await phone.getByRole('button',{name:'Pair this device',exact:true}).click();
      await phone.getByRole('textbox',{name:'Search sessions',exact:true}).fill(launch.title);
      await phone.locator('.phone-session-row').filter({hasText:launch.title}).click();
      await phone.getByText('Fixture interrupted',{exact:true}).waitFor();assert.equal(await phone.getByText('Fixture approved',{exact:true}).count(),1);
      await phone.getByRole('button',{name:'Take control',exact:true}).click();
      await poll(async()=>await rendered.getByRole('textbox',{name:'Message to agent'}).isDisabled(),'Phone takeover did not fence desktop input');
      await phone.getByRole('textbox',{name:'Message to agent'}).fill('question');
      await phone.locator('.structured-chat').getByRole('button',{name:'Send',exact:true}).click();
      await phone.getByLabel('Two',{exact:true}).check();await phone.getByRole('button',{name:'Send answers',exact:true}).click();
      await phone.getByText('Fixture answered',{exact:true}).waitFor();await rendered.getByText('Fixture answered',{exact:true}).waitFor();
      assert.match(fs.readFileSync(path.join(home,'answers.json'),'utf8'),/Two/);
      await phone.getByRole('textbox',{name:'Message to agent'}).fill('approval');
      await phone.locator('.structured-chat').getByRole('button',{name:'Send',exact:true}).click();
      await phone.getByRole('button',{name:'Deny',exact:true}).waitFor();
      const previousWrite=fs.statSync(path.join(home,'approved.txt')).mtimeMs;
      phoneProxy.disconnect();
      await poll(async()=>await phone.getByRole('button',{name:'Take control',exact:true}).count()===1&&await phone.getByRole('button',{name:'Take control',exact:true}).isEnabled(),'Phone reconnect did not restore chat');
      await phone.getByRole('button',{name:'Take control',exact:true}).click();
      await phone.getByRole('button',{name:'Deny',exact:true}).click();await phone.getByText('Fixture denied',{exact:true}).waitFor();
      assert.equal(fs.statSync(path.join(home,'approved.txt')).mtimeMs,previousWrite,'Denied action changed its witness');
      await rendered.getByRole('button',{name:'Take control',exact:true}).click();
      await poll(async()=>await phone.getByRole('textbox',{name:'Message to agent'}).isDisabled(),'Desktop reclaim did not fence phone input');
      assert.equal(await phone.getByText('Fixture answered',{exact:true}).count(),1,'Phone reconnect duplicated a final message');
      assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.AGENTC2_QA_SCREENSHOT_DIR)await phone.screenshot({path:path.join(process.env.AGENTC2_QA_SCREENSHOT_DIR,'companion-chat-ssh.png')});
      const devices=await rendered.evaluate(()=>window.agentHQ.remoteStatus());await rendered.evaluate((device)=>window.agentHQ.revokeRemote(device),devices.devices[0].id);
      await phone.getByText('This device was revoked. Pair again from desktop.').waitFor();
      await phoneProxy.close();phoneProxy=null;await browser.close();browser=null;
      await rendered.evaluate((config)=>window.agentHQ.saveRemote(config),{enabled:false,port:gatewayPort,url:origin,transport:'https'});
      assert.deepEqual(errors,[]);
      await app.close();app=null;
    }
    for(const [chatId,h] of [[first.chatSessionId,second],[isolated.chatSessionId,treeHandle]]){
      await service.chats.submit(desktop,h,{protocolVersion:1,commandId:crypto.randomUUID(),operation:'stop',sessionId:chatId,payload:{}});
      await poll(async()=>(await service.chats.history(desktop,h,0)).session.state==='stopped','Stop not recorded');
    }
    const retainedReceipt=await service.chats.receipt(desktop,second,first.receipt.commandId);
    const pruned=await service.chats.prune(desktop,second);assert.deepEqual(pruned.events,[]);assert.ok(pruned.retainedFrom>1);
    assert.equal((await service.chats.receipt(desktop,second,first.receipt.commandId)).state,retainedReceipt.state);
    assert.equal(pruned.session.providerSessionId,'native-thread');
    assert.throws(()=>execFileSync('/usr/bin/tmux',['-S',tmuxSocket,'has-session','-t',first.name],{stdio:'pipe'}));
    workerPid=(await service.chats.request('default','health')).pid;
    console.log('PASS real isolated SSH, private worker bootstrap, idempotent initial instructions, inventory/native IDs/usage, detach replay, exact approval, worktree retry, scoped stop, retained receipts after transcript pruning, structured-output SSH forwarding'+(process.env.DISPLAY?', and actual Electron/paired companion question, reconnect, denial, handoff, and revocation':''));
  }catch(error){
    if(phoneProxy){await phoneProxy.page.screenshot({path:path.join(os.tmpdir(),'agentc2-chat-phone-failure.png'),fullPage:true}).catch(()=>{});console.error('Phone fixture state:',await phoneProxy.page.locator('.phone-main').innerText().catch(()=>''));}
    throw error;
  }finally{
    await phoneProxy?.close().catch(()=>{});await browser?.close().catch(()=>{});await app?.close().catch(()=>{});service?.chats.closeAll();service?.terminals.closeAll();
    if(workerPid){try{process.kill(workerPid,'SIGTERM');}catch{}}
    try{execFileSync('/usr/bin/tmux',['-S',path.join(directory,'tmux.sock'),'kill-server'],{stdio:'ignore'});}catch{}
    service?.tunnels.closeAll();fixtureServer?.closeAllConnections();if(fixtureServer)await new Promise((resolve)=>fixtureServer.close(resolve));
    daemon?.kill();process.env.PATH=originalPath;fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch((error)=>{console.error(error);process.exitCode=1;});
