const { spawn } = require('node:child_process');

// tmux control mode accepts commands over stdin without involving Windows'
// console mouse translation. ignore-size keeps this client from resizing chats.
class TmuxControl {
  constructor(ssh, sshArgs, host, name, env = process.env) {
    this.pending = [];
    this.active = null;
    this.output = '';
    this.error = '';
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The owner may only use the control connection on its first scroll.
    this.ready.catch(() => {});
    this.startTimeout = setTimeout(() => this.fail(new Error('tmux control connection timed out')), 15000);
    this.child = spawn(ssh, [...sshArgs, ...(host ? [host, 'tmux'] : []), '-C', 'attach-session', '-f', 'no-output,ignore-size', '-t', name], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    this.child.stdout.on('data', (chunk) => {
      this.output += chunk.toString();
      let newline;
      while ((newline = this.output.indexOf('\n')) !== -1) {
        const line = this.output.slice(0, newline).replace(/\r$/, '');
        this.output = this.output.slice(newline + 1);
        this.line(line);
      }
    });
    this.child.stderr.on('data', (chunk) => { this.error = (this.error + chunk).slice(-4000); });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', () => this.fail(new Error(this.error.trim() || 'tmux control connection closed')));
    this.child.stdin.on('error', (error) => this.fail(error));
  }

  line(line) {
    if (line.startsWith('%begin ')) {
      this.active = this.pending.shift() || null;
    } else if (line.startsWith('%end ') || line.startsWith('%error ')) {
      if (this.resolveReady) {
        if (line.startsWith('%error ')) { this.fail(new Error('Could not attach tmux control client')); return; }
        clearTimeout(this.startTimeout);
        const resolve = this.resolveReady;
        this.resolveReady = null;
        resolve();
      } else if (this.active) {
        clearTimeout(this.active.timeout);
        if (line.startsWith('%error ')) this.active.reject(new Error(this.active.lines.join('\n') || 'tmux history command failed'));
        else this.active.resolve(this.active.lines.join('\n'));
        this.active = null;
      }
    } else if (line.startsWith('%exit')) {
      this.fail(new Error('tmux control connection ended'));
    } else if (this.active && !line.startsWith('%')) {
      this.active.lines.push(line);
    }
  }

  async command(text) {
    await this.ready;
    if (this.closed) throw new Error('tmux control connection is closed');
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, lines: [], timeout: null };
      request.timeout = setTimeout(() => this.fail(new Error('tmux history command timed out')), 10000);
      this.pending.push(request);
      this.child.stdin.write(text + '\n');
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimeout);
    this.rejectReady(error);
    for (const request of [this.active, ...this.pending]) {
      if (request) { clearTimeout(request.timeout); request.reject(error); }
    }
    this.pending = [];
    this.active = null;
    this.child?.kill();
  }

  close() { this.fail(new Error('Terminal detached')); }
}

module.exports = { TmuxControl };
