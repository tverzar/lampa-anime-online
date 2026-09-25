(function () {
  'use strict';

  if (window.anime_online_plugin) return;
  window.anime_online_plugin = true;

  var VERSION = '1.12.0';
  var API = 'https://anilibria.top/api/v1';
  var YUMMY_API = 'https://api.yani.tv';
  var YUMMY_TV = 'https://yummyanime.tv';
  var CORS_PROXY = 'https://lampa-anime-proxy.rammthaok.workers.dev/proxy?url=';
  var COMPONENT = 'anime_online';
  var FRAME_CONTROLLER = 'anime_online_frame';
  var FRAME_STYLE = 'anime_online_frame_style';

  function text(value) {
    return $('<div>').text(value == null ? '' : String(value)).html();
  }

  function proxyUrl(url) {
    return CORS_PROXY + encodeURIComponent(url);
  }

  function absolute(url) {
    if (!url) return '';
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.indexOf('/') === 0) return 'https://kodikplayer.com' + url;
    return url;
  }

  function queryFor(movie) {
    return movie.title || movie.name || movie.original_title || movie.original_name || '';
  }

  function seriesCountLabel(count) {
    count = parseInt(count, 10) || 0;
    var lastTwo = count % 100;
    var last = count % 10;
    var word = lastTwo >= 11 && lastTwo <= 14 ? 'серий' : last === 1 ? 'серию' : last >= 2 && last <= 4 ? 'серии' : 'серий';
    return count + ' ' + word;
  }

  function episodeTimeline(movie, season, episode) {
    var episodeNumber = Number(episode);
    if (!movie || !isFinite(episodeNumber) || episodeNumber < 1 || !Lampa.Timeline || !Lampa.Timeline.watchedEpisode) return null;
    try {
      return Lampa.Timeline.watchedEpisode(movie, Number(season) || 1, episodeNumber, true);
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------------------------------- */
  /* Полноэкранное окно с плеером Kodik.                                   */
  /*                                                                       */
  /* Прямые потоки из Kodik извлечь нельзя: kodikplayer.com не отдаёт       */
  /* CORS-заголовки (прямой XHR из Lampa режется браузером), а через        */
  /* CORS-прокси его эндпоинт /ftor отвечает 500. Поэтому плеер Kodik       */
  /* открывается как iframe — iframe не подчиняется CORS.                   */
  /* -------------------------------------------------------------------- */

  function frameStyles() {
    if ($('#' + FRAME_STYLE).length) return;
    var css = '' +
      '.anime-online-frame{position:fixed;top:0;right:0;bottom:0;left:0;z-index:200;background:#000;display:flex;flex-direction:column;}' +
      '.anime-online-frame__bar{display:flex;align-items:center;padding:.5em 1em;background:rgba(0,0,0,.9);z-index:3;}' +
      '.anime-online-frame__title{flex:1;font-size:1.1em;color:#fff;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-right:1em;}' +
      '.anime-online-frame__button{margin-left:.6em;padding:.4em 1.1em;border-radius:.4em;background:rgba(255,255,255,.14);color:#fff;font-size:1em;white-space:nowrap;transition:background .15s,color .15s;}' +
      '.anime-online-frame__button.focus{background:#fff;color:#000;}' +
      '.anime-online-frame__body{flex:1;position:relative;background:#000;}' +
      '.anime-online-frame__window{position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000;}';
    $('head').append($('<style id="' + FRAME_STYLE + '"></style>').text(css));
  }

  function showFrame(url, title, onBack) {
    var link = absolute(url);
    if (!link) return Lampa.Noty.show('Не удалось получить ссылку на плеер');

    frameStyles();

    var html = $('<div class="anime-online-frame">' +
      '<div class="anime-online-frame__bar">' +
        '<div class="anime-online-frame__title"></div>' +
        '<div class="anime-online-frame__button selector anime-online-frame__player">В плеер</div>' +
        '<div class="anime-online-frame__button selector anime-online-frame__close">Назад</div>' +
      '</div>' +
      '<div class="anime-online-frame__body">' +
        '<iframe class="anime-online-frame__window" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" frameborder="0" scrolling="no"></iframe>' +
      '</div>' +
    '</div>');

    html.find('.anime-online-frame__title').text(title || 'Аниме онлайн');
    html.find('.anime-online-frame__window').attr('src', link);
    $('body').append(html);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      html.find('.anime-online-frame__window').attr('src', 'about:blank');
      html.remove();
      if (onBack) onBack();
    }

    function focusPlayer() {
      var frame = html.find('.anime-online-frame__window')[0];
      if (frame) frame.focus();
    }

    html.find('.anime-online-frame__close').on('hover:enter', close).on('click', close);
    html.find('.anime-online-frame__player').on('hover:enter', focusPlayer).on('click', focusPlayer);

    Lampa.Controller.add(FRAME_CONTROLLER, {
      toggle: function () {
        Lampa.Controller.collectionSet(html);
        Lampa.Controller.collectionFocus(html.find('.anime-online-frame__close')[0], html);
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
  /* AniLibria — прямые HLS-потоки, без прокси и токена                    */
  /* -------------------------------------------------------------------- */

  function request(path, success, error) {
    var network = new Lampa.Reguest();
    network.timeout(15000);
    network.silent(API + path, function (data) {
      success(data);
    }, function () {
      if (error) error();
    });
    return network;
  }

  function findReleases(movie, success, error) {
    var variants = [];
    [movie.title, movie.name, movie.original_title, movie.original_name].forEach(function (value) {
      if (value && variants.indexOf(value) === -1) variants.push(value);
    });

    function next() {
      if (!variants.length) return error();
      var query = variants.shift();
      request('/app/search/releases?query=' + encodeURIComponent(query), function (items) {
        if (Array.isArray(items) && items.length) success(items, query);
        else next();
      }, next);
    }

    next();
  }

  function chooseRelease(items, movie) {
    var choices = items.slice(0, 20).map(function (item) {
      var labels = [];
      if (item.year) labels.push(item.year);
      if (item.type && item.type.description) labels.push(item.type.description);
      var title = item.name && item.name.main || 'Без названия';
      if (item.episodes_total) title += ' (' + seriesCountLabel(item.episodes_total) + ')';
      return {
        title: title,
        subtitle: labels.join(' · '),
        release: item
      };
    });

    Lampa.Select.show({
      title: 'Выберите аниме',
      items: choices,
      onBack: function () {
        Lampa.Controller.toggle('content');
      },
      onSelect: function (choice) {
        Lampa.Activity.push({
          url: '',
          title: choice.title,
          component: COMPONENT,
          release_id: choice.release.id,
          movie: movie
        });
      }
    });
  }

  function openAniLibria(movie) {
    Lampa.Loading.start();
    findReleases(movie, function (items) {
      Lampa.Loading.stop();
      chooseRelease(items, movie);
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Аниме не найдено в AniLibria');
    });
  }

  /* -------------------------------------------------------------------- */
  /* Транспорт для HTML/JSON источников: сначала CORS-прокси, при неудаче  */
  /* — прямой запрос.                                                      */
  /* -------------------------------------------------------------------- */

  function requestText(url, success, error, headers) {
    var network = new Lampa.Reguest();
    network.timeout(15000);
    var options = { dataType: 'text', headers: headers || {} };
    network.native(proxyUrl(url), success, function () {
      network.clear();
      network.timeout(15000);
      network.native(url, success, error, false, options);
    }, false, options);
    return network;
  }

  function htmlValue(value) {
    return $('<textarea>').html(value || '').text().trim();
  }

  /* -------------------------------------------------------------------- */
  /* YummyAnime.TV — открытый AJAX сайта отдаёт ссылку на плеер Kodik      */
  /* -------------------------------------------------------------------- */

  function openYummyTv(movie) {
    var query = queryFor(movie);
    if (!query) return Lampa.Noty.show('Не удалось определить название');
    Lampa.Loading.start();
    requestText(YUMMY_TV + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(query), function (html) {
      Lampa.Loading.stop();
      var found = [];
      var seen = {};
      var re = /<a class="movie-item__link" href="([^"]+)">[\s\S]*?<div class="movie-item__label [^"]+">([\s\S]*?)<\/div>[\s\S]*?<div class="movie-item__title" title="([^"]+)">/gi;
      var match;
      while ((match = re.exec(String(html || ''))) && found.length < 50) {
        var url = match[1].indexOf('http') === 0 ? match[1] : YUMMY_TV + match[1];
        if (seen[url]) continue;
        seen[url] = true;
        found.push({ url: url, title: htmlValue(match[3]), subtitle: htmlValue(match[2]) });
      }
      if (!found.length) return Lampa.Noty.show('Аниме не найдено на YummyAnime.TV');
      Lampa.Select.show({
        title: 'YummyAnime.TV: выберите релиз', items: found,
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { openYummyTvRelease(choice, movie); }
      });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось выполнить поиск на YummyAnime.TV');
    });
  }

  function openYummyTvRelease(choice, movie) {
    Lampa.Loading.start();
    requestText(choice.url, function (html) {
      var params = String(html || '').match(/class="xfplayer"[^>]+data-params="([^"]*mod=kodik-player[^"]*)"/i);
      if (!params) {
        Lampa.Loading.stop();
        return Lampa.Noty.show('У релиза нет совместимого плеера Kodik');
      }
      var query = htmlValue(params[1]);
      requestText(YUMMY_TV + '/engine/ajax/controller.php?' + query, function (answer) {
        Lampa.Loading.stop();
        var json;
        try { json = typeof answer === 'string' ? JSON.parse(answer) : answer; } catch (e) {}
        if (!json || !json.success || !json.data) return Lampa.Noty.show('YummyAnime.TV не вернул ссылку плеера');
        showFrame(String(json.data).replace(/\\\//g, '/'), 'YummyAnime.TV · ' + choice.title, function () {
          Lampa.Controller.toggle('content');
        });
      }, function () {
        Lampa.Loading.stop();
        Lampa.Noty.show('Не удалось получить плеер YummyAnime.TV');
      }, { Referer: choice.url, Accept: 'application/json' });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось открыть релиз YummyAnime.TV');
    });
  }

  /* -------------------------------------------------------------------- */
  /* YummyAnime (api.yani.tv) — требует личный токен приложения            */
  /* -------------------------------------------------------------------- */

  function yummyToken() {
    return String(Lampa.Storage.get('anime_online_yummy_token', '') || '').trim();
  }

  /* Токен приложения сейчас не обязателен: api.yani.tv отвечает и без него.
     Заголовок отправляем только если токен задан в настройках. */
  function requestYummy(path, success, error) {
    var headers = { 'Lang': 'ru', 'Accept': 'application/json' };
    var token = yummyToken();
    if (token) headers['X-Application'] = token;
    var network = new Lampa.Reguest();
    network.timeout(20000);
    network.native(proxyUrl(YUMMY_API + path), success, error, false, { headers: headers });
    return network;
  }

  function openYummy(movie) {
    var query = queryFor(movie);
    if (!query) return Lampa.Noty.show('Не удалось определить название');
    Lampa.Loading.start();
    requestYummy('/anime?q=' + encodeURIComponent(query) + '&limit=30&offset=0', function (json) {
      Lampa.Loading.stop();
      var items = json && Array.isArray(json.response) ? json.response : [];
      if (!items.length) return Lampa.Noty.show('Аниме не найдено в YummyAnime');
      items = items.slice().sort(function (a, b) {
        var yearA = parseInt(a && a.year, 10) || 0;
        var yearB = parseInt(b && b.year, 10) || 0;
        return yearB - yearA;
      });
      Lampa.Select.show({
        title: 'YummyAnime: выберите релиз',
        items: items.map(function (item) {
          return {
            title: item.title || 'Без названия',
            subtitle: [item.year, item.type && item.type.name].filter(Boolean).join(' · '),
            anime: item
          };
        }),
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { openYummyRelease(choice.anime, movie); }
      });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('API YummyAnime не ответил — возможно, нужен токен в настройках «Аниме онлайн»');
    });
  }

  /* У одной серии бывает несколько плееров — берём наиболее удобный для встраивания. */
  var PLAYER_ORDER = ['alloha', 'kodik', 'cvh', 'sibnet'];

  function playerRank(video) {
    var probe = (String(video.iframe_url || '') + ' ' + String(video.data && video.data.player || '')).toLowerCase();
    for (var i = 0; i < PLAYER_ORDER.length; i++) {
      if (probe.indexOf(PLAYER_ORDER[i]) !== -1) return i;
    }
    return PLAYER_ORDER.length;
  }

  function openYummyRelease(anime, movie) {
    Lampa.Loading.start();
    requestYummy('/anime/' + encodeURIComponent(anime.anime_url || anime.anime_id) + '?need_videos=true', function (json) {
      Lampa.Loading.stop();
      var detail = json && json.response || {};
      var videos = Array.isArray(detail.videos) ? detail.videos : [];
      videos = videos.filter(function (video) {
        return !!video.iframe_url;
      });
      if (!videos.length) return Lampa.Noty.show('В этом релизе нет встраиваемых плееров');
      var voices = {};
      videos.forEach(function (video) {
        var name = String(video.data && video.data.dubbing || 'Озвучка не указана').trim();
        var key = name.toLocaleLowerCase();
        if (!voices[key]) voices[key] = { name: name, videos: {} };
        var number = video.number != null ? String(video.number) : video.index != null ? String(video.index) : String(Object.keys(voices[key].videos).length + 1);
        var current = voices[key].videos[number];
        if (!current || playerRank(video) < playerRank(current)) voices[key].videos[number] = video;
      });
      var voiceChoices = Object.keys(voices).map(function (key) {
        var voice = voices[key];
        var numbers = Object.keys(voice.videos).sort(function (a, b) {
          return (parseFloat(a) || 0) - (parseFloat(b) || 0);
        });
        var first = numbers.length ? voice.videos[numbers[0]] : null;
        return {
          title: voice.name + ' (' + seriesCountLabel(numbers.length) + ')',
          subtitle: first && first.data && first.data.player || 'Плеер YummyAnime',
          voice: voice,
          count: numbers.length
        };
      }).sort(function (a, b) { return b.count - a.count; });

      function showVoices() {
        Lampa.Select.show({
          title: 'YummyAnime: выберите озвучку',
          items: voiceChoices,
          onBack: function () { Lampa.Controller.toggle('content'); },
          onSelect: function (choice) { showEpisodes(choice.voice); }
        });
      }

      function showEpisodes(voice) {
        var episodes = Object.keys(voice.videos).sort(function (a, b) {
          var numberA = parseFloat(a);
          var numberB = parseFloat(b);
          if (!isNaN(numberA) && !isNaN(numberB)) return numberA - numberB;
          return a.localeCompare(b, 'ru');
        }).map(function (number) {
          return { number: number, video: voice.videos[number] };
        });
        Lampa.Select.show({
          title: 'YummyAnime: выберите серию',
          items: episodes.map(function (episode) {
            return { title: 'Серия ' + episode.number, subtitle: voice.name, video: episode.video, number: episode.number };
          }),
          onBack: showVoices,
          onSelect: function (episode) {
            showFrame(episode.video.iframe_url, (detail.title || anime.title) + ' · серия ' + episode.number, function () {
              Lampa.Controller.toggle('content');
            });
          }
        });
      }

      showVoices();
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось получить серии YummyAnime');
    });
  }

  /* -------------------------------------------------------------------- */
  /* Меню источников                                                       */
  /* -------------------------------------------------------------------- */

  function openAnime(movie) {
    Lampa.Select.show({
      title: 'Источник аниме',
      items: [
        { title: 'AniLibria', subtitle: 'Без токена · прямые HLS-потоки', source: 'anilibria' },
        { title: 'YummyAnime.TV', subtitle: 'Без токена · плеер Kodik в окне Lampa', source: 'yummytv' },
        { title: 'YummyAnime', subtitle: 'Без токена · озвучки Alloha, Kodik и Sibnet в окне', source: 'yummy' }
      ],
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (item) {
        if (item.source === 'yummytv') openYummyTv(movie);
        else if (item.source === 'yummy') openYummy(movie);
        else openAniLibria(movie);
      }
    });
  }

  /* -------------------------------------------------------------------- */
  /* Список серий AniLibria                                                */
  /* -------------------------------------------------------------------- */

  function AnimeComponent(object) {
    var self = this;
    var network = new Lampa.Reguest();
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var last;
    var release;

    function qualityMap(episode) {
      var result = {};
      if (episode.hls_1080) result['1080p'] = episode.hls_1080;
      if (episode.hls_720) result['720p'] = episode.hls_720;
      if (episode.hls_480) result['480p'] = episode.hls_480;
      return result;
    }

    function bestUrl(episode) {
      return episode.hls_1080 || episode.hls_720 || episode.hls_480 || '';
    }

    function makePlaylist(episodes) {
      return episodes.map(function (episode) {
        var number = episode.ordinal == null ? '' : episode.ordinal;
        var label = number === '' ? '?' : number;
        return {
          url: bestUrl(episode),
          title: (release.name && release.name.main || 'Аниме') + ' — серия ' + label,
          quality: qualityMap(episode),
          season: 1,
          episode: number || undefined,
          card: object.movie,
          timeline: episodeTimeline(object.movie, 1, number)
        };
      }).filter(function (entry) {
        return !!entry.url;
      });
    }

    function playEpisode(episode, playlist) {
      var url = bestUrl(episode);
      if (!url) return Lampa.Noty.show('Для этой серии нет видеопотока');

      var number = episode.ordinal == null ? '' : episode.ordinal;
      var label = number === '' ? '?' : number;
      var entry = {
        url: url,
        title: (release.name && release.name.main || 'Аниме') + ' — серия ' + label,
        quality: qualityMap(episode),
        season: 1,
        episode: number || undefined,
        card: object.movie,
        timeline: episodeTimeline(object.movie, 1, number)
      };
      entry.playlist = playlist;
      Lampa.Player.play(entry);
      Lampa.Player.playlist(playlist);
    }

    function appendEpisode(episode, playlist) {
      var number = episode.ordinal == null ? '?' : episode.ordinal;
      var available = [];
      if (episode.hls_1080) available.push('1080p');
      if (episode.hls_720) available.push('720p');
      if (episode.hls_480) available.push('480p');
      var title = 'Серия ' + number + (episode.name ? ' — ' + episode.name : '');
      var item = $('<div class="online selector anime-online__episode">' +
        '<div class="online__body">' +
          '<div class="online__title">' + text(title) + '</div>' +
          '<div class="online__quality">AniLibria · ' + text(available.join(', ')) + '</div>' +
        '</div>' +
      '</div>');

      item.on('hover:focus', function (event) {
        last = event.target;
        scroll.update($(event.target), true);
      });
      item.on('hover:enter', function () {
        playEpisode(episode, playlist);
      });
      scroll.append(item);
    }

    function showEmpty(message) {
      var empty = Lampa.Template.get('list_empty');
      empty.find('.empty__descr').text(message);
      scroll.append(empty);
    }

    function load() {
      Lampa.Loading.start();
      network.timeout(15000);
      network.silent(API + '/anime/releases/' + encodeURIComponent(object.release_id), function (data) {
        Lampa.Loading.stop();
        release = data || {};
        var episodes = Array.isArray(release.episodes) ? release.episodes.slice() : [];
        episodes.sort(function (a, b) { return Number(a.ordinal) - Number(b.ordinal); });
        var playlist = makePlaylist(episodes);
        if (!episodes.length) showEmpty('У релиза пока нет доступных серий');
        else episodes.forEach(function (episode) { appendEpisode(episode, playlist); });
        self.start(true);
      }, function () {
        Lampa.Loading.stop();
        showEmpty('Не удалось получить серии AniLibria');
        self.start(true);
      });
    }

    this.create = function () {
      files.appendFiles(scroll.render());
      load();
    };

    this.start = function (first) {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (first) last = scroll.render().find('.selector').eq(0)[0];
      if (object.movie) Lampa.Background.immediately(Lampa.Utils.cardImgBackground(object.movie));
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
      network.clear();
      scroll.destroy();
      files.destroy();
    };
  }

  /* -------------------------------------------------------------------- */
  /* Кнопка на карточке и настройки                                        */
  /* -------------------------------------------------------------------- */

  function addButton(event) {
    if (!event || event.type !== 'complite' || !event.object || !event.data || !event.data.movie) return;
    var root = event.object.activity.render();
    if (root.find('.view--anime-online').length) return;

    var button = $('<div class="full-start__button selector view--anime-online" data-subtitle="3 источника · ' + VERSION + '">' +
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>' +
      '<span>Аниме онлайн</span>' +
    '</div>');
    button.on('hover:enter', function () { openAnime(event.data.movie); });

    var anchor = root.find('.view--torrent');
    if (anchor.length) anchor.after(button);
    else root.find('.full-start-new__buttons, .full-start__buttons').first().append(button);
  }

  function addSettings() {
    Lampa.Params.select('anime_online_yummy_token', '', '');
    Lampa.Template.add('settings_anime_online', '<div>' +
      '<div class="settings-param selector" data-name="anime_online_yummy_token" data-type="input" data-string="true" placeholder="X-Application token">' +
        '<div class="settings-param__name">Токен приложения YummyAnime (не обязателен)</div>' +
        '<div class="settings-param__value"></div>' +
        '<div class="settings-param__descr">Необязательно: API YummyAnime отвечает и без токена. Токен (yummyani.me/dev/applications) хранится локально в Lampa и уходит только на api.yani.tv</div>' +
      '</div></div>');

    function insertFolder() {
      if (!Lampa.Settings.main || !Lampa.Settings.main() || Lampa.Settings.main().render().find('[data-component="anime_online"]').length) return;
      var folder = $('<div class="settings-folder selector" data-component="anime_online">' +
        '<div class="settings-folder__icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></div>' +
        '<div class="settings-folder__name">Аниме онлайн</div></div>');
      Lampa.Settings.main().render().find('[data-component="more"]').after(folder);
      Lampa.Settings.main().update();
    }
    if (window.appready) insertFolder();
    else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') insertFolder(); });
  }

  Lampa.Component.add(COMPONENT, AnimeComponent);
  Lampa.Listener.follow('full', addButton);
  addSettings();
  Lampa.Manifest.plugins = {
    type: 'video',
    version: VERSION,
    name: 'Аниме онлайн — ' + VERSION,
    description: 'Просмотр аниме через AniLibria, YummyAnime.TV и YummyAnime',
    component: COMPONENT,
    onContextMenu: function () {
      return { name: 'Аниме онлайн', description: 'AniLibria + YummyAnime.TV + YummyAnime' };
    },
    onContextLauch: function (movie) { openAnime(movie); }
  };

  console.log('[Anime Online] loaded', VERSION);
})();
