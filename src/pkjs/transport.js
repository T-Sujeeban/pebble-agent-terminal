// Phone side of the chunked AppMessage transport. Mirror of src/c/net.c.

// AppMessage dict budget is 8200 B: 1 B count + 7 B per tuple + payloads.
// Four tuples (CHUNK + three int32) leave 8159 B; keep margin.
var MAX_CHUNK = 8000;

var s_transfer = 0;

function sendBuffer(bytes, pageId, opts) {
  opts = opts || {};
  var chunkSize = Math.max(1, Math.min(opts.chunkSize || MAX_CHUNK, MAX_CHUNK));
  var done = opts.onDone || function () {};
  var progress = opts.onProgress;
  var total = bytes.length;
  var token = ++s_transfer;
  var offset = 0;
  var seq = 0;

  if (total === 0) {
    done(null);
    return;
  }

  function next() {
    if (token !== s_transfer) {
      return;
    }
    if (offset >= total) {
      done(null);
      return;
    }
    var end = Math.min(offset + chunkSize, total);
    var chunk = Array.prototype.slice.call(bytes, offset, end);
    Pebble.sendAppMessage(
      { CHUNK: chunk, SEQ: seq, TOTAL: total, PAGEID: pageId },
      function () {
        offset = end;
        seq++;
        if (progress) {
          progress(offset, total);
        }
        next();
      },
      function (e) {
        if (token !== s_transfer) {
          return;
        }
        s_transfer++;
        done(new Error('appmessage failed at seq ' + seq + '/' + Math.ceil(total / chunkSize) +
                       (e && e.error ? ': ' + e.error.message : '')));
      }
    );
  }

  next();
}

// Abandons any transfer in flight; its callbacks become no-ops.
function cancel() {
  s_transfer++;
}

module.exports = { sendBuffer: sendBuffer, cancel: cancel, MAX_CHUNK: MAX_CHUNK };
