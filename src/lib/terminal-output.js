const WRITE_BATCH_CHARS = 256 * 1024
const MAX_PENDING_CHARS = 4 * 1024 * 1024
const OVERLOAD_MARKER_RESERVE = 128

function atLiveEdge(terminal) {
  const buffer = terminal?.buffer?.active
  return !buffer || buffer.type === 'alternate' || buffer.viewportY >= buffer.baseY
}

// Coalesce bursts of small PTY frames before handing them to xterm. xterm
// still time-slices parsing internally; this avoids flooding its write queue
// with a separate render task for every websocket frame.
export function createTerminalOutputQueue(terminal) {
  const queue = []
  let frame = 0
  let disposed = false
  let pendingChars = 0
  let currentParts = null
  let currentPartChars = 0

  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(flush)
  }

  function flush() {
    frame = 0
    if (disposed || !queue.length) return

    let remaining = WRITE_BATCH_CHARS
    const batch = []
    const callbacks = []
    while (remaining > 0 && queue.length) {
      const item = queue[0]
      if (typeof item === 'function') {
        callbacks.push(queue.shift())
        break
      }
      if (Array.isArray(item)) {
        while (item.length && remaining > 0) {
          const chunk = item[0]
          const length = Math.min(remaining, chunk.length)
          batch.push(chunk.slice(0, length))
          remaining -= length
          pendingChars -= length
          if (length === chunk.length) item.shift()
          else item[0] = chunk.slice(length)
        }
        if (!item.length) {
          queue.shift()
          if (currentParts === item) { currentParts = null; currentPartChars = 0 }
        }
      } else {
        const length = Math.min(remaining, item.length)
        batch.push(item.slice(0, length))
        remaining -= length
        pendingChars -= length
        if (length === item.length) queue.shift()
        else queue[0] = item.slice(length)
      }
    }

    const complete = () => {
      // Stay attached to live output but preserve the reader's position in
      // scrollback once they have deliberately moved away from the prompt.
      if (!disposed && atLiveEdge(terminal)) terminal.scrollToBottom()
      for (const callback of callbacks) callback()
      if (queue.length) schedule()
    }
    if (batch.length) terminal.write(batch.join(''), complete)
    else complete()
  }

  return {
    write(data, callback) {
      if (disposed) return
      const value = String(data ?? '')
      if (value) {
        if (pendingChars + value.length > MAX_PENDING_CHARS) {
          const queuedChars = pendingChars
          const callbacks = queue.filter((item) => typeof item === 'function')
          queue.length = 0
          pendingChars = 0
          currentParts = null
          currentPartChars = 0
          // A dropped interval can contain half of an ANSI control sequence.
          // Reset parser and screen state before continuing so stale escape
          // fragments cannot leave xterm in a broken rendering mode.
          terminal.reset()
          const recent = value.slice(-(MAX_PENDING_CHARS - OVERLOAD_MARKER_RESERVE))
          const dropped = queuedChars + value.length - recent.length
          const marker = `\r\n[terminal overloaded; terminal view reset, ${dropped} queued characters omitted]\r\n`
          queue.push([marker, recent], ...callbacks)
          pendingChars = marker.length + recent.length
        } else {
          if (!currentParts || queue.at(-1) !== currentParts || currentPartChars + value.length > WRITE_BATCH_CHARS) {
            currentParts = []
            currentPartChars = 0
            queue.push(currentParts)
          }
          currentParts.push(value)
          currentPartChars += value.length
          pendingChars += value.length
        }
      }
      if (callback) queue.push(callback)
      if (!value && !callback) return
      schedule()
    },
    dispose() {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      queue.length = 0
      pendingChars = 0
      currentParts = null
      currentPartChars = 0
    }
  }
}
