(function () {
  'use strict';

  if (window.anime_online_plugin) return;
  window.anime_online_plugin = true;

  var VERSION = '1.6.3';
  var API = 'https://anilibria.top/api/v1';
  var YUMMY_API = 'https://api.yani.tv';
  var ANI_MEDIA = 'https://ani-media.online';
  var YUMMY_TV = 'https://yummyanime.tv';
  var COMPONENT = 'anime_online';
  var KODIK_COMPONENT = 'anime_online_kodik';

  function text(value) {
    return $('<div>').text(value == null ? '' : String(value)).html();
  }

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

  function queryFor(movie) {
    return movie.title || movie.name || movie.original_title || movie.original_name || '';
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
      if (item.episodes_total) labels.push(item.episodes_total + ' эп.');
      return {
        title: item.name && item.name.main || 'Без названия',
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

  function requestYummy(path, success, error) {
    var token = String(Lampa.Storage.get('anime_online_yummy_token', '') || '').trim();
    var network = new Lampa.Reguest();
    network.timeout(15000);
    network.native(YUMMY_API + path, success, error, false, {
      headers: { 'X-Application': token, 'Lang': 'ru', 'Accept': 'application/json' }
    });
    return network;
  }

  function requestText(url, success, error, headers) {
    var network = new Lampa.Reguest();
    network.timeout(15000);
    network.native(url, success, error, false, { dataType: 'text', headers: headers || {} });
    return network;
  }

  function htmlValue(value) {
    return $('<textarea>').html(value || '').text().trim();
  }

  function openAniMedia(movie) {
    var query = queryFor(movie);
    if (!query) return Lampa.Noty.show('Не удалось определить название');
    Lampa.Loading.start();
    var url = ANI_MEDIA + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(query);
    requestText(url, function (html) {
      Lampa.Loading.stop();
      var block = String(html || '').split('<!-- DLE Search by https://lazydev.pro -->');
      block = block.length > 2 ? block[1] : String(html || '');
      var found = [];
      var seen = {};
      var re = /<a\s+href="([^"]+)"\s+class="new-anime__link"\s+title="([^"]+)"[\s\S]*?<span class="new-anime__series">([\s\S]*?)<\/span>/gi;
      var match;
      while ((match = re.exec(block))) {
        if (seen[match[1]]) continue;
        seen[match[1]] = true;
        found.push({ title: htmlValue(match[2]), subtitle: htmlValue(match[3]), url: match[1] });
      }
      if (!found.length) return Lampa.Noty.show('Аниме не найдено на Ani-Media');
      Lampa.Select.show({
        title: 'Ani-Media: выберите релиз', items: found,
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) { openAniMediaRelease(choice, movie); }
      });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось выполнить поиск на Ani-Media');
    });
  }

  function openAniMediaRelease(choice, movie) {
    Lampa.Loading.start();
    requestText(choice.url, function (html) {
      var iframe = String(html || '').match(/<iframe[^>]+(?:data-src|src)="((?:https?:)?\/\/[^\"]*kodik[^\"]+)"/i);
      if (!iframe) {
        Lampa.Loading.stop();
        return Lampa.Noty.show('У релиза нет совместимого плеера Kodik');
      }
      var playerUrl = iframe[1].indexOf('//') === 0 ? 'https:' + iframe[1] : iframe[1];
      openCatalogKodik(choice, movie, playerUrl, 'Ani-Media');
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось открыть релиз Ani-Media');
    });
  }

  function openCatalogKodik(choice, movie, playerUrl, sourceName, voiceName, voiceChosen) {
    requestText(playerUrl, function (playerHtml) {
      var rawPlayerHtml = String(playerHtml || '');
      var origin = (playerUrl.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://kodikplayer.com';
      var translations = [];
      var translationsBlock = rawPlayerHtml.match(/<div class="(?:serial-)?translations-box">[\s\S]*?<select>([\s\S]*?)<\/select>/i);
      if (translationsBlock) {
        var translationRe = /<option[\s\S]*?data-translation-type="([^"]+)"[\s\S]*?data-media-id="([^"]+)"[\s\S]*?data-media-hash="([^"]+)"[\s\S]*?data-media-type="([^"]+)"[\s\S]*?data-title="([^"]+)"[\s\S]*?data-episode-count="([^"]*)"[\s\S]*?>/gi;
        var translationMatch;
        while ((translationMatch = translationRe.exec(translationsBlock[1]))) {
          translations.push({
            title: htmlValue(translationMatch[5]),
            subtitle: (translationMatch[1] === 'subtitles' ? 'Субтитры' : 'Озвучка') +
              (translationMatch[6] ? ' · серии ' + translationMatch[6] : ''),
            player: origin + '/' + translationMatch[4] + '/' + translationMatch[2] + '/' + translationMatch[3] + '/720p'
          });
        }
      }
      if (!voiceChosen && translations.length > 1) {
        Lampa.Loading.stop();
        return Lampa.Select.show({
          title: sourceName + ': выберите озвучку',
          items: translations,
          onBack: function () { Lampa.Controller.toggle('content'); },
          onSelect: function (translation) {
            Lampa.Loading.start();
            openCatalogKodik(choice, movie, translation.player, sourceName, translation.title, true);
          }
        });
      }
      Lampa.Loading.stop();
      var material = { title: choice.title, link: playerUrl, translation: { title: voiceName || sourceName } };
      var seasons = {};
      var seasonRe = /<div class="season-([^\"]+)">([\s\S]*?)(?=<\/div>)/gi;
      var seasonMatch;
      while ((seasonMatch = seasonRe.exec(rawPlayerHtml))) {
        var episodes = {};
        var episodeRe = /<option[\s\S]*?value="([^"]+)"[\s\S]*?data-id="([^"]+)"[\s\S]*?data-hash="([^"]+)"[\s\S]*?>/gi;
        var episodeMatch;
        while ((episodeMatch = episodeRe.exec(seasonMatch[2]))) {
          episodes[episodeMatch[1]] = playerUrl + (playerUrl.indexOf('?') === -1 ? '?' : '&') +
            'season=' + encodeURIComponent(seasonMatch[1]) + '&episode=' + encodeURIComponent(episodeMatch[1]);
        }
        if (Object.keys(episodes).length) seasons[seasonMatch[1]] = { episodes: episodes };
      }
      if (Object.keys(seasons).length) {
        material.seasons = seasons;
        delete material.link;
      }
      Lampa.Activity.push({ url: '', title: choice.title, component: KODIK_COMPONENT, material: material, movie: movie });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось прочитать плеер ' + sourceName);
    });
  }

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
        var json;
        try { json = typeof answer === 'string' ? JSON.parse(answer) : answer; } catch (e) {}
        if (!json || !json.success || !json.data) {
          Lampa.Loading.stop();
          return Lampa.Noty.show('YummyAnime.TV не вернул ссылку плеера');
        }
        openCatalogKodik(choice, movie, String(json.data).replace(/\\\//g, '/'), 'YummyAnime.TV');
      }, function () {
        Lampa.Loading.stop();
        Lampa.Noty.show('Не удалось получить плеер YummyAnime.TV');
      }, { Referer: choice.url, Accept: 'application/json' });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось открыть релиз YummyAnime.TV');
    });
  }

  function openYummy(movie) {
    var token = String(Lampa.Storage.get('anime_online_yummy_token', '') || '').trim();
    if (!token) {
      Lampa.Noty.show('Укажите токен приложения YummyAnime в настройках «Аниме онлайн»');
      return;
    }
    var query = queryFor(movie);
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
      Lampa.Noty.show('Ошибка API YummyAnime или неверный токен');
    });
  }

  function openYummyRelease(anime, movie) {
    Lampa.Loading.start();
    requestYummy('/anime/' + encodeURIComponent(anime.anime_url || anime.anime_id) + '?need_videos=true', function (json) {
      Lampa.Loading.stop();
      var detail = json && json.response || {};
      var videos = Array.isArray(detail.videos) ? detail.videos : [];
      videos = videos.filter(function (video) {
        var player = video.data && video.data.player || '';
        return /kodik/i.test(player) || /kodik|aniqit/i.test(video.iframe_url || '');
      });
      if (!videos.length) return Lampa.Noty.show('В этом релизе нет совместимых потоков Kodik');
      Lampa.Select.show({
        title: 'YummyAnime: серия и озвучка',
        items: videos.map(function (video) {
          return {
            title: 'Серия ' + (video.number || video.index || '?'),
            subtitle: [video.data && video.data.dubbing, video.data && video.data.player].filter(Boolean).join(' · '),
            video: video
          };
        }),
        onBack: function () { Lampa.Controller.toggle('content'); },
        onSelect: function (choice) {
          var video = choice.video;
          Lampa.Activity.push({
            url: '', title: detail.title || anime.title, component: KODIK_COMPONENT,
            material: {
              title: detail.title || anime.title,
              link: video.iframe_url,
              translation: { title: video.data && video.data.dubbing || 'YummyAnime' }
            }, movie: movie
          });
        }
      });
    }, function () {
      Lampa.Loading.stop();
      Lampa.Noty.show('Не удалось получить серии YummyAnime');
    });
  }

  function openAnime(movie) {
    Lampa.Select.show({
      title: 'Источник аниме',
      items: [
        { title: 'AniLibria', subtitle: 'Без токена · прямые HLS-потоки', source: 'anilibria' },
        { title: 'YummyAnime', subtitle: 'Каталог и озвучки · требуется токен приложения', source: 'yummy' },
        { title: 'Ani-Media', subtitle: 'Без токена · каталог и серии через Kodik', source: 'animedia' },
        { title: 'YummyAnime.TV', subtitle: 'Без токена · каталог и серии через Kodik', source: 'yummytv' }
      ],
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (item) {
        if (item.source === 'yummy') openYummy(movie);
        else if (item.source === 'animedia') openAniMedia(movie);
        else if (item.source === 'yummytv') openYummyTv(movie);
        else openAniLibria(movie);
      }
    });
  }

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
        var number = episode.ordinal == null ? '?' : episode.ordinal;
        return {
          url: bestUrl(episode),
          title: (release.name && release.name.main || 'Аниме') + ' — серия ' + number,
          quality: qualityMap(episode),
          season: 1,
          episode: number
        };
      }).filter(function (entry) {
        return !!entry.url;
      });
    }

    function playEpisode(episode, playlist) {
      var url = bestUrl(episode);
      if (!url) return Lampa.Noty.show('Для этой серии нет видеопотока');

      var number = episode.ordinal == null ? '?' : episode.ordinal;
      var entry = {
        url: url,
        title: (release.name && release.name.main || 'Аниме') + ' — серия ' + number,
        quality: qualityMap(episode),
        season: 1,
        episode: number
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

  function KodikComponent(object) {
    var self = this;
    var network = new Lampa.Reguest();
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var last;
    var cachedPlayerScript = '';
    var cachedInfoUrl = '';

    function absolute(url, origin) {
      if (!url) return '';
      if (url.indexOf('//') === 0) return 'https:' + url;
      if (url.indexOf('/') === 0) return origin + url;
      return url;
    }

    function decodeLink(value) {
      try {
        if (/^(https?:)?\/\//.test(value)) return absolute(value, '');
        return atob(value.replace(/[a-zA-Z]/g, function (letter) {
          var code = letter.charCodeAt(0) + 18;
          var max = letter <= 'Z' ? 90 : 122;
          return String.fromCharCode(code <= max ? code : code - 26);
        }));
      } catch (e) { return ''; }
    }

    function extractStreams(playerLink, success, error) {
      var url = absolute(playerLink, '');
      var originMatch = url.match(/^(https?:\/\/[^/]+)/);
      var origin = originMatch ? originMatch[1] : 'https://kodikplayer.com';
      network.clear();
      network.timeout(15000);
      network.native(url, function (html) {
        html = String(html || '').replace(/\n/g, '');
        var paramsMatch = html.match(/\burlParams = '([^']+)'/);
        var type = html.match(/\b(?:videoInfo|vInfo)\.type = '([^']+)'/);
        var hash = html.match(/\b(?:videoInfo|vInfo)\.hash = '([^']+)'/);
        var id = html.match(/\b(?:videoInfo|vInfo)\.id = '([^']+)'/);
        var script = html.match(/<script[^>]*\bsrc=["'](\/assets\/js\/app\.(?:serial|single)\.[^"']+)["']/i) ||
          html.match(/<script[^>]*\bsrc=["'](\/assets\/js\/app\.player_single[^"']+)["']/i);
        var params;
        try { params = paramsMatch && JSON.parse(paramsMatch[1]); } catch (e) {}
        if (!params || !type || !hash || !id || !script) return error();
        var post = 'd=' + encodeURIComponent(params.d || '') +
          '&d_sign=' + encodeURIComponent(params.d_sign || '') +
          '&pd=' + encodeURIComponent(params.pd || '') +
          '&pd_sign=' + encodeURIComponent(params.pd_sign || '') +
          '&ref=' + encodeURIComponent(params.ref || '') +
          '&ref_sign=' + encodeURIComponent(params.ref_sign || '') +
          '&bad_user=true&cdn_is_working=true&type=' + encodeURIComponent(type[1]) +
          '&hash=' + encodeURIComponent(hash[1]) + '&id=' + encodeURIComponent(id[1]) + '&info=%7B%7D';
        var scriptUrl = origin + script[1];

        function getLinks() {
          network.clear();
          network.timeout(15000);
          network.native(cachedInfoUrl, function (json) {
            if (typeof json === 'string') {
              try { json = JSON.parse(json); } catch (e) { json = null; }
            }
            if (!json || !json.links) return error();
            var quality = {};
            Object.keys(json.links).forEach(function (key) {
              var row = json.links[key];
              var link = decodeLink(row && row[0] && row[0].src || '');
              if (link) quality[key + 'p'] = absolute(link, origin);
            });
            var keys = Object.keys(quality).sort(function (a, b) { return parseInt(b) - parseInt(a); });
            if (!keys.length) return error();
            success({ url: quality[keys[0]], quality: quality });
          }, error, post, {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'Accept': 'application/json'
            }
          });
        }

        if (cachedPlayerScript === scriptUrl && cachedInfoUrl) return getLinks();
        network.clear();
        network.native(scriptUrl, function (scriptText) {
          var info = String(scriptText || '').replace(/\n/g, '').match(/\$\.ajax\(\{type:\s*["']POST["'],\s*url:\s*atob\(["']([^"']+)["']\)/);
          try { cachedInfoUrl = info && absolute(atob(info[1]), origin); } catch (e) { cachedInfoUrl = ''; }
          if (!cachedInfoUrl) return error();
          cachedPlayerScript = scriptUrl;
          getLinks();
        }, error, false, { dataType: 'text' });
      }, error, false, { dataType: 'text' });
    }

    function flatten(material) {
      var rows = [];
      if (material.seasons) {
        Object.keys(material.seasons).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (season) {
          var episodes = material.seasons[season] && material.seasons[season].episodes || {};
          Object.keys(episodes).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (episode) {
            rows.push({ season: season, episode: episode, link: episodes[episode] });
          });
        });
      } else if (material.link) rows.push({ season: '', episode: '', link: material.link });
      return rows;
    }

    function play(row) {
      Lampa.Loading.start();
      extractStreams(row.link, function (stream) {
        Lampa.Loading.stop();
        var label = row.episode ? 'Сезон ' + row.season + ' · серия ' + row.episode : object.material.title;
        var entry = { url: stream.url, quality: stream.quality, title: label };
        Lampa.Player.play(entry);
        Lampa.Player.playlist([entry]);
      }, function () {
        Lampa.Loading.stop();
        Lampa.Noty.show('Kodik не отдал прямой видеопоток');
      });
    }

    function append(row) {
      var label = row.episode ? 'Сезон ' + row.season + ' · серия ' + row.episode : (object.material.title || 'Смотреть');
      var voice = object.material.translation && object.material.translation.title || 'Kodik';
      var item = $('<div class="online selector"><div class="online__body">' +
        '<div class="online__title">' + text(label) + '</div>' +
        '<div class="online__quality">Kodik · ' + text(voice) + '</div></div></div>');
      item.on('hover:focus', function (event) { last = event.target; scroll.update($(event.target), true); });
      item.on('hover:enter', function () { play(row); });
      scroll.append(item);
    }

    this.create = function () {
      files.appendFiles(scroll.render());
      var rows = flatten(object.material || {});
      if (!rows.length) {
        var empty = Lampa.Template.get('list_empty');
        empty.find('.empty__descr').text('У выбранной озвучки нет серий');
        scroll.append(empty);
      } else rows.forEach(append);
      this.start(true);
    };
    this.start = function (first) {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (first) last = scroll.render().find('.selector').eq(0)[0];
      if (object.movie) Lampa.Background.immediately(Lampa.Utils.cardImgBackground(object.movie));
      Lampa.Controller.add('content', {
        toggle: function () { Lampa.Controller.collectionSet(scroll.render(), files.render()); Lampa.Controller.collectionFocus(last || false, scroll.render()); },
        up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
        down: function () { Navigator.move('down'); }, right: function () { Navigator.move('right'); },
        left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
        back: this.back
      });
      Lampa.Controller.toggle('content');
    };
    this.render = function () { return files.render(); };
    this.back = function () { Lampa.Activity.backward(); };
    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () { network.clear(); scroll.destroy(); files.destroy(); };
  }

  function addButton(event) {
    if (!event || event.type !== 'complite' || !event.object || !event.data || !event.data.movie) return;
    var root = event.object.activity.render();
    if (root.find('.view--anime-online').length) return;

    var button = $('<div class="full-start__button selector view--anime-online" data-subtitle="4 источника · ' + VERSION + '">' +
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
        '<div class="settings-param__name">Токен приложения YummyAnime</div>' +
        '<div class="settings-param__value"></div>' +
        '<div class="settings-param__descr">Создаётся на yummyani.me/dev/applications; хранится локально в Lampa</div>' +
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
  Lampa.Component.add(KODIK_COMPONENT, KodikComponent);
  Lampa.Listener.follow('full', addButton);
  addSettings();
  Lampa.Manifest.plugins = {
    type: 'video',
    version: VERSION,
    name: 'Аниме онлайн — ' + VERSION,
    description: 'Просмотр аниме через AniLibria, YummyAnime, Ani-Media и YummyAnime.TV',
    component: COMPONENT,
    onContextMenu: function () {
      return { name: 'Аниме онлайн', description: 'AniLibria + YummyAnime + Ani-Media + YummyAnime.TV' };
    },
    onContextLauch: function (movie) { openAnime(movie); }
  };

  console.log('[Anime Online] loaded', VERSION);
})();
