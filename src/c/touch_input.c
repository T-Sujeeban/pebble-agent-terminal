#include "touch_input.h"

// Tuning. Velocities are Q8 fixed point in pixels per FLING_TICK_MS tick;
// divide by 256 for whole pixels, multiply by 1000/FLING_TICK_MS for px/s.
#define TAP_SLOP_PX 6            // px of travel still counted as a tap
#define EDGE_ZONE_PX 40          // a swipe must start this close to a side
#define EDGE_SWIPE_NUM 3         // and cross 3/5 (60%) of the screen
#define EDGE_SWIPE_DEN 5
#define TAP_MAX_MS 400           // touchdown->liftoff bound for a tap
#define FLING_TICK_MS 33         // ms between momentum ticks
#define FLING_RELEASE_MS 80      // stale movement at liftoff means no fling
#define FLING_FRICTION_Q8 242    // velocity *= 242/256 each tick
#define FLING_MIN_VEL_Q8 512     // 2 px/tick, below this liftoff does not fling
#define FLING_STOP_VEL_Q8 128    // 0.5 px/tick, below this the fling rests
#define FLING_MAX_VEL_Q8 10240   // 40 px/tick

static uint32_t prv_now_ms(void) {
  time_t s = 0;
  uint16_t ms = time_ms(&s, NULL);
  return (uint32_t)s * 1000 + ms;
}

static int16_t prv_abs16(int16_t v) {
  return v < 0 ? -v : v;
}

static void prv_stop_fling(TouchInput *ti) {
  if (ti->fling_timer) {
    app_timer_cancel(ti->fling_timer);
    ti->fling_timer = NULL;
  }
  ti->vel_q8 = 0;
  ti->accum_q8 = 0;
}

static void prv_fling_tick(void *data) {
  TouchInput *ti = data;
  ti->fling_timer = NULL;

  ti->accum_q8 += ti->vel_q8;
  int16_t step = (int16_t)(ti->accum_q8 >> 8);
  ti->accum_q8 -= (int32_t)step << 8;

  if (step != 0 && ti->cbs.on_scroll(step, ti->context) != step) {
    prv_stop_fling(ti);
    return;
  }

  ti->vel_q8 = (ti->vel_q8 * FLING_FRICTION_Q8) >> 8;
  if (ti->vel_q8 > -FLING_STOP_VEL_Q8 && ti->vel_q8 < FLING_STOP_VEL_Q8) {
    prv_stop_fling(ti);
    return;
  }
  ti->fling_timer = app_timer_register(FLING_TICK_MS, prv_fling_tick, ti);
}

static void prv_touchdown(TouchInput *ti, const TouchEvent *e, uint32_t now) {
  ti->suppress_tap = (ti->fling_timer != NULL);
  prv_stop_fling(ti);
  ti->down = true;
  ti->dragging = false;
  ti->down_x = e->x;
  ti->down_y = e->y;
  ti->last_y = e->y;
  ti->down_ms = now;
  ti->move_ms = now;
}

static void prv_position_update(TouchInput *ti, const TouchEvent *e, uint32_t now) {
  if (!ti->down) {
    return;
  }
  if (!ti->dragging &&
      (prv_abs16((int16_t)(e->x - ti->down_x)) > TAP_SLOP_PX ||
       prv_abs16((int16_t)(e->y - ti->down_y)) > TAP_SLOP_PX)) {
    ti->dragging = true;
  }
  if (!ti->dragging) {
    return;
  }

  int16_t dy = (int16_t)(e->y - ti->last_y);
  uint32_t dt = now - ti->move_ms;
  ti->last_y = e->y;
  ti->move_ms = now;

  if (dt > 0) {
    int32_t v = ((int32_t)-dy * 256 * FLING_TICK_MS) / (int32_t)dt;
    ti->vel_q8 = (ti->vel_q8 + v) / 2;
    if (ti->vel_q8 > FLING_MAX_VEL_Q8) {
      ti->vel_q8 = FLING_MAX_VEL_Q8;
    } else if (ti->vel_q8 < -FLING_MAX_VEL_Q8) {
      ti->vel_q8 = -FLING_MAX_VEL_Q8;
    }
  }
  if (dy != 0) {
    ti->cbs.on_scroll((int16_t)-dy, ti->context);
  }
}

static void prv_liftoff(TouchInput *ti, const TouchEvent *e, uint32_t now) {
  if (!ti->down) {
    return;
  }
  ti->down = false;

  if (!ti->dragging) {
    if (!ti->suppress_tap && now - ti->down_ms <= TAP_MAX_MS && ti->cbs.on_tap) {
      ti->cbs.on_tap(GPoint(e->x, e->y), ti->context);
    }
    return;
  }

  if (ti->cbs.on_edge_swipe && ti->width > 0) {
    int16_t dx = (int16_t)(e->x - ti->down_x);
    int32_t need = (int32_t)ti->width * EDGE_SWIPE_NUM / EDGE_SWIPE_DEN;
    if (ti->down_x <= EDGE_ZONE_PX && dx >= need) {
      prv_stop_fling(ti);
      ti->cbs.on_edge_swipe(-1, ti->context);
      return;
    }
    if (ti->down_x >= (int16_t)(ti->width - EDGE_ZONE_PX) && -dx >= need) {
      prv_stop_fling(ti);
      ti->cbs.on_edge_swipe(1, ti->context);
      return;
    }
  }

  bool fling = (now - ti->move_ms <= FLING_RELEASE_MS) &&
               (ti->vel_q8 > FLING_MIN_VEL_Q8 || ti->vel_q8 < -FLING_MIN_VEL_Q8);
  if (!fling) {
    prv_stop_fling(ti);
    return;
  }
  ti->accum_q8 = 0;
  ti->fling_timer = app_timer_register(FLING_TICK_MS, prv_fling_tick, ti);
}

void touch_input_handle_event(const TouchEvent *event, void *context) {
  TouchInput *ti = context;
  uint32_t now = prv_now_ms();

  switch (event->type) {
    case TouchEvent_Touchdown:
      prv_touchdown(ti, event, now);
      break;
    case TouchEvent_PositionUpdate:
      prv_position_update(ti, event, now);
      break;
    case TouchEvent_Liftoff:
      prv_liftoff(ti, event, now);
      break;
  }
}

bool touch_input_init(TouchInput *ti, const TouchInputCallbacks *cbs, int16_t width,
                      void *context) {
  TouchInput blank = {0};
  *ti = blank;
  ti->width = width;
  ti->cbs = *cbs;
  ti->context = context;

  if (!touch_service_is_enabled()) {
    return false;
  }
  touch_service_subscribe(touch_input_handle_event, ti);
  return true;
}

void touch_input_deinit(TouchInput *ti) {
  prv_stop_fling(ti);
  touch_service_unsubscribe();
}
