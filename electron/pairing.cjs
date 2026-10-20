const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A local-only invitation file lets an owner generate a link without the GUI.
// Only its hash is stored; consuming it is synchronous and single-use.
class Pairing {
  constructor(directory) { this.file = path.join(directory, 'companion-invitation.json'); }
  clear() { fs.rmSync(this.file, { force: true }); }
  issue(origin) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 15 * 60_000;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ origin, secretHash: this.hash(token), expiresAt }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return { url: `${origin}/companion.html#pair=${token}`, expiresAt };
  }
  hash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
  consume(token, origin) {
    let invitation;
    try { invitation = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return false; }
    if (typeof token !== 'string' || token.length > 200 || invitation.origin !== origin || invitation.expiresAt <= Date.now() || invitation.secretHash !== this.hash(token)) return false;
    this.clear();
    return true;
  }
}

module.exports = { Pairing };
