/* anime_check — самопроверка для телевизора.
 *
 * Зачем: показать на экране телевизора, где именно ломается цепочка
 * «Lampa → сервис на VPS → Kodik → плеер». Нужно, когда плагин на ТВ
 * ведёт себя иначе, чем на компьютере, а подключиться к телевизору нельзя:
 * телевизор сам сообщает, что у него происходит.
 *
 * Установка: Настройки → Расширения → Добавить плагин:
 *   https://tverzar.github.io/lampa-anime-online/anime_check.js
 * Дальше ничего нажимать не надо: через пару секунд после запуска Lampa
 * проверка пройдёт сама, строки появятся уведомлениями, а в конце откроется
 * окно со всем списком — его можно сфотографировать.
 */
(function () {
  'use strict';

  if (window.anime_check_plugin) return;
  window.anime_check_plugin = true;

  var VERSION = '1.0.0';
  var TOKEN = 'aae367a1303194a38cbfb7ad146f68e2';
  var ADDRESSES = [
    { name: 'Прямой адрес 8443', base: 'https://94.156.237.213.nip.io:8443/kino/' + TOKEN },
    { name: 'Резерв Cloudflare', base: 'https://lampa-anime-proxy.rammthaok.workers.dev/kino/' + TOKEN }
  ];
  /* Ссылка 13-й серии «Изгнанного реинкарнированного рыцаря» — того самого
     релиза, что открыт на телевизоре: проверяется весь путь целиком. */
  var KODIK = 'https://kodikplayer.com/season/120923/f48dc023d67a7a6df95ae6e5fb543dd8/720p' +
              '?translations=false&only_episode=true&only_season=true&episode=13';

  var lines = [];
  var working = [];

  function say(text) {
    lines.push(text);
    try { Lampa.Noty.show(text); } catch (error) { /* экран ещё не готов */ }
    console.log('[anime_check] ' + text);
  }

  function report() {
    var html = lines.map(function (line) {
      return '<div style="padding:.35em 0">' + String(line)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
    }).join('');
    var modal = Lampa.Modal;
    if (!modal || !modal.open) {
      say('Список проверок — в уведомлениях выше');
      return;
    }
    try {
      modal.open({
        title: 'Проверка аниме — ' + VERSION,
        html: $('<div>' + html + '</div>'),
        size: 'medium',
        onBack: function () { modal.close(); },
        buttons: [{ name: 'Понятно', onSelect: function () { modal.close(); } }]
      });
    } catch (error) {
      say('Окно отчёта не открылось: ' + (error && error.message || error));
    }
  }

  function api(base, action, params, success, failure, wait) {
    var pairs = [];
    for (var key in params) {
      if (params.hasOwnProperty(key)) pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    }
    var url = base + '/' + action + (pairs.length ? '?' + pairs.join('&') : '');
    var network = new Lampa.Reguest();
    network.timeout(wait || 12000);
    var started = Date.now();
    network.silent(url, function (data) {
      success(data, ((Date.now() - started) / 1000).toFixed(1));
    }, function () {
      if (failure) failure(((Date.now() - started) / 1000).toFixed(1));
    });
  }

  function playStreams(title, number, streams) {
    var quality = {};
    (streams || []).forEach(function (entry) {
      if (entry && entry.hls) quality[entry.quality] = entry.hls;
    });
    var order = ['1080p', '720p', '480p', '360p'];
    var best = '';
    for (var index = 0; index < order.length && !best; index++) best = quality[order[index]] || '';
    if (!best) { for (var name in quality) { if (quality.hasOwnProperty(name)) { best = quality[name]; break; } } }
    if (!best) return false;
    var entry = { url: best, title: title + ' — серия ' + number, quality: quality, season: 1, episode: parseFloat(number) || 1 };
    entry.playlist = [entry];
    Lampa.Player.play(entry);
    Lampa.Player.playlist(entry.playlist);
    return true;
  }

  function checkKodik(base) {
    say('Проверяю поток 13-й серии…');
    api(base, 'kodik_url', { url: KODIK, episode: 13 }, function (data, seconds) {
      var streams = (data && data.streams) || [];
      say('Kodik ответил за ' + seconds + ' с: озвучек ' + ((data.translations || []).length) +
          ', серий ' + ((data.episodes || []).length) + ', качеств ' + streams.length);
      if (!streams.length) {
        say('Сервис не отдал поток — серия откроется окном с чужим плеером');
        report();
        return;
      }
      var names = streams.map(function (entry) { return entry.quality; }).join(', ');
      say('Играю ' + names + ' — сейчас должно начаться видео');
      if (!playStreams('Проверка', 13, streams)) {
        say('Плеер Lampa не принял поток');
        report();
        return;
      }
      setTimeout(report, 5000);
    }, function (seconds) {
      say('Kodik не ответил за ' + seconds + ' с');
      report();
    }, 30000);
  }

  function checkPlaces() {
    var pending = ADDRESSES.length;

    function done() {
      pending--;
      if (pending > 0) return;
      if (!working.length) {
        say('Ни один адрес сервиса не отвечает — дело в сети телевизора');
        report();
        return;
      }
      checkKodik(working[0].base);
    }

    ADDRESSES.forEach(function (address) {
      api(address.base, 'health', {}, function (data, seconds) {
        say(address.name + ': ответил за ' + seconds + ' с, версия ' + ((data && data.version) || '?'));
        working.push(address);
        done();
      }, function (seconds) {
        say(address.name + ': НЕ ОТВЕТИЛ за ' + seconds + ' с');
        done();
      }, 12000);
    });
  }

  function start() {
    var anime = window.__anime;
    if (!anime || !anime.version) {
      say('Плагин «Аниме онлайн» не подключён — расширение не загрузилось');
    } else {
      say('Плагин «Аниме онлайн» ' + anime.version + ' загружен');
    }
    checkPlaces();
  }

  Lampa.Manifest.plugins = {
    type: 'other',
    version: VERSION,
    name: 'Проверка аниме — ' + VERSION,
    description: 'Самопроверка: доступен ли сервис потоков и играет ли видео'
  };

  window.__anime_check = { version: VERSION, start: start, addresses: ADDRESSES, lines: function () { return lines; } };
  console.log('[anime_check] включён, версия ' + VERSION);

  /* Даём приложению подняться и только потом проверяем. */
  setTimeout(function () {
    try { start(); } catch (error) { say('Ошибка проверки: ' + (error && error.message || error)); report(); }
  }, 4000);
})();
