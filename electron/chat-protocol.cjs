const contract = require('./chat-protocol.json');

const COMMAND_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION_ID = /^chat-[a-f0-9]{32}$/;
const OUTCOMES = ['completed', 'failed', 'interrupted', 'denied', 'unknown'];

function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid chat object fields');
  return value;
}

function text(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) throw new Error('Invalid chat text');
  return value;
}

function choice(value, values) {
  if (!values.includes(value)) throw new Error('Invalid chat value');
  return value;
}

function modelId(value) { text(value, 200); if (/[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid model ID'); return value; }
function identifier(value) { return text(value, contract.limits.id); }
function optionalId(value) { return value === null ? null : identifier(value); }
function wireSize(input) {
  const json = JSON.stringify(input, (_key, value) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid JSON chat value');
    return value;
  });
  if (Buffer.byteLength(json) > contract.limits.wireBytes) throw new Error('Chat message is too large');
}
function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid chat session ID');
  return value;
}

function validateCommand(input) {
  object(input, ['protocolVersion', 'commandId', 'operation', 'sessionId', 'payload'], ['protocolVersion', 'commandId', 'operation', 'payload']);
  if (input.protocolVersion !== contract.version) throw new Error('Unsupported chat protocol version');
  if (typeof input.commandId !== 'string' || !COMMAND_ID.test(input.commandId)) throw new Error('Invalid chat command ID');
  choice(input.operation, contract.operations);
  const payload = input.payload;
  if (input.operation === 'create') {
    if (Object.hasOwn(input, 'sessionId')) throw new Error('Create does not accept a session ID');
    object(payload, ['provider', 'cwd', 'title', 'roeProfile', 'providerSessionId', 'managedName', 'instructions', 'model'], ['provider', 'cwd', 'title', 'roeProfile']);
    if (Object.hasOwn(payload, 'managedName') && (typeof payload.managedName !== 'string' || !/^hq-[a-f0-9]{12}$/.test(payload.managedName))) throw new Error('Invalid managed chat name');
    if (Object.hasOwn(payload, 'instructions')) text(payload.instructions, 20000, true);
    if (Object.hasOwn(payload, 'model')) modelId(payload.model);
    choice(payload.provider, contract.providers);
    if (!text(payload.cwd, contract.limits.path).startsWith('/')) throw new Error('Chat working directory must be absolute');
    text(payload.title, contract.limits.title, true);
    choice(payload.roeProfile, ['full', 'gated', 'provider-default']);
    if (Object.hasOwn(payload, 'providerSessionId')) identifier(payload.providerSessionId);
  } else {
    sessionId(input.sessionId);
    if (['send', 'steer'].includes(input.operation)) {
      object(payload, input.operation === 'steer' ? ['text', 'expectedTurnId'] : ['text']);
      text(payload.text, contract.limits.text);
      if (input.operation === 'steer') identifier(payload.expectedTurnId);
    } else if (input.operation === 'model') {
      object(payload, ['model']); modelId(payload.model);
    } else if (input.operation === 'respond') {
      object(payload, ['requestId', 'turnId', 'itemId', 'decision', 'answers'], ['requestId', 'turnId', 'itemId']);
      identifier(payload.requestId); optionalId(payload.turnId); optionalId(payload.itemId);
      if (Object.hasOwn(payload, 'decision') === Object.hasOwn(payload, 'answers')) throw new Error('Supply a decision or question answers');
      if (Object.hasOwn(payload, 'decision')) choice(payload.decision, ['allow', 'deny']);
      if (Object.hasOwn(payload, 'answers')) {
        if (!Array.isArray(payload.answers) || !payload.answers.length || payload.answers.length > 20) throw new Error('Invalid chat answers');
        for (const answer of payload.answers) { object(answer, ['questionId', 'answers']); identifier(answer.questionId); if (!Array.isArray(answer.answers) || answer.answers.length > 20) throw new Error('Invalid chat answers'); for (const value of answer.answers) text(value, 10000, true); }
      }
    } else object(payload, []);
  }
  wireSize(input);
  return structuredClone(input);
}

function validateCapabilities(input) {
  object(input, ['provider', 'version', 'status', 'reason', ...contract.capabilities]);
  choice(input.provider, contract.providers);
  optionalId(input.version);
  choice(input.status, ['supported', 'unsupported', 'unverified']);
  if (input.reason !== null) text(input.reason, 2000);
  for (const name of contract.capabilities) if (typeof input[name] !== 'boolean') throw new Error('Invalid chat capability');
  if (input.status !== 'supported' && contract.capabilities.some((name) => input[name])) throw new Error('Unsupported provider cannot advertise actions');
  return structuredClone(input);
}

function unavailableCapabilities(provider, version = null, reason = 'Provider integration has not been verified') {
  return validateCapabilities({ provider, version, status: 'unverified', reason, ...Object.fromEntries(contract.capabilities.map((name) => [name, false])) });
}

function validateEvent(input) {
  object(input, ['protocolVersion', 'sessionId', 'sequence', 'timestamp', 'provider', 'providerSessionId', 'turnId', 'itemId', 'type', 'data']);
  if (input.protocolVersion !== contract.version) throw new Error('Unsupported chat protocol version');
  sessionId(input.sessionId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('Invalid chat sequence');
  if (typeof input.timestamp !== 'string' || !Number.isFinite(Date.parse(input.timestamp)) || new Date(input.timestamp).toISOString() !== input.timestamp) throw new Error('Invalid chat timestamp');
  choice(input.provider, contract.providers);
  optionalId(input.providerSessionId); optionalId(input.turnId); optionalId(input.itemId);
  choice(input.type, contract.eventTypes);
  const data = input.data;
  switch (input.type) {
    case 'session.updated': object(data, ['state', 'detail']); choice(data.state, contract.sessionStates); text(data.detail, 2000, true); break;
    case 'message.delta': object(data, ['text']); text(data.text, contract.limits.text, true); break;
    case 'message.completed': object(data, ['role', 'text']); choice(data.role, ['user', 'assistant']); text(data.text, contract.limits.text, true); break;
    case 'tool.started': object(data, ['name', 'input']); identifier(data.name); text(data.input, contract.limits.text, true); break;
    case 'tool.completed': object(data, ['name', 'output', 'isError']); identifier(data.name); text(data.output, contract.limits.text, true); if (typeof data.isError !== 'boolean') throw new Error('Invalid tool result'); break;
    case 'approval.requested': object(data, ['requestId', 'action', 'detail']); identifier(data.requestId); text(data.action, 2000); text(data.detail, contract.limits.text, true); break;
    case 'question.requested':
      object(data, ['requestId', 'questions']); identifier(data.requestId);
      if (!Array.isArray(data.questions) || !data.questions.length || data.questions.length > 20) throw new Error('Invalid questions');
      for (const question of data.questions) { object(question, ['id', 'question', 'options', 'multiple']); identifier(question.id); text(question.question, 10000); if (!Array.isArray(question.options) || question.options.length > 100 || typeof question.multiple !== 'boolean') throw new Error('Invalid question options'); for (const option of question.options) text(option, 10000); }
      break;
    case 'request.resolved': object(data, ['requestId', 'state', 'decision']); identifier(data.requestId); choice(data.state, ['resolved', 'expired']); if (data.decision !== null) choice(data.decision, ['allow', 'deny', 'answered']); break;
    case 'usage.updated':
      object(data, ['inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'contextUsedTokens', 'contextCapacityTokens']);
      for (const value of Object.values(data)) if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid usage metric');
      break;
    case 'turn.completed': object(data, ['outcome', 'detail']); choice(data.outcome, OUTCOMES); text(data.detail, 2000, true); break;
    case 'error': object(data, ['code', 'message', 'retryable']); identifier(data.code); text(data.message, 2000); if (typeof data.retryable !== 'boolean') throw new Error('Invalid error state'); break;
    case 'provider.event': object(data, ['method', 'payload']); identifier(data.method); if (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) throw new Error('Invalid provider payload'); break;
  }
  wireSize(input);
  return structuredClone(input);
}

module.exports = { contract, validateCommand, validateEvent, validateCapabilities, unavailableCapabilities, sessionId };
