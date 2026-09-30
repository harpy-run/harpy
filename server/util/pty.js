// Lazy loader for the PTY backend. @lydell/node-pty distributes its native
// binaries as per-platform optionalDependencies (@lydell/node-pty-<platform>-<arch>),
// so the .node files arrive inside the npm tarball itself — no install
// scripts, no GitHub download, no node-gyp/MSVC toolchain, and `npm i -g`
// updates can never leave a host without its binaries (the failure mode
// that killed every terminal on Windows with the previous prebuilt fork).
let impl
let implError

export async function getPty() {
  if (impl) return impl
  if (implError) throw implError
  try {
    const mod = await import('@lydell/node-pty')
    impl = mod.default || mod
    return impl
  } catch (error) {
    implError = new Error(
      `PTY backend unavailable on ${process.platform}-${process.arch}: ${error?.message || error}. ` +
      'Reinstall harpy (npm i -g @harpy-run/harpy) and do not omit optional dependencies.'
    )
    implError.cause = error
    throw implError
  }
}

export async function spawnPty(file, args = [], opts = {}) {
  const pty = await getPty()
  // On Windows use the bundled OpenConsole/ConPTY pair shipped inside the
  // platform package — identical everywhere and immune to the ancient
  // conhost bugs that shipped with early Windows 10 builds.
  if (process.platform === 'win32' && opts.useConptyDll === undefined) {
    opts = { useConptyDll: true, ...opts }
  }
  return pty.spawn(file, args, opts)
}
