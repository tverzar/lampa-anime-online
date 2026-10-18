/* Сквозная проверка источника Aprel: меню источников → поиск → поток → плеер. */
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

const calls = { selects: [], plays: [], notes: [], api: [] };
const values = { aprel_login: 'demo_user', aprel_password: 'demo_pass' };

const Lampa = {
  Component: { add: () => {} },
  Listener: { follow: () => {} },
  Template: { add: () => {}, get: () => chainable() },
  SettingsApi: { addComponent: () => {}, addParam: () => {} },
  Params: { get: (name) => values[name] },
  Storage: { get: (n, d) => (n in values ? values[n] : d), set: () => {} },
  Manifest: { plugins: {} },
  Reguest: class {
    constructor() { this.handlers = null; }
    timeout() { return this; }
    silent(url, ok, err, post, options) {
      calls.api.push(url.replace(/^https?:\/\/[^/]+\/kino\/[a-f0-9]{32}/, ''));
      if (url.indexOf('/aprel_search') !== -1) {
        ok({ items: [{ title: 'Железный человек', url: 'https://aprelteam.gokino.by/films/488.html' }] });
      } else if (url.indexOf('/aprel_stream') !== -1) {
        ok({ success: true, qualities: { '720p': 'https://cdn.example/720.m3u8', '360p': 'https://cdn.example/360.m3u8' } });
      }
      return this;
    }
    native() { return this; }
    clear() { return this; }
  },
  Noty: { show: (m) => calls.notes.push(m) },
  Loading: { start: () => {}, stop: () => {} },
  Select: { show: (options) => calls.selects.push(options) },
  Controller: { toggle: () => {} },
  Activity: { push: () => {} },
  Scroll: class { constructor() { return chainable(); } },
  Explorer: class { constructor() { return chainable(); } },
  Player: {
    play: (entry) => calls.plays.push(entry),
    playlist: (list) => calls.plays.push({ playlist: list })
  },
  Timeline: { view: () => {}, time: () => {} },
  Favorites: {}, Utils: {}, Lang: { translate: (s) => s }
};

const sandbox = {
  window: { Lampa, addEventListener: () => {}, fetch: null },
  document: { addEventListener: () => {}, createElement: () => ({ style: {} }) },
  console, setTimeout, clearTimeout, navigator: { userAgent: 'test' }
};
sandbox.window.window = sandbox.window;
sandbox.$ = chainable();
sandbox.jQuery = sandbox.$;
sandbox.Lampa = Lampa;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('kino_online.js', 'utf8'), sandbox, { filename: 'kino_online.js' });

sandbox.window.__kino.open({ title: 'Железный человек' });
const sources = calls.selects[0];
console.log('1) меню источников:', sources ? sources.items.map((i) => i.title).join(' / ') : 'НЕТ');

sources.onSelect(sources.items[0]);
const results = calls.selects[1];
console.log('2) результаты поиска:', results ? results.title + ' — ' + results.items.length + ' шт' : 'НЕТ');

results.onSelect(results.items[0]);
const play = calls.plays[0];
console.log('3) плеер получил:', play ? play.url : 'НЕТ');
console.log('   качества:', play ? Object.keys(play.quality).join('/') : '—');
console.log('   запросы к сервису:', calls.api.join(', '));
console.log('уведомления:', calls.notes.join(' | ') || 'нет');
