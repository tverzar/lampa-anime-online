/* Проверка одной кнопки: загрузчик рисует «Онлайн», плагины свою кнопку не рисуют. */
const fs = require('fs');
const vm = require('vm');

function makeChain() {
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

const calls = { jquery: [], follows: [], selects: [], notices: [], appended: [] };

function jquery(arg) {
  if (typeof arg === 'string') {
    calls.jquery.push(arg);
    if (arg.indexOf('full-start__button') !== -1) {
      const node = makeChain();
      return new Proxy(node, {
        get(obj, key) {
          if (key === 'on') return (evt, fn) => { calls.buttonHandler = fn; return obj; };
          if (key === 'length') return 1;
          if (key === 'then') return undefined;
          if (typeof key === 'symbol') return undefined;
          return () => obj;
        }
      });
    }
  }
  return makeChain();
}

const Lampa = {
  Component: { add: () => {} },
  Listener: { follow: (name, handler) => calls.follows.push({ name, handler }) },
  Template: { add: () => {}, get: () => makeChain() },
  SettingsApi: { addComponent: () => {}, addParam: () => {} },
  Params: { get: () => '' },
  Storage: { get: (n, d) => d, set: () => {} },
  Manifest: {},
  Reguest: class { timeout() { return this; } silent() { return this; } native() { return this; } clear() { return this; } },
  Noty: { show: (m) => calls.notices.push(m) },
  Loading: { start: () => {}, stop: () => {} },
  Select: { show: (o) => calls.selects.push(o) },
  Controller: { toggle: () => {} },
  Activity: { push: () => {} },
  Scroll: class { constructor() { return makeChain(); } },
  Explorer: class { constructor() { return makeChain(); } },
  Player: { play: () => {}, playlist: () => {} },
  Timeline: { view: () => {}, time: () => {} },
  Favorites: {}, Utils: {}, Lang: { translate: (s) => s }
};

const sandbox = {
  window: { Lampa, addEventListener: () => {}, fetch: null },
  document: {
    addEventListener: () => {},
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {} }),
    head: { appendChild: () => {} }
  },
  console, setTimeout, clearTimeout, navigator: { userAgent: 'test' }
};
sandbox.window.window = sandbox.window;
sandbox.$ = jquery;
sandbox.jQuery = jquery;
sandbox.Lampa = Lampa;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('online_all.js', 'utf8'), sandbox, { filename: 'online_all.js' });

console.log('1) флаг одной кнопки:', sandbox.window.lampa_online_single === true);

const full = calls.follows.filter((f) => f.name === 'full')[0];
console.log('2) загрузчик подписался на карточку:', !!full);

sandbox.window.__anime = { open: (m) => calls.selects.push({ anime: m.title }) };
sandbox.window.__kino = { open: (m) => calls.selects.push({ kino: m.title }) };

const root = makeChain();
full.handler({ type: 'complite', object: { activity: { render: () => root } }, data: { movie: { title: 'Игра Престолов' } } });

const button = calls.jquery.filter((html) => html.indexOf('full-start__button') !== -1)[0];
console.log('3) кнопка создана:', button ? button.match(/<span>([^<]+)</)[1] : 'НЕТ');

/* нажимаем кнопку: у мока .on просто возвращает chain, поэтому зовём openMenu через Select */
if (calls.buttonHandler) calls.buttonHandler();
const select = calls.selects[0];
console.log('4) меню выбора:', select ? select.title + ' → ' + select.items.map((i) => i.title).join(' / ') : 'НЕТ');
if (select) {
  select.onSelect(select.items[0]);
  console.log('5) выбор «Аниме» открыл:', JSON.stringify(calls.selects[calls.selects.length - 1]));
}

/* плагины со флагом не должны рисовать свою кнопку */
calls.jquery.length = 0;
const animeSandbox = Object.assign({}, sandbox, { window: Object.assign({}, sandbox.window, { lampa_online_single: true }) });
animeSandbox.window.window = animeSandbox.window;
vm.createContext(animeSandbox);
vm.runInContext(fs.readFileSync('anime_online.js', 'utf8'), animeSandbox, { filename: 'anime_online.js' });
const animeFull = calls.follows.filter((f) => f.name === 'full').pop();
if (animeFull) animeFull.handler({ type: 'complite', object: { activity: { render: () => root } }, data: { movie: { title: 'x' } } });
console.log('6) аниме-плагин свою кнопку не рисует:', calls.jquery.filter((h) => h.indexOf('view--anime-online') !== -1).length === 0);
