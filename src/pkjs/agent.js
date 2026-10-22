// Mistral Agent + Conversation API client for the Agent Terminal.
//
// Responsibilities:
//   - Create and manage a Mistral Agent (POST /v1/agents) with built-in tools
//     (web_search, code_interpreter) + custom function tools (get_weather, set_timer)
//   - Manage conversations via the Conversations API (POST /v1/conversations)
//   - Execute custom function tools in PKJS (Open-Meteo weather, watch timer)
//   - Tool loop: detect function.call entries, execute, append results, recurse
//   - Extract HTML from the agent's response entries
//   - Render HTML → display list via renderer.js
//   - Send the display list to the watch via transport.js
//
// The system prompt is stored server-side in the Agent's `instructions` field.
// Conversation history is stored server-side — we only keep a conversation_id.

var renderer = require('./renderer');
var transport = require('./transport');
var skill = require('./skill');

var MISTRAL_AGENTS_URL = 'https://api.mistral.ai/v1/agents';
var MISTRAL_CONVERSATIONS_URL = 'https://api.mistral.ai/v1/conversations';
var MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';
var OPEN_METEO_GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
var OPEN_METEO_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
var DEFAULT_MODEL = 'mistral-small-latest';
var REQUEST_TIMEOUT_MS = 45000;
var MAX_TOOL_ROUNDS = 5;

// Downstream command: phone → watch (set_timer).
var CMD_SET_TIMER = 12;

function log(msg) {
  console.log('[agent] ' + msg);
}

// --- Storage ---------------------------------------------------------------

function store(key, value) {
  try {
    if (value === undefined) {
      var s = localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    }
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (e) { /* no localStorage */ }
  return null;
}

function removeStore(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

function getConfig() {
  var storedPrompt = store('agent_system_prompt');
  var storedVersion = store('agent_system_prompt_version');
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
  // Model or prompt changed → agent must be recreated on next use.
  removeStore('agent_id');
  removeStore('agent_model');
  removeStore('agent_prompt_version');
  // Also reset conversation since the agent changed.
  removeStore('conversation_id');
}

// --- Tool definitions (sent to Mistral when creating the Agent) ------------

var TOOLS = [
  { type: 'web_search' },
  { type: 'code_interpreter' },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city. ALWAYS use this for weather questions. Never make up weather data.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, e.g. Paris, Tokyo, New York, Londres' }
        },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_timer',
      description: 'Set a vibrating timer on the Pebble watch. Use when the user asks for a timer, countdown, or alarm.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Timer duration in seconds (e.g. 300 for 5 minutes)' },
          label: { type: 'string', description: 'Optional short label for the timer, e.g. "tea", "pasta", "sport"' }
        },
        required: ['seconds']
      }
    }
  }
];

// --- Agent management ------------------------------------------------------

// Ensures a Mistral Agent exists. Recreates if model or prompt version changed.
// callback(agentId) — agentId is a string, or null on error.
function ensureAgent(callback) {
  var cfg = getConfig();
  if (!cfg.apiKey) { callback(null); return; }

  var storedAgentId = store('agent_id');
  var storedModel = store('agent_model');
  var storedPromptVer = store('agent_prompt_version');

  if (storedAgentId && storedModel === cfg.model &&
      storedPromptVer === skill.SKILL_PROMPT_VERSION) {
    log('using existing agent: ' + storedAgentId);
    callback(storedAgentId);
    return;
  }

  log('creating new agent (model=' + cfg.model + ')');

  var body = JSON.stringify({
    model: cfg.model,
    name: 'Pebble Watch Agent',
    description: 'Voice-driven AI assistant on a Pebble Time 2 smartwatch. Produces compact HTML for a 200x228 e-paper display. Has access to web search, code interpreter, weather, and watch timer tools.',
    instructions: cfg.systemPrompt,
    tools: TOOLS,
    completion_args: { temperature: 0.3, max_tokens: 2048 }
  });

  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        var agentId = data.id;
        store('agent_id', agentId);
        store('agent_model', cfg.model);
        store('agent_prompt_version', skill.SKILL_PROMPT_VERSION);
        log('agent created: ' + agentId);
        callback(agentId);
      } catch (e) {
        log('agent create parse error: ' + e);
        callback(null);
      }
    } else {
      var detail = xhr.responseText || ('HTTP ' + xhr.status);
      try {
        var err = JSON.parse(xhr.responseText);
        if (err.error && err.error.message) detail = err.error.message;
      } catch (e2) {}
      log('agent create error ' + xhr.status + ': ' + detail);
      callback(null);
    }
  };

  xhr.open('POST', MISTRAL_AGENTS_URL, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + cfg.apiKey);
  xhr.setRequestHeader('Content-Type', 'application/json');
  try {
    xhr.send(body);
  } catch (e) {
    log('agent create send error: ' + e);
    callback(null);
  }
}

// --- Conversation management -----------------------------------------------

function resetConversation() {
  removeStore('conversation_id');
}

// --- Custom tool execution -------------------------------------------------

// Execute a custom function tool. callback(resultJsonString)
function executeTool(name, argsJson, callback) {
  var args;
  try { args = JSON.parse(argsJson); } catch (e) {
    callback(JSON.stringify({ error: 'Invalid arguments: ' + e }));
    return;
  }

  if (name === 'get_weather') {
    getWeather(args.city || '', callback);
  } else if (name === 'set_timer') {
    setTimer(args.seconds || 0, args.label || '', callback);
  } else {
    callback(JSON.stringify({ error: 'Unknown tool: ' + name }));
  }
}

// Fetch weather from Open-Meteo (free, no API key).
// Two-step: geocode city → lat/lon, then fetch current conditions.
function getWeather(city, callback) {
  if (!city) {
    callback(JSON.stringify({ error: 'No city provided' }));
    return;
  }

  var geoUrl = OPEN_METEO_GEO_URL + '?name=' + encodeURIComponent(city) +
    '&count=1&language=fr&format=json';

  var geoXhr = new XMLHttpRequest();
  geoXhr.onreadystatechange = function () {
    if (geoXhr.readyState !== 4) return;
    if (geoXhr.status < 200 || geoXhr.status >= 300) {
      callback(JSON.stringify({ error: 'Geocoding failed (HTTP ' + geoXhr.status + ')' }));
      return;
    }
    try {
      var geo = JSON.parse(geoXhr.responseText);
      if (!geo.results || geo.results.length === 0) {
        callback(JSON.stringify({ error: 'City not found: ' + city }));
        return;
      }
      var loc = geo.results[0];
      fetchWeatherData(loc.latitude, loc.longitude, loc.name, callback);
    } catch (e) {
      callback(JSON.stringify({ error: 'Geocoding parse error: ' + e }));
    }
  };

  geoXhr.open('GET', geoUrl, true);
  try { geoXhr.send(); } catch (e) {
    callback(JSON.stringify({ error: 'Geocoding request failed: ' + e }));
  }
}

function fetchWeatherData(lat, lon, cityName, callback) {
  var url = OPEN_METEO_WEATHER_URL +
    '?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=1';

  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status < 200 || xhr.status >= 300) {
      callback(JSON.stringify({ error: 'Weather fetch failed (HTTP ' + xhr.status + ')' }));
      return;
    }
    try {
      var data = JSON.parse(xhr.responseText);
      var cur = data.current || {};
      var daily = data.daily || {};
      var result = {
        city: cityName,
        temp: Math.round(cur.temperature_2m),
        humidity: cur.relative_humidity_2m,
        wind: Math.round(cur.wind_speed_10m),
        weather_code: cur.weather_code,
        high: daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null,
        low: daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null
      };
      // Map WMO weather code to a short French description
      result.condition = weatherCodeToText(cur.weather_code);
      log('weather for ' + cityName + ': ' + result.temp + 'C ' + result.condition);
      callback(JSON.stringify(result));
    } catch (e) {
      callback(JSON.stringify({ error: 'Weather parse error: ' + e }));
    }
  };

  xhr.open('GET', url, true);
  try { xhr.send(); } catch (e) {
    callback(JSON.stringify({ error: 'Weather request failed: ' + e }));
  }
}

// WMO weather interpretation codes → short text
function weatherCodeToText(code) {
  var map = {
    0: 'Degage', 1: 'Peu nuageux', 2: 'Nuageux', 3: 'Couvert',
    45: 'Brouillard', 48: 'Brouillard givrant',
    51: 'Bruine legere', 53: 'Bruine', 55: 'Bruine forte',
    61: 'Pluie legere', 63: 'Pluie', 65: 'Pluie forte',
    71: 'Neige legere', 73: 'Neige', 75: 'Neige forte',
    80: 'Averses', 81: 'Averses', 82: 'Fortes averses',
    95: 'Orage', 96: 'Orage avec grele', 99: 'Orage avec grele'
  };
  return map[code] || 'Variable';
}

// Set a vibrating timer on the watch via AppMessage.
function setTimer(seconds, label, callback) {
  seconds = Math.round(Number(seconds) || 0);
  if (seconds <= 0 || seconds > 86400) {
    callback(JSON.stringify({ ok: false, error: 'Invalid duration: ' + seconds }));
    return;
  }
  try {
    Pebble.sendAppMessage({ CMD: CMD_SET_TIMER, ARG: seconds });
    log('timer set: ' + seconds + 's' + (label ? ' (' + label + ')' : ''));
    callback(JSON.stringify({ ok: true, seconds: seconds, label: label }));
  } catch (e) {
    callback(JSON.stringify({ ok: false, error: String(e) }));
  }
}

// --- Response parsing ------------------------------------------------------

// Extract the final text content from Conversations API outputs entries.
function extractTextFromOutputs(outputs) {
  if (!outputs || !outputs.length) return '';
  // Walk backwards to find the last message.output entry
  for (var i = outputs.length - 1; i >= 0; i--) {
    var entry = outputs[i];
    if (entry.type === 'message.output' && entry.content) {
      if (typeof entry.content === 'string') return entry.content;
      if (Array.isArray(entry.content)) {
        return entry.content.map(function (c) {
          return (c && c.type === 'text' && c.text) ? c.text : '';
        }).join('');
      }
    }
  }
  return '';
}

// Find the last function.call entry in outputs, or null.
function findFunctionCall(outputs) {
  if (!outputs) return null;
  for (var i = outputs.length - 1; i >= 0; i--) {
    if (outputs[i].type === 'function.call') return outputs[i];
  }
  return null;
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

// --- Fetch available models ------------------------------------------------

function fetchModels(apiKey, callback) {
  if (!apiKey) { callback(null); return; }

  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        var all = data.data || [];
        var chatModels = all.filter(function (m) {
          if (!m.capabilities) return true;
          return m.capabilities.completion_chat === true ||
                 m.capabilities.chat_completion === true;
        });
        var ids = (chatModels.length > 0 ? chatModels : all).map(function (m) {
          return m.id;
        });
        ids.sort();
        log('fetched ' + ids.length + ' models');
        callback(ids);
      } catch (e) {
        log('fetchModels parse error: ' + e);
        callback(null);
      }
    } else {
      log('fetchModels HTTP ' + xhr.status);
      callback(null);
    }
  };

  xhr.open('GET', MISTRAL_MODELS_URL, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  try {
    xhr.send();
  } catch (e) {
    log('fetchModels send error: ' + e);
    callback(null);
  }
}

// --- Conversations API -----------------------------------------------------

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

function askAgent(userText, callbacks) {
  var cfg = getConfig();
  if (!cfg.apiKey) {
    callbacks.onError('No API key', 'Set your Mistral API key in the app settings.');
    return;
  }

  cancelRequest();
  var token = ++requestToken;

  callbacks.onStatus('Thinking...');

  ensureAgent(function (agentId) {
    if (requestToken !== token) return;
    if (!agentId) {
      callbacks.onError('Agent error', 'Could not create Mistral agent. Check your API key.');
      return;
    }
    sendConversationInput(agentId, userText, null, 0, token, callbacks);
  });
}

// Send inputs to the conversation. If convId is null, starts a new conversation.
// toolResultEntry: optional function.result entry to append (for tool loop).
// round: current tool loop iteration (to prevent infinite loops).
function sendConversationInput(agentId, inputs, toolResultEntry, round, token, callbacks) {
  if (requestToken !== token) return;

  var cfg = getConfig();
  var convId = store('conversation_id');
  var url, body;

  if (toolResultEntry) {
    // Appending a tool result to an existing conversation
    url = MISTRAL_CONVERSATIONS_URL + '/' + convId;
    body = JSON.stringify({ inputs: [toolResultEntry] });
  } else if (convId) {
    // Continue existing conversation with text input
    url = MISTRAL_CONVERSATIONS_URL + '/' + convId;
    body = JSON.stringify({ inputs: inputs });
  } else {
    // Start new conversation
    url = MISTRAL_CONVERSATIONS_URL;
    body = JSON.stringify({ agent_id: agentId, inputs: inputs });
  }

  log('conversation request (round=' + round + ', conv=' + (convId || 'new') + ')');

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
        var newConvId = data.conversation_id || data.id || convId;
        if (newConvId) store('conversation_id', newConvId);

        var outputs = data.outputs || [];
        var fnCall = findFunctionCall(outputs);

        if (fnCall && round < MAX_TOOL_ROUNDS) {
          // Custom function tool call — execute it and append the result
          log('tool call: ' + fnCall.name + '(' + fnCall.arguments + ')');
          callbacks.onStatus('Calling ' + fnCall.name + '...');

          executeTool(fnCall.name, fnCall.arguments, function (resultJson) {
            if (requestToken !== token) return;
            var resultEntry = {
              object: 'entry',
              type: 'function.result',
              tool_call_id: fnCall.tool_call_id,
              result: resultJson
            };
            sendConversationInput(agentId, null, resultEntry, round + 1, token, callbacks);
          });
          return;
        }

        // No more tool calls — extract the final text response
        var content = extractTextFromOutputs(outputs);
        if (!content) {
          // Fallback: check if there's any text in any entry
          content = JSON.stringify(outputs).slice(0, 500);
        }
        var html = sanitizeHtml(extractHtml(content));
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

  xhr.open('POST', url, true);
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
    images: false,
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
  fetchModels: fetchModels,
  extractHtml: extractHtml,
  sanitizeHtml: sanitizeHtml,
};
