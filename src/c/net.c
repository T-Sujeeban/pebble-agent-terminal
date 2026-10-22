#ifndef NET_HOST_TEST
#include <pebble.h>
#endif

#include "net.h"

// Implemented in main.c.

static struct {
  NetPageHandler handler;
  void *ctx;

  uint8_t *buf;
  size_t total;
  size_t received;
  uint32_t page_id;
  uint16_t chunk_size;
  uint16_t nchunks;
  bool active;
  uint8_t got[NET_MAX_CHUNKS / 8];

  uint8_t *done_buf;
  size_t done_len;
  uint32_t done_page;

  AppTimer *stall_timer;
  AppTimer *deliver_timer;
  bool outbox_busy;
} s;

static void prv_drop_partial(void) {
  free(s.buf);
  s.buf = NULL;
  s.active = false;
  s.total = 0;
  s.received = 0;
  if (s.stall_timer) {
    app_timer_cancel(s.stall_timer);
    s.stall_timer = NULL;
  }
}

static void prv_stalled(void *unused) {
  s.stall_timer = NULL;
  APP_LOG(APP_LOG_LEVEL_WARNING, "net: page %u stalled at %u/%u",
          (unsigned)s.page_id, (unsigned)s.received, (unsigned)s.total);
  prv_drop_partial();
}

static void prv_kick_stall_timer(void) {
  if (s.stall_timer && app_timer_reschedule(s.stall_timer, NET_STALL_TIMEOUT_MS)) {
    return;
  }
  s.stall_timer = app_timer_register(NET_STALL_TIMEOUT_MS, prv_stalled, NULL);
}

static void prv_deliver(void *unused) {
  s.deliver_timer = NULL;
  uint8_t *buf = s.done_buf;
  size_t len = s.done_len;
  uint32_t page = s.done_page;
  s.done_buf = NULL;
  if (!buf) {
    return;
  }
  if (s.handler) {
    s.handler(buf, len, page, s.ctx);
  } else {
    free(buf);
  }
}

static bool prv_start(uint32_t page_id, size_t total, uint16_t chunk_size) {
  prv_drop_partial();
  size_t nchunks = (total + chunk_size - 1) / chunk_size;
  if (nchunks > NET_MAX_CHUNKS) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "net: %u chunks of %u too many", (unsigned)nchunks,
            (unsigned)chunk_size);
    return false;
  }
  s.buf = malloc(total);
  if (!s.buf) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "net: alloc %u failed", (unsigned)total);
    return false;
  }
  memset(s.got, 0, sizeof(s.got));
  s.page_id = page_id;
  s.total = total;
  s.chunk_size = chunk_size;
  s.nchunks = nchunks;
  s.received = 0;
  s.active = true;
  return true;
}

static void prv_accept_chunk(uint32_t page_id, uint32_t seq, size_t total, const uint8_t *data,
                             uint16_t len) {
  if (!data || len == 0 || total == 0 || total > NET_MAX_PAGE_BYTES || len > total) {
    return;
  }
  if (!s.active || page_id != s.page_id || total != s.total) {
    if (seq != 0 || !prv_start(page_id, total, len)) {
      return;
    }
  }
  if (seq >= s.nchunks) {
    return;
  }
  size_t off = (size_t)seq * s.chunk_size;
  size_t want = (total - off < s.chunk_size) ? total - off : s.chunk_size;
  if (len != want) {
    return;
  }

  prv_kick_stall_timer();
  if (s.got[seq >> 3] & (1 << (seq & 7))) {
    return;
  }
  s.got[seq >> 3] |= 1 << (seq & 7);
  memcpy(s.buf + off, data, len);
  s.received += len;
  if (s.received < s.total) {
    return;
  }

  free(s.done_buf);
  s.done_buf = s.buf;
  s.done_len = s.total;
  s.done_page = s.page_id;
  s.buf = NULL;
  prv_drop_partial();
  if (!s.deliver_timer) {
    s.deliver_timer = app_timer_register(0, prv_deliver, NULL);
  }
}

static bool prv_tuple_u32(const Tuple *t, uint32_t *out) {
  if (!t || (t->type != TUPLE_INT && t->type != TUPLE_UINT)) {
    return false;
  }
  int32_t v;
  switch (t->length) {
    case 1: v = (t->type == TUPLE_INT) ? t->value->int8 : t->value->uint8; break;
    case 2: v = (t->type == TUPLE_INT) ? t->value->int16 : t->value->uint16; break;
    case 4: v = (t->type == TUPLE_INT) ? t->value->int32 : (int32_t)t->value->uint32; break;
    default: return false;
  }
  if (v < 0) {
    return false;
  }
  *out = (uint32_t)v;
  return true;
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  if (status && status->type == TUPLE_CSTRING && status->length > 0) {
    app_on_status(status->value->cstring);
  }
  // Downstream command from phone (e.g. CMD_SET_TIMER).
  Tuple *cmd = dict_find(iter, MESSAGE_KEY_CMD);
  if (cmd && (cmd->type == TUPLE_INT || cmd->type == TUPLE_UINT)) {
    uint32_t cmd_val = 0;
    prv_tuple_u32(cmd, &cmd_val);
    uint32_t arg_val = 0;
    prv_tuple_u32(dict_find(iter, MESSAGE_KEY_ARG), &arg_val);
    app_on_cmd((uint8_t)cmd_val, (int32_t)arg_val);
  }
  Tuple *chunk = dict_find(iter, MESSAGE_KEY_CHUNK);
  if (!chunk || chunk->type != TUPLE_BYTE_ARRAY) {
    return;
  }
  uint32_t seq, total, page_id;
  if (!prv_tuple_u32(dict_find(iter, MESSAGE_KEY_SEQ), &seq) ||
      !prv_tuple_u32(dict_find(iter, MESSAGE_KEY_TOTAL), &total) ||
      !prv_tuple_u32(dict_find(iter, MESSAGE_KEY_PAGEID), &page_id)) {
    return;
  }
  prv_accept_chunk(page_id, seq, total, chunk->value->data, chunk->length);
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "net: inbox dropped (0x%x)", reason);
  prv_drop_partial();
}

static void prv_outbox_sent(DictionaryIterator *iter, void *context) {
  s.outbox_busy = false;
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  s.outbox_busy = false;
  APP_LOG(APP_LOG_LEVEL_WARNING, "net: outbox failed (0x%x)", reason);
}

void net_init(NetPageHandler handler, void *ctx) {
  s.handler = handler;
  s.ctx = ctx;
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  AppMessageResult r = app_message_open(app_message_inbox_size_maximum(),
                                        app_message_outbox_size_maximum());
  if (r != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "net: app_message_open failed (0x%x)", r);
  }
}

void net_deinit(void) {
  if (s.deliver_timer) {
    app_timer_cancel(s.deliver_timer);
    s.deliver_timer = NULL;
  }
  prv_drop_partial();
  free(s.done_buf);
  s.done_buf = NULL;
  s.handler = NULL;
}

bool net_send_cmd(uint8_t cmd, int32_t arg) {
  if (s.outbox_busy) {
    return false;
  }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return false;
  }
  dict_write_uint8(iter, MESSAGE_KEY_CMD, cmd);
  dict_write_int32(iter, MESSAGE_KEY_ARG, arg);
  if (app_message_outbox_send() != APP_MSG_OK) {
    return false;
  }
  s.outbox_busy = true;
  return true;
}

bool net_send_text(uint8_t cmd, const char *text) {
  if (s.outbox_busy || !text || !text[0]) {
    return false;
  }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return false;
  }
  dict_write_uint8(iter, MESSAGE_KEY_CMD, cmd);
  dict_write_cstring(iter, MESSAGE_KEY_TEXT, text);
  if (app_message_outbox_send() != APP_MSG_OK) {
    return false;
  }
  s.outbox_busy = true;
  return true;
}

bool net_is_receiving(void) {
  return s.active;
}

bool net_progress(size_t *received, size_t *total) {
  if (!s.active || s.total == 0) {
    return false;
  }
  *received = s.received;
  *total = s.total;
  return true;
}
