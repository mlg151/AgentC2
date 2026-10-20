// Run locally (or in your own remote shell) to get a one-use phone pairing link.
// The gateway accepts only a matching, unexpired invitation hash on disk.
const fs = require('node:fs');
const path = require('node:path');
const { Pairing } = require('../electron/pairing.cjs');
const candidates = ['agentc2', 'AgentC2', 'agent-hq', 'Agent HQ'].map((name) => path.join(process.env.APPDATA, name));
const directory = process.env.AGENTC2_DATA_DIR || process.env.AGENT_HQ_DATA_DIR || candidates.find((candidate) => fs.existsSync(path.join(candidate, 'workspace.json'))) || candidates[0];
const config = JSON.parse(fs.readFileSync(path.join(directory, 'remote-access.json'), 'utf8'));
if (!config.enabled || !config.url) throw new Error('Enable remote access first');
const invitation = new Pairing(directory).issue(config.url);
console.log(JSON.stringify(invitation));
