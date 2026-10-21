#pragma once

#ifndef TOUCH_INPUT_TEST
#include <pebble.h>
#endif

typedef struct {
  // Screen-relative liftoff point. Not called for drags, flings, or the tap
  // that stops a fling.
  void (*on_tap)(GPoint pt, void *context);
  // Positive delta_y moves further down the page. Return the delta actually
  // applied after clamping; a short return stops an in-flight fling.
  int16_t (*on_scroll)(int16_t delta_y, void *context);
  // A drag that began within EDGE_ZONE_PX of one side and crossed
  // EDGE_SWIPE_FRAC of the screen. -1 started at the left edge, +1 at the right.
  void (*on_edge_swipe)(int8_t dir, void *context);
} TouchInputCallbacks;

typedef struct {
  TouchInputCallbacks cbs;
  void *context;
  AppTimer *fling_timer;
  int32_t vel_q8;
  int32_t accum_q8;
  uint32_t down_ms;
  uint32_t move_ms;
  int16_t width;
  int16_t down_x, down_y;
  int16_t last_y;
  bool down;
  bool dragging;
  bool suppress_tap;
} TouchInput;

// Subscribes to the touch service. Returns false if touch is unavailable or
// the user has disabled it, in which case nothing is subscribed.
bool touch_input_init(TouchInput *ti, const TouchInputCallbacks *cbs, int16_t width,
                      void *context);
void touch_input_deinit(TouchInput *ti);

// Pass directly to touch_service_subscribe() with the TouchInput as context.
void touch_input_handle_event(const TouchEvent *event, void *context);
