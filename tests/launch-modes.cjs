// Check the argv of real CLI processes without submitting any agent prompts.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const helper = Buffer.from(fs.readFileSync(path.join(__dirname, '..', 'electron', 'provider_telemetry.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'electron', 'remote.py'), 'utf8')).toString('base64');
const hook = fs.readFileSync(path.join(__dirname, '..', 'electron', 'session-hook.py')).toString('base64');
const providerBinDir = process.env.AGENTC2_PROVIDER_BIN_DIR || '';
const source = `
import base64,json,os,subprocess,time
from pathlib import Path
if ${JSON.stringify(providerBinDir)}: os.environ['PATH'] = ${JSON.stringify(providerBinDir)} + os.pathsep + os.environ.get('PATH', '')
scope={'__name__':'agent_hq_launch_test'}
exec(base64.b64decode('${helper}'),scope)
results=[]
def process_args(pid):
 seen=set(); pending=[int(pid)]; result=[]
 while pending:
  current=pending.pop()
  if current in seen: continue
  seen.add(current)
  try:
   result.append((Path('/proc')/str(current)/'cmdline').read_bytes().split(b'\\0'))
   children=(Path('/proc')/str(current)/'task'/str(current)/'children').read_text().split()
   pending.extend(int(child) for child in children)
  except (OSError,ValueError): pass
 return result
name=None
try:
 for field,value in [('instructions','echo forbidden'),('conversationId','00000000-0000-4000-8000-000000000000'),('preset',{'command':'echo'})]:
  try:
   scope['create']({'provider':'terminal',field:value})
   raise AssertionError('Terminal accepted agent launch options')
  except ValueError: pass
 name=scope['create']({'provider':'terminal','cwd':'/tmp','title':'AgentC2 shell launch test'})['name']
 time.sleep(1)
 shell=next(s for s in scope['tmux_sessions']() if s['id']==name)
 assert shell['provider']=='terminal' and shell['managed'] and shell['state']=='live'
 assert shell['canAttach'] and shell['canStop'] and shell['canInterrupt']
 assert scope['checked'](['tmux','display-message','-p','-t',name,'#{history_limit}|#{session_windows}'])=='50000|1'
 assert not (scope['HOOK_ROOT']/name).exists()
 scope['checked'](['tmux','send-keys','-t',name,'exit 7','Enter'])
 for attempt in range(20):
  shell=next(s for s in scope['tmux_sessions']() if s['id']==name)
  if shell['state']=='exited': break
  time.sleep(.1)
 assert shell['exitCode']==7 and shell['canStop'] and not shell['canInterrupt']
 results.append({'provider':'terminal','historyLimit':50000,'exitCode':7,'agentOptionsRejected':True})
finally:
 if name: scope['managed_action']({'name':name},'stop')
for provider,executable in [('codex','codex'),('claude','claude'),('antigravity','agy'),('claude','claude3')]:
 name=None
 try:
  payload={'provider':provider,'cwd':'/tmp','title':'AgentC2 launch permissions test','hookSource':base64.b64decode('${hook}').decode()}
  if executable=='claude3': payload['preset']={'command':'claude3','args':'','name':'OpenRouter test','fullPermissions':True,'attentionHooks':True}
  name=scope['create'](payload)['name']
  time.sleep(2)
  pid=scope['checked'](['tmux','display-message','-p','-t',name,'#{pane_pid}'])
  flag=scope['PERMISSION_FLAGS'][provider]
  assert any(flag.encode() in args for args in process_args(pid)), provider+' did not receive full-permissions flag'
  assert scope['checked'](['tmux','display-message','-p','-t',name,'#{history_limit}|#{session_windows}']) == '50000|1'
  if provider in ['codex','claude']:
   hook_path=scope['HOOK_ROOT']/name/'hook.py'
   assert hook_path.is_file()
   argv=process_args(pid)
   expected=b'notify=' if provider=='codex' else b'--settings'
   assert any(any(arg.startswith(expected) for arg in args) for args in argv), provider+' hook configuration missing from CLI argv'
   if provider=='codex':
    subprocess.run(['python3',str(hook_path),provider,'notify','PROFILE=',json.dumps({'type':'agent-turn-complete','turn-id':'test-turn'})],check=True)
   else:
    subprocess.run(['python3',str(hook_path),provider,'hook'],input=json.dumps({'hook_event_name':'PermissionRequest'}),text=True,check=True)
    subprocess.run(['python3',str(hook_path),provider,'hook'],input=json.dumps({'hook_event_name':'Stop'}),text=True,check=True)
   events=scope['session_events'](name)
   assert events[-1]['kind']=='completed'
   if provider=='claude': assert events[-2]['kind']=='input'
  resume=scope['agent_command'](provider,'00000000-0000-4000-8000-000000000000')
  assert flag in resume and '00000000-0000-4000-8000-000000000000' in resume
  results.append({'provider':provider,'command':executable,'fullPermissions':True,'historyLimit':50000,'resumeUsesFullPermissions':True,'hookEventsVerified':provider in ['codex','claude']})
 finally:
  if name: scope['managed_action']({'name':name},'stop')
for provider in ['codex','claude']:
 name=None
 try:
  payload={'provider':provider,'cwd':'/tmp','title':'AgentC2 gated launch test','roeProfile':'gated','hookSource':base64.b64decode('${hook}').decode()}
  name=scope['create'](payload)['name']
  time.sleep(2)
  pid=scope['checked'](['tmux','display-message','-p','-t',name,'#{pane_pid}'])
  argv=process_args(pid)
  flat=[arg for process in argv for arg in process]
  assert scope['PERMISSION_FLAGS'][provider].encode() not in flat
  if provider=='codex':
   assert b'--sandbox' in flat and b'read-only' in flat and b'--ask-for-approval' in flat and b'on-request' in flat
  else:
   assert b'--permission-mode' in flat and b'default' in flat
   assert any(b'"ask"' in arg and b'Bash' in arg and b'Edit' in arg for arg in flat)
  assert scope['tmux_option'](name,'@hq_roe')=='gated'
  results.append({'provider':provider,'gatedLaunchFlags':True,'sessionMetadata':True})
 finally:
  if name: scope['managed_action']({'name':name},'stop')
print(json.dumps(results))
`;
const ssh = require('../electron/platform.cjs').sshBinary();
const host = process.env.AGENTC2_HOST || process.env.AGENT_HQ_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an explicitly configured SSH test host');
const child = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-'], { windowsHide: true });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code; });
child.stdin.end(source);
