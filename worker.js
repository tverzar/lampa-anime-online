var ALLOWED_HOSTS = [
  'ani-media.online',
  'yummyanime.tv',
  'api.yani.tv',
  'kinokrad.cc',
  'kinokrad.co',
  'kinogo.ai',
  'kinogo.zone',
  'baskino.me',
  'kodik.info',
  'kodik.biz',
  'kodik.cc',
  'kodik.club',
  'kodikplayer.com',
  'kodikapi.com',
  'kodikapi.ru'
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Application, Lang',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function isAllowed(hostname) {
  hostname = hostname.toLowerCase();
  return ALLOWED_HOSTS.some(function (host) {
    return hostname === host || hostname.endsWith('.' + host);
  });
}

function jsonError(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(origin))
  });
}

async function readLimited(response, limit, timeoutMs) {
  if (!response.body) return { body: new Uint8Array(0) };
  var reader = response.body.getReader();
  var chunks = [];
  var total = 0;
  var deadline = Date.now() + timeoutMs;
  while (true) {
    var timer;
    var remaining = Math.max(1, deadline - Date.now());
    var result = await Promise.race([
      reader.read(),
      new Promise(function (resolve) {
        timer = setTimeout(function () { resolve(null); }, remaining);
      })
    ]);
    clearTimeout(timer);
    if (!result) {
      reader.cancel().catch(function () {});
      return { timedOut: true };
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      reader.cancel().catch(function () {});
      return { tooLarge: true };
    }
    chunks.push(result.value);
  }
  var body = new Uint8Array(total);
  var offset = 0;
  chunks.forEach(function (chunk) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return { body: body };
}

var EXTRACTOR_ORIGIN = 'http://94.156.237.213.nip.io';
var EXTRACTOR_TIMEOUT_MS = 25000;

/* /kino/* — мост к серверному экстрактору HDrezka на VPS.
   Нужен по двум причинам: телевизор часто открывает Lampa по https (тогда
   обычный http-запрос к VPS блокируется как mixed content), и Cloudflare
   сообщает нам IP клиента, который экстрактор подставляет в CF-Connecting-IP. */
async function kinoBridge(request, origin) {
  var requestUrl = new URL(request.url);
  var target = EXTRACTOR_ORIGIN + requestUrl.pathname + requestUrl.search;
  var clientIp = request.headers.get('CF-Connecting-IP') || '';
  var headers = new Headers({ 'Accept': 'application/json' });
  if (clientIp) headers.set('X-Kino-Client-IP', clientIp);

  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, EXTRACTOR_TIMEOUT_MS);
  try {
    var upstream = await fetch(target, { headers: headers, signal: controller.signal });
    var body = await upstream.arrayBuffer();
    var responseHeaders = new Headers(corsHeaders(origin));
    responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(body, { status: upstream.status, headers: responseHeaders });
  } catch (e) {
    return jsonError('Extractor unavailable', 504, origin);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default {
  async fetch(request) {
    var origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    var requestUrl = new URL(request.url);
    if (requestUrl.pathname === '/kino' || requestUrl.pathname.indexOf('/kino/') === 0) {
      return kinoBridge(request, origin);
    }
    if (requestUrl.pathname !== '/proxy') return jsonError('Not found', 404, origin);
    if (request.method !== 'GET' && request.method !== 'POST') return jsonError('Method not allowed', 405, origin);

    var target;
    try {
      target = new URL(requestUrl.searchParams.get('url') || '');
    } catch (e) {
      return jsonError('Invalid target URL', 400, origin);
    }
    if (target.protocol !== 'https:' || !isAllowed(target.hostname)) {
      return jsonError('Target host is not allowed', 403, origin);
    }

    var upstreamHeaders = new Headers();
    ['accept', 'content-type', 'x-application', 'lang', 'referer'].forEach(function (name) {
      var value = request.headers.get(name);
      if (value) upstreamHeaders.set(name, String(value));
    });
    if (!upstreamHeaders.has('accept')) upstreamHeaders.set('Accept', '*/*');

    var body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
    if (body && body.byteLength > 1024 * 1024) return jsonError('Request body too large', 413, origin);

    try {
      var startedAt = Date.now();
      var currentUrl = target;
      var method = request.method;
      var requestBody = body;
      var upstream;
      for (var redirects = 0; redirects <= 5; redirects++) {
        var remainingMs = Math.max(1, 9000 - (Date.now() - startedAt));
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, remainingMs);
        var raceTimeoutId;
        var fetchTask = fetch(currentUrl.toString(), {
          method: method,
          headers: upstreamHeaders,
          body: requestBody,
          redirect: 'manual',
          signal: controller.signal
        });
        upstream = await Promise.race([
          fetchTask,
          new Promise(function (resolve) {
            raceTimeoutId = setTimeout(function () { resolve(null); }, remainingMs);
          })
        ]);
        clearTimeout(timeoutId);
        clearTimeout(raceTimeoutId);
        if (!upstream) return jsonError('Upstream request timed out', 504, origin);
        if ([301, 302, 303, 307, 308].indexOf(upstream.status) === -1) break;
        var location = upstream.headers.get('Location');
        if (!location) break;
        if (redirects === 5) return jsonError('Too many redirects', 502, origin);
        currentUrl = new URL(location, currentUrl);
        if (currentUrl.protocol !== 'https:' || !isAllowed(currentUrl.hostname)) {
          return jsonError('Redirect host is not allowed', 502, origin);
        }
        if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === 'POST')) {
          method = 'GET';
          requestBody = undefined;
          upstreamHeaders.delete('content-type');
        }
      }
      var responseHeaders = new Headers(corsHeaders(origin));
      var contentType = upstream.headers.get('Content-Type');
      if (contentType) responseHeaders.set('Content-Type', contentType);
      var cacheControl = upstream.headers.get('Cache-Control');
      if (cacheControl) responseHeaders.set('Cache-Control', cacheControl);
      var result = await readLimited(upstream, 8 * 1024 * 1024, Math.max(1, 9000 - (Date.now() - startedAt)));
      if (result.timedOut) return jsonError('Upstream response timed out', 504, origin);
      if (result.tooLarge) return jsonError('Upstream response too large', 413, origin);
      return new Response(result.body, { status: upstream.status, headers: responseHeaders });
    } catch (e) {
      return jsonError('Upstream request failed', 502, origin);
    }
  }
};
