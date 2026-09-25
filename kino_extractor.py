#!/usr/bin/env python3
"""kino-extractor — серверный экстрактор HDrezka (Rezka) для плагина Lampa.

Что делает:
  * проходит антибот Anubis (proof-of-work techaro.lol) на hdrezka-home.tv;
  * ищет фильмы и сериалы, разбирает переводы/сезоны/серии;
  * достаёт прямую ссылку на HLS через /ajax/get_cdn_series/;
  * подставляет в CF-Connecting-IP адрес заказчика: сайт отдаёт поток только
    клиентам из РФ/СНГ, а CDN потом сверяет IP того, кто запрашивает ссылку.
    Поэтому видео должен качать сам плагин, а не этот сервис.

Запуск: python3 kino_extractor.py --config /etc/kino-extractor.json
Ручки:  /kino/<token>/{health,search,info,episodes,stream}
"""
import argparse
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

VERSION = "1.1.0"
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
CONFIG = {}


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
            else:
                self._send({"error": "неизвестный метод",
                            "methods": ["health", "search", "info", "episodes", "stream"]}, 404)
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
