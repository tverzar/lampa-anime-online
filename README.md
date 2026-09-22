# Lampa Anime Online

Плагин для просмотра аниме в Lampa.

Источники:

- AniLibria
- YummyAnime
- Ani-Media
- YummyAnime.TV

## Установка

Откройте в Lampa раздел добавления плагина и укажите прямую ссылку:

```text
https://tverzar.github.io/lampa-anime-online/anime_online.js
```

Для AniLibria, Ani-Media и YummyAnime.TV отдельный токен не требуется. Токен приложения YummyAnime при необходимости задаётся в настройках плагина.

## Прокси Cloudflare

`worker.js` — CORS-прокси для работы плагина на Apple TV. Он принимает запросы только к Ani-Media, YummyAnime, YummyAnime.TV и доменам Kodik. Адрес Worker:

```text
https://lampa-anime-proxy.rammthaok.workers.dev/proxy
```

Чтобы обновить Worker, выполните `npx wrangler deploy` из этой папки после входа в Cloudflare через Wrangler.
