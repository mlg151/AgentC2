const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer.cjs');
const { enableTerminalTouchScroll } = loadRenderer('terminalTouch.ts');
class Surface extends EventTarget {
  clientHeight = 200;
  listeners = new Map();
  addEventListener(name, listener, options) { this.listeners.set(name, listener); super.addEventListener(name, listener, options); }
  removeEventListener(name, listener, options) { this.listeners.delete(name); super.removeEventListener(name, listener, options); }
}
const node = new Surface(), scrolled = [];
let screen = { clientHeight: 200 };
const terminal = { rows: 20, element: { querySelector: (selector) => { assert.equal(selector, '.xterm-screen'); return screen; } }, scrollLines: (lines) => scrolled.push(lines) };
const dispose = enableTerminalTouchScroll(terminal, node);
function event(name, points = []) {
  const value = new Event(name, { cancelable: true });
  Object.defineProperty(value, 'touches', { value: points.map(([x, y, identifier = 1]) => ({ clientX: x, clientY: y, identifier })) });
  node.dispatchEvent(value); return value.defaultPrevented;
}
assert.equal(node.listeners.size, 4);
assert.equal(event('touchmove', [[0, 30]]), false);
event('touchstart'); assert.equal(event('touchmove', [[0, 30]]), false);
event('touchstart', [[0, 0], [20, 20, 2]]); assert.equal(event('touchmove', [[0, 30]]), false);
event('touchstart', [[0, 0]]); assert.equal(event('touchmove', [[0, 30, 2]]), false);
assert.equal(event('touchmove', [[1, 4]]), false);
assert.equal(event('touchmove', [[0, 9]]), true); assert.deepEqual(scrolled, []);
assert.equal(event('touchmove', [[0, 11]]), true); assert.deepEqual(scrolled, [-1]);
event('touchmove', [[0, 31]]); assert.deepEqual(scrolled, [-1, -2]);
event('touchmove', [[0, 1]]); assert.deepEqual(scrolled, [-1, -2, 2]);
event('touchend'); assert.equal(event('touchmove', [[0, 40]]), false);
event('touchstart', [[0, 0]]); assert.equal(event('touchmove', [[20, 2]]), false); assert.equal(event('touchmove', [[20, 40]]), false);
event('touchstart', [[0, 0]]); event('touchmove', [[0, 20], [20, 20, 2]]); assert.equal(event('touchmove', [[0, 40]]), false);
event('touchstart', [[0, 0]]); event('touchcancel'); assert.equal(event('touchmove', [[0, 20]]), false);
for (const current of [{ clientHeight: 0 }, null]) { screen = current; event('touchstart', [[0, 0]]); event('touchmove', [[0, 20]]); assert.equal(scrolled.at(-1), -2); }
terminal.element = undefined; event('touchstart', [[0, 0]]); event('touchmove', [[0, 30]]); assert.equal(scrolled.at(-1), -3);
node.clientHeight = 0; const count = scrolled.length; event('touchstart', [[0, 0]]); assert.equal(event('touchmove', [[0, 30]]), true); assert.equal(scrolled.length, count);
dispose(); assert.equal(node.listeners.size, 0); event('touchstart', [[0, 0]]); event('touchmove', [[0, 90]]); assert.equal(scrolled.length, count);
console.log('PASS local terminal touch direction, sub-row accumulation, vertical intent, horizontal and pinch passthrough, identifier isolation, zero-size fallback, cancellation, and listener disposal');
