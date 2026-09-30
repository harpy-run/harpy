import { ws } from './ws.js'
import { workspace, leafList, paneAreaVisible } from '../state/app.js'

// Live workspace watches per connection. The subscription dies with the
// socket, so it is re-armed on every (re)open and re-pointed whenever the
// workspace or pane layout changes. Views only consume `ws.on('fs',
// 'changed')` events — they never manage the subscription themselves.
let watched = new Set()

function desiredPaths() {
  const paths = new Set()
  if (workspace.value?.path) paths.add(workspace.value.path)
  // Split/agent panes pin their own workspaces so a side-by-side project
  // still receives live fs:changed events without being focused.
  if (paneAreaVisible.value) {
    for (const leaf of leafList()) if (leaf.path) paths.add(leaf.path)
  }
  return paths
}

function subscribe(force = false) {
  const next = desiredPaths()
  if (!force && next.size === watched.size && [...next].every((path) => watched.has(path))) return
  for (const path of watched) {
    if (!next.has(path)) ws.request('fs', 'unwatch', { workspace: path }).catch(() => {})
  }
  watched = next
  for (const path of watched) ws.request('fs', 'watch', { workspace: path }).catch(() => {})
}

export function refreshFsWatch() {
  subscribe()
}

export function initFsWatch() {
  window.addEventListener('harpy:ws-open', () => subscribe(true))
  window.addEventListener('harpy:workspace-change', () => subscribe())
  subscribe()
}
