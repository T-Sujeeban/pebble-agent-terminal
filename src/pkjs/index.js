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
var CMD_HELLO_ROUND = 0x10000;

var s_width = 200;
var s_round = false;

function log(msg) {
  console.log('[agent-terminal] ' + msg);
}

function status(text) {
  try { Pebble.sendAppMessage({ STATUS: String(text).slice(0, 63) }); } catch (e) {}
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
    '<h1>Agent Terminal</h1>' +
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
      sendSimplePage('Agent Terminal', ['Press SELECT', 'to talk'], '#2196F3');
      break;

    case CMD_TEXT:
      var text = p.TEXT;
      if (!text || !String(text).trim()) {
        log('empty text');
        return;
      }
      log('user: ' + text);
      agent.askAgent(String(text), agentCallbacks);
      break;

    case CMD_CANCEL:
      log('cancelled');
      agent.cancelRequest();
      status('Cancelled');
      sendSimplePage('Agent Terminal', ['Request cancelled.', 'Press SELECT to try again.'], '#2196F3');
      break;
  }
});
