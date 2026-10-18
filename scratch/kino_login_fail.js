/* Проверка: «Кино онлайн» создаёт настройки входа и отправляет их на сервер. */
const fs = require('fs');
const vm = require('vm');

function chainable() {
  const target = function () { return proxy; };
  const proxy = new Proxy(target, {
    get(obj, key) {
      if (key === 'length') return 0;
      if (key === 'then') return undefined;
      if (key === 'html' || key === 'text' || key === 'val') return () => '';
      if (key === 'is') return () => false;
      if (typeof key === 'symbol') return undefined;
      return () => proxy;
    },
    apply() { return proxy; }
  });
  return proxy;
}

const calls = { components: [], params: [], fetches: [], notes: [] };
const values = { rezka_login: 'test_user', rezka_password: 'test_pass' };

const Lampa = {
  Component: { add: () => {} },
  Listener: { follow: () => {} },
  Template: { add: () => {}, get: () => chainable() },
  SettingsApi: {
    addComponent: (c) => calls.components.push(c),
    addParam: (p) => calls.params.push(p)
  },
  Params: { get: (name) => values[name], select: () => {} },
  Storage: { get: (n, d) => (n in values ? values[n] : d), set: () => {} },
  Manifest: { plugins: {} },
  Reguest: class { timeout() { return this; } silent() { return this; } native() { return this; } clear() { return this; } },
  Noty: { show: (m) => calls.notes.push(m) },
  Loading: { start: () => {}, stop: () => {} },
  Select: { show: () => {} },
  Controller: { toggle: () => {} },
  Activity: { push: () => {} },
  Scroll: class { constructor() { return chainable(); } },
  Explorer: class { constructor() { return chainable(); } },
  Player: { play: () => {}, playlist: () => {} },
  Timeline: { view: () => {}, time: () => {} },
  Favorites: {}, Utils: {}, Lang: { translate: (s) => s }
};

const sandbox = {
  window: {
    Lampa,
    addEventListener: () => {},
    fetch: (url, options) => {
      calls.fetches.push({ url, options });
      return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'сайт не принял логин или пароль' }) });
    }
  },
  document: { addEventListener: () => {}, createElement: () => ({ style: {} }) },
  console, setTimeout, clearTimeout,
  navigator: { userAgent: 'test' }
};
sandbox.window.window = sandbox.window;
sandbox.$ = chainable();
sandbox.jQuery = sandbox.$;
sandbox.Lampa = Lampa;

vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync('kino_online.js', 'utf8'), sandbox, { filename: 'kino_online.js' });
} catch (error) {
  console.log('ПАДЕНИЕ ПРИ ЗАГРУЗКЕ:', error.message);
  process.exit(1);
}

setTimeout(() => {
  console.log('раздел настроек:', JSON.stringify(calls.components.map((c) => c.name)));
  console.log('параметры:', calls.params.map((p) => p.param.name + ':' + p.param.type).join(', '));
  console.log('запросов входа:', calls.fetches.length);
  const first = calls.fetches[0];
  if (first) {
    console.log('адрес:', first.url.replace(/^https?:\/\/[^/]+/, ''));
    console.log('метод:', first.options.method, '| тип:', first.options.headers['Content-Type']);
    console.log('тело:', first.options.body);
    console.log('пароль в адресе:', first.url.includes('test_pass') ? 'ДА (плохо)' : 'нет');
  }
  console.log('уведомления:', calls.notes.join(' | '));
}, 100);
