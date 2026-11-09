// Isolate helper/worker state while loading the production Electron entry point.
// Path conversion still invokes the actual default distribution's wslpath.
const local = require('../../electron/local.cjs');
const original = local.localCommand;
const home = process.env.AGENTC2_TEST_HOME;
if (!/^\/tmp\/agentc2-windows-local-[a-zA-Z0-9]+$/.test(home || '')) throw Error('Invalid WSL fixture HOME');
local.localCommand = (command, args, ...options) => original('env', [`HOME=${home}`, command, ...args], ...options);
require('../../electron/main.cjs');
