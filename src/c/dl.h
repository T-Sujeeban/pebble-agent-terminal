#pragma once
#include <pebble.h>

// Display-list wire format. Produced phone-side, streamed over AppMessage,
// rendered verbatim on the watch. All integers little-endian.
//
//   header:  'P' 'B' 'D' 'L' | u8 version | u16 page_w | i16 page_h
//   ops:     u8 opcode followed by operands, terminated by DL_OP_END
//
// Coordinates are page-absolute; y may exceed screen height. The watch draws
// only the ops intersecting the current viewport.

#define DL_MAGIC0 'P'
#define DL_MAGIC1 'B'
#define DL_MAGIC2 'D'
#define DL_MAGIC3 'L'
#define DL_VERSION 1
#define DL_HEADER_SIZE 9

typedef enum {
  DL_OP_END = 0x00,
  DL_OP_TEXT = 0x01,   // i16 x, i16 y, u8 font, u8 len, u8 utf8[len]
  DL_OP_LINK = 0x02,   // i16 x, i16 y, i16 w, i16 h, u16 id
  DL_OP_RULE = 0x03,   // i16 y, i16 w
  DL_OP_COLOR = 0x04,  // u8 GColor8 argb; applies to later TEXT/RULE ops
  DL_OP_FILL = 0x05,   // i16 x, i16 y, i16 w, i16 h, u8 GColor8 argb
  DL_OP_IMAGE = 0x06,  // i16 x, i16 y, i16 w, i16 h, u16 len, u8 png[len]
  DL_OP_INPUT = 0x07,  // i16 x, i16 y, i16 w, i16 h, u16 field, u8 flags,
                       // u8 len, u8 placeholder[len]
} DLOpcode;

#define DL_INPUT_PASSWORD 0x01
#define DL_INPUT_SUBMIT 0x02   // enter/submit triggers the form
#define DL_INPUT_BUTTON 0x04

// Colour is decoder state, so it must be applied even for culled ops.
#define DL_COLOR_DEFAULT 0xC0  // opaque black

// Index into dl_font(). Kept stable across the wire; do not renumber.
typedef enum {
  DL_FONT_GOTHIC_14 = 0,
  DL_FONT_GOTHIC_14_BOLD = 1,
  DL_FONT_GOTHIC_18 = 2,
  DL_FONT_GOTHIC_18_BOLD = 3,
  DL_FONT_GOTHIC_24 = 4,
  DL_FONT_GOTHIC_24_BOLD = 5,
  DL_FONT_GOTHIC_28 = 6,
  DL_FONT_GOTHIC_28_BOLD = 7,
  DL_FONT_COUNT = 8,
} DLFont;

GFont dl_font(DLFont f);

typedef struct {
  const uint8_t *data;
  size_t len;
  uint16_t page_w;
  int16_t page_h;
} DisplayList;

// Returns false if the header is absent or the version is unknown.
bool dl_parse_header(const uint8_t *data, size_t len, DisplayList *out);

// Draws every op intersecting [scroll_y, scroll_y + bounds.size.h).
void dl_render(GContext *ctx, const DisplayList *dl, GRect bounds, int16_t scroll_y);

// Returns the link id at a page-absolute point, or -1.
int32_t dl_hit_test(const DisplayList *dl, GPoint page_pt);
