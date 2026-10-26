function check(needs) {
  const required = ['desktop', 'linux-ssh', 'linux-cleanup', 'coverage'];
  for (const name of required) {
    if (needs[name]?.result !== 'success') throw Error(`${name}: ${needs[name]?.result || 'missing'} (success required)`);
  }
  for (const [name, job] of Object.entries(needs)) if (job.result !== 'success') throw Error(`${name}: ${job.result}`);
}
module.exports = { check };
if (require.main === module) {
  try { check(JSON.parse(process.env.QUALITY_GATE_NEEDS)); console.log('All required jobs succeeded'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
