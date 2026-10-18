(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Один плагин-загрузчик на две кнопки: «Аниме онлайн» и «Кино онлайн». */
  /* Сам ничего не показывает — подтягивает два рабочих плагина с        */
  /* GitHub Pages, а если страница недоступна, берёт их с jsDelivr.      */
  /* ------------------------------------------------------------------ */

  if (window.lampa_online_all) return;
  window.lampa_online_all = true;

  /* Одна кнопка на оба плагина: сами они свою кнопку не рисуют (видят этот
     флаг), а меню «Аниме / Кино» строит этот загрузчик. */
  window.lampa_online_single = true;

  var VERSION = '1.2.0';

  var BUNDLE = [
    {
      name: 'Аниме онлайн',
      loaded: function () { return !!window.anime_online_plugin; },
      urls: [
        'https://tverzar.github.io/lampa-anime-online/anime_online.js',
        'https://cdn.jsdelivr.net/gh/tverzar/lampa-anime-online@3e62989/anime_online.js'
      ]
    },
    {
      name: 'Кино онлайн',
      loaded: function () { return !!window.kino_online_plugin; },
      urls: [
        'https://tverzar.github.io/lampa-anime-online/kino_online.js',
        'https://cdn.jsdelivr.net/gh/tverzar/lampa-anime-online@3e62989/kino_online.js'
      ]
    }
  ];

  function notice(message) {
    if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
    else console.log('[Online ALL] ' + message);
  }

  function load(entry) {
    if (entry.loaded()) return void console.log('[Online ALL] ' + entry.name + ' уже загружен');

    function attempt(index) {
      if (index >= entry.urls.length) {
        notice(entry.name + ': плагин не загрузился');
        return;
      }
      var url = entry.urls[index] + (entry.urls[index].indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
      var script = document.createElement('script');
      script.src = url;
      script.onload = function () {
        console.log('[Online ALL] ' + entry.name + ' загружен (' + (index ? 'jsDelivr' : 'Pages') + ')');
      };
      script.onerror = function () {
        console.log('[Online ALL] ' + entry.name + ': адрес не ответил, пробую резервный');
        script.remove();
        attempt(index + 1);
      };
      document.head.appendChild(script);
    }

    attempt(0);
  }

  /* ------------------------------------------------------------------ */
  /* Одна кнопка «Онлайн»: аниме или кино                                  */
  /* ------------------------------------------------------------------ */

  function openMenu(movie) {
    var items = [];
    if (window.__anime) items.push({ title: 'Аниме', subtitle: 'AniLibria · YummyAnime · Kodik', source: 'anime' });
    if (window.__kino) items.push({ title: 'Кино', subtitle: 'Aprel · HDrezka · Kinokrad', source: 'kino' });
    if (!items.length) return notice('Плагины ещё загружаются — попробуйте через пару секунд');
    Lampa.Select.show({
      title: 'Что смотрим',
      items: items,
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (item) {
        if (item.source === 'anime') window.__anime.open(movie);
        else window.__kino.open(movie);
      }
    });
  }

  function addButton(event) {
    if (!event || event.type !== 'complite' || !event.object || !event.data || !event.data.movie) return;
    var root = event.object.activity.render();
    if (root.find('.view--online-all').length) return;

    var button = $('<div class="full-start__button selector view--online-all" data-subtitle="Аниме и кино · ' + VERSION + '">' +
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>' +
      '<span>Онлайн</span>' +
    '</div>');
    button.on('hover:enter', function () { openMenu(event.data.movie); });

    var anchor = root.find('.view--torrent');
    if (anchor.length) anchor.after(button);
    else root.find('.full-start-new__buttons, .full-start__buttons').first().append(button);
  }

  if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('full', addButton);

  BUNDLE.forEach(load);

  console.log('[Online ALL] загрузчик ' + VERSION + ' запущен');
})();
