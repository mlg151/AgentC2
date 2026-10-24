const crypto = require('node:crypto');
const ENVELOPE_VERSION = 1;

const LIMITS = Object.freeze({ queries: 5, directives: 20, automations: 10, queryHops: 3, resultBytes: 64000, pageSize: 50, envelopeBytes: 256000, coordinationRecords: 100, coordinationPlanBytes: 24000, coordinationEvidence: 50, coordinationRecordBytes: 64000 });
const AUTOMATION_KINDS = ['specops_workflow', 'oporder', 'preset', 'centcom_trigger'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fingerprint = (v) => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  return object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
}

// Evidence can contain pasted credentials. Never persist them in the outcome journal.
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, /password|secret|token|credential|privatekey|authorization/i.test(k) && !/tokens|tokenCount/i.test(k) ? '[REDACTED]' : redact(value)]));
  if (typeof v !== 'string') return v;
  return v.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\b(Bearer\s+|(?:password|api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function bounded(value, maxBytes = LIMITS.resultBytes) {
  const safe = redact(value);
  const json = JSON.stringify(safe) ?? 'null';
  if (Buffer.byteLength(json) <= maxBytes) return safe;
  return { truncated: true, originalBytes: Buffer.byteLength(json), reason: 'Result byte limit exceeded; narrow filters or read a smaller page.', preview: Buffer.from(json).subarray(0, Math.floor(maxBytes / 2)).toString('utf8') };
}

function parseCentcomEnvelope(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const blocks = [...rawText.matchAll(/```agentc2-c2\r?\n([\s\S]*?)\r?\n```/g)];
  if (!blocks.length) return rawText.includes('```agentc2-c2') ? { error: 'Unterminated agentc2-c2 block' } : null;
  if (blocks.length !== 1) return { error: 'Exactly one agentc2-c2 block is allowed' };
  if (Buffer.byteLength(blocks[0][1]) > LIMITS.envelopeBytes) return { error: 'Envelope byte limit exceeded' };
  let parsed;
  try { parsed = JSON.parse(blocks[0][1]); } catch { return { error: 'Malformed JSON in agentc2-c2 block' }; }
  if (!object(parsed) || parsed.version !== ENVELOPE_VERSION) return { error: `Envelope requires version: ${ENVELOPE_VERSION}` };
  const diagnostics = [];
  const result = { version: ENVELOPE_VERSION, rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 2000) : '', diagnostics };
  if (typeof parsed.rationale === 'string' && parsed.rationale.length > 2000) diagnostics.push({ code: 'truncated', field: 'rationale', originalLength: parsed.rationale.length, limit: 2000 });
  for (const k of Object.keys(parsed)) if (!['version', 'rationale', 'queries', 'directives', 'automations'].includes(k)) diagnostics.push({ code: 'invalid_field', field: k, message: 'Unknown envelope field' });
  for (const collection of ['queries', 'directives', 'automations']) {
    result[collection] = [];
    if (parsed[collection] === undefined) continue;
    if (!Array.isArray(parsed[collection])) {
      diagnostics.push({ code: 'invalid_collection', collection, message: 'Expected an array' });
      continue;
    }
    parsed[collection].forEach((request, index) => {
      const diagnostic = { collection, index, clientRequestId: typeof request?.id === 'string' ? request.id : null };
      if (index >= LIMITS[collection]) {
        diagnostics.push({ ...diagnostic, code: 'over_limit', message: `${collection} limit is ${LIMITS[collection]}` });
        return;
      }
      if (!object(request) || typeof (request.kind || request.type) !== 'string' ||
          (request.kind !== undefined && request.type !== undefined && request.kind !== request.type) ||
          (request.id !== undefined && (typeof request.id !== 'string' || !request.id || request.id.includes('\0') || request.id.length > 200)) ||
          (request.params !== undefined && !object(request.params)) ||
          (request.preconditions !== undefined && !object(request.preconditions))) {
        diagnostics.push({ ...diagnostic, code: 'invalid_request', message: 'Expected kind, optional string id, and object params/preconditions' });
        return;
      }
      const fields = collection === 'automations' ? ['id', 'kind', 'title', 'rationale', 'evidence', 'payload'] : ['id', 'kind', 'type', 'params', 'summary', 'rationale', 'preconditions'];
      const invalidField = Object.keys(request).find((key) => !fields.includes(key));
      const invalidText = ['title', 'summary', 'rationale'].find((key) => request[key] !== undefined && (typeof request[key] !== 'string' || request[key].length > (key === 'rationale' ? 2000 : 150)));
      if (invalidField || invalidText) {
        diagnostics.push({ ...diagnostic, code: 'invalid_request', message: `Invalid request field: ${invalidField || invalidText}` });
        return;
      }
      if (request.evidence !== undefined && (!Array.isArray(request.evidence) || request.evidence.length > 10 || request.evidence.some((item) => typeof item !== 'string' || item.length > 2000))) {
        diagnostics.push({ ...diagnostic, code: 'invalid_request', message: 'Evidence must contain at most ten strings, each at most 2000 characters' });
        return;
      }
      result[collection].push(request);
    });
  }
  return result;
}

module.exports = { ENVELOPE_VERSION, LIMITS, AUTOMATION_KINDS, object, fingerprint, redact, bounded, parseCentcomEnvelope };
