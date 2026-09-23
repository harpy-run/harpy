import { useEffect, useState } from 'preact/hooks'

// Minimal code-split helper: imports the module on first render so heavy
// vendor chunks (CodeMirror, xterm) and large panels stay out of the initial
// bundle. Named export is picked explicitly to keep esbuild chunking static.
export function lazyView(load, name) {
  return function LazyView(props) {
    const [Comp, setComp] = useState(null)
    useEffect(() => {
      let alive = true
      load().then((mod) => { if (alive) setComp(() => mod[name]) }).catch(() => {})
      return () => { alive = false }
    }, [])
    return Comp ? <Comp {...props} /> : <div class="lazy-view" aria-busy="true" />
  }
}
