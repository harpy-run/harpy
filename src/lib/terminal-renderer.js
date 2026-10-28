import { WebglAddon } from '@xterm/addon-webgl'

// xterm 6 supports WebGL and its built-in DOM renderer. The old canvas addon
// was removed upstream and must not be loaded against the new terminal API.
//
// Older render addons could throw during teardown when internals were
// undefined when the addon never fully activated (or gets disposed twice),
// and the throw propagates through AddonManager.dispose → terminal.dispose →
// Preact unmount, which aborts the whole mode-switch render and leaves the
// old panes painted — a frozen UI. Teardown bugs must never crash unmounts.
function guarded(addon) {
  const dispose = addon.dispose?.bind(addon)
  let disposed = false
  if (dispose) {
    addon.dispose = () => {
      if (disposed) return
      disposed = true
      try { dispose() } catch { /* see above */ }
    }
  }
  return addon
}

export function attachFastRenderer(terminal) {
  let addon
  try {
    addon = guarded(new WebglAddon())
    // Background tabs and mobile GPUs can lose their WebGL context. Disposing
    // the addon restores xterm's DOM renderer without resetting the buffer.
    addon.onContextLoss(() => addon.dispose())
    terminal.loadAddon(addon)
    return 'webgl'
  } catch {
    addon?.dispose()
    return 'dom'
  }
}
