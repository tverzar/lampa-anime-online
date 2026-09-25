(function () {
  'use strict';

  if (window.kino_online_plugin) return;
  window.kino_online_plugin = true;

  var VERSION = '2.0.0';

  /* -------------------------------------------------------------------- */
  /* Источник 1 — HDrezka через свой серверный экстрактор.                 */
  /*                                                                       */
  /* Сайт закрыт антиботом Anubis и отдаёт поток только клиентам из РФ,    */
  /* поэтому ссылку берёт сервис на нашем VPS, а видео качает сам телевизор */
  /* (CDN сверяет IP того, кто запросил ссылку, поэтому проксировать      */
  /* поток нельзя). Качество без входа на сайт — 360p.                     */
  /* -------------------------------------------------------------------- */

  var EXTRACTOR_TOKEN = 'aae367a1303194a38cbfb7ad146f68e2';
  var EXTRACTORS = [
    'https://94.156.237.213.nip.io:8443/kino/' + EXTRACTOR_TOKEN,
    'https://lampa-anime-proxy.rammthaok.workers.dev/kino/' + EXTRACTOR_TOKEN
  ];
  var EXTRACTOR = EXTRACTORS[0];
  var activeExtractor = 0;

  /* Источник 2 — запасной: Kinokrad, плеер открывается окном (iframe).    */

  var CORS_PROXY = 'https://lampa-anime-proxy.rammthaok.workers.dev/proxy?url=';
  var FRAME_CONTROLLER = 'kino_online_frame';
  var FRAME_STYLE = 'kino_online_frame_style';

  var SITES = [
    {
      id: 'kinokrad',
      title: 'Kinokrad',
      subtitle: 'фильмы и сериалы · плеер окном',
      domain: 'https://kinokrad.cc',
      search: function (query) {
        return this.domain + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(query);
      },
      resultPattern: /<a[^>]+href="(https?:\/\/[^"']*kinokrad\.cc\/\d+-[^"']+\.html)"[^>]*>([\s\S]{2,140}?)<\/a>/gi
    }
  ];

  function text(value) {
    return $('<div>').text(value == null ? '' : String(value)).html();
  }

  function queryFor(movie) {
    return movie.title || movie.name || movie.original_title || movie.original_name || '';
  }

  function yearFor(movie) {
    var date = movie.release_date || movie.first_air_date || '';
    return date ? String(date).slice(0, 4) : '';
  }

  function plain(html) {
    return $('<div>').html(String(html || '').replace(/<[^>]*>/g, ' ')).text().replace(/\s+/g, ' ').trim();
  }

  function hostOf(url) {
    var match = String(url).match(/^https?:\/\/([^/]+)/i);
    return match ? match[1] : url;
  }

  function proxyUrl(url) {
    return CORS_PROXY + encodeURIComponent(url);
  }

  /* -------------------------------------------------------------------- */
  /* Запросы к экстрактору                                                 */
  /* -------------------------------------------------------------------- */

  function api(path, params, success, error) {
    var pairs = [];
    for (var key in params) {
      if (params.hasOwnProperty(key) && params[key] != null && params[key] !== '') {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
      }
    }
    var query = pairs.length ? '?' + pairs.join('&') : '';
    var remembered = Lampa.Storage.get('kino_extractor', '');
    var start = remembered === '1' ? 1 : (remembered === '0' ? 0 : activeExtractor);

    function attempt(index) {
      var network = new Lampa.Reguest();
      /* первый адрес проверяем быстро: если порт закрыт, сразу уходим на резервный */
      network.timeout(index === start && !remembered ? 7000 : 25000);
      network.silent(EXTRACTORS[index] + path + query, function (data) {
        activeExtractor = index;
        Lampa.Storage.set('kino_extractor', String(index));
        success(data);
      }, function () {
        if (index + 1 < EXTRACTORS.length) attempt(index + 1);
        else error && error('Сервис HDrezka не ответил');
      });
    }

    attempt(start);
  }

  /* -------------------------------------------------------------------- */
  /* Воспроизведение прямым потоком                                        */
  /* -------------------------------------------------------------------- */

  function qualityMap(streams) {
    var map = {};
    streams.forEach(function (entry) {
      if (entry.hls) map[entry.quality] = entry.hls;
      else if (entry.mp4) map[entry.quality] = entry.mp4;
    });
    return map;
  }

  function bestOf(streams) {
    var order = ['1080p', '720p', '480p', '360p'];
    for (var index = 0; index < order.length; index++) {
      var match = streams.filter(function (entry) { return entry.quality === order[index] && entry.hls; })[0];
      if (match) return match;
    }
    return streams.filter(function (entry) { return entry.hls; })[0] || null;
  }

  function playStream(stream, title, movie) {
    var best = bestOf(stream.streams || []);
    if (!best) return Lampa.Noty.show('Поток не найден — попробуйте другую озвучку');

    var entry = {
      url: best.hls,
      title: title,
      quality: qualityMap(stream.streams || []),
      card: movie
    };
    Lampa.Player.play(entry);
    Lampa.Player.playlist([entry]);
  }

  /* -------------------------------------------------------------------- */
  /* Разбор выдачи экстрактора                                             */
  /* -------------------------------------------------------------------- */

  function betterMatch(items, movie) {
    var title = String(queryFor(movie) || '').toLowerCase();
    var year = yearFor(movie);

    function score(item) {
      var value = 0;
      var name = String(item.title || '').toLowerCase();
      if (name === title) value += 4;
      else if (name.indexOf(title) !== -1) value += 2;
      if (year && String(item.year) === year) value += 3;
      if (item.kind === 'movie') value += 1;
      return value;
    }

    return items.slice().sort(function (left, right) { return score(right) - score(left); });
  }

  function label(item) {
    var parts = [item.title];
    if (item.year) parts.push(item.year);
    if (item.kind === 'series') parts.push('сериал');
    return parts.join(' · ');
  }

  function pickTranslator(meta, page, movie, title, callback) {
    var translators = meta.translators || [];
    if (translators.length < 2) {
      return callback(translators.length ? translators[0].id : null);
    }
    Lampa.Select.show({
      title: 'Озвучка',
      items: translators.map(function (translator) {
        return { title: translator.name, translator: translator };
      }),
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (choice) { callback(choice.translator.id); }
    });
  }

  function pickEpisode(page, translator, meta, movie, title) {
    var seasons = meta.seasons || [];
    var season = seasons.length ? String(seasons[0].id) : '1';

    function chooseSeason(next) {
      if (seasons.length < 2) return next(season);
      Lampa.Select.show({
        title: 'Сезон',
        items: seasons.map(function (item) {
          return { title: item.name || ('Сезон ' + item.id), season: String(item.id) };
        }),
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { next(choice.season); }
      });
    }

    chooseSeason(function (chosen) {
      Lampa.Loading.start();
      api('/episodes', { url: page, translator: translator, season: chosen }, function (data) {
        Lampa.Loading.stop();
        var episodes = data.episodes || [];
        if (!episodes.length) return Lampa.Noty.show('Список серий пуст — попробуйте другую озвучку');
        Lampa.Select.show({
          title: 'Серия',
          items: episodes.map(function (episode) {
            return { title: episode.name || ('Серия ' + episode.id), episode: episode };
          }),
          onBack: function () { Lampa.Controller.toggle('content'); },
          onSelect: function (choice) {
            Lampa.Loading.start();
            api('/stream', { url: page, translator: translator, season: chosen, episode: choice.episode.id },
              function (stream) {
                Lampa.Loading.stop();
                if (!stream.success) return Lampa.Noty.show('Поток не отдан: ' + (stream.message || 'сайт молчит'));
                playStream(stream, title + ' — ' + (choice.episode.name || ('серия ' + choice.episode.id)), movie);
              }, function (message) {
                Lampa.Loading.stop();
                Lampa.Noty.show(message);
              });
          }
        });
      }, function (message) {
        Lampa.Loading.stop();
        Lampa.Noty.show(message);
      });
    });
  }

  function openTitle(item, movie) {
    Lampa.Loading.start();
    api('/info', { url: item.url }, function (meta) {
      Lampa.Loading.stop();
      var title = label(item);
      pickTranslator(meta, item.url, movie, title, function (translator) {
        if (meta.is_series) return pickEpisode(item.url, translator, meta, movie, title);
        Lampa.Loading.start();
        api('/stream', { url: item.url, translator: translator }, function (stream) {
          Lampa.Loading.stop();
          if (!stream.success) return Lampa.Noty.show('Поток не отдан: ' + (stream.message || 'сайт молчит'));
          playStream(stream, title, movie);
        }, function (message) {
          Lampa.Loading.stop();
          Lampa.Noty.show(message);
        });
      });
    }, function (message) {
      Lampa.Loading.stop();
      Lampa.Noty.show(message);
    });
  }

  function openRezka(movie) {
    var query = queryFor(movie);
    Lampa.Loading.start();
    api('/search', { q: query, limit: 10 }, function (data) {
      Lampa.Loading.stop();
      var items = betterMatch(data.items || [], movie);
      if (!items.length) return fallback(movie, 'HDrezka: ничего не найдено');
      Lampa.Select.show({
        title: 'HDrezka: выберите фильм',
        items: items.map(function (item) {
          return { title: label(item), item: item };
        }),
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { openTitle(choice.item, movie); }
      });
    }, function (message) {
      Lampa.Loading.stop();
      fallback(movie, message);
    });
  }

  /* -------------------------------------------------------------------- */
  /* Запасной источник: окно с чужим плеером (iframe)                      */
  /* -------------------------------------------------------------------- */

  function frameStyles() {
    if ($('#' + FRAME_STYLE).length) return;
    var css = '' +
      '.kino-online-frame{position:fixed;top:0;right:0;bottom:0;left:0;z-index:200;background:#000;display:flex;flex-direction:column;}' +
      '.kino-online-frame__bar{display:flex;align-items:center;padding:.5em 1em;background:rgba(0,0,0,.9);z-index:3;}' +
      '.kino-online-frame__title{flex:1;font-size:1.1em;color:#fff;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-right:1em;}' +
      '.kino-online-frame__button{margin-left:.6em;padding:.4em 1.1em;border-radius:.4em;background:rgba(255,255,255,.14);color:#fff;font-size:1em;white-space:nowrap;transition:background .15s,color .15s;}' +
      '.kino-online-frame__button.focus{background:#fff;color:#000;}' +
      '.kino-online-frame__body{flex:1;position:relative;background:#000;}' +
      '.kino-online-frame__window{position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000;}' +
      '.kino-online-frame__hint{position:absolute;top:.8em;left:1em;padding:.3em .8em;border-radius:.3em;background:rgba(0,0,0,.6);color:rgba(255,255,255,.7);font-size:.95em;z-index:2;}';
    $('head').append($('<style id="' + FRAME_STYLE + '"></style>').text(css));
  }

  function showFrame(url, title, hint) {
    if (!url) return Lampa.Noty.show('Не удалось получить ссылку на плеер');
    frameStyles();

    var html = $('<div class="kino-online-frame">' +
      '<div class="kino-online-frame__bar">' +
        '<div class="kino-online-frame__title"></div>' +
        '<div class="kino-online-frame__button selector kino-online-frame__player">В плеер</div>' +
        '<div class="kino-online-frame__button selector kino-online-frame__close">Назад</div>' +
      '</div>' +
      '<div class="kino-online-frame__body">' +
        '<div class="kino-online-frame__hint"></div>' +
        '<iframe class="kino-online-frame__window" referrerpolicy="unsafe-url" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" frameborder="0" scrolling="no"></iframe>' +
      '</div>' +
    '</div>');

    html.find('.kino-online-frame__title').text(title || 'Кино онлайн');
    html.find('.kino-online-frame__hint').text(hint || '').toggle(!!hint);
    html.find('.kino-online-frame__window').attr('src', url);
    $('body').append(html);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      html.find('.kino-online-frame__window').attr('src', 'about:blank');
      html.remove();
      Lampa.Controller.toggle('content');
    }

    function focusPlayer() {
      var frame = html.find('.kino-online-frame__window')[0];
      if (frame) frame.focus();
    }

    html.find('.kino-online-frame__close').on('hover:enter', close).on('click', close);
    html.find('.kino-online-frame__player').on('hover:enter', focusPlayer).on('click', focusPlayer);

    Lampa.Controller.add(FRAME_CONTROLLER, {
      toggle: function () {
        Lampa.Controller.collectionSet(html);
        Lampa.Controller.collectionFocus(html.find('.kino-online-frame__close')[0], html);
      },
      up: function () {}, down: function () {}, left: function () {}, right: function () {},
      back: close
    });
    Lampa.Controller.toggle(FRAME_CONTROLLER);
  }

  function requestText(url, success, error) {
    var network = new Lampa.Reguest();
    network.timeout(15000);
    var options = { dataType: 'text', headers: { 'Accept-Language': 'ru,en;q=0.8' } };
    network.native(proxyUrl(url), success, function () {
      network.clear();
      network.timeout(15000);
      network.native(url, success, error, false, options);
    }, false, options);
  }

  function pageDomain(html, site) {
    var match = String(html).match(/[?&]d=([a-z0-9.\-]+\.[a-z]{2,6})/i);
    if (match) return match[1];
    return String(site.domain || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }

  function withDomain(url, domain) {
    if (!domain || /[?&]d=/i.test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'd=' + encodeURIComponent(domain);
  }

  function extractPlayers(html) {
    var players = [];
    var seen = {};
    var regex = /<iframe[^>]{0,400}?src=["']([^"']+)["']/gi;
    var match;
    while ((match = regex.exec(html)) !== null) {
      var url = String(match[1]).replace(/&amp;/g, '&');
      if (url.indexOf('//') === 0) url = 'https:' + url;
      if (!/^https?:/i.test(url)) continue;
      if (/youtube|youtu\.be|vk\.com\/video|google/i.test(url)) continue;
      if (seen[url]) continue;
      seen[url] = true;
      players.push({ url: url, host: hostOf(url) });
    }
    return players;
  }

  function choosePlayer(players, title) {
    if (players.length === 1) return showFrame(players[0].url, title, players[0].host);
    Lampa.Select.show({
      title: 'Выберите плеер',
      items: players.map(function (player, index) {
        return { title: 'Плеер ' + (index + 1), subtitle: player.host, player: player };
      }),
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (choice) { showFrame(choice.player.url, title, choice.player.host); }
    });
  }

  function openKinokradTitle(item, site, movie) {
    Lampa.Loading.start();
    requestText(item.url, function (response) {
      Lampa.Loading.stop();
      var html = typeof response === 'string' ? response : (response && response.responseText) || '';
      var domain = pageDomain(html, site);
      var players = extractPlayers(html).map(function (player) {
        player.url = withDomain(player.url, domain);
        return player;
      });
      if (!players.length) return Lampa.Noty.show('На этой странице плеер не найден — выберите другой результат');
      var year = yearFor(movie);
      var title = item.title + (year && item.title.indexOf(year) === -1 ? ' · ' + year : '');
      choosePlayer(players, title);
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось открыть страницу фильма');
    });
  }

  function openKinokrad(site, movie, message) {
    if (message) Lampa.Noty.show(message);
    Lampa.Loading.start();
    requestText(site.search(queryFor(movie)), function (response) {
      Lampa.Loading.stop();
      var html = typeof response === 'string' ? response : (response && response.responseText) || '';
      var items = [];
      var seen = {};
      var match;
      site.resultPattern.lastIndex = 0;
      while ((match = site.resultPattern.exec(html)) !== null) {
        var url = match[1];
        var name = plain(match[2]);
        if (!name || seen[url]) continue;
        seen[url] = true;
        items.push({ title: name, subtitle: site.title, url: url });
        if (items.length >= 25) break;
      }
      if (!items.length) return Lampa.Noty.show(site.title + ': ничего не найдено');
      Lampa.Select.show({
        title: site.title + ': выберите фильм',
        items: items,
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { openKinokradTitle(choice, site, movie); }
      });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Поиск на ' + site.title + ' не ответил');
    });
  }

  function fallback(movie, message) {
    if (SITES.length === 1) return openKinokrad(SITES[0], movie, message);
    Lampa.Select.show({
      title: 'Откуда смотреть',
      items: SITES.map(function (site) {
        return { title: site.title, subtitle: site.subtitle, site: site };
      }),
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (choice) { openKinokrad(choice.site, movie); }
    });
  }

  function openKino(movie) {
    if (!queryFor(movie)) return Lampa.Noty.show('Не удалось определить название');
    openRezka(movie);
  }

  /* -------------------------------------------------------------------- */
  /* Кнопка на карточке фильма                                             */
  /* -------------------------------------------------------------------- */

  function addButton(event) {
    if (!event || event.type !== 'complite' || !event.object || !event.data || !event.data.movie) return;
    var root = event.object.activity.render();
    if (root.find('.view--kino-online').length) return;

    var button = $('<div class="full-start__button selector view--kino-online" data-subtitle="HDrezka + Kinokrad · ' + VERSION + '">' +
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 5h18v14H3zM5 7v10h14V7H5zm3 2 5 3-5 3V9z"/></svg>' +
      '<span>Кино онлайн</span>' +
    '</div>');
    button.on('hover:enter', function () { openKino(event.data.movie); });

    var anchor = root.find('.view--anime-online');
    if (!anchor.length) anchor = root.find('.view--torrent');
    if (anchor.length) anchor.after(button);
    else root.find('.full-start-new__buttons, .full-start__buttons').first().append(button);
  }

  Lampa.Listener.follow('full', addButton);

  /* Отладочный вход: можно вызвать из консоли — window.__kino.open({title:'Интерстеллар'}) */
  window.__kino = { version: VERSION, open: openKino, api: api, extractor: EXTRACTOR };

  Lampa.Manifest.plugins = {
    type: 'video',
    version: VERSION,
    name: 'Кино онлайн — ' + VERSION,
    description: 'Фильмы и сериалы: HDrezka прямым потоком, Kinokrad запасным',
    component: 'kino_online',
    onContextMenu: function () {
      return { name: 'Кино онлайн', description: 'HDrezka — прямой поток' };
    },
    onContextLauch: function (movie) { openKino(movie); }
  };

  console.log('[Kino Online] loaded', VERSION);
})();
