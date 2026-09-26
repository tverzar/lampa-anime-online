(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Один плагин-загрузчик на две кнопки: «Аниме онлайн» и «Кино онлайн». */
  /* Сам ничего не показывает — подтягивает два рабочих плагина с        */
  /* GitHub Pages, а если страница недоступна, берёт их с jsDelivr.      */
  /* ------------------------------------------------------------------ */

  if (window.lampa_online_all) return;
  window.lampa_online_all = true;

  var VERSION = '1.1.0';

  var BUNDLE = [
    {
      name: 'Аниме онлайн',
      loaded: function () { return !!window.anime_online_plugin; },
      urls: [
        'https://tverzar.github.io/lampa-anime-online/anime_online.js',
        'https://cdn.jsdelivr.net/gh/tverzar/lampa-anime-online@5afb874/anime_online.js'
      ]
    },
    {
      name: 'Кино онлайн',
      loaded: function () { return !!window.kino_online_plugin; },
      urls: [
        'https://tverzar.github.io/lampa-anime-online/kino_online.js',
        'https://cdn.jsdelivr.net/gh/tverzar/lampa-anime-online@5afb874/kino_online.js'
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

  BUNDLE.forEach(load);

  console.log('[Online ALL] загрузчик ' + VERSION + ' запущен');
})();
