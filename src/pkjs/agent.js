// Mistral API client + conversation management for the Agent Terminal.
//
// Responsibilities:
//   - Manage conversation history (system prompt + user/assistant turns)
//   - Call the Mistral chat completions API
//   - Extract HTML from the agent's response (strip markdown fences, etc.)
//   - Render HTML → display list via renderer.js
//   - Send the display list to the watch via transport.js

var renderer = require('./renderer');
var transport = require('./transport');
var skill = require('./skill');

var MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
var DEFAULT_MODEL = 'mistral-small-latest';
var MAX_HISTORY_MESSAGES = 40;
var REQUEST_TIMEOUT_MS = 45000;

// --- Storage ---------------------------------------------------------------

function store(key, value) {
  try {
    if (value === undefined) {
      var s = localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* no localStorage */ }
  return null;
}

function removeStore(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

function getConfig() {
  var storedPrompt = store('agent_system_prompt');
  var storedVersion = store('agent_system_prompt_version');
  // Use the built-in default if no prompt is stored, or if the stored prompt
  // was saved by an older app version (version mismatch → auto-upgrade).
  var useDefault = !storedPrompt || storedVersion !== skill.SKILL_PROMPT_VERSION;
  return {
    apiKey: store('agent_api_key') || '',
    model: store('agent_model') || DEFAULT_MODEL,
    systemPrompt: useDefault ? skill.SKILL_PROMPT : storedPrompt,
  };
}

function saveConfig(cfg) {
  if (cfg.apiKey !== undefined) store('agent_api_key', cfg.apiKey);
  if (cfg.model !== undefined) store('agent_model', cfg.model);
  if (cfg.resetPrompt) {
    removeStore('agent_system_prompt');
    removeStore('agent_system_prompt_version');
  } else if (cfg.systemPrompt !== undefined) {
    store('agent_system_prompt', cfg.systemPrompt);
    store('agent_system_prompt_version', skill.SKILL_PROMPT_VERSION);
  }
}

// --- Conversation history --------------------------------------------------

var conversation = [];

function resetConversation() {
  conversation = [];
}

function addUserMessage(text) {
  conversation.push({ role: 'user', content: text });
  trimHistory();
}

function addAssistantMessage(html) {
  conversation.push({ role: 'assistant', content: html });
  trimHistory();
}

function trimHistory() {
  while (conversation.length > MAX_HISTORY_MESSAGES) {
    conversation.shift();
  }
}

function buildMessages() {
  var cfg = getConfig();
  var messages = [{ role: 'system', content: cfg.systemPrompt }];
  for (var i = 0; i < conversation.length; i++) {
    messages.push(conversation[i]);
  }
  return messages;
}

// --- HTML extraction -------------------------------------------------------

function extractHtml(response) {
  if (!response) return '';
  var text = String(response).trim();

  var fenceMatch = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  var firstTag = text.indexOf('<');
  var lastTag = text.lastIndexOf('>');
  if (firstTag >= 0 && lastTag > firstTag) {
    var before = text.slice(0, firstTag).trim();
    var after = text.slice(lastTag + 1).trim();
    if (before.length < 100 && after.length < 100) {
      text = text.slice(firstTag, lastTag + 1);
    }
  }

  return text;
}

function sanitizeHtml(html) {
  if (!html || !html.trim()) {
    return '<div style="background:#f44336;color:white;padding:4px 8px;font-weight:bold;">Empty response</div>' +
           '<p style="margin:8px;font-size:14px;">The agent returned an empty response. Try again.</p>';
  }

  var forbidden = /<script|<iframe|<object|<embed|<form|<input|<button|<select|<textarea/i;
  if (forbidden.test(html)) {
    html = html.replace(/<(script|iframe|object|embed|form|input|button|select|textarea)[^>]*>[\s\S]*?<\/\1>/gi, '');
    html = html.replace(/<(script|iframe|object|embed|form|input|button|select|textarea)[^>]*\/?>/gi, '');
  }

  if (/<table|<[^>]+style=["'][^"']*float|<[^>]+style=["'][^"']*display:\s*flex|<[^>]+style=["'][^"']*display:\s*grid/i.test(html)) {
    html = '<div style="background:#ff9800;color:white;padding:4px 8px;font-weight:bold;">Layout too complex</div>' +
           '<p style="margin:8px;font-size:14px;">The agent produced a layout too complex for the watch. Try rephrasing your question.</p>';
  }

  return html;
}

// --- Mistral API call ------------------------------------------------------

var currentRequest = null;
var requestToken = 0;

function cancelRequest() {
  requestToken++;
  if (currentRequest && currentRequest.xhr) {
    try { currentRequest.xhr.abort(); } catch (e) {}
  }
  currentRequest = null;
  transport.cancel();
}

function log(msg) {
  console.log('[agent] ' + msg);
}

function askAgent(userText, callbacks) {
  var cfg = getConfig();
  if (!cfg.apiKey) {
    callbacks.onError('No API key', 'Set your Mistral API key in the app settings.');
    return;
  }

  cancelRequest();
  var token = ++requestToken;

  addUserMessage(userText);
  callbacks.onStatus('Thinking...');

  var messages = buildMessages();
  var body = JSON.stringify({
    model: cfg.model,
    messages: messages,
    temperature: 0.3,
    max_tokens: 2048,
  });

  log('calling Mistral (' + cfg.model + ', ' + messages.length + ' messages)');

  var xhr = new XMLHttpRequest();
  currentRequest = { token: token, xhr: xhr };

  var timeoutId = setTimeout(function () {
    if (currentRequest && currentRequest.token === token) {
      try { xhr.abort(); } catch (e) {}
      currentRequest = null;
      if (requestToken === token) {
        callbacks.onError('Timeout', 'The agent took too long to respond.');
      }
    }
  }, REQUEST_TIMEOUT_MS);

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    clearTimeout(timeoutId);
    if (currentRequest && currentRequest.token !== token) return;
    currentRequest = null;
    if (requestToken !== token) return;

    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        var content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        var html = sanitizeHtml(extractHtml(content));
        addAssistantMessage(html);
        renderAndSend(html, token, callbacks);
      } catch (e) {
        log('parse error: ' + e);
        callbacks.onError('Parse error', String(e));
      }
    } else {
      var detail = xhr.responseText || ('HTTP ' + xhr.status);
      try {
        var err = JSON.parse(xhr.responseText);
        if (err.error && err.error.message) detail = err.error.message;
      } catch (e2) {}
      log('API error ' + xhr.status + ': ' + detail);
      callbacks.onError('API error ' + xhr.status, String(detail).slice(0, 200));
    }
  };

  xhr.open('POST', MISTRAL_API_URL, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + cfg.apiKey);
  xhr.setRequestHeader('Content-Type', 'application/json');
  try {
    xhr.send(body);
  } catch (e) {
    clearTimeout(timeoutId);
    currentRequest = null;
    callbacks.onError('Network error', String(e));
  }
}

// --- Render HTML → display list → send to watch ----------------------------

function renderAndSend(html, token, callbacks) {
  if (requestToken !== token) return;

  callbacks.onStatus('Rendering...');

  var hasDom = (typeof document !== 'undefined' && typeof document.createElement === 'function');
  if (!hasDom) {
    callbacks.onError('No DOM', 'This app requires Android (PKJS runs in a Chromium WebView).');
    return;
  }

  var fullHtml = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=200,initial-scale=1">' +
    '<style>' +
    'body{margin:0;padding:0;background:#fff;color:#000;font-family:sans-serif;width:200px;}' +
    'img{max-width:200px;}' +
    '</style></head><body>' + html + '</body></html>';

  renderer.render(fullHtml, {
    width: 200,
    round: false,
    scripts: false,
    images: true,
    minImagePx: 32,
    maxImageBytes: 16000,
    segment: 0,
  }).then(function (res) {
    if (requestToken !== token) return;

    var bytes = res.bytes;
    if (!bytes || bytes.length === 0) {
      callbacks.onError('Empty render', 'The agent response produced no displayable content.');
      return;
    }
    if (bytes.length > 32768) {
      callbacks.onError('Response too large', Math.round(bytes.length / 1024) + 'KB (limit 32KB). Try a shorter question.');
      return;
    }

    var pageId = (Math.floor(Math.random() * 256)) & 0xff;
    callbacks.onStatus('Sending...');

    transport.sendBuffer(bytes, pageId, {
      onDone: function (err) {
        if (requestToken !== token) return;
        if (err) {
          log('send failed: ' + err);
          callbacks.onError('Send failed', String(err));
        } else {
          log('sent ' + bytes.length + 'B display list');
          callbacks.onDisplayList(bytes, pageId);
        }
      },
    });
  }).catch(function (e) {
    if (requestToken !== token) return;
    log('render failed: ' + e);
    callbacks.onError('Render failed', String(e));
  });
}

// --- Exports ---------------------------------------------------------------

module.exports = {
  askAgent: askAgent,
  cancelRequest: cancelRequest,
  resetConversation: resetConversation,
  getConfig: getConfig,
  saveConfig: saveConfig,
  extractHtml: extractHtml,
  sanitizeHtml: sanitizeHtml,
  conversation: conversation,
};
