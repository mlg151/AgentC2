// Rebuild the adapter's pinned protocol subset using the exact supported CLI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const version = '0.163.0';
const binary = process.env.AGENTC2_CODEX_BINARY || 'codex';
const installed = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (installed !== `codex-cli ${version}`) throw new Error(`Expected Codex ${version}; found ${installed}`);
const names = [
  'v1/InitializeParams', 'v1/InitializeResponse', 'v2/GetAccountParams', 'v2/GetAccountResponse',
  'v2/ThreadStartParams', 'v2/ThreadResumeParams', 'v2/ThreadStartResponse', 'v2/ThreadResumeResponse',
  'v2/TurnStartParams', 'v2/TurnStartResponse', 'v2/TurnSteerParams', 'v2/TurnSteerResponse', 'v2/TurnInterruptParams', 'v2/TurnInterruptResponse',
  'v2/ThreadTurnsListParams', 'v2/ThreadTurnsListResponse',
  'v2/TurnStartedNotification', 'v2/TurnCompletedNotification',
  'v2/ItemStartedNotification', 'v2/ItemCompletedNotification', 'v2/AgentMessageDeltaNotification',
  'v2/ThreadTokenUsageUpdatedNotification',
  'CommandExecutionRequestApprovalParams', 'CommandExecutionRequestApprovalResponse',
  'FileChangeRequestApprovalParams', 'FileChangeRequestApprovalResponse',
  'ToolRequestUserInputParams', 'ToolRequestUserInputResponse',
];
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', '$schema', '$id'].includes(key)).map(([key, item]) => [key, strip(item)]));
}
function prune(schema) {
  const { definitions = {}, ...body } = strip(schema), retained = {};
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.replace('#/definitions/', '');
      if (!Object.hasOwn(retained, name)) { retained[name] = definitions[name]; if (!retained[name]) throw new Error(`Missing definition ${name}`); visit(retained[name]); }
    }
    for (const item of Object.values(value)) visit(item);
  }
  visit(body);
  return Object.keys(retained).length ? { ...body, definitions: retained } : body;
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-codex-schema-'));
try {
  execFileSync(binary, ['app-server', 'generate-json-schema', '--out', directory], { stdio: 'inherit' });
  const schemas = Object.fromEntries(names.map((name) => [name, prune(JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8')))]));
  const target = path.join(__dirname, '..', 'electron', 'chat-codex-schema.json');
  fs.writeFileSync(target, JSON.stringify({ version, source: 'codex app-server generate-json-schema', schemas }) + '\n');
  console.log(`Generated ${names.length} protocol schemas for Codex ${version}`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
