// Encoder mirror of src/c/dl.h. Keep the two in lockstep.

var MAGIC = [0x50, 0x42, 0x44, 0x4c]; // 'PBDL'
var VERSION = 1;

var OP = { END: 0x00, TEXT: 0x01, LINK: 0x02, RULE: 0x03, COLOR: 0x04, FILL: 0x05, IMAGE: 0x06, INPUT: 0x07 };

var INPUT_FLAG = { PASSWORD: 0x01, SUBMIT: 0x02, BUTTON: 0x04 };

// The watch decoder accepts palettized/grayscale PNG at 1/2/4/8 bpp only.
var MAX_PAGE_H = 32000;

// GColor8 is 0bAARRGGBB, 2 bits per channel; channel value n renders as n*85.
function toGColor8(r, g, b, a) {
  if (a === undefined) a = 255;
  var q = function (v) { return Math.max(0, Math.min(3, Math.round(v / 85))); };
  return (q(a) << 6) | (q(r) << 4) | (q(g) << 2) | q(b);
}

// Accepts "rgb(r, g, b)" / "rgba(r, g, b, a)" as returned by getComputedStyle.
function cssToGColor8(css) {
  var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(css || '');
  if (!m) return 0xc0;
  var a = m[4] === undefined ? 255 : Math.round(parseFloat(m[4]) * 255);
  return toGColor8(+m[1], +m[2], +m[3], a);
}

var FONT = {
  GOTHIC_14: 0, GOTHIC_14_BOLD: 1,
  GOTHIC_18: 2, GOTHIC_18_BOLD: 3,
  GOTHIC_24: 4, GOTHIC_24_BOLD: 5,
  GOTHIC_28: 6, GOTHIC_28_BOLD: 7,
};

function Writer() {
  this.bytes = [];
}

Writer.prototype.u8 = function (v) {
  this.bytes.push(v & 0xff);
  return this;
};

Writer.prototype.i16 = function (v) {
  v = Math.max(-32768, Math.min(32767, v | 0));
  this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  return this;
};

Writer.prototype.u16 = function (v) {
  v = Math.max(0, Math.min(65535, v | 0));
  this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  return this;
};

// graphics_draw_text() discards the whole string on a single invalid UTF-8
// byte, and the glyph cache keys codepoints to 17 bits.
function encodeText(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var cp = str.codePointAt(i);
    if (cp > 0xffff) { i++; cp = 0x25af; }
    if (cp === 0xfffd || cp < 0x20) { if (cp !== 0x0a) cp = 0x20; }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

// Find the largest byte offset <= maxBytes that does not split a multi-byte
// UTF-8 sequence. UTF-8 continuation bytes have the pattern 10xxxxxx (0x80–0xBF).
function safeUtf8Boundary(bytes, maxBytes) {
  if (maxBytes >= bytes.length) return bytes.length;
  var off = maxBytes;
  // Back up at most 3 bytes to avoid landing in the middle of a sequence
  while (off > 0 && (bytes[off] & 0xc0) === 0x80) off--;
  return off;
}

function DisplayList(pageW) {
  this.w = new Writer();
  this.pageW = pageW;
  this.pageH = 0;
  MAGIC.forEach(function (b) { this.w.u8(b); }, this);
  this.w.u8(VERSION).u16(pageW).i16(0);
}

DisplayList.prototype.text = function (x, y, font, str) {
  var bytes = encodeText(str);
  // len is u8; split overlong runs at safe UTF-8 boundaries so no multi-byte
  // character is split across two DL_OP_TEXT ops (which would produce
  // invalid UTF-8 on the watch and cause graphics_draw_text to drop the run).
  var off = 0;
  while (off < bytes.length) {
    var end = safeUtf8Boundary(bytes, off + 255);
    var slice = bytes.slice(off, end);
    this.w.u8(OP.TEXT).i16(x).i16(y).u8(font).u8(slice.length);
    for (var i = 0; i < slice.length; i++) this.w.u8(slice[i]);
    off = end;
    if (off < bytes.length) x = 0; // continuation lines start at margin
  }
  return this;
};

DisplayList.prototype.link = function (x, y, w, h, id) {
  this.w.u8(OP.LINK).i16(x).i16(y).i16(w).i16(h).u16(id);
  return this;
};

DisplayList.prototype.rule = function (y, w) {
  this.w.u8(OP.RULE).i16(y).i16(w);
  return this;
};

DisplayList.prototype.image = function (x, y, w, h, pngBytes) {
  this.w.u8(OP.IMAGE).i16(x).i16(y).i16(w).i16(h).u16(pngBytes.length);
  for (var i = 0; i < pngBytes.length; i++) this.w.u8(pngBytes[i]);
  return this;
};

DisplayList.prototype.input = function (x, y, w, h, field, flags, placeholder) {
  var bytes = encodeText(placeholder || '');
  var end = safeUtf8Boundary(bytes, 255);
  var slice = bytes.slice(0, end);
  this.w.u8(OP.INPUT).i16(x).i16(y).i16(w).i16(h).u16(field).u8(flags || 0).u8(slice.length);
  for (var i = 0; i < slice.length; i++) this.w.u8(slice[i]);
  return this;
};

DisplayList.prototype.color = function (argb) {
  this.w.u8(OP.COLOR).u8(argb);
  return this;
};

DisplayList.prototype.fill = function (x, y, w, h, argb) {
  this.w.u8(OP.FILL).i16(x).i16(y).i16(w).i16(h).u8(argb);
  return this;
};

DisplayList.prototype.finish = function (pageH) {
  this.w.u8(OP.END);
  var b = this.w.bytes;
  pageH = Math.max(-32768, Math.min(32767, pageH | 0));
  b[7] = pageH & 0xff;
  b[8] = (pageH >> 8) & 0xff;
  return b;
};

module.exports = {
  OP: OP, FONT: FONT, DisplayList: DisplayList, encodeText: encodeText, VERSION: VERSION,
  toGColor8: toGColor8, cssToGColor8: cssToGColor8, MAX_PAGE_H: MAX_PAGE_H, INPUT_FLAG: INPUT_FLAG,
};
