// Phone-side page renderer. Lays a real page out in a hidden iframe at the
// watch's CSS width and emits a display list from the resulting geometry.
// Requires a DOM: runs in the Android PKJS WebView, never in pypkjs.
//
// Scripting model (two frames, deliberately):
//   1. hydrate  — sandbox="allow-scripts", NO allow-same-origin. Page JS runs
//      in an opaque origin, so it cannot touch the PKJS parent (which is
//      file:///android_asset/... with allowUniversalAccessFromFileURLs, i.e. a
//      full filesystem/any-origin read if it ever got in). An injected agent
//      waits for the DOM to settle and postMessages the serialized HTML out.
//   2. measure  — sandbox="allow-same-origin", scripts off, as before. The
//      parent reads geometry from a document that can no longer execute
//      anything. All the hostile page ever controls is a string of HTML.
// allow-scripts + allow-same-origin together would be one line shorter and a
// documented sandbox escape; that is why it is not used.
//
// The hydrate frame keeps connect-src 'none', so a client-rendered app would
// boot and then never load its data. Instead its fetch/XHR are marshalled to
// the parent over postMessage and performed there, which makes the parent a
// policy checkpoint (see proxyPolicy) rather than the frame a network peer.

var dl = require('./dl');

// Metric-exact Gothic faces + the break-fidelity transform. Both optional so a
// bundle without them still renders, with browser fonts and browser breaking.
var fontCss = '';
var pebbleText = null;
try { fontCss = require('./pebble_fonts').css; } catch (e) { console.log('[renderer] pebble fonts missing, line breaks will not match the watch'); }
try { pebbleText = require('./pebble_text'); } catch (e2) { console.log('[renderer] pebble_text missing, line breaks will not match the watch'); }

// Indexed by the wire font id (fontFor() bucket + bold bit).
var FACE = ['PebbleGothic14', 'PebbleGothic18', 'PebbleGothic24', 'PebbleGothic28'];
var FACE_PX = [14, 18, 24, 28];
var FACE_NAME = ['GOTHIC_14', 'GOTHIC_14_BOLD', 'GOTHIC_18', 'GOTHIC_18_BOLD',
  'GOTHIC_24', 'GOTHIC_24_BOLD', 'GOTHIC_28', 'GOTHIC_28_BOLD'];

var CONFIG = {
  // Only used when the metrics fonts are missing from the bundle.
  fontFamily: '"Helvetica Neue",Helvetica,Arial,sans-serif',
  timeoutMs: 5000,
  scripts: true,
  settleQuietMs: 250,
  settleMaxMs: 3000,
  maxHtmlBytes: 4000000,
  proxy: true, // parent-mediated fetch for the hydrate frame; needs baseHref
  proxyMaxRequests: 48,
  proxyMaxBytes: 4000000,
  proxyTimeoutMs: 5000,
  images: false,
  round: false,
  roundInset: 22,
  roundTop: 44,
  imageBits: 1, // 1 = mono, 8 = 64-colour GColor8 palette
  imageDither: 'atkinson', // or 'none'
  minImagePx: 48,
  maxImages: 3,
  maxImageBytes: 12000,
  maxSegmentBytes: 24000,
};

// Mirrors NET_MAX_PAGE_BYTES in src/c/net.h: the watch drops anything larger.
var MAX_SEG_BYTES = 32768;

var MAX_I16 = 32767;
var DEFAULT_COLOR = 0xc0; // DL_COLOR_DEFAULT, opaque black
var WHITE = 0xff;
var SKIP = {
  SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, LINK: 1, META: 1,
  SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, AUDIO: 1, VIDEO: 1,
};

var ADS = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adsystem|taboola|outbrain|scorecardresearch|hotjar|segment\.(?:io|com)|amplitude|mixpanel)[^>]*>\s*<\/script>/gi;

function options(opts) {
  var o = {};
  for (var k in CONFIG) o[k] = opts[k] === undefined ? CONFIG[k] : opts[k];
  o.width = opts.width || 200;
  o.baseHref = opts.baseHref || '';
  o.segment = Math.max(0, opts.segment | 0);
  o.host = opts.document || document;
  // Without a real page URL there is nothing to resolve against and nothing to
  // scope the allowlist to, so the proxy stays off.
  o.proxy = !!(o.proxy && o.scripts && o.baseHref);
  return o;
}

// graphics_fill_rect does not blend, so translucent backgrounds are composited
// against the white page here instead of being shipped as-is.
function bgColor(css) {
  var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(css || '');
  if (!m) return WHITE;
  var a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (!(a > 0.02)) return WHITE;
  return dl.toGColor8(+m[1] * a + 255 * (1 - a), +m[2] * a + 255 * (1 - a), +m[3] * a + 255 * (1 - a));
}

// Gradients and background-images leave no colour to read, so light text ends
// up invisible on the watch's white page unless it is forced back to black.
function legible(fg, bg) {
  if ((fg >> 6) !== 3) fg |= 0xc0;
  if (fg !== bg) return fg;
  var lum = ((bg >> 4) & 3) + ((bg >> 2) & 3) + (bg & 3);
  return lum >= 5 ? DEFAULT_COLOR : WHITE;
}

function hidden(cs) {
  return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
}

function hiddenBranch(el, win) {
  for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
    if (hidden(win.getComputedStyle(p))) return true;
  }
  return false;
}

function fontFor(cs) {
  var size = parseFloat(cs.fontSize) || 16;
  var w = cs.fontWeight;
  var bold = (w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600) ? 1 : 0;
  var f = size < 16 ? dl.FONT.GOTHIC_14
    : size < 22 ? dl.FONT.GOTHIC_18
    : size < 26 ? dl.FONT.GOTHIC_24
    : dl.FONT.GOTHIC_28;
  return f + bold;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function injectHead(html, head) {
  var m = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html);
  if (!m) return '<!doctype html><html><head>' + head + '</head><body>' + html + '</body></html>';
  var at = m.index + m[0].length;
  return html.slice(0, at) + head + html.slice(at);
}

function styleHead(o, showImages, fonts) {
  // white-space:pre-wrap is load-bearing: the transform steers Chromium with
  // real newlines, which collapse to spaces under any other value.
  return (o.baseHref ? '<base data-pb href="' + esc(o.baseHref) + '">' : '') +
    '<style data-pb>' + (fonts ? fontCss : '') +
    'html,body{margin:0;padding:0;width:' + o.width + 'px;overflow-x:hidden}' +
    // The circle masks the corners, so text is inset while backgrounds still
    // reach the edge of the buffer.
    (o.round ? 'body{padding:' + o.roundTop + 'px ' + o.roundInset +
      'px;box-sizing:border-box}' : '') +
    '*{font-family:' + (fonts && fontCss ? FACE[1] : o.fontFamily) + '!important;' +
    (fonts && fontCss ? 'font-kerning:none!important;font-variant-ligatures:none!important;' +
      'font-feature-settings:"kern" 0,"liga" 0,"clig" 0,"calt" 0!important;' +
      'font-synthesis:none!important;letter-spacing:0!important;word-spacing:0!important;' +
      'white-space:pre-wrap!important;' : '') +
    'max-width:' + o.width + 'px!important;' +
    'box-sizing:border-box}' +
    (showImages
      ? 'img{height:auto!important}svg,video,canvas,object,embed,iframe{display:none!important}'
      : 'img,svg,video,canvas,object,embed,iframe{display:none!important}') +
    '</style>';
}

// Runs inside the hydrate frame. Serialized with toString(), so no closures.
function settleAgent(quietMs, maxMs, maxBytes, nonce, proxy) {
  var post = window.parent.postMessage.bind(window.parent);
  var done = false, armed = false, timer = null, inflight = 0;
  // styled-components and friends adopt the server's <style> and then feed the
  // CSSOM through insertRule, which leaves the element empty; outerHTML would
  // hand the layout stage an unstyled page.
  function materializeCss() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var node = sheets[i].ownerNode, rules, css = '', j;
      if (!node || node.tagName !== 'STYLE') continue;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      for (j = 0; j < rules.length; j++) css += rules[j].cssText;
      if (css && css !== node.textContent) node.textContent = css;
    }
  }
  // A stylesheet still in flight will move everything once it lands, so it holds
  // the quiet period open the same way an outstanding fetch does.
  function cssPending() {
    var links = document.getElementsByTagName('link'), waiting = false;
    for (var i = 0; i < links.length; i++) {
      var n = links[i];
      if (!/(^|\s)stylesheet(\s|$)/i.test(n.rel || '') || n.disabled || n.sheet || n.pbDone) continue;
      if (!n.pbWatched) {
        n.pbWatched = 1;
        n.addEventListener('load', function () { this.pbDone = 1; bump(); });
        n.addEventListener('error', function () { this.pbDone = 1; bump(); });
      }
      waiting = true;
    }
    return waiting;
  }
  function finish() {
    if (done) return;
    done = true;
    var html = '';
    try {
      var junk = document.querySelectorAll('[data-pb]');
      for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
      materializeCss();
      html = document.documentElement.outerHTML;
      if (html.length > maxBytes) html = '';
    } catch (e) { html = ''; }
    try { post({ n: nonce, html: html }, '*'); } catch (e2) { /* parent gone */ }
  }
  // A response is about to mutate the DOM, so an outstanding request keeps the
  // quiet period open. maxMs is still the only thing that ends the render.
  function bump() {
    if (!armed) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (inflight > 0 || cssPending()) bump();
      else finish();
    }, quietMs);
  }
  function arm() { armed = true; bump(); }

  if (proxy) {
    var seq = 0, waiting = {};
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (e.source !== window.parent || !d || d.n !== nonce || !d.res) return;
      var cb = waiting[d.res.i];
      if (!cb) return;
      delete waiting[d.res.i];
      inflight--;
      bump();
      cb(d.res);
    });
    var body = function (b) {
      return typeof b === 'string' ? b : (b === undefined || b === null ? null : String(b));
    };
    var send = function (req) {
      return new Promise(function (resolve) {
        req.i = ++seq;
        waiting[req.i] = resolve;
        inflight++;
        bump();
        post({ n: nonce, req: req }, '*');
      });
    };

    window.fetch = function (input, init) {
      init = init || {};
      var url = (input && input.url) || String(input);
      var hdrs = {}, h = init.headers || (input && input.headers);
      if (Array.isArray(h)) h.forEach(function (p) { hdrs[p[0]] = p[1]; });
      else if (h && typeof h.forEach === 'function') h.forEach(function (v, k) { hdrs[k] = v; });
      else if (h) for (var k in h) hdrs[k] = h[k];
      return send({ u: url, m: String(init.method || (input && input.method) || 'GET').toUpperCase(),
        h: hdrs, b: body(init.body) }).then(function (r) {
        if (r.err) throw new TypeError('Failed to fetch');
        var empty = r.s === 204 || r.s === 205 || r.s === 304;
        var res;
        try { res = new Response(empty ? null : r.b, { status: r.s, statusText: r.t, headers: r.h }); }
        catch (e) { res = new Response(empty ? null : r.b, { status: r.s }); }
        try { Object.defineProperty(res, 'url', { value: r.u }); } catch (e2) { /* frozen */ }
        return res;
      });
    };

    var PXHR = function () {
      this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null;
      this.responseText = ''; this.responseURL = ''; this.responseType = '';
      this.withCredentials = false; this.timeout = 0;
      this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
      this._h = {}; this._ev = {};
    };
    PXHR.UNSENT = 0; PXHR.OPENED = 1; PXHR.HEADERS_RECEIVED = 2; PXHR.LOADING = 3; PXHR.DONE = 4;
    PXHR.prototype = {
      open: function (m, u) { this._m = String(m).toUpperCase(); this._u = u; this._state(1); },
      setRequestHeader: function (k, v) { this._h[k] = v; },
      overrideMimeType: function () {},
      abort: function () { this._dead = true; },
      addEventListener: function (t, f) { (this._ev[t] = this._ev[t] || []).push(f); },
      removeEventListener: function (t, f) {
        var a = this._ev[t] || [], i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
      },
      getResponseHeader: function (k) {
        k = String(k).toLowerCase();
        for (var n in (this._rh || {})) if (n.toLowerCase() === k) return this._rh[n];
        return null;
      },
      getAllResponseHeaders: function () {
        var s = '';
        for (var n in (this._rh || {})) s += n.toLowerCase() + ': ' + this._rh[n] + '\r\n';
        return s;
      },
      _fire: function (t) {
        var e = { type: t, target: this, currentTarget: this };
        var a = (this._ev[t] || []).concat(this['on' + t] || []);
        for (var i = 0; i < a.length; i++) try { a[i].call(this, e); } catch (x) { /* page bug */ }
      },
      _state: function (s) { this.readyState = s; this._fire('readystatechange'); },
      send: function (b) {
        var self = this;
        send({ u: this._u, m: this._m || 'GET', h: this._h, b: body(b) }).then(function (r) {
          if (self._dead) return;
          if (r.err) { self._state(4); self._fire('error'); self._fire('loadend'); return; }
          self.status = r.s; self.statusText = r.t || ''; self.responseURL = r.u; self._rh = r.h;
          self.responseText = r.b || '';
          self.response = self.responseText;
          if (self.responseType === 'json') {
            try { self.response = JSON.parse(self.responseText); } catch (e) { self.response = null; }
          }
          self._state(2); self._state(3); self._state(4);
          self._fire('load'); self._fire('loadend');
        });
      },
    };
    window.XMLHttpRequest = PXHR;
    try {
      navigator.sendBeacon = function (u, d) { send({ u: u, m: 'POST', h: {}, b: body(d) }); return true; };
    } catch (e3) { /* read-only */ }
  }

  try {
    new MutationObserver(bump).observe(document, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
  } catch (e) { /* pre-body observe failed; timers still fire */ }
  document.addEventListener('DOMContentLoaded', arm);
  window.addEventListener('load', arm);
  setTimeout(arm, quietMs);
  setTimeout(finish, maxMs);
}

var PRIVATE_HOST = /^(localhost|.+\.(localhost|local|internal|home\.arpa))$/i;
var PRIVATE_IP4 = /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

// Everything the frame asks for lands here. Rejects anything that is not an
// http(s) request to the page's own registrable domain, and anything aimed at
// the phone's own network. Returns the absolute URL to fetch, or null.
function proxyPolicy(raw, base) {
  var u, b;
  try { u = new URL(String(raw), base); b = new URL(base); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  var h = u.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(h) || PRIVATE_IP4.test(h)) return null;
  // ponytail: 2000::/3 is the only globally routable v6 range; no PTR lookup.
  if (h.indexOf(':') >= 0 && !/^[23]/.test(h)) return null;
  // ponytail: no public suffix list, just the ccTLD shape (foo.co.uk); a
  // registry whose second level is longer than 3 chars would over-share.
  var reg = function (n) {
    var p = n.toLowerCase().split('.');
    return p.slice(p.length > 2 && p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? -3 : -2).join('.');
  };
  return reg(h) === reg(b.hostname) ? u.href : null;
}

function proxyFetch(url, req, timeoutMs, live) {
  return new Promise(function (resolve) {
    var x = new XMLHttpRequest();
    live.push(x);
    var t = setTimeout(function () { x.abort(); resolve({ err: 'timeout' }); }, timeoutMs);
    function fail(e) { clearTimeout(t); resolve({ err: e }); }
    try {
      x.open(req.m || 'GET', url, true);
      x.withCredentials = true; // whatever cookie jar the WebView has for that origin
      for (var k in req.h) try { x.setRequestHeader(k, req.h[k]); } catch (e) { /* forbidden */ }
    } catch (e2) { return fail('open'); }
    x.onload = function () {
      clearTimeout(t);
      var h = {};
      String(x.getAllResponseHeaders() || '').split(/\r?\n/).forEach(function (line) {
        var i = line.indexOf(':');
        if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      resolve({ s: x.status || 502, t: x.statusText || '', u: x.responseURL || url, h: h, b: x.responseText || '' });
    };
    x.onerror = function () { fail('network'); };
    x.send(req.b === undefined ? null : req.b);
  });
}

function offscreen(f, width) {
  f.style.cssText = 'position:absolute;left:-99999px;top:0;border:0;visibility:hidden;' +
    'width:' + width + 'px;height:800px';
}

// Stage 1. Resolves to hydrated HTML, or null if the page never settled.
function hydrate(html, o) {
  return new Promise(function (resolve) {
    var win = o.host.defaultView || window;
    var f = o.host.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    offscreen(f, o.width);
    var nonce = 'pb' + Math.random().toString(36).slice(2);
    var done = false;
    var stats = o.proxyStats = { requests: 0, blocked: 0, bytes: 0 };
    var live = [];
    function finish(out) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeEventListener('message', onMsg);
      live.forEach(function (x) { try { x.abort(); } catch (e) { /* done */ } });
      f.remove();
      resolve(out || null);
    }
    function reply(i, res) {
      res.i = i;
      try { f.contentWindow.postMessage({ n: nonce, res: res }, '*'); } catch (e) { /* frame gone */ }
    }
    // Blocked requests still count, so a page spraying denied URLs runs out.
    function serve(req) {
      stats.requests++;
      var url = done ? null : proxyPolicy(req.u, o.baseHref);
      if (!url || stats.requests > o.proxyMaxRequests || stats.bytes > o.proxyMaxBytes) {
        stats.blocked++;
        return reply(req.i, { err: 'blocked' });
      }
      proxyFetch(url, req, o.proxyTimeoutMs, live).then(function (r) {
        stats.bytes += (r.b || '').length;
        reply(req.i, r);
      });
    }
    function onMsg(e) {
      if (e.source !== f.contentWindow || !e.data || e.data.n !== nonce) return;
      if (e.data.req) return serve(e.data.req);
      finish(e.data.html);
    }
    var timer = setTimeout(finish, o.settleMaxMs + 2000);
    win.addEventListener('message', onMsg);
    f.srcdoc = injectHead(String(html).replace(ADS, ''),
      '<meta data-pb http-equiv="Content-Security-Policy" content="img-src \'none\';' +
      'media-src \'none\';font-src \'none\';connect-src \'none\'">' +
      styleHead(o, false, false) +
      '<script data-pb>(' + settleAgent.toString() + ')(' +
      (o.settleQuietMs | 0) + ',' + (o.settleMaxMs | 0) + ',' + (o.maxHtmlBytes | 0) +
      ',' + JSON.stringify(nonce) + ',' + !!o.proxy + ')<\/script>');
    o.host.body.appendChild(f);
  });
}

// The Pebble system font has limited glyph coverage: no emoji, no variation
// selectors, and accented Latin characters may or may not be present depending
// on the watch model. Strip diacritics (é→e, ç→c), drop emoji/supplementary
// plane chars and variation selectors, and NFC-normalize so the WebView
// measures exactly what the watch can render.
function sanitizeText(text) {
  if (!text) return text;
  try { text = text.normalize('NFC'); } catch (e) {}
  var out = '';
  for (var i = 0; i < text.length; i++) {
    var cp = text.codePointAt(i);
    // Drop supplementary-plane characters (emoji, etc.) — skip low surrogate
    if (cp > 0xffff) { i++; continue; }
    // Drop variation selectors (U+FE00–U+FE0F), ZWJ, ZWNJ
    if ((cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d || cp === 0x200c) continue;
    // Replace lone surrogates (shouldn't happen in well-formed DOM text)
    if (cp >= 0xd800 && cp <= 0xdfff) { out += '?'; continue; }
    var ch = text.charAt(i);
    if (cp >= 0x80) {
      // Strip diacritics: NFD decompose → remove combining marks (U+0300–U+036F)
      try {
        var nfd = ch.normalize('NFD');
        var stripped = '';
        for (var k = 0; k < nfd.length; k++) {
          var cc = nfd.charCodeAt(k);
          if (cc >= 0x0300 && cc <= 0x036f) continue;
          stripped += nfd.charAt(k);
        }
        // Use the stripped version only if it collapsed to a single ASCII char
        if (stripped.length === 1 && stripped.charCodeAt(0) < 0x80) {
          out += stripped;
          continue;
        }
      } catch (e) {}
    }
    out += ch;
  }
  return out;
}

// The watch is fed the original characters; the transform's zero-width spaces,
// word joiners and forced newlines exist only to steer Chromium.
function sourceText(meta, from, to) {
  if (!meta) return null;
  return meta.orig.slice(meta.map[from], meta.map[to - 1] + 1);
}

// Splits a text node into one run per visual line using word-granularity rects.
function runsFor(node, doc, meta) {
  var s = node.nodeValue;
  var range = doc.createRange();
  range.selectNodeContents(node);
  var rects = range.getClientRects();
  if (!rects.length) return [];

  var toks = [], re = /\S+/g, m;
  while ((m = re.exec(s))) toks.push([m[0], m.index]);
  if (!toks.length) return [];
  var span = function (a, b) {
    return sourceText(meta, toks[a][1], toks[b][1] + toks[b][0].length) ||
      toks.slice(a, b + 1).map(function (t) { return t[0]; }).join(' ');
  };
  if (rects.length === 1) {
    return [{ x: rects[0].left, y: rects[0].top, text: span(0, toks.length - 1) }];
  }

  var lines = [], cur = null;
  for (var i = 0; i < toks.length; i++) {
    range.setStart(node, toks[i][1]);
    range.setEnd(node, toks[i][1] + toks[i][0].length);
    var r = range.getClientRects()[0];
    if (!r || (!r.width && !r.height)) continue;
    if (cur && Math.abs(r.top - cur.y) <= 1) {
      cur.last = i;
      if (r.left < cur.x) cur.x = r.left;
    } else {
      cur = { x: r.left, y: r.top, first: i, last: i };
      lines.push(cur);
    }
  }
  return lines.map(function (l) { return { x: l.x, y: l.y, text: span(l.first, l.last) }; });
}

// Pebble's metrics are per size, not a scaling, so each bucket needs its own
// face; and the transform needs HTML-normal (collapsed) whitespace, which
// white-space:pre-wrap would otherwise preserve verbatim.
function applyPebbleFonts(win, doc, o) {
  var metas = new Map();
  if (!fontCss) return metas;
  var walker = doc.createTreeWalker(doc.body, 4, null);
  var jobs = [], n;
  while ((n = walker.nextNode())) {
    if (!/\S/.test(n.nodeValue)) continue;
    var el = n.parentElement;
    if (!el || SKIP[el.tagName]) continue;
    var font = fontFor(win.getComputedStyle(el));
    var box = 0;
    for (var p = el; p && !box; p = p.parentElement) box = p.clientWidth;
    jobs.push({ node: n, el: el, font: font, box: box || o.width });
  }
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i], st = j.el.style;
    st.setProperty('font-family', FACE[j.font >> 1], 'important');
    st.setProperty('font-size', FACE_PX[j.font >> 1] + 'px', 'important');
    st.setProperty('font-weight', (j.font & 1) ? '700' : '400', 'important');

    var text = sanitizeText(j.node.nodeValue.replace(/\s+/g, ' '));
    if (!j.node.previousSibling) text = text.replace(/^ /, '');
    if (!j.node.nextSibling) text = text.replace(/ $/, '');
    if (!text) continue;
    if (pebbleText) {
      var t = pebbleText.transform(text, j.box, FACE_NAME[j.font]);
      j.node.nodeValue = t.text;
      metas.set(j.node, { orig: text, map: t.map });
    } else {
      j.node.nodeValue = text;
    }
  }
  return metas;
}

function usableHref(a) {
  var h = a.getAttribute('href');
  if (!h || h.charAt(0) === '#') return null;
  var abs = a.href;
  return /^(https?|mailto|tel):/i.test(abs) ? abs : null;
}

var TEXT_INPUT = { text: 1, search: 1, email: 1, url: 1, password: 1, number: 1, tel: 1 };
var BUTTON_INPUT = { submit: 1, button: 1, image: 1, reset: 1 };

// SUBMIT means "enter/submit here triggers the form", so it rides on the text
// field as well as on the button. A textarea takes a newline instead.
function fieldFor(el) {
  var type = String(el.type || '').toLowerCase();
  var form = !!el.form;
  if (el.tagName === 'TEXTAREA') return { type: 'textarea', flags: 0, submits: false };
  if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && BUTTON_INPUT[type])) {
    var s = form && type !== 'button' && type !== 'reset';
    return { type: type || 'submit', flags: dl.INPUT_FLAG.BUTTON | (s ? dl.INPUT_FLAG.SUBMIT : 0), submits: s };
  }
  if (el.tagName === 'INPUT' && TEXT_INPUT[type]) {
    return { type: type, submits: form,
      flags: (type === 'password' ? dl.INPUT_FLAG.PASSWORD : 0) | (form ? dl.INPUT_FLAG.SUBMIT : 0) };
  }
  return null;
}

// applyPebbleFonts has already rewritten the text nodes with the break-steering
// transform, so a button's label has to come back out of the source map or it
// arrives as "S u b s c r i b e".
function origText(el, metas) {
  var out = '', w = el.ownerDocument.createTreeWalker(el, 4, null), n;
  while ((n = w.nextNode())) out += metas.get(n) ? metas.get(n).orig : n.nodeValue;
  return out;
}

function fieldLabel(el, f, metas) {
  var s = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') ||
    ((f.flags & dl.INPUT_FLAG.BUTTON) ? (el.value || origText(el, metas) || '') : '') ||
    el.getAttribute('name') || f.type;
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Enough to re-find the control in the live page after the watch replies.
function cssPath(el) {
  var parts = [];
  for (var n = el; n && n.nodeType === 1 && n.tagName !== 'HTML'; n = n.parentElement) {
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
    var i = 1;
    for (var s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
  }
  return parts.join(' > ');
}

function hasBox(el) {
  var rects = el.getClientRects();
  for (var i = 0; i < rects.length; i++) if (rects[i].width >= 1 && rects[i].height >= 1) return true;
  return false;
}

// ---- images ---------------------------------------------------------------

var CRC = null;
function crc32(bytes) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC[n] = c >>> 0;
    }
  }
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var out = [], i;
  var len = data.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  var body = [];
  for (i = 0; i < 4; i++) body.push(type.charCodeAt(i));
  for (i = 0; i < len; i++) body.push(data[i] & 0xff);
  var c = crc32(body);
  return out.concat(body, [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]);
}

var SNAP = [0, 85, 170, 255];
function snap(v) { return SNAP[Math.max(0, Math.min(3, Math.round(v / 85)))]; }

// Atkinson diffuses 6/8 of the error; the missing 2/8 is what keeps it cheap
// to compress and washes out less at 200px wide.
function diffuse(buf, w, h, x, y, ch, c, err) {
  var pts = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];
  for (var i = 0; i < 6; i++) {
    var nx = x + pts[i][0], ny = y + pts[i][1];
    if (nx < 0 || nx >= w || ny >= h) continue;
    buf[(ny * w + nx) * ch + c] += err / 8;
  }
}

function quantize(data, w, h, o) {
  var mono = o.imageBits === 1;
  var dither = o.imageDither !== 'none';
  var ch = mono ? 1 : 3;
  var buf = new Float32Array(w * h * ch);
  var i, p;
  for (i = 0; i < w * h; i++) {
    var a = data[i * 4 + 3] / 255;
    var r = data[i * 4] * a + 255 * (1 - a);
    var g = data[i * 4 + 1] * a + 255 * (1 - a);
    var b = data[i * 4 + 2] * a + 255 * (1 - a);
    if (mono) buf[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    else { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; }
  }

  var idx = new Uint8Array(w * h);
  var pal = mono ? [[0, 0, 0], [255, 255, 255]] : [];
  var seen = {};
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      p = y * w + x;
      if (mono) {
        var v = buf[p], out = v >= 128 ? 255 : 0;
        idx[p] = out ? 1 : 0;
        if (dither) diffuse(buf, w, h, x, y, 1, 0, v - out);
      } else {
        var c3 = [0, 0, 0];
        for (i = 0; i < 3; i++) {
          var cv = buf[p * 3 + i], sv = snap(cv);
          c3[i] = sv;
          if (dither) diffuse(buf, w, h, x, y, 3, i, cv - sv);
        }
        var key = (c3[0] << 16) | (c3[1] << 8) | c3[2];
        if (seen[key] === undefined) { seen[key] = pal.length; pal.push(c3); }
        idx[p] = seen[key];
      }
    }
  }
  return { bits: mono ? 1 : 8, pal: pal, idx: idx };
}

function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return Promise.reject(new Error('no CompressionStream'));
  var s = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Response(s).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
}

function pngIndexed(w, h, q) {
  var perByte = 8 / q.bits;
  var stride = Math.ceil(w / perByte);
  var raw = new Uint8Array(h * (stride + 1));
  for (var y = 0; y < h; y++) {
    var row = y * (stride + 1) + 1;
    for (var x = 0; x < w; x++) {
      if (q.bits === 8) raw[row + x] = q.idx[y * w + x];
      else raw[row + (x >> 3)] |= (q.idx[y * w + x] & 1) << (7 - (x & 7));
    }
  }
  return deflate(raw).then(function (z) {
    var ihdr = [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff,
      (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, q.bits, 3, 0, 0, 0];
    var plte = [];
    for (var i = 0; i < q.pal.length; i++) plte.push(q.pal[i][0], q.pal[i][1], q.pal[i][2]);
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .concat(chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', z), chunk('IEND', []));
  });
}

// A cross-origin <img> taints the canvas, so the pixels are re-fetched as bytes
// and decoded from a same-origin blob. Needs allowUniversalAccessFromFileURLs,
// which the PKJS WebView sets.
function sameOriginBitmap(url) {
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.responseType = 'arraybuffer';
    x.onload = function () {
      if (x.status && (x.status < 200 || x.status >= 300)) return reject(new Error('http ' + x.status));
      if (!x.response) return reject(new Error('empty'));
      resolve(createImageBitmap(new Blob([x.response])));
    };
    x.onerror = function () { reject(new Error('xhr failed')); };
    x.send();
  });
}

function drawTo(o, src, c) {
  var cv = o.host.createElement('canvas');
  cv.width = c.w;
  cv.height = c.h;
  var ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0, c.w, c.h);
  return ctx.getImageData(0, 0, c.w, c.h).data;
}

function encodeOne(o, c) {
  var url = c.el.currentSrc || c.el.src;
  return sameOriginBitmap(url)
    .then(function (bm) { return drawTo(o, bm, c); })
    .catch(function () { return drawTo(o, c.el, c); })
    .then(function (px) { return pngIndexed(c.w, c.h, quantize(px, c.w, c.h, o)); });
}

function encodeImages(win, doc, o) {
  var els = doc.getElementsByTagName('img'), cands = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el.complete || !el.naturalWidth) continue;
    var r = el.getBoundingClientRect();
    if (r.width < o.minImagePx || r.height < o.minImagePx) continue;
    if (hiddenBranch(el, win)) continue;
    cands.push({ el: el, w: Math.round(r.width), h: Math.round(r.height) });
  }
  cands.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
  cands = cands.slice(0, o.maxImages);

  var budget = o.maxImageBytes, out = [];
  out.failed = 0;
  return cands.reduce(function (p, c) {
    return p.then(function () {
      if (budget <= 0) return null;
      return encodeOne(o, c).then(function (bytes) {
        if (bytes.length > budget) return;
        budget -= bytes.length;
        c.bytes = bytes;
        out.push(c);
      }, function () { out.failed++; });
    });
  }, Promise.resolve()).then(function () { return out; });
}

// ---- display list ---------------------------------------------------------

function build(win, doc, o, metas) {
  var width = o.width;
  var pageH = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1);
  var ox = win.scrollX || 0, oy = win.scrollY || 0;

  return (o.images ? encodeImages(win, doc, o) : Promise.resolve([])).then(function (imgs) {
    var recs = [];
    var links = [];
    var fields = [];
    var bgs = new Map();
    var ctrls = [].slice.call(doc.querySelectorAll('input,textarea,button,select'));
    var forms = [].slice.call(doc.forms);

    function effectiveBg(el) {
      if (bgs.has(el)) return bgs.get(el);
      var c = bgColor(win.getComputedStyle(el).backgroundColor);
      if (c === WHITE && el.parentElement) c = effectiveBg(el.parentElement);
      bgs.set(el, c);
      return c;
    }

    function cx(x) { return Math.max(0, Math.min(MAX_I16, Math.round(x + ox))); }

    // Absolute page rects of an element; inline elements give one per line.
    function boxes(el) {
      var rects = el.getClientRects(), out = [];
      for (var k = 0; k < rects.length; k++) {
        var r = rects[k];
        if (r.width < 1 || r.height < 1) continue;
        var t = Math.round(r.top + oy);
        out.push({ top: t, bot: Math.round(r.bottom + oy), x: cx(r.left), w: Math.min(MAX_I16, Math.round(r.width)) });
      }
      return out;
    }

    function imageFor(el) {
      for (var i = 0; i < imgs.length; i++) if (imgs[i].el === el) return imgs[i];
      return null;
    }

    var walker = doc.createTreeWalker(doc.body, 1 | 4, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return /\S/.test(n.nodeValue) ? 1 : 2;
        if (SKIP[n.tagName]) return 2;
        return hidden(win.getComputedStyle(n)) ? 2 : 1;
      },
    });

    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        var pcs = win.getComputedStyle(n.parentElement);
        var font = fontFor(pcs);
        var tcolor = legible(dl.cssToGColor8(pcs.color), effectiveBg(n.parentElement));
        var runs = runsFor(n, doc, metas.get(n));
        for (var i = 0; i < runs.length; i++) {
          var ty = Math.round(runs[i].y + oy);
          if (ty < 0) continue;
          recs.push({ k: 't', top: ty, bot: ty, x: cx(runs[i].x), font: font, color: tcolor,
            enc: dl.encodeText(runs[i].text), text: runs[i].text });
        }
        continue;
      }

      var cs = win.getComputedStyle(n);
      var tag = n.tagName;

      // Quantization alone folds near-whites to 0xff, so this drops ordinary
      // page backgrounds without a separate threshold.
      var bg = bgColor(cs.backgroundColor);
      if (bg !== WHITE) {
        var fills = boxes(n);
        for (var b = 0; b < fills.length; b++) {
          fills[b].k = 'f';
          fills[b].argb = bg;
          recs.push(fills[b]);
        }
      }

      if (tag === 'IMG') {
        var im = imageFor(n);
        if (im) {
          var ib = boxes(n)[0];
          if (ib) {
            ib.k = 'i';
            ib.h = im.h;
            ib.w = im.w;
            ib.bytes = im.bytes;
            recs.push(ib);
          }
        }
        continue;
      }

      if (tag === 'HR' || n.getAttribute('role') === 'separator') {
        var rr = n.getBoundingClientRect();
        var ry = Math.round(rr.top + oy);
        if (ry >= 0) {
          var rc = cs.borderTopColor && cs.borderTopWidth !== '0px' ? cs.borderTopColor : cs.color;
          recs.push({ k: 'r', top: ry, bot: ry, w: Math.min(width, Math.round(rr.width) || width),
            color: legible(dl.cssToGColor8(rc), effectiveBg(n)) });
        }
        continue;
      }

      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
        var fd = fieldFor(n);
        // The raw rect, not boxes(): cx() clamps a left:-99999px control back
        // onto the page, and those are exactly the ones to drop.
        var rc = fd && n.getBoundingClientRect();
        if (rc && rc.width >= 1 && rc.height >= 1 && rc.right > 0 && rc.left < width && rc.top + oy >= 0) {
          var label = fieldLabel(n, fd, metas);
          fields.push({
            id: fields.length, tag: tag.toLowerCase(), type: fd.type,
            name: n.getAttribute('name') || '', placeholder: label,
            selector: cssPath(n), index: ctrls.indexOf(n),
            form: n.form ? forms.indexOf(n.form) : -1,
            action: n.form ? n.form.action || '' : '',
            method: n.form ? String(n.form.method || 'get').toLowerCase() : '',
            submits: fd.submits, flags: fd.flags,
          });
          recs.push({ k: 'n', top: Math.round(rc.top + oy), bot: Math.round(rc.bottom + oy),
            x: cx(rc.left), w: Math.min(MAX_I16, Math.round(rc.width)),
            id: fields.length - 1, flags: fd.flags, label: label, enc: dl.encodeText(label) });
        }
      }

      if (tag === 'A') {
        var href = usableHref(n);
        if (!href) continue;
        var lb = boxes(n);
        if (!lb.length) continue;
        // ids are page-global: the watch sends one back and the phone resolves
        // it against the whole-page table, whatever segment it came from.
        var id = links.length;
        links.push(href);
        for (var j = 0; j < lb.length; j++) {
          lb[j].k = 'l';
          lb[j].id = id;
          recs.push(lb[j]);
        }
      }
    }

    // Paint order is y order; ties keep document order (fill before its text).
    recs.sort(function (a, b) { return a.top - b.top; });

    // Overflowing/absolutely-placed content can sit below scrollHeight; without
    // this every stray record past it would start its own one-pixel segment.
    for (var q = 0; q < recs.length; q++) pageH = Math.max(pageH, recs[q].bot);

    // A segment must fit BOTH the watch's int16 page height and its receive
    // buffer, and text-dense pages hit the byte limit first.
    var cap = Math.min(o.maxSegmentBytes, MAX_SEG_BYTES - 1);
    var all = [], tops = [], heights = [];
    var i2 = 0;
    while (i2 < recs.length || !all.length) {
      var top = tops.length ? tops[tops.length - 1] : 0;
      if (all.length) top = recs[i2].top;
      tops.push(top);
      var list = new dl.DisplayList(width);
      var color = DEFAULT_COLOR;
      var used = 10; // header + END
      var emitted = 0;
      var segH = Math.max(1, Math.min(dl.MAX_PAGE_H, pageH - top));

      while (i2 < recs.length) {
        var r = recs[i2];
        var y = r.top - top;
        if (y > segH) break;
        var wantColor = r.color !== undefined && r.color !== color;
        var cost = (wantColor ? 2 : 0) + (
          r.k === 't' ? 7 * Math.max(1, Math.ceil(r.enc.length / 255)) + r.enc.length
            : r.k === 'l' ? 11
              : r.k === 'f' ? 10
                : r.k === 'r' ? 5
                  : r.k === 'n' ? 13 + r.enc.length
                    : 11 + r.bytes.length);
        if (emitted && (used + cost > cap || (r.k === 'i' && r.bot - top > segH))) break;
        if (wantColor) list.color(color = r.color);
        var h = Math.min(r.bot - top, segH) - Math.max(y, 0);
        if (r.k === 't') list.text(r.x, y, r.font, r.text);
        else if (r.k === 'l') { if (h >= 1) list.link(r.x, Math.max(y, 0), r.w, h, r.id); }
        else if (r.k === 'f') { if (h >= 1) list.fill(r.x, Math.max(y, 0), r.w, h, r.argb); }
        else if (r.k === 'r') list.rule(y, r.w);
        else if (r.k === 'n') { if (h >= 1) list.input(r.x, Math.max(y, 0), r.w, h, r.id, r.flags, r.label); }
        else list.image(r.x, y, r.w, r.h, r.bytes);
        used += cost;
        emitted++;
        i2++;
      }

      // Trim the trailing gap so the watch does not scroll past the content.
      if (i2 < recs.length) segH = Math.max(1, Math.min(segH, recs[i2].top - top));
      heights.push(segH);
      all.push(list.finish(segH));
    }

    var seg = Math.min(o.segment, all.length - 1);
    return {
      bytes: all[seg],
      segmentBytes: all,
      segmentTops: tops,
      segmentHeights: heights,
      links: links,
      fields: fields,
      proxyStats: o.proxyStats || null,
      pageH: pageH,
      segH: heights[seg],
      segment: seg,
      segments: all.length,
      truncated: all.length > 1,
      width: width,
      title: (doc.title || '').trim(),
      images: imgs.length,
      imagesFailed: imgs.failed || 0,
      imageBytes: imgs.reduce(function (s, c) { return s + c.bytes.length; }, 0),
    };
  });
}

function layout(html, o) {
  return new Promise(function (resolve, reject) {
    var f = o.host.createElement('iframe');
    f.setAttribute('sandbox', 'allow-same-origin');
    offscreen(f, o.width);
    var settled = false;
    function go() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      function drop(e) { f.remove(); if (e) reject(e); }
      try {
        var idoc = f.contentDocument, iwin = f.contentWindow;
        var metas = applyPebbleFonts(iwin, idoc, o);
        // scrollHeight is floored by the iframe's own height; collapse first.
        f.style.height = '0px';
        var h = Math.max(idoc.documentElement.scrollHeight, idoc.body.scrollHeight, 1);
        f.style.height = h + 'px';
        void idoc.body.offsetHeight;
        build(iwin, idoc, o, metas).then(function (r) {
          // The markup the field selectors were derived from. Absent, never
          // truncated, when it is too big to hand back through PKJS.
          if (html.length <= o.maxHtmlBytes) r.html = html;
          drop();
          resolve(r);
        }, drop);
      } catch (e) {
        drop(e);
      }
    }
    var timer = setTimeout(go, o.timeoutMs);
    f.addEventListener('load', go);
    f.srcdoc = injectHead(html, styleHead(o, o.images, true));
    o.host.body.appendChild(f);
  });
}

function visibleLen(html) {
  return html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
}

// Page JS that boots and then replaces server-rendered markup with a spinner
// (it cannot fetch, by design) must not cost us the text we already had.
function keptContent(hydrated, raw) {
  return hydrated && visibleLen(hydrated) >= visibleLen(raw) * 0.5 ? hydrated : null;
}

function render(html, opts) {
  var o = options(opts || {});
  if (!o.scripts) return layout(html, o);
  return hydrate(html, o).then(function (h) { return layout(keptContent(h, html) || html, o); });
}

// Readability strips chrome/nav before layout. Falls back to the raw page when
// extraction fails or the library is not bundled.
function renderReadable(html, opts) {
  opts = opts || {};
  var o = options(opts);
  var R;
  try {
    R = require('@mozilla/readability').Readability;
  } catch (e) {
    R = null;
  }
  if (!R) return render(html, opts);
  var pre = o.scripts ? hydrate(html, o) : Promise.resolve(null);
  return pre.then(function (h) {
    h = keptContent(h, html);
    var src = h || html;
    var article = null;
    try {
      if (o.baseHref) src = src.replace(/<head[^>]*>/i, '$&<base href="' + esc(o.baseHref) + '">');
      article = new R(new DOMParser().parseFromString(src, 'text/html')).parse();
    } catch (e2) {
      article = null;
    }
    if (!article || !article.content) {
      return layout(h || html, o);
    }
    return layout('<!doctype html><html><head><title>' + esc(article.title || '') +
      '</title></head><body>' + article.content + '</body></html>', o);
  });
}

module.exports = { render: render, renderReadable: renderReadable, CONFIG: CONFIG };

