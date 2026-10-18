/* Проверка: плагин грузится и создаёт раздел настроек через SettingsApi. */
const fs = require('fs');
const vm = require('vm');

function chainable(name) {
  const target = function () { return proxy; };
  const proxy = new Proxy(target, {
    get(obj, key) {
      if (key === 'length') return 0;
      if (key === 'then') return undefined;
      if (key === 'html') return () => '';
      if (key === 'text') return () => '';
      if (key === 'value') return () => '';
      if (key === 'is') return () => false;
      if (typeof key === 'symbol') return undefined;
      return () => proxy;
    },
    apply() { return proxy; }
  });
  return proxy;
}

const calls = { components: [], params: [], reports: [] };

const Lampa = {
  Component: { add: () => {} },
  Listener: { follow: () => {} },
  Template: { add: () => {}, get: () => chainable('template') },
  SettingsApi: {
    addComponent: () => { throw new Error('другой API'); },
    addParam: (p) => calls.params.push(p)
  },
  Params: { get: (name) => (name === 'anime_quality' ? '480p' : ''), select: () => {} },
  Storage: { get: (n, d) => (n === 'anime_quality' ? '480p' : d), set: () => {} },
  Manifest: { plugins: {} },
  Reguest: class {
    constructor() { this.url = ''; }
    timeout() { return this; }
    silent(url, ok) { calls.reports.push(url); return this; }
    native() { return this; }
    clear() { return this; }
  },
  Noty: { show: () => {} },
  Loading: { start: () => {}, stop: () => {} },
  Select: { show: () => {} },
  Controller: { toggle: () => {} },
  Activity: { push: () => {} },
  Scroll: class { constructor() { return chainable('scroll'); } },
  Explorer: class { constructor() { return chainable('explorer'); } },
  Player: { play: () => {}, playlist: () => {} },
  Timeline: { view: () => {}, time: () => {} },
  Favorites: {},
  Utils: {},
  Lang: { translate: (s) => s },
  Arrays: { add: () => {} }
};

const sandbox = {
  window: { Lampa, addEventListener: () => {}, appready: false, fetch: null },
  document: { addEventListener: () => {}, createElement: () => ({ style: {} }) },
  console,
  setTimeout,
  clearTimeout,
  navigator: { userAgent: 'test' },
  localStorage: { getItem: () => null, setItem: () => {} }
};
sandbox.window.window = sandbox.window;
sandbox.Image = function () { var self = this; this._src = ''; Object.defineProperty(this, 'src', { set: function (v) { calls.reports.push(v); }, get: function () { return self._src; } }); };
sandbox.$ = chainable('jquery');
sandbox.jQuery = sandbox.$;
sandbox.Lampa = Lampa;

const code = fs.readFileSync('anime_online.js', 'utf8');
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'anime_online.js' });
} catch (error) {
  console.log('ПАДЕНИЕ ПРИ ЗАГРУЗКЕ:', error.message);
  process.exit(1);
}

console.log('плагин загрузился без ошибок');
console.log('раздел настроек:', JSON.stringify(calls.components.map((c) => c.name)));
console.log('параметры:', calls.params.map((p) => p.param.name + ':' + p.param.type).join(', '));
const quality = calls.params.find((p) => p.param.name === 'anime_quality');
console.log('качество — значения:', quality ? Object.keys(quality.param.values).join('/') : 'НЕТ');
console.log('версия манифеста:', Lampa.Manifest.plugins.version, '| имя:', Lampa.Manifest.plugins.name);
console.log('отчётов на сервер при старте:', calls.reports.length);
console.log('первый отчёт:', decodeURIComponent(calls.reports[0] || '').slice(-90));
