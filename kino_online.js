(function () {
  'use strict';

  if (window.kino_online_plugin) return;
  window.kino_online_plugin = true;

  var VERSION = '1.0.0';
  var CORS_PROXY = 'https://lampa-anime-proxy.rammthaok.workers.dev/proxy?url=';
  var FRAME_CONTROLLER = 'kino_online_frame';
  var FRAME_STYLE = 'kino_online_frame_style';

  /* -------------------------------------------------------------------- */
  /* Источники.                                                            */
  /*                                                                       */
  /* Поток здесь получить нельзя: сайты кинотеатров не отдают CORS и       */
  /* прячут ссылки за сессионными токенами. Поэтому плеер открывается      */
  /* отдельным окном (iframe) — iframe не подчиняется CORS, а ссылку на    */
  /* плеер плагин берёт из свежей HTML-страницы фильма, чтобы токен был    */
  /* актуальным. Плееры Alloha и другие CDN отвечают только при наличии    */
  /* Referer, поэтому открывать их нужно именно окном, а не копировать     */
  /* ссылку в адресную строку.                                             */
  /* -------------------------------------------------------------------- */

  var SITES = [
    {
      id: 'kinokrad',
      title: 'Kinokrad',
      subtitle: 'фильмы и сериалы · без токена',
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

  function proxyUrl(url) {
    return CORS_PROXY + encodeURIComponent(url);
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

  /* -------------------------------------------------------------------- */
  /* Полноэкранное окно с плеером                                          */
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

  function showFrame(url, title, hint, onBack) {
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
      if (onBack) onBack();
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
      up: function () {},
      down: function () {},
      left: function () {},
      right: function () {},
      back: close
    });
    Lampa.Controller.toggle(FRAME_CONTROLLER);
  }

  /* -------------------------------------------------------------------- */
  /* Запросы через CORS-прокси (на телевизоре прямой запрос не проходит)   */
  /* -------------------------------------------------------------------- */

  function requestText(url, success, error) {
    var network = new Lampa.Reguest();
    network.timeout(15000);
    var options = { dataType: 'text', headers: { 'Accept-Language': 'ru,en;q=0.8' } };
    network.native(proxyUrl(url), success, function () {
      network.clear();
      network.timeout(15000);
      network.native(url, success, error, false, options);
    }, false, options);
    return network;
  }

  function requestHtml(url, success, error) {
    requestText(url, function (response) {
      var html = typeof response === 'string' ? response : (response && response.responseText) || '';
      if (!html || html.length < 200) return error();
      success(html);
    }, error);
  }

  /* -------------------------------------------------------------------- */
  /* Разбор страницы поиска и страницы фильма                              */
  /* -------------------------------------------------------------------- */

  function findTitles(site, movie, success, error) {
    var query = queryFor(movie);
    if (!query) return error('Не удалось определить название');

    requestHtml(site.search(query), function (html) {
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
      if (!items.length) return error('Ничего не найдено');
      success(items);
    }, function () {
      error('Поиск не ответил');
    });
  }

  /* Плееры Alloha и родственные им отдают видео только когда знают домен
     площадки: без параметра d они отвечают «запрашиваемый контент не найден».
     Берём значение d из ссылок самой страницы, иначе — из домена источника. */

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

  function choosePlayer(players, title, movie) {
    if (players.length === 1) {
      return showFrame(players[0].url, title, players[0].host, function () {
        Lampa.Controller.toggle('content');
      });
    }
    Lampa.Select.show({
      title: 'Выберите плеер',
      items: players.map(function (player, index) {
        return { title: 'Плеер ' + (index + 1), subtitle: player.host, player: player };
      }),
      onBack: function () {
        Lampa.Controller.toggle('content');
      },
      onSelect: function (choice) {
        showFrame(choice.player.url, title, choice.player.host, function () {
          Lampa.Controller.toggle('content');
        });
      }
    });
  }

  function openTitle(item, site, movie) {
    Lampa.Loading.start();
    requestHtml(item.url, function (html) {
      Lampa.Loading.stop();
      var domain = pageDomain(html, site);
      var players = extractPlayers(html).map(function (player) {
        player.url = withDomain(player.url, domain);
        return player;
      });
      if (!players.length) return Lampa.Noty.show('На этой странице плеер не найден — выберите другой результат');
      var year = yearFor(movie);
      var title = item.title + (year && item.title.indexOf(year) === -1 ? ' · ' + year : '');
      choosePlayer(players, title, movie);
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось открыть страницу фильма');
    });
  }

  function openSource(site, movie) {
    Lampa.Loading.start();
    findTitles(site, movie, function (items) {
      Lampa.Loading.stop();
      Lampa.Select.show({
        title: site.title + ': выберите фильм',
        items: items,
        onBack: function () {
          Lampa.Controller.toggle('content');
        },
        onSelect: function (choice) {
          openTitle(choice, site, movie);
        }
      });
    }, function (message) {
      Lampa.Loading.stop();
      Lampa.Noty.show(site.title + ': ' + (message || 'ничего не найдено'));
    });
  }

  function openKino(movie) {
    if (!queryFor(movie)) return Lampa.Noty.show('Не удалось определить название');

    if (SITES.length === 1) return openSource(SITES[0], movie);

    Lampa.Select.show({
      title: 'Откуда смотреть',
      items: SITES.map(function (site) {
        return { title: site.title, subtitle: site.subtitle, site: site };
      }),
      onBack: function () {
        Lampa.Controller.toggle('content');
      },
      onSelect: function (choice) {
        openSource(choice.site, movie);
      }
    });
  }

  /* -------------------------------------------------------------------- */
  /* Кнопка на карточке фильма                                             */
  /* -------------------------------------------------------------------- */

  function addButton(event) {
    if (!event || event.type !== 'complite' || !event.object || !event.data || !event.data.movie) return;
    var root = event.object.activity.render();
    if (root.find('.view--kino-online').length) return;

    var button = $('<div class="full-start__button selector view--kino-online" data-subtitle="Kinokrad · ' + VERSION + '">' +
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

  Lampa.Manifest.plugins = {
    type: 'video',
    version: VERSION,
    name: 'Кино онлайн — ' + VERSION,
    description: 'Фильмы и сериалы из онлайн-кинотеатра Kinokrad',
    component: 'kino_online',
    onContextMenu: function () {
      return { name: 'Кино онлайн', description: 'Kinokrad — фильмы и сериалы' };
    },
    onContextLauch: function (movie) { openKino(movie); }
  };

  console.log('[Kino Online] loaded', VERSION);
})();
