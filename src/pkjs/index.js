// Agent Terminal — PKJS entry point.
//
// Handles AppMessage from the watch, delegates to agent.js for Mistral API
// calls, and manages the settings page.
//
// Runs inside the Pebble mobile app's Chromium WebView (Android). The DOM
// is available for renderer.js to lay out agent-generated HTML.

var agent = require('./agent');

// Mirrors CMD_* in src/c/net.h.
var CMD_HELLO = 1;
var CMD_TEXT = 6;
var CMD_CANCEL = 10;
var CMD_HOME = 11;
var CMD_HELLO_ROUND = 0x10000;

var s_width = 200;
var s_round = false;
var APP_VERSION = '0.2.1';

function log(msg) {
  console.log('[agent-terminal] ' + msg);
}

function status(text) {
  try { Pebble.sendAppMessage({ STATUS: String(text).slice(0, 63) }); } catch (e) {}
}

// Strip accents and non-ASCII from dictation input so the AI always
// receives clean ASCII text (and the conversation history stays ASCII).
function sanitizeDictation(text) {
  try { text = text.normalize('NFD'); } catch (e) { return text; }
  var out = '';
  for (var i = 0; i < text.length; i++) {
    var cc = text.charCodeAt(i);
    if (cc >= 0x0300 && cc <= 0x036f) continue; // combining marks
    if (cc < 0x20 || cc > 0x7e) { out += '?'; continue; } // non-printable-ASCII
    out += text.charAt(i);
  }
  return out;
}

// --- Page builders for error/idle states -----------------------------------

var dl = require('./dl');

function buildMessagePage(title, lines, color) {
  var list = new dl.DisplayList(s_width);
  var y = 4;

  var headerColor = dl.toGColor8(
    parseInt(color.substr(1, 2), 16),
    parseInt(color.substr(3, 2), 16),
    parseInt(color.substr(5, 2), 16)
  );
  list.fill(0, y, s_width, 24, headerColor);
  list.color(0xff);
  list.text(8, y + 4, dl.FONT.GOTHIC_18_BOLD, title);
  list.color(0xc0);
  y += 30;

  for (var i = 0; i < lines.length; i++) {
    var text = String(lines[i]);
    var words = text.split(/\s+/);
    var line = '';
    for (var w = 0; w < words.length; w++) {
      if (line && line.length + 1 + words[w].length > 28) {
        list.text(8, y, dl.FONT.GOTHIC_14, line);
        y += 16;
        line = words[w];
      } else {
        line = line ? line + ' ' + words[w] : words[w];
      }
    }
    if (line) {
      list.text(8, y, dl.FONT.GOTHIC_14, line);
      y += 16;
    }
    y += 4;
  }

  return list.finish(y + 4);
}

function sendSimplePage(title, lines, color) {
  var bytes = buildMessagePage(title, lines, color || '#2196F3');
  var transport = require('./transport');
  var pageId = (Math.floor(Math.random() * 256)) & 0xff;
  transport.sendBuffer(bytes, pageId, {
    onDone: function (err) {
      if (err) log('send failed: ' + err);
    },
  });
}

// --- Welcome page (Mistral-branded home screen) -----------------------------

function buildWelcomePage() {
  var list = new dl.DisplayList(s_width);
  var W = s_width;

  // Mistral gradient header: 4 horizontal strips (yellow → orange → red → dark red)
  var gradColors = [
    dl.toGColor8(255, 216, 0),   // #FFD800 yellow
    dl.toGColor8(255, 112, 0),   // #FF7000 orange
    dl.toGColor8(196, 30, 58),   // #C41E3A red
    dl.toGColor8(107, 15, 26),   // #6B0F1A dark red
  ];
  var stripH = 16;
  var headerH = gradColors.length * stripH; // 64px
  for (var i = 0; i < gradColors.length; i++) {
    list.fill(0, i * stripH, W, stripH, gradColors[i]);
  }

  // Pixel-art "M" logo in white, centered on the gradient
  // 5×5 M pattern at 6px per pixel = 30×30 px
  var px = 6;
  var logoSize = 5 * px;
  var logoX = Math.floor((W - logoSize) / 2);
  var logoY = 10;
  var mRows = [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ];
  for (var row = 0; row < 5; row++) {
    var col = 0;
    while (col < 5) {
      if (mRows[row][col]) {
        var start = col;
        while (col < 5 && mRows[row][col]) col++;
        list.fill(logoX + start * px, logoY + row * px, (col - start) * px, px, 0xFF);
      } else {
        col++;
      }
    }
  }

  // Title: "Agent Terminal" in white below the logo
  list.color(0xFF);
  var titleY = logoY + logoSize + 4;
  list.text(35, titleY, dl.FONT.GOTHIC_18_BOLD, 'Agent Terminal');

  // Subtitle: "Powered by Mistral AI"
  var subY = titleY + 20;
  list.text(16, subY, dl.FONT.GOTHIC_14, 'Powered by Mistral AI');

  // Instructions card (light gray box — 0xEA = GColor8 medium-light gray)
  var cardY = headerH + 14;
  var cardH = 72;
  list.fill(8, cardY, W - 16, cardH, dl.toGColor8(200, 200, 200));
  list.color(0xC0);
  list.text(20, cardY + 10, dl.FONT.GOTHIC_18_BOLD, 'Press SELECT');
  list.text(20, cardY + 32, dl.FONT.GOTHIC_18, 'to talk');
  list.color(0xAA);
  list.text(20, cardY + 54, dl.FONT.GOTHIC_14, 'BACK = home');

  // Footer with version
  var footerY = cardY + cardH + 16;
  list.color(0xAA);
  list.text(32, footerY, dl.FONT.GOTHIC_14, 'Mistral AI v' + APP_VERSION);

  return list.finish(footerY + 18);
}

function sendWelcomePage() {
  var bytes = buildWelcomePage();
  var transport = require('./transport');
  var pageId = (Math.floor(Math.random() * 256)) & 0xff;
  transport.sendBuffer(bytes, pageId, {
    onDone: function (err) {
      if (err) log('send welcome failed: ' + err);
    },
  });
}

// --- Agent callbacks -------------------------------------------------------

var agentCallbacks = {
  onDisplayList: function (bytes, pageId) {
    status('Agent Terminal');
  },
  onStatus: function (text) {
    status(text);
  },
  onError: function (title, detail) {
    log('error: ' + title + ' — ' + detail);
    status('Error');
    sendSimplePage(title, [detail], '#f44336');
  },
};

// --- Settings page ---------------------------------------------------------

function configPage() {
  var cfg = agent.getConfig();
  var html =
    '<!doctype html><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    '<title>Agent Terminal</title><style>' +
    'body{font:16px -apple-system,Roboto,sans-serif;margin:0;padding:16px;background:#f7f7f7;color:#111}' +
    'h1{font-size:19px;margin:0 0 4px}' +
    'p{color:#666;font-size:13px;margin:0 0 16px}' +
    'label{display:block;font-size:13px;color:#555;margin:12px 0 4px}' +
    'input,select{width:100%;box-sizing:border-box;font:14px ui-monospace,Menlo,monospace;' +
    'padding:10px;border:1px solid #ccc;border-radius:8px;background:#fff}' +
    '.row{display:flex;gap:10px;margin-top:18px}' +
    'button{flex:1;padding:13px;font-size:16px;border:0;border-radius:8px}' +
    '#save{background:#0a7cff;color:#fff}#cancel{background:#e4e4e4;color:#222}' +
    '.danger{background:#f44336;color:#fff;margin-top:10px}' +
    '</style>' +
    '<h1>Agent Terminal <span style="font-size:12px;color:#999;font-weight:normal;">v' + APP_VERSION + '</span></h1>' +
    '<p>Configure your Mistral AI agent. Get an API key at <strong>console.mistral.ai</strong>.</p>' +
    '<label for="key">Mistral API Key</label>' +
    '<input id="key" type="password" placeholder="sk-..." value="' + escAttr(cfg.apiKey) + '">' +
    '<label for="model">Model</label>' +
    '<select id="model">' +
    modelOptions(cfg.model) +
    '</select>' +
    '<label for="prompt">System Prompt (advanced)</label>' +
    '<textarea id="prompt" style="width:100%;height:20vh;box-sizing:border-box;font:12px ui-monospace,Menlo,monospace;padding:10px;border:1px solid #ccc;border-radius:8px;background:#fff;resize:vertical;">' + escHtml(cfg.systemPrompt) + '</textarea>' +
    '<div class=row><button id=cancel>Cancel</button><button id=save>Save</button></div>' +
    '<button id="clear" class=danger>Clear conversation history</button>' +
    '<button id="resetPrompt" style="background:#ff9800;color:#fff;margin-top:10px;">Reset prompt to default</button>' +
    '<script>' +
    'function close(v){location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));}' +
    'document.getElementById("cancel").onclick=function(){close({});};' +
    'document.getElementById("save").onclick=function(){' +
    'close({apiKey:document.getElementById("key").value.trim(),' +
    'model:document.getElementById("model").value,' +
    'systemPrompt:document.getElementById("prompt").value});};' +
    'document.getElementById("clear").onclick=function(){close({clearHistory:true});};' +
    'document.getElementById("resetPrompt").onclick=function(){' +
    'close({apiKey:document.getElementById("key").value.trim(),' +
    'model:document.getElementById("model").value,' +
    'resetPrompt:true});};' +
    '<\/script>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function modelOptions(selected) {
  var models = [
    'mistral-small-latest',
    'mistral-medium-latest',
    'mistral-large-latest',
    'open-mistral-nemo',
    'codestral-latest',
  ];
  return models.map(function (m) {
    return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>';
  }).join('');
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Event listeners -------------------------------------------------------

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configPage());
});

Pebble.addEventListener('webviewclosed', function (e) {
  var r = e && e.response;
  if (!r) return;
  var cfg;
  try { cfg = JSON.parse(decodeURIComponent(r)); } catch (err) {
    try { cfg = JSON.parse(r); } catch (err2) { log('bad config response'); return; }
  }
  if (!cfg) return;
  if (cfg.clearHistory) {
    agent.resetConversation();
    log('conversation history cleared');
    return;
  }
  if (cfg.apiKey || cfg.model || cfg.systemPrompt !== undefined || cfg.resetPrompt) {
    agent.saveConfig(cfg);
    agent.resetConversation();
    log('config saved');
  }
});

Pebble.addEventListener('ready', function () {
  var cfg = agent.getConfig();
  log('ready, dom=' + (typeof document !== 'undefined') + ', model=' + cfg.model +
      ', hasKey=' + !!cfg.apiKey);
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.CMD === undefined) return;
  var arg = p.ARG || 0;

  switch (p.CMD) {
    case CMD_HELLO:
      var w = arg & 0xffff;
      if (w > 0 && w <= 512) s_width = w;
      s_round = !!(arg & CMD_HELLO_ROUND);
      log('hello, width=' + s_width);
      agent.resetConversation();
      status('Agent Terminal');
      sendWelcomePage();
      break;

    case CMD_HOME:
      // BACK pressed while browsing — show welcome page, keep conversation
      log('home');
      status('Agent Terminal');
      sendWelcomePage();
      break;

    case CMD_TEXT:
      var text = p.TEXT;
      if (!text || !String(text).trim()) {
        log('empty text');
        return;
      }
      text = sanitizeDictation(String(text));
      log('user: ' + text);
      agent.askAgent(text, agentCallbacks);
      break;

    case CMD_CANCEL:
      log('cancelled');
      agent.cancelRequest();
      status('Cancelled');
      sendSimplePage('Agent Terminal', ['Request cancelled.', 'Press SELECT to try again.'], '#2196F3');
      break;
  }
});
