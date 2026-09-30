import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'

// The default DOM renderer measures every distinct codepoint through
// getBoundingClientRect — a forced layout per ~30 characters that costs
// multiple seconds on terminals rich in box-drawing/Unicode output (agent
// TUIs are exactly that). WebGL and canvas measure glyphs through
// ctx.measureText with no layout at all. Prefer WebGL, fall back to canvas,
// and only keep the DOM renderer if both are unavailable.
//
// Both render addons have a teardown bug: dispose() reads internals that are
// undefined when the addon never fully activated (or gets disposed twice),
// and the throw propagates through AddonManager.dispose → terminal.dispose →
// Preact unmount, which aborts the whole mode-switch render and leaves the
// old panes painted — a frozen UI. Teardown bugs must never crash unmounts.
function guarded(addon) {
  const dispose = addon.dispose?.bind(addon)
  if (dispose) {
    addon.dispose = () => {
      try { dispose() } catch { /* see above */ }
    }
  }
  return addon
}

export function attachFastRenderer(terminal) {
  try {
    terminal.loadAddon(guarded(new WebglAddon()))
    return 'webgl'
  } catch {
    try {
      terminal.loadAddon(guarded(new CanvasAddon()))
      return 'canvas'
    } catch {
      return 'dom'
    }
  }
}
