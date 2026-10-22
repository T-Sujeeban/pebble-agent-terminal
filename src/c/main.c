// Agent Terminal — a voice-driven AI agent display for the Pebble Time 2.
//
// State machine: idle → recording → thinking → browsing → (follow-up) → recording
//
//   idle:     SELECT starts dictation. Status bar shows "Agent Terminal".
//   recording: system dictation screen. On result, sends CMD_TEXT to phone.
//   thinking: waiting for the agent's display list. BACK cancels.
//   browsing: viewing the rendered response. UP/DOWN scrolls, SELECT starts
//             a follow-up dictation (conversation context preserved on phone),
//             BACK returns to idle.
//
// The display-list pipeline (dl.c, net.c, touch_input.c) is inherited from
// coredevices/pebble-browser-app. The phone side renders agent-generated HTML
// into a display list via the same DOM-based renderer.
//
// Timer: the phone (PKJS) can send CMD_SET_TIMER with ARG = seconds.
// A countdown runs in the status bar; when it fires, the watch vibrates
// in a long-short-long pattern and shows "Timer!" on screen.

#include <pebble.h>
#include "dl.h"
#include "net.h"
#include "touch_input.h"

#define HELLO_RETRY_MS 2000
#define SCROLL_STEP 32
#define BAR_H 18
#define CHROME_TICK_MS 250
#define BUSY_TICKS_THINKING 200 // 50s — agent calls can be slow
#define DICTATION_BYTES 256
#define TIMER_TICK_MS 1000
#define TIMER_MAX_SECONDS 86400 // 24h cap

typedef enum {
  STATE_IDLE = 0,
  STATE_RECORDING,
  STATE_THINKING,
  STATE_BROWSING,
} AppState;

static Window *s_window;
static Layer *s_page_layer;
static Layer *s_bar_layer;
static TouchInput s_touch;
static bool s_touch_active;
static DictationSession *s_dictation;
static AppTimer *s_hello_timer;
static AppTimer *s_chrome_timer;

static uint8_t *s_page;
static DisplayList s_dl;
static bool s_have_page;
static int16_t s_scroll_y;
static int16_t s_width;
static AppState s_state = STATE_IDLE;
static uint8_t s_busy_ticks;
static char s_status[64] = "Agent Terminal";

// --- Timer state -----------------------------------------------------------

static AppTimer *s_timer_tick;
static uint32_t s_timer_remaining; // seconds left
static bool s_timer_active;

// --- Layout ----------------------------------------------------------------

static void prv_layout(GRect root, GRect *bar, GRect *page) {
#ifdef PBL_ROUND
  *bar = GRect(65, 16, 130, 22);
  *page = root;
#else
  *bar = GRect(0, 0, root.size.w, BAR_H);
  *page = GRect(0, BAR_H, root.size.w, root.size.h - BAR_H);
#endif
}

// --- Status bar ------------------------------------------------------------

static void prv_chrome_tick(void *unused) {
  s_chrome_timer = NULL;
  if (!s_busy_ticks) return;
  if (--s_busy_ticks == 0) {
    s_busy_ticks = 0;
    if (s_state == STATE_THINKING) {
      s_state = STATE_IDLE;
      snprintf(s_status, sizeof(s_status), "Agent Terminal");
    }
  } else {
    s_chrome_timer = app_timer_register(CHROME_TICK_MS, prv_chrome_tick, NULL);
  }
  layer_mark_dirty(s_bar_layer);
}

static void prv_set_busy(const char *text, uint8_t ticks) {
  strncpy(s_status, text, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  s_busy_ticks = ticks;
  if (!s_chrome_timer) s_chrome_timer = app_timer_register(CHROME_TICK_MS, prv_chrome_tick, NULL);
  layer_mark_dirty(s_bar_layer);
}

static void prv_clear_busy(void) {
  s_busy_ticks = 0;
  if (s_state == STATE_THINKING || s_state == STATE_BROWSING) {
    snprintf(s_status, sizeof(s_status), "Agent Terminal");
  }
  layer_mark_dirty(s_bar_layer);
}

// Called from net.c when the phone sends a STATUS string.
void app_on_status(const char *text) {
  strncpy(s_status, text, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  layer_mark_dirty(s_bar_layer);
}

// --- Timer -----------------------------------------------------------------

static void prv_format_timer(char *buf, size_t len, uint32_t seconds) {
  uint32_t h = seconds / 3600;
  uint32_t m = (seconds % 3600) / 60;
  uint32_t s = seconds % 60;
  if (h > 0) {
    snprintf(buf, len, "Timer %u:%02u:%02u", (unsigned)h, (unsigned)m, (unsigned)s);
  } else {
    snprintf(buf, len, "Timer %u:%02u", (unsigned)m, (unsigned)s);
  }
}

static void prv_timer_finished(void *unused) {
  s_timer_tick = NULL;
  s_timer_active = false;
  s_timer_remaining = 0;

  // Long-short-long vibration pattern to get attention
  static const uint32_t segments[] = { 500, 200, 500, 200, 800 };
  VibesPattern pat = {
    .durations = segments,
    .num_segments = 5,
  };
  vibes_enqueue_custom_pattern(pat);

  // Show timer alert on screen
  snprintf(s_status, sizeof(s_status), "Timer!");
  s_busy_ticks = 40; // 10s of "Timer!" in the status bar
  if (!s_chrome_timer) s_chrome_timer = app_timer_register(CHROME_TICK_MS, prv_chrome_tick, NULL);
  layer_mark_dirty(s_bar_layer);

  // Flash the page area briefly
  if (s_state == STATE_BROWSING || s_state == STATE_IDLE) {
    layer_mark_dirty(s_page_layer);
  }
}

static void prv_timer_tick(void *unused) {
  s_timer_tick = NULL;
  if (!s_timer_active) return;
  if (s_timer_remaining > 0) {
    s_timer_remaining--;
  }
  if (s_timer_remaining == 0) {
    prv_timer_finished(NULL);
    return;
  }
  // Update status bar with countdown
  char buf[32];
  prv_format_timer(buf, sizeof(buf), s_timer_remaining);
  strncpy(s_status, buf, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  layer_mark_dirty(s_bar_layer);
  s_timer_tick = app_timer_register(TIMER_TICK_MS, prv_timer_tick, NULL);
}

static void prv_start_timer(uint32_t seconds) {
  if (seconds == 0 || seconds > TIMER_MAX_SECONDS) return;

  // Cancel any existing timer
  if (s_timer_tick) {
    app_timer_cancel(s_timer_tick);
    s_timer_tick = NULL;
  }

  s_timer_remaining = seconds;
  s_timer_active = true;

  // Show immediate feedback
  char buf[32];
  prv_format_timer(buf, sizeof(buf), seconds);
  strncpy(s_status, buf, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  layer_mark_dirty(s_bar_layer);

  // Start the 1s tick
  s_timer_tick = app_timer_register(TIMER_TICK_MS, prv_timer_tick, NULL);

  APP_LOG(APP_LOG_LEVEL_INFO, "timer started: %us", (unsigned)seconds);
}

static void prv_cancel_timer(void) {
  if (s_timer_tick) {
    app_timer_cancel(s_timer_tick);
    s_timer_tick = NULL;
  }
  s_timer_active = false;
  s_timer_remaining = 0;
}

// --- Downstream commands (phone → watch) -----------------------------------

// Called from net.c when the phone sends a CMD tuple.
void app_on_cmd(uint8_t cmd, int32_t arg) {
  switch (cmd) {
    case CMD_SET_TIMER:
      prv_start_timer((uint32_t)arg);
      break;
    default:
      break;
  }
}

// --- State transitions -----------------------------------------------------

static void prv_set_state(AppState state) {
  s_state = state;
  switch (state) {
    case STATE_IDLE:
      prv_clear_busy();
      if (!s_timer_active) {
        snprintf(s_status, sizeof(s_status), "Agent Terminal");
      }
      free(s_page);
      s_page = NULL;
      s_have_page = false;
      s_scroll_y = 0;
      layer_mark_dirty(s_page_layer);
      layer_mark_dirty(s_bar_layer);
      break;
    case STATE_RECORDING:
      break;
    case STATE_THINKING:
      prv_set_busy("Thinking...", BUSY_TICKS_THINKING);
      break;
    case STATE_BROWSING:
      prv_clear_busy();
      layer_mark_dirty(s_page_layer);
      layer_mark_dirty(s_bar_layer);
      break;
  }
}

// --- Scrolling -------------------------------------------------------------

static int16_t prv_max_scroll(void) {
  if (!s_have_page) return 0;
  GRect b = layer_get_bounds(s_page_layer);
  int32_t max = (int32_t)s_dl.page_h - b.size.h;
  return (int16_t)(max < 0 ? 0 : max);
}

static int16_t prv_apply_scroll(int16_t delta_y, void *context) {
  if (!s_have_page || s_state != STATE_BROWSING) return 0;
  int32_t want = (int32_t)s_scroll_y + delta_y;
  int32_t max = prv_max_scroll();
  if (want < 0) want = 0;
  if (want > max) want = max;
  int16_t applied = (int16_t)(want - s_scroll_y);
  if (applied != 0) {
    s_scroll_y = (int16_t)want;
    layer_mark_dirty(s_page_layer);
  }
  return applied;
}

// --- Dictation -------------------------------------------------------------

static void prv_dictation_result(DictationSession *session, DictationSessionStatus status,
                                 char *transcription, void *ctx) {
  s_state = STATE_IDLE;
  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    if (net_send_text(CMD_TEXT, transcription)) {
      prv_set_state(STATE_THINKING);
    } else {
      prv_set_busy("Busy", 20);
      prv_set_state(STATE_IDLE);
    }
  } else if (status != DictationSessionStatusFailureTranscriptionRejected) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "dictation failed (%d)", (int)status);
    prv_set_busy("No dictation", 20);
    prv_set_state(STATE_IDLE);
  } else {
    prv_set_state(STATE_IDLE);
  }
}

static void prv_start_dictation(void) {
  if (s_state == STATE_THINKING) return;
  if (!s_dictation) {
    s_dictation = dictation_session_create(DICTATION_BYTES, prv_dictation_result, NULL);
  }
  if (!s_dictation) {
    prv_set_busy("No dictation", 20);
    return;
  }
  s_state = STATE_RECORDING;
  dictation_session_start(s_dictation);
}

// --- Page received (from phone) --------------------------------------------

static void prv_page_received(uint8_t *data, size_t len, uint32_t page_id, void *ctx) {
  if (s_hello_timer) { app_timer_cancel(s_hello_timer); s_hello_timer = NULL; }
  DisplayList dl;
  if (!dl_parse_header(data, len, &dl)) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "bad display list (%u bytes)", (unsigned)len);
    free(data);
    prv_set_busy("Bad response", 20);
    prv_set_state(STATE_IDLE);
    return;
  }
  free(s_page);
  s_page = data;
  s_dl = dl;
  s_have_page = true;
  s_scroll_y = 0;

  APP_LOG(APP_LOG_LEVEL_INFO, "page %u: %ub h=%d heap=%u", (unsigned)page_id, (unsigned)len,
          dl.page_h, (unsigned)heap_bytes_free());

  prv_set_state(STATE_BROWSING);
}

// --- Rendering ---------------------------------------------------------

static void prv_page_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  if (s_have_page && s_state == STATE_BROWSING) {
    dl_render(ctx, &s_dl, b, s_scroll_y);
  } else if (s_state == STATE_IDLE) {
    // Brief loading state — the phone sends the branded welcome page
    // shortly after CMD_HELLO / CMD_HOME.
    graphics_context_set_text_color(ctx, GColorDarkGray);
    graphics_draw_text(ctx, "Loading...", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(0, b.size.h / 2 - 8, b.size.w, 20),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void prv_bar_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  size_t got, total;
  if (net_progress(&got, &total)) {
    graphics_context_set_fill_color(ctx, GColorPictonBlue);
    int16_t w = (int16_t)((int32_t)b.size.w * got / total);
    graphics_fill_rect(ctx, GRect(0, b.size.h - 2, w, 2), 0, GCornerNone);
  }

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_status, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(3, -2, b.size.w - 6, b.size.h), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);
}

// --- Touch -----------------------------------------------------------------

static void prv_tap(GPoint pt, void *context) {
  if (s_state == STATE_IDLE) {
    prv_start_dictation();
    return;
  }
  if (s_state == STATE_BROWSING) {
    prv_apply_scroll(SCROLL_STEP, NULL);
  }
}

// --- Button handlers -------------------------------------------------------

static void prv_up_click(ClickRecognizerRef r, void *ctx) {
  prv_apply_scroll(-SCROLL_STEP, NULL);
}

static void prv_down_click(ClickRecognizerRef r, void *ctx) {
  prv_apply_scroll(SCROLL_STEP, NULL);
}

static void prv_select_click(ClickRecognizerRef r, void *ctx) {
  if (s_state == STATE_IDLE || s_state == STATE_BROWSING) {
    prv_start_dictation();
  }
}

static void prv_back_click(ClickRecognizerRef r, void *ctx) {
  switch (s_state) {
    case STATE_BROWSING:
      // Request the branded welcome page from the phone (conversation preserved)
      net_send_cmd(CMD_HOME, 0);
      break;
    case STATE_THINKING:
      net_send_cmd(CMD_CANCEL, 0);
      prv_set_state(STATE_IDLE);
      break;
    case STATE_IDLE:
      window_stack_pop(true);
      break;
    case STATE_RECORDING:
      break;
  }
}

static void prv_click_config(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 100, prv_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 100, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

// --- Hello retry -----------------------------------------------------------

static void prv_hello_retry(void *ctx) {
  s_hello_timer = NULL;
  if (s_state != STATE_IDLE || net_is_receiving()) return;
  net_send_cmd(CMD_HELLO, s_width | PBL_IF_ROUND_ELSE(CMD_HELLO_ROUND, 0));
  s_hello_timer = app_timer_register(HELLO_RETRY_MS, prv_hello_retry, NULL);
}

// --- Window lifecycle ------------------------------------------------------

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bar, page;
  prv_layout(layer_get_bounds(root), &bar, &page);

  s_page_layer = layer_create(page);
  layer_set_update_proc(s_page_layer, prv_page_update);
  layer_add_child(root, s_page_layer);

  s_bar_layer = layer_create(bar);
  layer_set_update_proc(s_bar_layer, prv_bar_update);
  layer_add_child(root, s_bar_layer);

  s_width = page.size.w;
  net_init(prv_page_received, NULL);

  static const TouchInputCallbacks cbs = { .on_tap = prv_tap, .on_scroll = prv_apply_scroll };
  s_touch_active = touch_input_init(&s_touch, &cbs, page.size.w, NULL);

  prv_set_state(STATE_IDLE);
  prv_hello_retry(NULL);

  APP_LOG(APP_LOG_LEVEL_INFO, "agent-terminal loaded w=%d touch=%d heap=%u", s_width,
          (int)s_touch_active, (unsigned)heap_bytes_free());
}

static void prv_window_unload(Window *window) {
  if (s_hello_timer) { app_timer_cancel(s_hello_timer); s_hello_timer = NULL; }
  if (s_chrome_timer) { app_timer_cancel(s_chrome_timer); s_chrome_timer = NULL; }
  prv_cancel_timer();
  if (s_dictation) { dictation_session_destroy(s_dictation); s_dictation = NULL; }
  if (s_touch_active) touch_input_deinit(&s_touch);
  net_deinit();
  layer_destroy(s_page_layer);
  layer_destroy(s_bar_layer);
  free(s_page);
  s_page = NULL;
  s_have_page = false;
}

int main(void) {
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
  app_event_loop();
  window_destroy(s_window);
}
