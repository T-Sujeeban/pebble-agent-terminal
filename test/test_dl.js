// Unit tests for dl.js — the display-list encoder.
// Run with: node --test test/test_dl.js

var dl = require('../src/pkjs/dl.js');
var test = require('node:test');
var assert = require('node:assert');

test('dl: header has correct magic, version, page dimensions', function () {
  var bytes = new dl.DisplayList(200).finish(100);
  assert.strictEqual(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'PBDL');
  assert.strictEqual(bytes[4], 1);
  assert.strictEqual(bytes[5] | (bytes[6] << 8), 200);
  assert.strictEqual(bytes[7] | (bytes[8] << 8), 100);
});

test('dl: empty page is just header + END', function () {
  var bytes = new dl.DisplayList(200).finish(0);
  assert.strictEqual(bytes.length, 10);
  assert.strictEqual(bytes[9], 0x00);
});

test('dl: text op encodes x, y, font, len, utf8', function () {
  var list = new dl.DisplayList(200);
  list.text(10, 20, dl.FONT.GOTHIC_14, 'Hi');
  var bytes = list.finish(30);
  assert.strictEqual(bytes[9], 0x01);
  assert.strictEqual(bytes[10] | (bytes[11] << 8), 10);
  assert.strictEqual(bytes[12] | (bytes[13] << 8), 20);
  assert.strictEqual(bytes[14], 0);
  assert.strictEqual(bytes[15], 2);
  assert.strictEqual(bytes[16], 0x48);
  assert.strictEqual(bytes[17], 0x69);
});

test('dl: text with UTF-8 characters', function () {
  var list = new dl.DisplayList(200);
  list.text(0, 0, dl.FONT.GOTHIC_14, '°C');
  var bytes = list.finish(20);
  assert.strictEqual(bytes[9], 0x01);
  assert.strictEqual(bytes[15], 3);
  assert.strictEqual(bytes[16], 0xC2);
  assert.strictEqual(bytes[17], 0xB0);
  assert.strictEqual(bytes[18], 0x43);
});

test('dl: long text splits into 255-byte chunks', function () {
  var list = new dl.DisplayList(200);
  list.text(0, 0, dl.FONT.GOTHIC_14, 'A'.repeat(300));
  var bytes = list.finish(20);
  assert.strictEqual(bytes[15], 255);
  var secondOpOffset = 9 + 7 + 255;
  assert.strictEqual(bytes[secondOpOffset], 0x01);
  assert.strictEqual(bytes[secondOpOffset + 6], 45);
});

test('dl: fill op encodes x, y, w, h, color', function () {
  var list = new dl.DisplayList(200);
  list.fill(0, 4, 200, 24, 0xE5);
  var bytes = list.finish(30);
  assert.strictEqual(bytes[9], 0x05);
  assert.strictEqual(bytes[10] | (bytes[11] << 8), 0);
  assert.strictEqual(bytes[12] | (bytes[13] << 8), 4);
  assert.strictEqual(bytes[14] | (bytes[15] << 8), 200);
  assert.strictEqual(bytes[16] | (bytes[17] << 8), 24);
  assert.strictEqual(bytes[18], 0xE5);
});

test('dl: color op is single byte', function () {
  var list = new dl.DisplayList(200);
  list.color(0xFF);
  var bytes = list.finish(10);
  assert.strictEqual(bytes[9], 0x04);
  assert.strictEqual(bytes[10], 0xFF);
  assert.strictEqual(bytes[11], 0x00);
});

test('dl: rule op encodes y, w', function () {
  var list = new dl.DisplayList(200);
  list.rule(38, 184);
  var bytes = list.finish(50);
  assert.strictEqual(bytes[9], 0x03);
  assert.strictEqual(bytes[10] | (bytes[11] << 8), 38);
  assert.strictEqual(bytes[12] | (bytes[13] << 8), 184);
});

test('dl: ops appear in order called', function () {
  var list = new dl.DisplayList(200);
  list.fill(0, 0, 200, 24, 0xE5);
  list.color(0xFF);
  list.text(8, 4, dl.FONT.GOTHIC_18_BOLD, 'Title');
  list.color(0xC0);
  list.text(8, 30, dl.FONT.GOTHIC_14, 'Body');
  list.rule(50, 184);
  var bytes = list.finish(60);
  var ops = [];
  var i = 9;
  while (i < bytes.length - 1) {
    ops.push(bytes[i]);
    switch (bytes[i]) {
      case 0x01: i += 7 + bytes[i + 6]; break;
      case 0x03: i += 5; break;
      case 0x04: i += 2; break;
      case 0x05: i += 10; break;
      default: i++; break;
    }
  }
  assert.deepStrictEqual(ops, [0x05, 0x04, 0x01, 0x04, 0x01, 0x03]);
});

test('dl: toGColor8 quantizes correctly', function () {
  assert.strictEqual(dl.toGColor8(0, 0, 0), 0xC0);
  assert.strictEqual(dl.toGColor8(255, 255, 255), 0xFF);
  assert.strictEqual(dl.toGColor8(255, 0, 0), 0xF0);
  assert.strictEqual(dl.toGColor8(0, 255, 0), 0xCC);
  assert.strictEqual(dl.toGColor8(0, 0, 255), 0xC3);
});

test('dl: toGColor8 with alpha', function () {
  assert.strictEqual(dl.toGColor8(0, 0, 0, 0), 0x00);
  assert.strictEqual(dl.toGColor8(255, 255, 255, 128), 0xBF);
});

test('dl: cssToGColor8 parses rgb/rgba', function () {
  assert.strictEqual(dl.cssToGColor8('rgb(0, 0, 0)'), 0xC0);
  assert.strictEqual(dl.cssToGColor8('rgb(255, 255, 255)'), 0xFF);
  assert.strictEqual(dl.cssToGColor8('rgba(0, 0, 0, 1)'), 0xC0);
  assert.strictEqual(dl.cssToGColor8('rgba(255, 255, 255, 0.5)'), 0xBF);
  assert.strictEqual(dl.cssToGColor8('red'), 0xC0);
  assert.strictEqual(dl.cssToGColor8(''), 0xC0);
  assert.strictEqual(dl.cssToGColor8(null), 0xC0);
});

test('dl: encodeText handles ASCII, 2-byte, 3-byte UTF-8', function () {
  assert.deepStrictEqual(dl.encodeText('Hello'), [0x48, 0x65, 0x6C, 0x6C, 0x6F]);
  assert.deepStrictEqual(dl.encodeText('°'), [0xC2, 0xB0]);
  assert.deepStrictEqual(dl.encodeText('世'), [0xE4, 0xB8, 0x96]);
});

test('dl: encodeText replaces control chars with space', function () {
  assert.deepStrictEqual(dl.encodeText('A\x01B'), [0x41, 0x20, 0x42]);
});

test('dl: encodeText preserves newline', function () {
  assert.deepStrictEqual(dl.encodeText('A\nB'), [0x41, 0x0A, 0x42]);
});

test('dl: encodeText replaces astral chars with placeholder', function () {
  assert.deepStrictEqual(dl.encodeText('\uD83D\uDE00'), [0xE2, 0x96, 0xAF]);
});

test('dl: font constants match wire format', function () {
  assert.strictEqual(dl.FONT.GOTHIC_14, 0);
  assert.strictEqual(dl.FONT.GOTHIC_14_BOLD, 1);
  assert.strictEqual(dl.FONT.GOTHIC_18, 2);
  assert.strictEqual(dl.FONT.GOTHIC_18_BOLD, 3);
  assert.strictEqual(dl.FONT.GOTHIC_24, 4);
  assert.strictEqual(dl.FONT.GOTHIC_24_BOLD, 5);
  assert.strictEqual(dl.FONT.GOTHIC_28, 6);
  assert.strictEqual(dl.FONT.GOTHIC_28_BOLD, 7);
});

test('dl: simulated message page produces valid display list', function () {
  var list = new dl.DisplayList(200);
  var y = 4;
  var headerColor = dl.toGColor8(33, 150, 243);
  list.fill(0, y, 200, 24, headerColor);
  list.color(0xFF);
  list.text(8, y + 4, dl.FONT.GOTHIC_18_BOLD, 'Agent Terminal');
  list.color(0xC0);
  y += 30;
  list.text(8, y, dl.FONT.GOTHIC_14, 'Press SELECT');
  y += 16;
  list.text(8, y, dl.FONT.GOTHIC_14, 'to talk');
  var bytes = list.finish(y + 20);
  assert.strictEqual(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'PBDL');
  assert.strictEqual(bytes[bytes.length - 1], 0x00);
  assert.ok(bytes.length < 32768);
});

test('dl: pageH is clamped to i16 range', function () {
  var bytes = new dl.DisplayList(200).finish(40000);
  var pageH = bytes[7] | (bytes[8] << 8);
  if (pageH & 0x8000) pageH -= 0x10000;
  assert.strictEqual(pageH, 32767);
});
