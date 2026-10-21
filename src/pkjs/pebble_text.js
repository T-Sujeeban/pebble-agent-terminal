// Rewrites text so Chromium's line breaking lands exactly where PebbleOS's
// does, then hands back a map from the rewritten string to the original.
//
// A metrics-matched font gets you ~87% of line breaks; the remaining 13% are
// places where CSS and the firmware's text_layout.c genuinely disagree:
//
//   - "-" ends a word in Pebble, so it starts the NEXT line. CSS breaks after
//     it. Fixed with a zero-width space before and a word joiner after.
//   - a word wider than the box is hyphenated by Pebble at positions that
//     reserve the drawn hyphen's width. CSS just overflows. Fixed with FORCED
//     breaks (newlines under white-space:pre-wrap) at those positions - a mere
//     break opportunity is not enough, Chromium declines it and fits one more
//     character because it does not know a hyphen will be drawn. U+00AD looks
//     like the right tool and is not; it measured far worse.
//   - UAX #14 lets Chromium break after "/" and "." inside a URL. Pebble only
//     breaks on its END_OF_WORD set. Fixed with word joiners.
//
// Whitespace is NOT fixed and cannot be: Pebble charges a space run that
// straddles a break to the new line, CSS hangs it on the old one. Feed this
// HTML-normal text (runs collapsed, leading whitespace stripped) and it does
// not arise.
//
// Port of tools/fontgen/pebble_layout.py; the two are asserted identical over
// the validation corpora by tools/fontgen/verify_js.py.
// ES5, no DOM, no Node builtins - runs under PKJS and pypkjs alike.

/* GENERATED-DATA-START (tools/fontgen/make_js.py) */
var RANGES = [32, 126, 160, 172, 174, 214, 216, 383, 402, 402, 508, 511, 536, 539, 710, 711, 728, 733, 960, 960, 8211, 8212, 8216, 8218, 8220, 8222, 8224, 8226, 8230, 8230, 8240, 8240, 8249, 8250, 8260, 8260, 8364, 8364, 8482, 8482, 8486, 8486, 8706, 8706, 8710, 8710, 8719, 8719, 8721, 8722, 8730, 8730, 8734, 8734, 8747, 8747, 8776, 8776, 8800, 8800, 8804, 8805, 9647, 9647, 9674, 9674, 63171, 63171, 64257, 64258];
var ADV = {
  GOTHIC_14: '##%\'\'+(#%%\'\'#%#&ffffffffff##&\'&%*ggggfeggcdfeiggggggeggkggf$&$\'&%fffffdffccfciffffdfdfgifge$#$\'##&&&\'#&%,f(\')$&\'ee%f(#"ef(jjj%ggggggigffffccccggggggggggggggfffffffifffffccccfffffff\'fffffgfggfgfgfgfgfgfgfgigfffffffffffgfgfgfgfgfgfccccccccccgfdcfffececefeeecgfgfgffgfgfgfgfjigdgdgdgfgfgfgfedefedgfgfgfgfgfgfkigggfefefeddiigfgfedce$#&$%%f\',###%%%%%&).%%&\'+g&\'(&%)+#(\'\'\'\'\'#ff',
  GOTHIC_14_BOLD: '#$\')(,)$&&\'(#%$\'ffffffffff$$%(%\'*hhhhgghhdfhgjhhhhhhhhhlhhg%\'%\'(%gggggfggdcgdjggggfgfghjghf%$&(#$\'\'(($&\',g\'\'*&&(fe%g($$eg\'jkj\'hhhhhhjhggggdddchhhhhhhhhhhhhhhggggggjgggggdddcggggggg\'ggggghghhghghghghghghghjhggggggggggghghghghghghgddddddcdddigfchgggdgdgggghchghghgghghghghgkjhfhfhfhghghghghfhihfhghghghghghgljhhhgfgfgfffjjhghghfff&$&%&\'g)-###&&&&&\'*/$$\'(*g&\'(&$**#\'\'\'\'\'(#ii',
  GOTHIC_18: '##%\'\',)#%%\')#&#\'gggggggggg##\')\'\'+ihhhgghhcegfkhhhhhhghikhig%\'%\'\'%gggggdggccfckggggefeggkggf&#&\'##\'\'\')#\'&-g(\'+\'\')ff%g(##eg(kkk\'iiiiiikhggggcccchhhhhhhhhhhhihgggggggkgggggccccggggggg)ggggggggigigighghghghghihggggggggggghghghghghghgcccccccccchfecgfffcfcfefdfchghghgghghghghglkhehehehfhfhfhfgegggehghghghghghgkkigigfgfgfddkkhghfgegg\'$&&\'\'h*.###%%%\'\'\')1%%\'(+h\'))\'&++#))(())#gg',
  GOTHIC_18_BOLD: '$$\')).*$&&(*$\'$(hhhhhhhhhh$$(*((,iiiihhiidghhliiiiiihiilijh%(%()&hhhhhfhhdcgdlhhhhfgfhhlhhg&$&\'$$()\'*$((-h)(+\'\'*gg&h($#fh)lll(iiiiiilihhhhedfdjiiiiiiiiiiijiihhhghhlhhhhhdddchghhhgh*hhhhhhhhihihihihihihihikihhhhhhhhhhhihigihihihihdcecdcdcddjghdhgghdhchghgieihihihhihihihihmlififigigigigighfhhhfigihihihihihlljhjhghghgffllihighfhh\'$&\'((i+/$$$\'\'\'((\',3&&()+i(**(\',,$**)))*$ii',
  GOTHIC_24: '$#&+).*#&&++$&$)iiiiiiiiii$$(+(\'/hiiiggiicehgkiiiiiigihkigg&(&\')%hhhhhehhcchcmhhhhfgehgkggg\'#\')$#()(\'#\'\'0h**.\')+gg%h+$%gh*nnn\'hhhhhhkiggggcccciiiiiiiiiiiigiihhhhhhmhhhhhccccihhhhhh+hhhhhghghhhhhhihihihihijihghghghghghihihihihihihcccccccccchfechhhgcgcgegfgcihihihhihihihihmmifififigigigifgegggeihihihihihihkkgggggggggeekmihiggeff\'#&%\'&i+1$$$(((\'\'\'.4&&(*+i)()\'&//#++**++$hh',
  GOTHIC_24_BOLD: '$$(,*1+$\'\'**$&$)jjjjjjjjjj$$)*)(0jjjjiijjdghiljjijjjjjjliii&)&\'*&iiiiigiiddhdniiiifggiiliih\'$\')$$)**)$(\'0i+*.()*hh&i,$&hi+ooo(jjjjjjnjiiihededkjjjjjjjjjjjiikiiiiiiniiiiiddfdjiiiiii*iiiiiiiijijijijijijijijkjiiihiiiiiiijijijijijijiddddddeeddjhgdhhhididififjejijijiijijijijionjfjfjfjgjgjgjgjgijjgjijijijijijilliiiihihhhggnnjijgjgff\'#&%\'\'j+2$$$((())\'.8\'\')++j*)*(&//$****++$kk',
  GOTHIC_28: '%%).-4.%((+.%(%*llllllllll%%*.)*3mmmmjjmmegljqmmlmmljmltllk\'*\'*,(kkkkkfkkeejeqkkkkgkfklpjlh*%*,&%++,-%+)5k,-/**.ii\'k-%%ik+tts*mmmmmmpmjjjjfefenmmmmmmmmmmmllkkkkkkkqkkkkkfefekkkkkkk.kkkkklklmkmkmkmkmkmkmkmlmkjkjkjkjkjkmkmkmkmkmkmkeeeeeeefeeljgeljjjejejfjflhmkmkmkkmkmkmkmkrqmgmgmglklklklkjfjhjfmkmkmkmkmkmktplllkhkhkhffpqmklkjfii)%+&))l.6%%%((())*/=\'&*-+m+,-)-35%----..$jj',
  GOTHIC_28_BOLD: '%%*.,4.%((,-%(%*kkkkkkkkkk%%)-*+3mllljjllehkjpllklllklmtllj\'*\'*,(kkkkkhkkeekeqkkkkhjikkpjkj*&),%%+,,-%+*4k,,.**-ii(k.%&ik,ttt*mmmmmmqljjjieegelllllllllllllklkkkkkkqkkkkkeegekkkkkkk-kkkkkkkkmkmkmklklklklklnlkjkikjkjkjklklllklklklkeeeeeeggeeljiekkkjejeihihlilklklkklklklklkqqlhlhlhljljljljkhklkilklklklklklktplkljjjjjjhhqqlkljkijj*&,\'*+m08%%%)))**)/<\'\'*.+m+,-)/34%--,,.-$mm'
};
var EM = { GOTHIC_14: 14, GOTHIC_14_BOLD: 14, GOTHIC_18: 18, GOTHIC_18_BOLD: 18, GOTHIC_24: 24, GOTHIC_24_BOLD: 24, GOTHIC_28: 28, GOTHIC_28_BOLD: 28 };
var WILDCARD = 0x25AF;
/* GENERATED-DATA-END */

var ZWSP = '​';
var WJ = '⁠';
var HARD = '\n';
var NEWLINE = 10, SPACE = 32, HYPHEN = 45;

// Break-opportunity codepoints, from PebbleOS applib/fonts/codepoint.c.
var END_OF_WORD = {};
(function (list) {
  for (var i = 0; i < list.length; i++) END_OF_WORD[list[i]] = 1;
})([0, 10, 32, 45, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2008, 0x2009, 0x200A, 0x200B, 0x205F, 0x3000]);

var ZERO_WIDTH = { 0x200B: 1, 0x2060: 1 };
var FORMATTING = { 0x200E: 1, 0x200F: 1, 0x202A: 1, 0x202B: 1, 0x202C: 1,
                   0x202D: 1, 0x202E: 1 };

// Letters outside the font's own table; only reached for scripts the watch
// cannot render anyway, where advances are approximate on both sides.
var ALNUM_FALLBACK = /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

var tables = {};

function table(font) {
  var t = tables[font];
  if (t) return t;
  var s = ADV[font];
  if (!s) throw new Error('pebble_text: unknown font ' + font);
  t = { adv: {}, alnum: {} };
  for (var r = 0, i = 0; r < RANGES.length; r += 2) {
    for (var cp = RANGES[r]; cp <= RANGES[r + 1]; cp++, i++) {
      var c = s.charCodeAt(i) - 32;
      if (c >= 64) { t.alnum[cp] = 1; c -= 64; }
      t.adv[cp] = c;
    }
  }
  tables[font] = t;
  return t;
}

function shouldSkip(cp) {
  return (cp < 32 && cp !== NEWLINE) || (cp >= 0x80 && cp <= 0x9F) ||
         (cp >= 0x2061 && cp <= 0x206F) || (cp >= 0xFFF9 && cp <= 0xFFFB) ||
         (cp >= 0x1F3FB && cp <= 0x1F3FF);
}

function isIdeograph(cp) { return cp > 0x2E80; }

function glyph(t, cp) {
  var a = t.adv[cp];
  return a === undefined ? t.adv[WILDCARD] || 0 : a;
}

// prv_codepoint_get_horizontal_advance() from text_layout.c.
function advance(font, cp) {
  if (ZERO_WIDTH[cp]) return 0;
  var t = table(font), em = EM[font];
  switch (cp) {
    case 0x2000: case 0x2002: return (em / 2) | 0;
    case 0x2001: case 0x2003: return em;
    case 0x2004: return (em / 3) | 0;
    case 0x2005: return (em / 4) | 0;
    case 0x2006: return (em / 6) | 0;
    case 0x2009: case 0x202F: return (em / 5) | 0;
    case 0x200A: return Math.max((em / 12) | 0, 1);
    case 0x205F: return ((em * 4) / 18) | 0;
    case 0x2007: return glyph(t, 48);
    case 0x2008: return glyph(t, 46);
    case 0x00A0: return glyph(t, SPACE);
  }
  var a = glyph(t, cp);
  return a > 0 ? a : 0;
}

function isAlnum(font, cp) {
  var t = table(font);
  if (t.adv[cp] !== undefined) return !!t.alnum[cp];
  return ALNUM_FALLBACK.test(String.fromCharCode(cp));
}

function cpAt(s, i) { return i < s.length ? s.charCodeAt(i) : 0; }

function width(font, s) {
  var w = 0;
  for (var i = 0; i < s.length; i++) w += advance(font, s.charCodeAt(i));
  return w;
}

// word_state_update()
var START = 0, IDEO = 1, GROWING = 2, JOINING = 3, END = 4;

function nextState(state, cp) {
  switch (state) {
    case START:
      return cp === NEWLINE ? END : (isIdeograph(cp) ? IDEO : GROWING);
    case IDEO:
      return cp === 0x2060 ? JOINING : END;
    case GROWING:
      if (cp === 0x2060) return JOINING;
      return (isIdeograph(cp) || END_OF_WORD[cp]) ? END : GROWING;
    case JOINING:
      if (cp === NEWLINE) return END;
      if (isIdeograph(cp)) return IDEO;
      return cp === 0x2060 ? JOINING : GROWING;
  }
  return END;
}

// word_init(). Returns {start, end, width} or null at end of text.
function wordInit(text, start, font) {
  var n = text.length;
  if (start >= n) return null;
  var i = start;
  if (shouldSkip(cpAt(text, i)) || FORMATTING[cpAt(text, i)]) i++;
  while (ZERO_WIDTH[cpAt(text, i)]) {
    if (i >= n) return null;
    i++;
  }
  if (i >= n) return null;

  var w = { start: i, end: i, width: 0 };
  var curr = cpAt(text, i), state = nextState(START, curr);
  for (;;) {
    i++;
    if (state === GROWING || state === IDEO) w.width += advance(font, curr);
    curr = cpAt(text, i);
    state = nextState(state, curr);
    if (state === END) break;
  }
  w.end = i;
  return w;
}

// walk_line() with update_dimensions_char_visitor_cb: how much fits.
function walkLineFit(text, start, maxWidth, suffix, font) {
  var i = start, walked = 0, last = -1;
  var cp = cpAt(text, i);
  if (cp === NEWLINE) return [i, 0];
  var next = advance(font, cp);
  while (walked + next + suffix <= maxWidth) {
    walked += next;
    last = i;
    i++;
    if (i > text.length) break;
    cp = cpAt(text, i);
    if (cp === NEWLINE) break;
    next = advance(font, cp);
  }
  return [last, walked];
}

// Offsets at which Pebble hyphenates a lone over-long word. Context-free: such
// a word never fits on a partial line, so it always starts a fresh one.
function cutsFor(piece, maxWidth, font) {
  var cuts = {}, start = 0, suffix = advance(font, HYPHEN), guard = 0;
  while (width(font, piece.slice(start)) > maxWidth && guard++ < piece.length) {
    var last = walkLineFit(piece, start, maxWidth, suffix, font)[0];
    if (last < 0) last = start;
    start = last + 1;
    if (start >= piece.length) break;
    cuts[start] = 1;
  }
  return cuts;
}

function leadingSpaces(s) {
  var i = 0;
  while (i < s.length && s.charAt(i) === ' ') i++;
  return i;
}

// Returns {text, map} where map[i] is the index in `text` of transformed[i].
function transform(text, maxWidth, font) {
  var out = [], map = [], i = 0, n = text.length;

  while (i < n) {
    var word = wordInit(text, i, font);
    if (!word) break;
    for (var j = i; j < word.start; j++) { out.push(text.charAt(j)); map.push(j); }

    var piece = text.slice(word.start, word.end);
    var lead = leadingSpaces(piece);
    var base = word.start + lead;
    var rest = piece.slice(lead);
    var oversize = rest.length > 0 && width(font, rest) > maxWidth;

    if (oversize && out.length && out[out.length - 1] !== HARD) {
      out.push(HARD); map.push(base);          // it cannot share a line
    } else if (!oversize) {
      for (var k = 0; k < lead; k++) { out.push(' '); map.push(word.start + k); }
    }

    if (rest.length) {
      var cuts = oversize ? cutsFor(rest, maxWidth, font) : {};
      for (var p = 0; p < rest.length; p++) {
        var ch = rest.charAt(p);
        if (cuts[p]) { out.push(HARD); map.push(base + p); }
        if (p === 0 && ch === '-' && !cuts[0]) { out.push(ZWSP); map.push(base); }
        out.push(ch); map.push(base + p);
        if (!isAlnum(font, ch.charCodeAt(0)) && p + 1 < rest.length && !cuts[p + 1]) {
          out.push(WJ); map.push(base + p);
        }
      }
    }
    i = word.end;
  }
  for (; i < n; i++) { out.push(text.charAt(i)); map.push(i); }

  return { text: out.join(''), map: map };
}

module.exports = {
  transform: transform,
  advance: advance,
  fonts: function () {
    var out = [];
    for (var k in ADV) if (ADV.hasOwnProperty(k)) out.push(k);
    return out;
  },
};
