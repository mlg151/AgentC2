const assert = require('node:assert/strict');
const { assertWindowSender } = require('../electron/window-sender.cjs');
const window = () => ({ webContents: { mainFrame: {} }, isDestroyed: () => false });
const main = window(), secondary = window(), unrelated = window();
const event = (target) => ({ sender: target.webContents, senderFrame: target.webContents.mainFrame });
assert.doesNotThrow(() => assertWindowSender(event(main), [main]));
assert.doesNotThrow(() => assertWindowSender(event(secondary), [main, secondary]));
for (const input of [event(secondary), event(unrelated), { ...event(main), senderFrame: {} }, { ...event(secondary), sender: main.webContents }]) {
  assert.throws(() => assertWindowSender(input, [main]), /Untrusted window/);
}
for (const target of [main, secondary]) {
  assert.throws(() => assertWindowSender({ ...event(target), senderFrame: {} }, [main, secondary]), /Untrusted window/);
}
secondary.isDestroyed = () => true;
assert.throws(() => assertWindowSender(event(secondary), [null, secondary]), /Untrusted window/);
assert.throws(() => assertWindowSender(event(main), []), /Untrusted window/);
console.log('PASS exact main-frame sender identity, secondary-window allowlist, foreign windows, subframes, destroyed windows, and missing windows');
