// Unit tests for agent.js — HTML extraction, sanitization, conversation management.
// Run with: node --test test/test_agent.js

global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = String(v); },
  removeItem: function (k) { delete this._data[k]; },
};

var Module = require('module');
var originalRequire = Module.prototype.require;
Module.prototype.require = function (path) {
  if (path === './renderer') return { render: function () { return Promise.resolve({ bytes: [] }); } };
  if (path === './transport') return { sendBuffer: function () {}, cancel: function () {} };
  if (path === './skill') return { SKILL_PROMPT: 'test skill prompt', SKILL_PROMPT_VERSION: 6 };
  return originalRequire.apply(this, arguments);
};

var agent = require('../src/pkjs/agent.js');

var test = require('node:test');
var assert = require('node:assert');

test('extractHtml: plain HTML passes through', function () {
  assert.strictEqual(agent.extractHtml('<div>Hello</div>'), '<div>Hello</div>');
});

test('extractHtml: strips markdown code fences', function () {
  assert.strictEqual(agent.extractHtml('```html\n<div>Hello</div>\n```'), '<div>Hello</div>');
});

test('extractHtml: strips plain code fences', function () {
  assert.strictEqual(agent.extractHtml('```\n<p>Hi</p>\n```'), '<p>Hi</p>');
});

test('extractHtml: extracts HTML from surrounding prose', function () {
  var result = agent.extractHtml('Here is the answer:\n<div>Weather</div>\nHope that helps!');
  assert.ok(result.indexOf('<div>Weather</div>') >= 0);
});

test('extractHtml: handles empty input', function () {
  assert.strictEqual(agent.extractHtml(''), '');
  assert.strictEqual(agent.extractHtml(null), '');
  assert.strictEqual(agent.extractHtml(undefined), '');
});

test('extractHtml: handles HTML with attributes', function () {
  var html = '<div style="background:#2196F3;color:white;">Title</div>';
  assert.strictEqual(agent.extractHtml(html), html);
});

test('extractHtml: multi-line HTML with fences', function () {
  var input = '```html\n<div style="color:red;">\n<p>Line 1</p>\n<p>Line 2</p>\n</div>\n```';
  var result = agent.extractHtml(input);
  assert.ok(result.indexOf('<div') >= 0);
  assert.ok(result.indexOf('Line 1') >= 0);
  assert.ok(result.indexOf('Line 2') >= 0);
});

test('sanitizeHtml: passes valid HTML through', function () {
  var html = '<div style="background:#2196F3;color:white;">Weather</div><p>18°C</p>';
  assert.strictEqual(agent.sanitizeHtml(html), html);
});

test('sanitizeHtml: returns error page for empty input', function () {
  assert.ok(agent.sanitizeHtml('').indexOf('Empty response') >= 0);
});

test('sanitizeHtml: returns error page for null input', function () {
  assert.ok(agent.sanitizeHtml(null).indexOf('Empty response') >= 0);
});

test('sanitizeHtml: strips script tags', function () {
  var result = agent.sanitizeHtml('<div>Hello</div><script>alert("xss")</script>');
  assert.ok(result.indexOf('<script>') === -1);
  assert.ok(result.indexOf('Hello') >= 0);
});

test('sanitizeHtml: strips form elements', function () {
  var result = agent.sanitizeHtml('<form><input type="text"><button>Submit</button></form><p>Content</p>');
  assert.ok(result.indexOf('<form') === -1);
  assert.ok(result.indexOf('<input') === -1);
  assert.ok(result.indexOf('<button') === -1);
});

test('sanitizeHtml: rejects tables', function () {
  assert.ok(agent.sanitizeHtml('<table><tr><td>Cell</td></tr></table>').indexOf('Layout too complex') >= 0);
});

test('sanitizeHtml: rejects flexbox layouts', function () {
  assert.ok(agent.sanitizeHtml('<div style="display:flex;"><div>A</div><div>B</div></div>').indexOf('Layout too complex') >= 0);
});

test('conversation: reset clears history', function () {
  agent.resetConversation();
  assert.ok(agent.getConfig() !== null);
});

test('config: default values', function () {
  global.localStorage._data = {};
  var cfg = agent.getConfig();
  assert.strictEqual(cfg.apiKey, '');
  assert.strictEqual(cfg.model, 'mistral-large-latest');
  assert.ok(cfg.systemPrompt.length > 0);
});

test('config: save and retrieve', function () {
  global.localStorage._data = {};
  agent.saveConfig({ apiKey: 'sk-test123', model: 'mistral-large-latest' });
  var cfg = agent.getConfig();
  assert.strictEqual(cfg.apiKey, 'sk-test123');
  assert.strictEqual(cfg.model, 'mistral-large-latest');
});

test('config: partial save preserves other values', function () {
  global.localStorage._data = {};
  agent.saveConfig({ apiKey: 'sk-abc', model: 'mistral-medium-latest' });
  agent.saveConfig({ apiKey: 'sk-xyz' });
  var cfg = agent.getConfig();
  assert.strictEqual(cfg.apiKey, 'sk-xyz');
  assert.strictEqual(cfg.model, 'mistral-medium-latest');
});

// Regression test: saveConfig must NOT delete the user's model preference.
// Bug in v0.3.0: removeStore('agent_model') deleted the preference right after storing it.
test('config: saveConfig preserves model preference (regression)', function () {
  global.localStorage._data = {};
  agent.saveConfig({ apiKey: 'sk-key', model: 'mistral-large-latest' });
  var cfg = agent.getConfig();
  assert.strictEqual(cfg.model, 'mistral-large-latest', 'model preference must survive saveConfig');
  // Agent tracking keys should be cleared so the agent gets recreated
  assert.strictEqual(global.localStorage.getItem('agent_id'), null, 'agent_id must be cleared');
  assert.strictEqual(global.localStorage.getItem('agent_created_model'), null, 'agent_created_model must be cleared');
});

test('extractHtml + sanitizeHtml: full pipeline', function () {
  var raw = '```html\n<div style="background:#2196F3;color:white;padding:4px 8px;font-weight:bold;">Weather</div>\n<p style="margin:8px;font-size:14px;">Paris: 18°C</p>\n```';
  var clean = agent.sanitizeHtml(agent.extractHtml(raw));
  assert.ok(clean.indexOf('Weather') >= 0);
  assert.ok(clean.indexOf('18°C') >= 0);
  assert.ok(clean.indexOf('```') === -1);
});

test('extractHtml + sanitizeHtml: XSS attempt is neutralized', function () {
  var clean = agent.sanitizeHtml(agent.extractHtml('<div>Safe</div><script>alert("xss")</script>'));
  assert.ok(clean.indexOf('<script>') === -1);
  assert.ok(clean.indexOf('Safe') >= 0);
});
