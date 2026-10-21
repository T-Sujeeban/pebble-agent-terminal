// DL_HOST_TEST: test/test_dl.c supplies its own Pebble stubs and includes this
// file directly; dl.h cannot be included there because it pulls in <pebble.h>.
#ifndef DL_HOST_TEST
#include "dl.h"
#endif

#include <string.h>

#define DL_TEXT_MAX 256

static const char *const s_font_keys[DL_FONT_COUNT] = {
  FONT_KEY_GOTHIC_14,
  FONT_KEY_GOTHIC_14_BOLD,
  FONT_KEY_GOTHIC_18,
  FONT_KEY_GOTHIC_18_BOLD,
  FONT_KEY_GOTHIC_24,
  FONT_KEY_GOTHIC_24_BOLD,
  FONT_KEY_GOTHIC_28,
  FONT_KEY_GOTHIC_28_BOLD,
};

static const uint8_t s_font_heights[DL_FONT_COUNT] = { 16, 16, 21, 21, 28, 28, 32, 32 };

GFont dl_font(DLFont f) {
  static GFont s_cache[DL_FONT_COUNT];
  if ((unsigned)f >= DL_FONT_COUNT) {
    f = DL_FONT_GOTHIC_14;
  }
  if (!s_cache[f]) {
    s_cache[f] = fonts_get_system_font(s_font_keys[f]);
  }
  return s_cache[f];
}

static inline int16_t prv_i16(const uint8_t *p) {
  return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

typedef struct {
  uint8_t op;
  uint8_t font;
  uint8_t text_len;
  uint8_t color;
  uint8_t flags;
  const uint8_t *text;
  const uint8_t *png;
  uint16_t png_len;
  int16_t x, y, w, h;
  uint16_t id;
} DLOp;

// uPNG's one inflated buffer becomes the GBitmap's pixels without a copy, and
// the compressed bytes are read in place out of the page buffer, so the decode
// costs exactly one row-aligned plane plus the palettes, upng_t and GBitmap.
#define DL_PNG_FIXED_COST 1536
// Slack left for the firmware's own allocations during the rest of the frame.
#define DL_PNG_HEAP_RESERVE 8192
#define DL_PNG_MAX_DIM 4096

// IHDR sits at a fixed offset in every PNG: 8-byte signature, 4-byte length,
// "IHDR", then w, h, bit depth, colour type.
static bool prv_png_heap_cost(const uint8_t *png, uint16_t len, uint32_t *out) {
  static const uint8_t k_sig[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
  static const uint8_t k_channels[7] = { 1, 0, 3, 1, 2, 0, 4 };
  if (len < 26 || memcmp(png, k_sig, sizeof(k_sig)) != 0 || memcmp(png + 12, "IHDR", 4) != 0) {
    return false;
  }
  const uint32_t w = ((uint32_t)png[16] << 24) | ((uint32_t)png[17] << 16) |
                     ((uint32_t)png[18] << 8) | png[19];
  const uint32_t h = ((uint32_t)png[20] << 24) | ((uint32_t)png[21] << 16) |
                     ((uint32_t)png[22] << 8) | png[23];
  const uint8_t depth = png[24], ctype = png[25];
  if (w == 0 || h == 0 || w > DL_PNG_MAX_DIM || h > DL_PNG_MAX_DIM ||
      depth == 0 || depth > 16 || ctype > 6 || k_channels[ctype] == 0) {
    return false;
  }
  const uint32_t bpp = (uint32_t)depth * k_channels[ctype];
  *out = ((w * bpp + 7) / 8) * h + h + DL_PNG_FIXED_COST;
  return true;
}

// Decodes one op, advancing *cur. False on END, truncation or an unknown
// opcode, which all terminate the walk.
static bool prv_next(const uint8_t **cur, const uint8_t *end, DLOp *out) {
  const uint8_t *p = *cur;
  if (p >= end) {
    return false;
  }
  const uint8_t op = *p++;
  const size_t avail = (size_t)(end - p);

  switch (op) {
    case DL_OP_TEXT:
      if (avail < 6) {
        return false;
      }
      out->x = prv_i16(p);
      out->y = prv_i16(p + 2);
      out->font = p[4];
      out->text_len = p[5];
      p += 6;
      if ((size_t)(end - p) < out->text_len) {
        return false;
      }
      out->text = p;
      p += out->text_len;
      break;

    case DL_OP_LINK:
      if (avail < 10) {
        return false;
      }
      out->x = prv_i16(p);
      out->y = prv_i16(p + 2);
      out->w = prv_i16(p + 4);
      out->h = prv_i16(p + 6);
      out->id = (uint16_t)((uint16_t)p[8] | ((uint16_t)p[9] << 8));
      p += 10;
      break;

    case DL_OP_RULE:
      if (avail < 4) {
        return false;
      }
      out->y = prv_i16(p);
      out->w = prv_i16(p + 2);
      p += 4;
      break;

    case DL_OP_COLOR:
      if (avail < 1) {
        return false;
      }
      out->color = p[0];
      p += 1;
      break;

    case DL_OP_FILL:
      if (avail < 9) {
        return false;
      }
      out->x = prv_i16(p);
      out->y = prv_i16(p + 2);
      out->w = prv_i16(p + 4);
      out->h = prv_i16(p + 6);
      out->color = p[8];
      p += 9;
      break;

    case DL_OP_IMAGE:
      if (avail < 10) {
        return false;
      }
      out->x = prv_i16(p);
      out->y = prv_i16(p + 2);
      out->w = prv_i16(p + 4);
      out->h = prv_i16(p + 6);
      out->png_len = (uint16_t)((uint16_t)p[8] | ((uint16_t)p[9] << 8));
      p += 10;
      if ((size_t)(end - p) < out->png_len) {
        return false;
      }
      out->png = p;
      p += out->png_len;
      break;

    case DL_OP_INPUT:
      if (avail < 10) {
        return false;
      }
      out->x = prv_i16(p);
      out->y = prv_i16(p + 2);
      out->w = prv_i16(p + 4);
      out->h = prv_i16(p + 6);
      out->id = (uint16_t)((uint16_t)p[8] | ((uint16_t)p[9] << 8));
      p += 10;
      if (avail < 12) {
        return false;
      }
      out->flags = p[0];
      out->text_len = p[1];
      p += 2;
      if ((size_t)(end - p) < out->text_len) {
        return false;
      }
      out->text = p;
      p += out->text_len;
      break;

    default:
      return false;
  }

  out->op = op;
  *cur = p;
  return true;
}

bool dl_parse_header(const uint8_t *data, size_t len, DisplayList *out) {
  if (!data || !out || len < DL_HEADER_SIZE) {
    return false;
  }
  if (data[0] != DL_MAGIC0 || data[1] != DL_MAGIC1 ||
      data[2] != DL_MAGIC2 || data[3] != DL_MAGIC3 || data[4] != DL_VERSION) {
    return false;
  }
  out->page_w = (uint16_t)((uint16_t)data[5] | ((uint16_t)data[6] << 8));
  out->page_h = prv_i16(data + 7);
  out->data = data + DL_HEADER_SIZE;
  out->len = len - DL_HEADER_SIZE;
  return true;
}

void dl_render(GContext *ctx, const DisplayList *dl, GRect bounds, int16_t scroll_y) {
  if (!ctx || !dl || !dl->data) {
    return;
  }

  const uint8_t *p = dl->data;
  const uint8_t *const end = dl->data + dl->len;
  const int32_t top = scroll_y;
  const int32_t bottom = top + bounds.size.h;
  const int16_t page_w = dl->page_w ? (int16_t)dl->page_w : bounds.size.w;
  char buf[DL_TEXT_MAX];
  DLOp o;

  uint8_t color = DL_COLOR_DEFAULT;
  int16_t text_set = -1, stroke_set = -1;

  while (prv_next(&p, end, &o)) {
    switch (o.op) {
      // Decoder state, tracked even while ops are culled.
      case DL_OP_COLOR:
        color = o.color;
        break;

      case DL_OP_TEXT: {
        const uint8_t font = (o.font < DL_FONT_COUNT) ? o.font : (uint8_t)DL_FONT_GOTHIC_14;
        const int32_t h = s_font_heights[font];
        const int32_t w = (int32_t)page_w - o.x;
        if (o.y >= bottom || o.y + h <= top || w <= 0) {
          break;
        }
        // graphics_draw_text() drops the whole string on one invalid UTF-8
        // byte, and the run is not NUL-terminated in the op stream.
        memcpy(buf, o.text, o.text_len);
        buf[o.text_len] = '\0';
        if (text_set != color) {
          graphics_context_set_text_color(ctx, (GColor8){ .argb = color });
          text_set = color;
        }
        graphics_draw_text(ctx, buf, dl_font((DLFont)font),
                           GRect(bounds.origin.x + o.x,
                                 bounds.origin.y + (int16_t)(o.y - top),
                                 (int16_t)w, (int16_t)h),
                           GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
        break;
      }

      case DL_OP_RULE: {
        if (o.y < top || o.y >= bottom || o.w <= 0) {
          break;
        }
        const int16_t sy = (int16_t)(bounds.origin.y + (o.y - top));
        if (stroke_set != color) {
          graphics_context_set_stroke_color(ctx, (GColor8){ .argb = color });
          stroke_set = color;
        }
        graphics_draw_line(ctx, GPoint(bounds.origin.x, sy),
                           GPoint((int16_t)(bounds.origin.x + o.w - 1), sy));
        break;
      }

      case DL_OP_FILL: {
        if (o.w <= 0 || o.h <= 0 || o.y >= bottom || (int32_t)o.y + o.h <= top) {
          break;
        }
        graphics_context_set_fill_color(ctx, (GColor8){ .argb = o.color });
        graphics_fill_rect(ctx, GRect(bounds.origin.x + o.x,
                                      bounds.origin.y + (int16_t)(o.y - top),
                                      o.w, o.h),
                           0, GCornerNone);
        break;
      }

      case DL_OP_INPUT: {
        if (o.w <= 0 || o.h <= 0 || o.y >= bottom || (int32_t)o.y + o.h <= top) {
          break;
        }
        const GRect fbox = GRect(bounds.origin.x + o.x,
                                 bounds.origin.y + (int16_t)(o.y - top), o.w, o.h);
        if (stroke_set != color) {
          graphics_context_set_stroke_color(ctx, (GColor8){ .argb = color });
          stroke_set = color;
        }
        graphics_draw_round_rect(ctx, fbox, 2);
        if (o.text_len > 0) {
          char buf[256];
          size_t n = o.text_len < sizeof(buf) - 1 ? o.text_len : sizeof(buf) - 1;
          memcpy(buf, o.text, n);
          buf[n] = '\0';
          if (text_set != color) {
            graphics_context_set_text_color(ctx, (GColor8){ .argb = color });
            text_set = color;
          }
          graphics_draw_text(ctx, buf, dl_font(DL_FONT_GOTHIC_14),
                             GRect(fbox.origin.x + 3, fbox.origin.y, fbox.size.w - 6, fbox.size.h),
                             GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
        }
        break;
      }

      case DL_OP_IMAGE: {
        if (o.w <= 0 || o.h <= 0 || o.png_len == 0 ||
            o.y >= bottom || (int32_t)o.y + o.h <= top) {
          break;
        }
        const GRect box = GRect(bounds.origin.x + o.x,
                                bounds.origin.y + (int16_t)(o.y - top), o.w, o.h);
        uint32_t cost;
        GBitmap *bmp = NULL;
        if (!prv_png_heap_cost(o.png, o.png_len, &cost)) {
          APP_LOG(APP_LOG_LEVEL_WARNING, "image %dx%d: bad png header (%u bytes)",
                  o.w, o.h, (unsigned)o.png_len);
        } else if (cost + DL_PNG_HEAP_RESERVE > heap_bytes_free()) {
          APP_LOG(APP_LOG_LEVEL_WARNING, "image %dx%d: needs %u+%u, %u free", o.w, o.h,
                  (unsigned)cost, DL_PNG_HEAP_RESERVE, (unsigned)heap_bytes_free());
        } else if ((bmp = gbitmap_create_from_png_data(o.png, o.png_len)) == NULL) {
          APP_LOG(APP_LOG_LEVEL_WARNING, "image %dx%d: decode failed", o.w, o.h);
        }
        if (!bmp) {
          if (stroke_set != color) {
            graphics_context_set_stroke_color(ctx, (GColor8){ .argb = color });
            stroke_set = color;
          }
          graphics_draw_rect(ctx, box);
          break;
        }
        graphics_draw_bitmap_in_rect(ctx, bmp, box);
        gbitmap_destroy(bmp);
        break;
      }

      default:
        break;
    }
  }
}

int32_t dl_hit_test(const DisplayList *dl, GPoint page_pt) {
  if (!dl || !dl->data) {
    return -1;
  }

  const uint8_t *p = dl->data;
  const uint8_t *const end = dl->data + dl->len;
  int32_t hit = -1;
  DLOp o;

  while (prv_next(&p, end, &o)) {
    if (o.op != DL_OP_LINK || o.w <= 0 || o.h <= 0) {
      continue;
    }
    if (page_pt.x >= o.x && page_pt.x < (int32_t)o.x + o.w &&
        page_pt.y >= o.y && page_pt.y < (int32_t)o.y + o.h) {
      hit = o.id;
    }
  }
  return hit;
}
