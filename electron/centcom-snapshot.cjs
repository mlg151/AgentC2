// Must match centcom_sync's per-file UTF-8 limit in remote.py.
const SITUATION_MAX_BYTES = 1_000_000;

function boundSituationSnapshot(snapshot) {
  const encodedSize = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (encodedSize(snapshot) <= SITUATION_MAX_BYTES) return snapshot;

  const reduced = structuredClone(snapshot);
  const collections = ['units', 'theaters', 'specops', 'exercises', 'faults', 'defconReasons', 'attention', 'flash'];
  reduced.truncation = {
    reason: 'Snapshot exceeds the CENTCOM workspace byte limit; omitted evidence is unavailable in this snapshot.',
    totals: Object.fromEntries(collections.map((key) => [key, snapshot[key].length])),
    omitted: Object.fromEntries(collections.map((key) => [key, 0])),
    outputTailsOmitted: 0,
  };
  // Preserve fleet identities and state before spending space on terminal text.
  for (const unit of reduced.units) {
    if (unit.outputTail) {
      unit.outputTail = '';
      reduced.truncation.outputTailsOmitted++;
    }
  }
  if (encodedSize(reduced) <= SITUATION_MAX_BYTES) return reduced;

  const faultKeys = new Set(reduced.faults.map((fault) => fault.sessionKey));
  const urgent = (unit) => ['live', 'waiting', 'waiting_for_input', 'blocked', 'requires_action'].includes(unit.state) || faultKeys.has(unit.key);
  reduced.units.sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
  reduced.specops.sort((a, b) => Number(['running', 'halted'].includes(b.state)) - Number(['running', 'halted'].includes(a.state)));
  // Reduce the largest collection in batches so large histories stay cheap to
  // serialize. Counts make a partial snapshot explicit to the commander.
  while (encodedSize(reduced) > SITUATION_MAX_BYTES) {
    const largest = collections.filter((key) => reduced[key].length)
      .sort((a, b) => encodedSize(reduced[b]) - encodedSize(reduced[a]))[0];
    const keep = Math.floor(reduced[largest].length / 2);
    reduced[largest] = reduced[largest].slice(0, keep);
    reduced.truncation.omitted[largest] = reduced.truncation.totals[largest] - keep;
  }
  return reduced;
}

module.exports = { boundSituationSnapshot };
