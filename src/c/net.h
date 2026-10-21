#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Chunked AppMessage transport. The phone streams a display-list byte stream
// as CHUNK/SEQ/TOTAL/PAGEID messages; this reassembles it into one heap buffer.

#define NET_MAX_PAGE_BYTES 32768
#define NET_MAX_CHUNKS 256
#define NET_STALL_TIMEOUT_MS 15000

// Ownership of `data` passes to the handler, which must free() it.
// Called from the event loop, never from the AppMessage inbox callback.
typedef void (*NetPageHandler)(uint8_t *data, size_t len, uint32_t page_id, void *ctx);

void net_init(NetPageHandler handler, void *ctx);
void net_deinit(void);

// Upstream commands. Mirrored in src/pkjs/index.js.
// arg = screen width, OR'd with CMD_HELLO_ROUND on a circular display.
#define CMD_HELLO 1
#define CMD_HELLO_ROUND 0x10000
#define CMD_TEXT 6    // dictated transcription → agent (TEXT = transcription string)
#define CMD_CANCEL 10 // cancel current agent request

// Dictated text travels as a string, not an int.
bool net_send_text(uint8_t cmd, const char *text);

// Upstream command. False if the outbox is busy.
bool net_send_cmd(uint8_t cmd, int32_t arg);

bool net_is_receiving(void);

// Bytes of the in-flight page. False when no transfer is active.
bool net_progress(size_t *received, size_t *total);

// Implemented by the app; called when the phone sends a STATUS string.
void app_on_status(const char *text);
