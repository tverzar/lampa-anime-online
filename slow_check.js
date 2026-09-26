/* slow_check — диагностический плагин для Lampa.
 *
 * Задача: найти, из-за какого запроса виснет карточка фильма.
 *
 * Что делает:
 *   * следит за XHR (jQuery и Lampa.Reguest), fetch и WebSocket;
 *   * следит за встроенными блоками — iframe (трейлер с YouTube), video, audio;
 *   * всё, что не ответило за 9 секунд, помечает «висит»;
 *   * ведёт журнал в хранилище Lampa, поэтому журнал переживает перезапуск
 *     приложения: карточку можно открыть, дождаться зависания, закрыть
 *     приложение и посмотреть журнал.
 *
 * Где смотреть: Настройки → Журнал запросов.
 *
 * Установка: Lampa → Настройки → Расширения → Добавить плагин →
 *   https://tverzar.github.io/lampa-anime-online/slow_check.js
 * После проверки плагин можно убрать.
 */
(function () {
  'use strict';

  if (window.slow_check_plugin) return;
  window.slow_check_plugin = true;

  var VERSION = '2.0.0';
  var HANG_MS = 9000;     /* сколько ждём ответа, прежде чем записать «висит» */
  var SLOW_MS = 4000;     /* всё, что дольше, тоже показываем */
  var KEEP_MS = 2000;     /* мелочь в журнал не пишем */
  var REPEAT_MS = 20000;  /* не повторять одно и то же уведомление чаще */
  var SAME_MS = 30000;    /* не дублировать одинаковые записи подряд */
  var KEEP = 60;          /* сколько записей держим в журнале */
  var STORAGE = 'slow_check_log';
  var COMPONENT = 'slow_check';
  var notices = {};

  /* ------------------------------------------------------------------ */
  /* журнал                                                              */
  /* ------------------------------------------------------------------ */

  function readLog() {
    try {
      var raw = Lampa.Storage.get(STORAGE, '[]');
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeLog(records) {
    try {
      Lampa.Storage.set(STORAGE, JSON.stringify(records.slice(-KEEP)));
    } catch (error) {}
  }

  function hostOf(url) {
    var value = String(url || '');
    var match = value.match(/^(?:iframe|video|audio)?\s*(?:[a-z]+:)?\/\/([^\/?#]+)/i);
    if (match) return match[1];
    return value.slice(0, 40) || 'без адреса';
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
    var record = { t: Date.now(), state: state, host: host, ms: Math.round(ms || 0), url: String(url).slice(0, 220) };
    console.log('[slow_check] ' + state + ': ' + host + ' (' + record.ms + ' мс) ' + record.url);

    var interesting = state === 'висит' || state === 'ошибка' || state === 'загрузилось' ||
                      state === 'встроено' || record.ms >= KEEP_MS;
    if (interesting) {
      var records = readLog();
      var last = records[records.length - 1];
      var same = last && last.host === record.host && last.state === record.state && record.t - last.t < SAME_MS;
      if (!same) {
        records.push(record);
        writeLog(records);
      }
    }

    if (state === 'висит') notify('Не отвечает: ' + host + ' (' + (record.ms / 1000).toFixed(1) + ' с)', 'hang:' + host);
    else if (state === 'ошибка') notify('Ошибка запроса: ' + host, 'fail:' + host);
    else if (record.ms >= SLOW_MS) notify('Медленно: ' + host + ' — ' + (record.ms / 1000).toFixed(1) + ' с', 'slow:' + host);
  }

  /* ------------------------------------------------------------------ */
  /* слежка за запросами                                                 */
  /* ------------------------------------------------------------------ */

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

  var NativeSocket = window.WebSocket;
  if (NativeSocket) {
    window.WebSocket = function (url, protocols) {
      var socket = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
      var started = Date.now();
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) report('висит', url, Date.now() - started);
      }, HANG_MS);
      socket.addEventListener('open', function () {
        settled = true;
        clearTimeout(timer);
        report('ответил', url, Date.now() - started);
      });
      socket.addEventListener('error', function () {
        settled = true;
        clearTimeout(timer);
        report('ошибка', url, Date.now() - started);
      });
      return socket;
    };
    window.WebSocket.prototype = NativeSocket.prototype;
  }

  /* iframe и медиа: у iframe видно, загрузился он или нет — так ловится
     зависший трейлер, который через XHR вообще не проходит */
  function watchNodes() {
    if (!window.MutationObserver || !document.documentElement) return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
          if (!node || node.nodeType !== 1 || !node.tagName) return;
          var tag = node.tagName.toLowerCase();
          if (tag !== 'iframe' && tag !== 'video' && tag !== 'audio') return;
          var src = node.getAttribute('src') || node.getAttribute('data-src') || '';
          if (!src) return;
          if (tag === 'iframe') {
            var started = Date.now();
            var finished = false;
            var timer = setTimeout(function () {
              if (!finished) report('висит', 'iframe ' + src, Date.now() - started);
            }, HANG_MS);
            node.addEventListener('load', function () {
              finished = true;
              clearTimeout(timer);
              report('загрузилось', 'iframe ' + src, Date.now() - started);
            });
            node.addEventListener('error', function () {
              finished = true;
              clearTimeout(timer);
              report('ошибка', 'iframe ' + src, Date.now() - started);
            });
          } else {
            report('встроено', tag + ' ' + src, 0);
          }
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ */
  /* экран с журналом: Настройки → Журнал запросов                        */
  /* ------------------------------------------------------------------ */

  var STATE_STYLE = {
    'висит': 'не отвечает',
    'ошибка': 'ошибка',
    'ответил': 'ответил',
    'загрузилось': 'загрузилось',
    'встроено': 'встроено'
  };

  function SlowLogComponent(object) {
    var self = this;
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var last;

    function appendRow(title, subtitle) {
      var item = $('<div class="online selector slow-check__row">' +
        '<div class="online__body">' +
          '<div class="online__title">' + $('<div>').text(title).html() + '</div>' +
          '<div class="online__quality">' + $('<div>').text(subtitle || '').html() + '</div>' +
        '</div>' +
      '</div>');
      scroll.append(item);
      return item;
    }

    function stamp(value) {
      var date = new Date(value || Date.now());
      function pad(number) { return number < 10 ? '0' + number : String(number); }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    function load() {
      var records = readLog().reverse();
      appendRow('Очистить журнал', 'убрать все записи').on('hover:enter', function () {
        writeLog([]);
        scroll.clear();
        load();
        Lampa.Noty.show('Журнал очищен');
      });

      if (!records.length) {
        appendRow('Журнал пуст', 'откройте карточку, которая виснет, и загляните сюда');
      } else {
        records.forEach(function (record) {
          var state = STATE_STYLE[record.state] || record.state;
          var seconds = record.ms ? ' · ' + (record.ms / 1000).toFixed(1) + ' с' : '';
          appendRow(record.host + ' — ' + state + seconds, stamp(record.t) + ' · ' + record.url);
        });
      }

      last = scroll.render().find('.selector').eq(0)[0];
      self.start(true);
    }

    this.create = function () {
      files.appendFiles(scroll.render());
      load();
    };

    this.start = function (first) {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (first) last = scroll.render().find('.selector').eq(0)[0];
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function () { Navigator.move('down'); },
        right: function () { Navigator.move('right'); },
        left: function () {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        back: this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.render = function () { return files.render(); };
    this.back = function () { Lampa.Activity.backward(); };
    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
      scroll.destroy();
      files.destroy();
    };
  }

  function addFolder() {
    if (!Lampa.Settings.main || !Lampa.Settings.main()) return;
    var render = Lampa.Settings.main().render();
    if (render.find('[data-component="' + COMPONENT + '"]').length) return;
    var folder = $('<div class="settings-folder selector" data-component="' + COMPONENT + '">' +
      '<div class="settings-folder__icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>' +
      '<div class="settings-folder__name">Журнал запросов</div></div>');
    render.find('[data-component="more"]').after(folder);
    Lampa.Settings.main().update();
  }

  Lampa.Component.add(COMPONENT, SlowLogComponent);
  if (window.appready) addFolder();
  else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') addFolder(); });

  watchNodes();

  Lampa.Manifest.plugins = {
    type: 'other',
    version: VERSION,
    name: 'Журнал запросов — ' + VERSION,
    description: 'Показывает, какой запрос не отвечает',
    component: COMPONENT
  };

  window.__slow = { version: VERSION, log: readLog, clear: function () { writeLog([]); } };

  console.log('[slow_check] включён, версия ' + VERSION);
})();
