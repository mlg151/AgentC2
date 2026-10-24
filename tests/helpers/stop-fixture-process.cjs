const fs = require('node:fs');

// Linux fixtures can own detached workers that are not Node ChildProcesses.
async function stopFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid fixture PID');
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // A detached worker may await reaping after it has closed all files.
      if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) return;
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture process ${pid} did not finish shutdown`);
}

module.exports = { stopFixtureProcess };
