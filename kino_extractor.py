#!/usr/bin/env python3
"""kino-extractor — серверный экстрактор HDrezka (Rezka) для плагина Lampa.

Что делает:
  * проходит антибот Anubis (proof-of-work techaro.lol) на hdrezka-home.tv;
  * ищет фильмы и сериалы, разбирает переводы/сезоны/серии;
  * достаёт прямую ссылку на HLS через /ajax/get_cdn_series/;
  * подставляет в CF-Connecting-IP адрес заказчика: сайт отдаёт поток только
    клиентам из РФ/СНГ, а CDN потом сверяет IP того, кто запрашивает ссылку.
    Поэтому видео должен качать сам плагин, а не этот сервис.
  * минтит прямые HLS-ссылки плеера Kodik (озвучки/серии нового YummyAnime):
    ссылки Kodik не привязаны к IP, поэтому их отдаём плагину как есть.

Запуск: python3 kino_extractor.py --config /etc/kino-extractor.json
Ручки:  /kino/<token>/{health,search,info,episodes,stream,kodik,kodik_stream}
"""
import argparse
import base64
from datetime import datetime
import gzip
import hashlib
import http.cookiejar
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.6.2"
BASE = "https://hdrezka-home.tv"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
FALLBACK_GEO = "5.16.4.4"
NULL = b"\x00"
LOG_LOCK = threading.Lock()

TRANSLATOR_ELEMENT = re.compile(r'<(a|li)\b([^>]*data-translator_id="(\d+)"[^>]*)>([\s\S]{0,200}?)</\1>')
SEASON = re.compile(r'data-tab_id="(\d+)"[^>]*>([^<]{1,40})<')
EPISODE = re.compile(r'data-episode_id="(\d+)"[^>]*>([^<]{1,60})<')


def log(message, *args):
    with LOG_LOCK:
        sys.stderr.write("[%s] %s\n" % (time.strftime("%d.%m %H:%M:%S"), message % args if args else message))
        sys.stderr.flush()


class RezkaSession:
    """Одна сессия на сервис: cookies Anubis и PHPSESSID переиспользуются."""

    def __init__(self, base=BASE):
        self.base = base
        self.lock = threading.RLock()
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.ready = False
        self.solves = 0

    def raw(self, url, data=None, headers=None, referer=None, timeout=45):
        body = urllib.parse.urlencode(data).encode() if isinstance(data, dict) else data
        request = urllib.request.Request(url, data=body)
        request.add_header("User-Agent", UA)
        request.add_header("Accept-Encoding", "gzip")
        request.add_header("Accept-Language", "ru-RU,ru;q=0.9")
        if referer:
            request.add_header("Referer", referer)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return response.status, raw.decode("utf-8", "ignore")
        except urllib.error.HTTPError as error:
            raw = error.read()
            if error.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return error.code, raw.decode("utf-8", "ignore")

    def solve(self):
        with self.lock:
            _, html = self.raw(self.base + "/")
            match = re.search(r'<script id="anubis_challenge" type="application/json">(.*?)</script>', html, re.S)
            if not match:
                self.ready = True
                log("Anubis не требуется")
                return
            payload = json.loads(match.group(1))
            challenge = payload["challenge"]
            difficulty = int(challenge.get("difficulty") or payload["rules"]["difficulty"])
            full, half = difficulty // 2, difficulty % 2 != 0
            nonce, started = 0, time.time()
            while True:
                digest = hashlib.sha256((challenge["randomData"] + str(nonce)).encode()).digest()
                if digest[:full] == NULL * full and (not half or digest[full] >> 4 == 0):
                    break
                nonce += 1
            params = urllib.parse.urlencode({"id": challenge["id"], "response": digest.hex(), "nonce": nonce,
                                             "redir": self.base + "/", "elapsedTime": 1500})
            self.raw(self.base + "/.within.website/x/cmd/anubis/api/pass-challenge?" + params)
            self.ready = True
            self.solves += 1
            log("Anubis пройден: сложность %s, nonce %s, %.2f c", difficulty, nonce, time.time() - started)

    def request(self, url, data=None, headers=None, referer=None):
        with self.lock:
            if not self.ready:
                self.solve()
            status, body = self.raw(url, data, headers, referer)
            if "anubis_challenge" in body:
                log("челлендж вернулся — перепроходим")
                self.solve()
                status, body = self.raw(url, data, headers, referer)
            return status, body

    def page(self, url):
        body = ""
        for attempt in range(3):
            _, body = self.request(url)
            if len(body) > 20000 and "anubis_challenge" not in body:
                return body
            log("страница не отдалась (попытка %d, %d байт)", attempt + 1, len(body))
            time.sleep(1.5)
            self.solve()
        return body

    def search(self, query, limit=10):
        _, body = self.request(self.base + "/search/",
                              {"do": "search", "subaction": "search", "q": query},
                              referer=self.base + "/")
        items, seen = [], set()
        pattern = re.compile(r'href="(https?://[^"]*?/(films|series|animation|cartoons)/[^"]+\.html)"[^>]*>([\s\S]{2,200}?)</a>')
        for match in pattern.finditer(body):
            url, kind, title = match.group(1), match.group(2), re.sub(r"<[^>]*>", " ", match.group(3))
            title = re.sub(r"\s+", " ", title).strip()
            if not title or url in seen:
                continue
            seen.add(url)
            year = re.search(r"\((\d{4})", title)
            name = re.sub(r"\s*\([^)]*\)\s*$", "", title).strip()
            items.append({"title": name or title, "full_title": title, "year": year.group(1) if year else "",
                          "kind": "series" if kind == "series" else "movie", "url": url})
            if len(items) >= limit:
                break
        return items

    @staticmethod
    def _pairs(pattern, html, limit=60):
        result, seen = [], set()
        for match in pattern.finditer(html):
            identifier, name = match.group(1), re.sub(r"\s+", " ", match.group(2)).strip()
            if identifier in seen or not name:
                continue
            seen.add(identifier)
            result.append({"id": identifier, "name": name})
            if len(result) >= limit:
                break
        return result

    @staticmethod
    def _translators(html, limit=60):
        """Озвучки лежат в <a data-translator_id="N" ...>Название</a>; имя — из title или из текста."""
        result, seen = [], set()
        for match in TRANSLATOR_ELEMENT.finditer(html):
            attributes, identifier, inner = match.group(2), match.group(3), match.group(4)
            if identifier in seen:
                continue
            title = re.search(r'title="([^"]{1,80})"', attributes)
            name = title.group(1) if title else re.sub(r"<[^>]*>", "", inner)
            name = re.sub(r"\s+", " ", name).strip()
            if not name:
                continue
            seen.add(identifier)
            result.append({"id": identifier, "name": name})
            if len(result) >= limit:
                break
        return result

    def meta(self, page_url):
        html = self.page(page_url)
        found = re.search(r'id="film_id"[^>]*value="(\d+)"', html) or re.search(r'data-id="(\d+)"', html)
        favs = re.search(r'id="ctrl_favs"\s+value="([^"]*)"', html)
        translators = self._translators(html)
        seasons = self._pairs(SEASON, html)
        return {"id": found.group(1) if found else None, "favs": favs.group(1) if favs else "",
                "translators": translators, "seasons": seasons, "is_series": "/series/" in page_url}

    def _cdn(self, page_url, film_id, translator, favs, geo_ip, season=None, episode=None, action=None):
        if action is None:
            action = "get_movie" if season is None else "get_stream"
        data = {"id": film_id, "translator_id": translator, "favs": favs, "action": action}
        if action == "get_stream":
            data.update({"is_camrip": "0", "is_ads": "0", "is_director": "0",
                         "season": str(season), "episode": str(episode or 1)})
        elif action == "get_episodes":
            data.update({"season": str(season)})
        else:
            data.update({"is_camrip": "0", "is_ads": "0", "is_director": "0"})
        _, body = self.request(self.base + "/ajax/get_cdn_series/?t=" + str(int(time.time() * 1000)), data,
                              {"X-Requested-With": "XMLHttpRequest", "CF-Connecting-IP": geo_ip or FALLBACK_GEO,
                               "Accept": "application/json, text/javascript, */*; q=0.01"},
                              referer=page_url)
        try:
            return json.loads(body)
        except Exception:
            return {"success": False, "message": "некорректный ответ сайта", "raw": body[:300]}

    def episodes(self, page_url, translator, season, geo_ip=None, meta=None):
        meta = meta or self.meta(page_url)
        if not meta.get("id"):
            return [], []
        translator = translator or (meta["translators"][0]["id"] if meta["translators"] else None)
        response = self._cdn(page_url, meta["id"], translator, meta["favs"], geo_ip,
                             season=season, action="get_episodes")
        if not response.get("success"):
            log("серии не отдались: %s", str(response)[:200])
        episodes = self._pairs(EPISODE, str(response.get("episodes") or ""), limit=300)
        seasons = self._pairs(SEASON, str(response.get("seasons") or ""), limit=50)
        return episodes, seasons

    def stream(self, page_url, translator=None, season=None, episode=None, geo_ip=None, meta=None):
        meta = meta or self.meta(page_url)
        if not meta.get("id"):
            return {"success": False, "message": "не удалось определить id фильма"}
        translator = translator or (meta["translators"][0]["id"] if meta["translators"] else None)
        response = self._cdn(page_url, meta["id"], translator, meta["favs"], geo_ip, season, episode)
        if response.get("success") and not response.get("url") and geo_ip and geo_ip != FALLBACK_GEO:
            log("поток не отдан для %s — пробуем страховочный IP", geo_ip)
            response = self._cdn(page_url, meta["id"], translator, meta["favs"], FALLBACK_GEO, season, episode)
        return response

    @staticmethod
    def parse_links(raw):
        items = []
        for chunk in str(raw or "").split(" or "):
            match = re.match(r"\[([^\]]+)\](https?://\S+)", chunk.strip())
            if not match:
                continue
            quality, url = match.group(1), match.group(2)
            item = next((entry for entry in items if entry["quality"] == quality), None)
            if item is None:
                item = {"quality": quality, "hls": None, "mp4": None}
                items.append(item)
            if ":hls:manifest.m3u8" in url:
                item["hls"] = url
            elif url.endswith(".mp4"):
                item["mp4"] = url
        return items


SESSION = RezkaSession()
TOKEN = ""

# ---------------------------------------------------------------------------
# Kodik — плеер, который отдаёт новый YummyAnime (yummyanime.tv)
# ---------------------------------------------------------------------------

KODIK = "https://kodikplayer.com"
KODIK_SITE = "https://yummyanime.tv/"
KODIK_OPTION = re.compile(r"<option\s+([^>]*?)>", re.S)
KODIK_EPISODE = re.compile(r'<option\s+value="(\d+)"[^>]*data-id="(\d+)"[^>]*data-hash="([^"]+)"[^>]*data-title="([^"]*)"')


def kodik_unshift(text):
    """Снимает обфускацию Kodik: каждая буква сдвинута на 18, с переносом по регистру."""
    result = []
    for symbol in text:
        code = ord(symbol)
        if 65 <= code <= 90 or 97 <= code <= 122:
            limit = 90 if symbol <= "Z" else 122
            value = code + 18
            result.append(chr(value if value <= limit else value - 26))
        else:
            result.append(symbol)
    return "".join(result)


def kodik_decode(source):
    if "//" in source:
        return source
    plain = kodik_unshift(source)
    return base64.b64decode(plain + "=" * (-len(plain) % 4)).decode("utf-8", "ignore")


def kodik_value(html, name):
    match = re.search(r'var\s+%s\s*=\s*"([^"]*)"' % name, html)
    return match.group(1) if match else ""


def kodik_attribute(attributes, name, default=""):
    match = re.search(r'%s="([^"]*)"' % name, attributes)
    return match.group(1) if match else default


class KodikSession:
    """Каталог Kodik отдаётся страницей, ссылки — POST-ом на /ftor (живут недолго)."""

    def __init__(self):
        self.lock = threading.RLock()
        self.pages = {}

    def get(self, url, referer=KODIK_SITE, timeout=45):
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer,
                                                       "Accept": "*/*", "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            if response.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", "ignore")

    def page_of(self, media_id, media_hash, quality="720p", form="serial"):
        """form: serial (страница релиза) или season (ссылка вида YummyAnime)."""
        url = "%s/%s/%s/%s/%s" % (KODIK, form, media_id, media_hash, quality)
        with self.lock:
            cached = self.pages.get(url)
            if cached and time.time() - cached[0] < 600:
                return cached[1]
        html = self.get(url)
        with self.lock:
            self.pages[url] = (time.time(), html)
        return html

    @staticmethod
    def parse_episodes(html):
        """Kodik иногда перечисляет одну и ту же серию дважды (по группам) — берём первую."""
        episodes, seen = [], set()
        for match in KODIK_EPISODE.finditer(html):
            number = int(match.group(1))
            if number in seen:
                continue
            seen.add(number)
            episodes.append({"number": number, "id": match.group(2), "hash": match.group(3),
                             "title": re.sub(r"\s+", " ", match.group(4)).strip() or ("%s серия" % number)})
        return episodes

    @staticmethod
    def parse_seasons(html):
        seasons = []
        for attributes in KODIK_OPTION.findall(html):
            serial_id = kodik_attribute(attributes, "data-serial-id")
            if not serial_id:
                continue
            seasons.append({"number": int(kodik_attribute(attributes, "value", "1") or 1),
                            "title": kodik_attribute(attributes, "data-title", "сезон"),
                            "media_id": serial_id,
                            "media_hash": kodik_attribute(attributes, "data-serial-hash")})
        return seasons

    @staticmethod
    def _other(form):
        return "season" if form == "serial" else "serial"

    def _catalog_page(self, media_id, media_hash, form, episode=None):
        """Одна страница Kodik: серии, озвучки и, если просили, поток серии."""
        html = self.page_of(media_id, media_hash, form=form)
        data = {"media_id": media_id, "media_hash": media_hash, "form": form,
                "episodes": self.parse_episodes(html), "seasons": self.parse_seasons(html),
                "translations": [], "default": None}
        for attributes in KODIK_OPTION.findall(html):
            translation_media = kodik_attribute(attributes, "data-media-id")
            if not translation_media:
                continue
            translation = {"id": kodik_attribute(attributes, "data-id"),
                           "title": kodik_attribute(attributes, "data-title"),
                           "media_id": translation_media,
                           "media_hash": kodik_attribute(attributes, "data-media-hash"),
                           "type": kodik_attribute(attributes, "data-translation-type", "voice"),
                           "count": int(kodik_attribute(attributes, "data-episode-count", "0") or 0)}
            data["translations"].append(translation)
            if 'selected="selected"' in attributes and not data["default"]:
                data["default"] = translation["id"]
        if data["translations"] and not data["default"]:
            data["default"] = data["translations"][0]["id"]
        if not data["episodes"] and data["translations"]:
            chosen = next((item for item in data["translations"] if item["id"] == data["default"]), None)
            if chosen:
                for candidate in (form, self._other(form)):
                    try:
                        episodes = self.parse_episodes(
                            self.page_of(chosen["media_id"], chosen["media_hash"], form=candidate))
                    except Exception:  # страница озвучки есть не у каждой формы
                        continue
                    if episodes:
                        data["episodes"] = episodes
                        data["episodes_form"] = candidate
                        break
        if episode is not None:
            item = next((entry for entry in data["episodes"] if str(entry["number"]) == str(episode)), None)
            if item is None and data["episodes"]:
                item = data["episodes"][0]
            if item is not None:
                data["episode"] = item["number"]
                data["streams"] = self.stream(item["id"], item["hash"])["streams"]
        return data

    def catalog(self, url=None, media_id=None, media_hash=None, form="", episode=None):
        """Либо разбор ссылки /serial|/season/<id>/<hash>, либо серии конкретной озвучки.

        Форму страницы определяем сами: у ссылок YummyAnime идентификаторы
        «сезонные», и запрос к /serial/ с ними отвечает 500.
        """
        if url:
            match = re.search(r"/(serial|season)/(\d+)/([0-9a-f]{16,})", url)
            if not match:
                raise ValueError("нужна ссылка вида https://kodikplayer.com/serial/<id>/<hash>/720p "
                                 "или .../season/<id>/<hash>/720p")
            form, media_id, media_hash = match.group(1), match.group(2), match.group(3)
        if not (media_id and media_hash):
            raise ValueError("нужны media_id и media_hash")
        forms = [form] if form in ("serial", "season") else ["serial", "season"]
        empty, error = None, None
        for candidate in forms:
            try:
                data = self._catalog_page(media_id, media_hash, candidate, episode)
            except Exception as failure:  # noqa: BLE001 — вторая форма обычно и срабатывает
                error = failure
                continue
            if data["episodes"] or data["translations"]:
                return data
            if empty is None:
                empty = data
        if empty is not None:
            return empty
        raise error if error is not None else ValueError("Kodik не отдал страницу")

    def stream(self, seria_id, seria_hash, quality="720p"):
        page = "%s/seria/%s/%s/%s" % (KODIK, seria_id, seria_hash, quality)
        html = self.get(page)
        vinfo = {}
        for key in ("type", "hash", "id"):
            match = re.search(r"vInfo\.%s\s*=\s*'([^']*)'" % key, html)
            vinfo[key] = match.group(1) if match else ""
        data = {"d": kodik_value(html, "domain"), "d_sign": kodik_value(html, "d_sign"),
                "pd": kodik_value(html, "pd"), "pd_sign": kodik_value(html, "pd_sign"),
                "ref": kodik_value(html, "ref"), "ref_sign": kodik_value(html, "ref_sign"),
                "bad_user": "false", "cdn_is_working": "0",
                "type": vinfo.get("type") or "seria", "hash": vinfo.get("hash") or seria_hash,
                "id": vinfo.get("id") or seria_id}
        request = urllib.request.Request(
            KODIK + "/ftor", data=urllib.parse.urlencode(data).encode(),
            headers={"User-Agent": UA, "Referer": page, "Origin": KODIK,
                     "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                     "X-Requested-With": "XMLHttpRequest",
                     "Accept": "application/json, text/javascript, */*; q=0.01",
                     "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            if response.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
        payload = json.loads(raw.decode("utf-8", "ignore"))
        streams = []
        for name, variants in (payload.get("links") or {}).items():
            for variant in variants:
                link = kodik_decode(variant.get("src", ""))
                if link.startswith("//"):
                    link = "https:" + link
                if not link.startswith("http"):
                    continue
                streams.append({"quality": ("%sp" % name) if str(name).isdigit() else str(name),
                                "hls": link, "format": variant.get("type", "")})
        streams.sort(key=lambda item: int(re.sub(r"\D", "", item["quality"]) or 0))
        return {"default": payload.get("default"), "streams": streams}


SESSION = RezkaSession()
KODIK_SESSION = KodikSession()
TOKEN = ""
CONFIG = {}


LOG_FILE = "/var/log/kino-plugin.log"


def append_log(kind, message, client, agent):
    """Журнал отчётов от плагинов: по нему видно, что происходит на телевизоре."""
    text = " ".join(str(message or "").split())[:2000]
    line = "%s | %s | %s | %s | %s\n" % (
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"), kind, client, str(agent or "")[:80], text)
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 2 * 1024 * 1024:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(line)
    except Exception as error:  # noqa: BLE001 — журнал не должен ломать сервис
        log("не смог записать журнал: %r", error)


def fetch_url(url, timeout=60):
    """Запрос к CDN без подмены заголовков — нужен для видео-прокси."""
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*",
                                                   "Accept-Encoding": "identity"})
    return urllib.request.urlopen(request, timeout=timeout)


SEGMENT_CACHE = {}      # ссылка сегмента -> (байты, тип, момент)
SEGMENT_ORDER = {}      # папка на CDN -> порядок сегментов из плейлиста
CACHE_LOCK = threading.Lock()
CACHE_LIMIT = 96 * 1024 * 1024
CACHE_TTL = 900
PREFETCH = 3


def cache_get(url):
    with CACHE_LOCK:
        item = SEGMENT_CACHE.get(url)
    if not item:
        return None
    body, content_type, moment = item
    if time.time() - moment > CACHE_TTL:
        with CACHE_LOCK:
            SEGMENT_CACHE.pop(url, None)
        return None
    return body, content_type


def cache_size():
    return sum(len(item[0]) for item in SEGMENT_CACHE.values())


def cache_put(url, body, content_type):
    if not body or len(body) > 8 * 1024 * 1024:
        return
    with CACHE_LOCK:
        SEGMENT_CACHE[url] = (body, content_type, time.time())
        while cache_size() > CACHE_LIMIT and len(SEGMENT_CACHE) > 1:
            oldest = min(SEGMENT_CACHE, key=lambda key: SEGMENT_CACHE[key][2])
            if oldest == url:
                break
            SEGMENT_CACHE.pop(oldest, None)


def remember_order(urls):
    """Запомнить порядок сегментов из плейлиста — он нужен для опережающей закачки."""
    segments = [item for item in urls if ".m3u8" not in item.split("?")[0].lower()]
    if len(segments) < 2:
        return
    folder = segments[0].rsplit("/", 1)[0]
    with CACHE_LOCK:
        SEGMENT_ORDER[folder] = segments


def neighbours(url):
    """Следующие сегменты: сначала по порядку из плейлиста, иначе по номеру seg-N."""
    folder = url.rsplit("/", 1)[0]
    with CACHE_LOCK:
        order = SEGMENT_ORDER.get(folder)
    if order and url in order:
        index = order.index(url)
        return order[index + 1:index + 1 + PREFETCH]
    match = re.search(r"seg-(\d+)-", url)
    if not match:
        return []
    number = int(match.group(1))
    tail = match.group(0)
    return [url.replace(tail, "seg-%d-" % (number + step)) for step in range(1, PREFETCH + 1)]


def warm_cache(url):
    """Заранее скачать сегмент, чтобы плеер получил его сразу."""
    if cache_get(url):
        return
    try:
        response = fetch_url(url, timeout=45)
        body = response.read()
        cache_put(url, body, segment_type(url, response))
        log("подготовил сегмент: %d байт", len(body))
    except Exception as error:  # noqa: BLE001 — подготовка не должна мешать просмотру
        log("не смог подготовить сегмент: %r", error)


def prefetch_after(url):
    for target in neighbours(url):
        if cache_get(target):
            continue
        threading.Thread(target=warm_cache, args=(target,), daemon=True).start()


def segment_type(url, response=None):
    tail = url.split("?")[0].lower()
    if tail.endswith(".ts"):
        return "video/mp2t"
    if tail.endswith((".mp4", ".m4s", ".m4v")):
        return "video/mp4"
    if tail.endswith(".aac"):
        return "audio/aac"
    if response is not None:
        return response.headers.get("Content-Type") or "video/mp2t"
    return "video/mp2t"


def proxy_link(base, url):
    """Ссылка внутри плейлиста → наш прокси (с «расширением» в адресе)."""
    tail = url.split("?")[0].lower()
    if ".m3u8" in tail:
        action = "playlist.m3u8"
    elif tail.endswith(".ts"):
        action = "segment.ts"
    else:
        action = "segment"
    return "%s/%s?url=%s" % (base.rstrip("/"), action, urllib.parse.quote(url, safe=""))


def proxy_manifest(base, url):
    """Скачать плейлист и переписать все ссылки на наш прокси.

    Нужно там, где CDN Кодика (solodcdn.com) не открывается у зрителя:
    телевизор тянет поток с нашего сервера, а сервер — с CDN.
    """
    response = fetch_url(url)
    raw = response.read()
    final = response.url
    content_type = response.headers.get("Content-Type") or "application/vnd.apple.mpegurl"
    text = raw.decode("utf-8", "ignore")
    lines = []
    absolute_list = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            lines.append(line)
            continue
        if stripped.startswith("#"):
            lines.append(re.sub(r'URI="([^"]+)"',
                                lambda m: 'URI="%s"' % proxy_link(base, urllib.parse.urljoin(final, m.group(1))),
                                line))
            continue
        absolute = urllib.parse.urljoin(final, stripped)
        absolute_list.append(absolute)
        lines.append(proxy_link(base, absolute))
    remember_order(absolute_list)
    return "\n".join(lines).encode(), content_type


class Handler(BaseHTTPRequestHandler):
    server_version = "kino-extractor/" + VERSION

    def log_message(self, fmt, *args):
        log("http %s", fmt % args)

    def _send(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, body, content_type, status=200, cache="no-store", origin="miss"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", cache)
        self.send_header("X-Cache", origin)
        self.end_headers()
        self.wfile.write(body)

    def _proxy_base(self, params):
        """Адрес, по которому прокси-ссылки видны клиенту."""
        base = self._param(params, "base", "")
        if base:
            return base.rstrip("/")
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "127.0.0.1:8791"
        scheme = self.headers.get("X-Forwarded-Proto") or ("https" if ":8443" in host else "http")
        prefix = self.path.split("?")[0].rsplit("/", 1)[0]
        return "%s://%s%s" % (scheme, host, prefix)

    def _client_ip(self):
        for header in ("X-Kino-Client-IP", "X-Real-IP", "X-Client-IP", "CF-Connecting-IP"):
            value = self.headers.get(header)
            if value:
                return value.strip()
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _param(self, params, name, default=None):
        return (params.get(name) or [default])[0]

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        if parts and parts[0] == "kino":
            parts = parts[1:]
        if parts and parts[0] == TOKEN:
            parts = parts[1:]
        else:
            self._send({"error": "нужен токен"}, 403)
            return
        params = urllib.parse.parse_qs(parsed.query)
        action = parts[0] if parts else "health"
        # ссылки видео-прокси могут идти с «расширением» — плеерам телевизоров
        # важно видеть .m3u8 и .ts в адресе
        if action in ("playlist.m3u8", "stream.m3u8", "index.m3u8"):
            action = "hls"
        elif action in ("segment.ts", "seg.ts", "segment.m4s"):
            action = "segment"
        geo_ip = self._client_ip()
        try:
            if action == "health":
                self._send({"ok": True, "version": VERSION, "rezka_ready": SESSION.ready,
                            "anubis_solves": SESSION.solves, "client_ip": geo_ip})
            elif action == "search":
                query = (self._param(params, "q", "") or "").strip()
                if not query:
                    self._send({"error": "нужен параметр q"}, 400)
                else:
                    self._send({"query": query,
                                "items": SESSION.search(query, int(self._param(params, "limit", "10")))})
            elif action == "info":
                url = self._param(params, "url", "")
                if not url.startswith("http"):
                    self._send({"error": "нужен параметр url"}, 400)
                else:
                    meta = SESSION.meta(url)
                    meta.pop("favs", None)
                    meta["quality_note"] = "без входа на сайт доступно 360p"
                    self._send(meta)
            elif action == "episodes":
                url = self._param(params, "url", "")
                if not url.startswith("http"):
                    self._send({"error": "нужен параметр url"}, 400)
                    return
                season = int(self._param(params, "season", "1"))
                meta = SESSION.meta(url)
                translator = self._param(params, "translator") or (meta["translators"][0]["id"] if meta["translators"] else None)
                episodes, seasons = SESSION.episodes(url, translator, season, geo_ip, meta)
                self._send({"season": season, "translator": translator, "episodes": episodes,
                            "seasons": seasons or meta["seasons"]})
            elif action == "stream":
                url = self._param(params, "url", "")
                if not url.startswith("http"):
                    self._send({"error": "нужен параметр url"}, 400)
                    return
                season = self._param(params, "season")
                episode = self._param(params, "episode")
                response = SESSION.stream(url, translator=self._param(params, "translator"),
                                          season=int(season) if season else None,
                                          episode=int(episode) if episode else None, geo_ip=geo_ip)
                payload = {"success": bool(response.get("success")), "message": response.get("message", ""),
                           "quality": response.get("quality"), "geo_ip": geo_ip,
                           "streams": SESSION.parse_links(response.get("url")),
                           "subtitles": [{"language": match.group(1), "url": match.group(2)}
                                         for match in re.finditer(r"\[([^\]]+)\](https?://\S+)",
                                                                  str(response.get("subtitle") or ""))]}
                self._send(payload, 200 if payload["success"] else 502)
            elif action == "kodik":
                url = self._param(params, "url", "")
                media_id = self._param(params, "media_id")
                media_hash = self._param(params, "media_hash")
                episode = self._param(params, "episode")
                form = self._param(params, "form", "")
                try:
                    self._send(KODIK_SESSION.catalog(url=url if url.startswith("http") else None,
                                                     media_id=media_id, media_hash=media_hash,
                                                     form=form or "", episode=episode))
                except ValueError as error:
                    self._send({"error": str(error)}, 400)
            elif action == "kodik_url":
                """Ссылка плеера Kodik с сайта (в т.ч. /season/… от YummyAnime) → потоки серии."""
                url = self._param(params, "url", "")
                episode = self._param(params, "episode")
                if not url:
                    self._send({"error": "нужен параметр url — ссылка плеера Kodik"}, 400)
                    return
                try:
                    result = KODIK_SESSION.catalog(url=url, episode=episode)
                except ValueError as error:
                    self._send({"error": str(error)}, 400)
                    return
                result["success"] = bool(result.get("streams"))
                self._send(result, 200 if result.get("streams") else 502)
            elif action == "log":
                """Отчёт из плагина: что делает телевизор и где спотыкается."""
                kind = (self._param(params, "kind", "plugin") or "plugin")[:32]
                message = self._param(params, "msg", "")
                append_log(kind, message, geo_ip, self.headers.get("User-Agent"))
                self._send({"ok": True})
            elif action == "hls":
                """Видео-прокси: плейлист CDN с переписанными на нас ссылками."""
                url = self._param(params, "url", "")
                if not url.startswith("http"):
                    self._send({"error": "нужен параметр url — ссылка на плейлист m3u8"}, 400)
                    return
                base = self._proxy_base(params)
                body, _upstream = proxy_manifest(base, url)
                # тип именно плейлиста: Safari/AVPlayer на Apple TV иначе
                # считает ответ обычным текстом и не играет
                self._send_raw(body, "application/vnd.apple.mpegurl")
            elif action == "segment":
                """Видео-прокси: сегмент или вложенный плейлист с CDN."""
                url = self._param(params, "url", "")
                if not url.startswith("http"):
                    self._send({"error": "нужен параметр url — ссылка на сегмент"}, 400)
                    return
                cached = cache_get(url)
                if cached:
                    body, content_type = cached
                    self._send_raw(body, content_type, cache="public, max-age=600", origin="hit")
                    prefetch_after(url)
                    return
                response = fetch_url(url)
                content_type = segment_type(url, response)
                # отдаём сегмент по мере скачивания: плеер получает первые байты
                # сразу, а не после того, как сервер соберёт все 2–3 МБ
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "public, max-age=600")
                self.send_header("X-Cache", "miss")
                length = response.headers.get("Content-Length")
                if length and length.isdigit():
                    self.send_header("Content-Length", length)
                else:
                    self.send_header("Connection", "close")
                self.end_headers()
                collected = []
                sent = 0
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    collected.append(chunk)
                    self.wfile.write(chunk)
                    sent += len(chunk)
                cache_put(url, b"".join(collected), content_type)
                prefetch_after(url)
                log("сегмент отдан: %d байт", sent)
            elif action == "kodik_stream":
                seria, hashed = self._param(params, "id", ""), self._param(params, "hash", "")
                if not (seria and hashed):
                    self._send({"error": "нужны параметры id и hash серии"}, 400)
                    return
                result = KODIK_SESSION.stream(seria, hashed)
                result["success"] = bool(result["streams"])
                self._send(result, 200 if result["streams"] else 502)
            else:
                self._send({"error": "неизвестный метод",
                            "methods": ["health", "search", "info", "episodes", "stream",
                                        "kodik", "kodik_url", "kodik_stream", "hls", "segment", "log"]}, 404)
        except Exception as error:  # noqa: BLE001 — сервис должен отвечать, а не падать
            log("ошибка обработки %s: %r", self.path, error)
            self._send({"error": str(error)}, 500)


def main():
    global TOKEN, CONFIG
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/kino-extractor.json")
    parser.add_argument("--port", type=int)
    parser.add_argument("--host", default="127.0.0.1")
    arguments = parser.parse_args()
    if os.path.exists(arguments.config):
        with open(arguments.config, encoding="utf-8") as handle:
            CONFIG = json.load(handle)
    TOKEN = CONFIG.get("token") or os.environ.get("KINO_TOKEN") or "kino"
    port = arguments.port or int(CONFIG.get("port") or 8791)
    log("kino-extractor %s запущен на %s:%d", VERSION, arguments.host, port)
    threading.Thread(target=SESSION.solve, daemon=True).start()
    server = ThreadingHTTPServer((arguments.host, port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
