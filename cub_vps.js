/* cub_vps — плагин Lampa: запросы к CUB (cub.best, cub.red и зеркала) идут
 * через наш VPS, потому что из РФ эти домены недоступны и Lampa виснет
 * на карточке фильма, дожидаясь блока «Реакции».
 *
 * Что делает: подменяет адрес запроса к зеркалам CUB на наш прокси
 *   https://94.156.237.213.nip.io:8443/cub/...      (сам CUB)
 *   https://94.156.237.213.nip.io:8443/cubtmdb/...  (TMDB-прокси CUB)
 * Всё остальное (TMDB, наши плагины, картинки) не трогает.
 *
 * Установка: Lampa → Настройки → Расширения → Добавить плагин →
 *   https://tverzar.github.io/lampa-anime-online/cub_vps.js
 * Проверить, что работает: в журнале запросов (плагин slow_check) адреса
 * cub.* больше не появляются, вместо них 94.156.237.213.nip.io.
 */
(function () {
  'use strict';

  if (window.cub_vps_plugin) return;
  window.cub_vps_plugin = true;

  var VERSION = '1.0.0';
  var PROXY = 'https://94.156.237.213.nip.io:8443';
  /* зеркала CUB: свой домен Lampa выбирает из этого списка */
  var MIRRORS = ['cub.best', 'cub.black', 'cub.red', 'cub.rip', 'durex.monster', 'cubnotrip.top',
                 'standby.cub.red', 'kurwa-bober.ninja', 'nackhui.com', 'cub.watch'];
  var TMDB_PREFIX = 'tmdb.';

  function rewrite(url) {
    if (!url || typeof url !== 'string') return url;
    var value = url.trim();
    if (value.indexOf(PROXY) === 0) return value;

    var match = value.match(/^(https?:)?\/\/([^\/?#]+)([\s\S]*)$/i);
    if (!match) return value;

    var host = match[2].toLowerCase();
    var path = match[3] || '/';
    var bare = host.split(':')[0];
    var isTmdb = bare.indexOf(TMDB_PREFIX) === 0;
    var mirror = isTmdb ? bare.slice(TMDB_PREFIX.length) : bare;
    if (MIRRORS.indexOf(mirror) === -1) return value;

    return PROXY + (isTmdb ? '/cubtmdb' : '/cub') + path;
  }

  /* XHR — через него ходят jQuery и Lampa.Reguest */
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(url);
    return nativeOpen.apply(this, args);
  };

  /* fetch */
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') {
        input = rewrite(input);
      } else if (input && input.url) {
        var fixed = rewrite(input.url);
        if (fixed !== input.url && window.Request) input = new Request(fixed, input);
      }
      return nativeFetch.call(this, input, init);
    };
  }

  /* скрипты, картинки и iframe: Lampa ставит им src напрямую */
  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'src') value = rewrite(value);
    return nativeSetAttribute.call(this, name, value);
  };

  ['HTMLScriptElement', 'HTMLImageElement', 'HTMLIFrameElement'].forEach(function (name) {
    var klass = window[name];
    if (!klass || !klass.prototype) return;
    var descriptor = Object.getOwnPropertyDescriptor(klass.prototype, 'src');
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(klass.prototype, 'src', {
      get: descriptor.get,
      set: function (value) { descriptor.set.call(this, rewrite(value)); },
      configurable: true
    });
  });

  window.__cub_vps = { version: VERSION, proxy: PROXY, rewrite: rewrite };

  Lampa.Manifest.plugins = {
    type: 'other',
    version: VERSION,
    name: 'CUB через VPS — ' + VERSION,
    description: 'Запросы CUB идут через наш сервер (cub.* из РФ недоступен)'
  };

  if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('CUB идёт через VPS');
  console.log('[cub_vps] включён, версия ' + VERSION + ', прокси ' + PROXY);
})();
