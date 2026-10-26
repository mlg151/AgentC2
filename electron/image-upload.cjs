const { spawn } = require('node:child_process');
const { localCommand } = require('./local.cjs');

const PNG_LIMIT = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REMOTE_UPLOAD = require('node:fs').readFileSync(require('node:path').join(__dirname, 'image-upload.py'), 'utf8').replaceAll('\r\n', '\n');

function validatePng(png) {
  if (!Buffer.isBuffer(png) || png.length < 45 || png.length > PNG_LIMIT || !png.subarray(0, 8).equals(PNG_SIGNATURE) || !png.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw new Error('Clipboard PNG is missing, invalid, or larger than 8 MB');
}

function uploadPng({ binary, args, target, local = false, png, spawnProcess = spawn }) {
  validatePng(png);
  const code = Buffer.from(REMOTE_UPLOAD, 'utf8').toString('base64');
  // The filename carries a digest computed from the bytes actually executed.
  // Test tracing can attribute this ephemeral helper without writing it remotely.
  const program = `import base64, hashlib; source = base64.b64decode("${code}"); exec(compile(source, "agentc2-image-upload-" + hashlib.sha256(source).hexdigest() + ".py", "exec"))`;
  const invocation = `'${program}'`;
  return new Promise((resolve, reject) => {
    const execution = local ? localCommand('python3', ['-c', program]) : { binary, args: [...args, target, 'python3', '-c', invocation], env: process.env };
    const child = spawnProcess(execution.binary, execution.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: execution.env });
    let output = '', errors = '', settled = false;
    const timeout = setTimeout(() => { child.kill(); finish(new Error('Image upload timed out')); }, 60000);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 4096) child.kill(); });
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); if (errors.length > 4096) child.kill(); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(errors.trim().slice(0, 500) || 'Image upload failed'));
      try {
        const value = JSON.parse(output.trim());
        if (!value || typeof value.path !== 'string' || value.bytes !== png.length || !/\/\.cache\/agent-hq\/uploads\/agentc2-[a-f0-9]{32}\.png$/.test(value.path)) throw new Error('Invalid remote upload result');
        finish(null, value.path);
      } catch (error) { finish(error); }
    });
    child.stdin.end(png);
  });
}

module.exports = { PNG_LIMIT, validatePng, uploadPng };
