/* slow_check — диагностический плагин для Lampa.
 *
 * Показывает уведомлением, какой сетевой запрос не отвечает или отвечает
 * слишком долго. Нужен один раз: найти, из-за кого карточка висит.
 *
 * Установка: Lampa → Настройки → Расширения → Добавить плагин →
 *   https://tverzar.github.io/lampa-anime-online/slow_check.js
 * После проверки плагин лучше убрать.
 *
 * Что делать: открыть карточку фильма, которая зависает, и смотреть
 * уведомления. Запись вида «Не отвечает: cub.red — 9.5 с» и есть виновник.
 * Полный список — window.__slow в консоли разработчика.
 */
(function () {
  'use strict';

  if (window.slow_check_plugin) return;
  window.slow_check_plugin = true;

  var VERSION = '1.0.0';
  var HANG_MS = 9000;   /* столько ждём ответа, прежде чем сказать «висит» */
  var SLOW_MS = 4000;   /* всё, что дольше, тоже показываем */
  var REPEAT_MS = 20000;

  var log = [];
  var notices = {};
  window.__slow = log;

  function hostOf(url) {
    try {
      return new URL(url, location.href).host || String(url).slice(0, 40);
    } catch (error) {
      return String(url).slice(0, 40);
    }
  }

  function notify(text, key) {
    var now = Date.now();
    if (notices[key] && now - notices[key] < REPEAT_MS) return;
    notices[key] = now;
    console.log('[slow_check] ' + text);
    if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
  }

  function report(state, url, ms) {
    var host = hostOf(url);
    var record = { state: state, host: host, ms: Math.round(ms), url: String(url).slice(0, 220) };
    log.push(record);
    if (log.length > 200) log.shift();

    if (state === 'висит') notify('Не отвечает: ' + host + ' (' + (ms / 1000).toFixed(1) + ' с)', 'hang:' + host);
    else if (ms >= SLOW_MS) notify('Медленно: ' + host + ' — ' + (ms / 1000).toFixed(1) + ' с', 'slow:' + host);
    else if (state === 'ошибка') notify('Ошибка запроса: ' + host, 'fail:' + host);
  }

  /* fetch (используют современные плагины) */
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var started = Date.now();
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) report('висит', url, Date.now() - started);
      }, HANG_MS);
      return nativeFetch.apply(this, arguments).then(function (response) {
        settled = true;
        clearTimeout(timer);
        report('ответил', url, Date.now() - started);
        return response;
      }, function (error) {
        settled = true;
        clearTimeout(timer);
        report('ошибка', url, Date.now() - started);
        throw error;
      });
    };
  }

  /* XMLHttpRequest (через него ходят jQuery и Lampa.Reguest) */
  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__slow_check = { url: url, started: 0 };
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var request = this;
    var info = request.__slow_check;
    if (info) {
      info.started = Date.now();
      var timer = setTimeout(function () {
        if (request.readyState !== 4) report('висит', info.url, Date.now() - info.started);
      }, HANG_MS);
      request.addEventListener('loadend', function () {
        clearTimeout(timer);
        report(request.status ? 'ответил' : 'ошибка', info.url, Date.now() - info.started);
      });
    }
    return nativeSend.apply(this, arguments);
  };

  Lampa.Manifest.plugins = {
    type: 'other',
    version: VERSION,
    name: 'Проверка медленных запросов — ' + VERSION,
    description: 'Показывает, какой запрос не отвечает'
  };

  console.log('[slow_check] включён, версия ' + VERSION);
})();
