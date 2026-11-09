const path = require('node:path');
const { compileTypeScript } = require('./ts-coverage.cjs');

// Isolate component orchestration contracts from already-tested workflow dialogs.
// The browser suite separately exercises the real React DOM, effects, and dialogs.
function phoneComponent(filename, properties, environment = {}) {
  const refs = [], states = [], effects = [], intervals = new Map(), components = new Map();
  let refIndex, stateIndex, effectIndex, pending, dirty, tree, props = properties, intervalId = 0;
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { const value = typeof next === 'function' ? next(states[index]) : next; dirty ||= !Object.is(states[index], value); states[index] = value; }];
    },
    useRef(initial) { const index = refIndex++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
    useMemo: (fn) => fn(),
    lazy: () => function Lazy() {},
    Suspense: function Suspense() {},
    useCallback: (fn) => fn,
    useEffect(fn, deps) {
      const index = effectIndex++, previous = effects[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(previous.deps[i], value))) {
        effects[index] = { deps, cleanup: previous?.cleanup };
        pending.push(() => { previous?.cleanup?.(); effects[index].cleanup = fn(); });
      }
    },
  };
  function loader(module) {
    if (environment.modules?.[module]) return environment.modules[module];
    if (module === 'react') return react;
    if (module === 'react/jsx-runtime') return require(module);
    if (module === '../workspace') return { situationFor: () => ({ callsigns: {} }) };
    if (!components.has(module)) components.set(module, new Proxy({}, { get: (_, name) => {
      const key = `${module}/${String(name)}`;
      if (!components.has(key)) { const fn = () => null; Object.defineProperty(fn, 'name', { value: name }); components.set(key, fn); }
      return components.get(key);
    } }));
    return components.get(module);
  }
  const exports = {}, window = { agentHQ: {}, confirm: () => true, open() {}, ...environment.window };
  compileTypeScript(path.resolve(__dirname, '../../src/companion', filename), ['exports', 'require', 'window', 'setInterval', 'clearInterval', ...Object.keys(environment.globals || {})])(exports, loader, window, (fn) => { intervals.set(++intervalId, fn); return intervalId; }, (id) => intervals.delete(id), ...Object.values(environment.globals || {}));
  const Component = Object.values(exports)[0];
  function render(next = props) {
    props = next;
    do { dirty = false; pending = []; refIndex = 0; stateIndex = 0; effectIndex = 0; tree = Component(props); if (environment.element) for (const node of all(tree)) if (node.props?.ref) node.props.ref.current = environment.element; pending.forEach((effect) => effect()); } while (dirty);
    return tree;
  }
  function all(node) {
    if (arguments.length === 0) node = tree;
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap((child) => all(child));
    return [node, ...all(node.props?.children)];
  }
  function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node?.props) return text(node.props.children); return node == null || typeof node === 'boolean' ? '' : String(node); }
  function find(predicate) { const node = all().find(predicate); if (!node) throw new Error(`Missing phone component node: ${text(tree)}`); return node; }
  function button(label) { return find((node) => node.type === 'button' && text(node) === label); }
  function component(name) { return find((node) => node.type?.name === name); }
  async function flush() { await new Promise(setImmediate); render(); }
  function close() { effects.forEach((effect) => effect?.cleanup?.()); }
  render();
  return { render, all, text, find, button, component, flush, close, intervals, window, get tree() { return tree; } };
}
module.exports = { phoneComponent };
