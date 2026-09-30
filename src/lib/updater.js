// Public release metadata for the npm-distributed app. The check is
// deliberately informational: nothing is ever downloaded or executed by the
// UI — updates are applied by `harpy update`. Users can review the GitHub
// release before installing, which also keeps the checker safe when a
// network is intercepted.

export const CURRENT_VERSION = "2.6.6"
export const RELEASE_URL = 'https://github.com/harpy-run/harpy/releases/latest'
const RELEASE_API_URL = 'https://api.github.com/repos/harpy-run/harpy/releases/latest'

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)],
    prerelease: match[4] || ''
  }
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return 0
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  // A stable release is newer than its prerelease (2.0.6 > 2.0.6-beta.1).
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

function releaseResult(release) {
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
  const version = tag.replace(/^v/i, '')
  const releaseUrl = typeof release?.html_url === 'string' ? release.html_url : RELEASE_URL
  return {
    currentVersion: CURRENT_VERSION,
    version,
    updateAvailable: Boolean(version && compareVersions(version, CURRENT_VERSION) > 0),
    releaseUrl,
    name: typeof release?.name === 'string' ? release.name : ('Harpy ' + tag),
    notes: typeof release?.body === 'string' ? release.body.trim() : '',
    publishedAt: release?.published_at || ''
  }
}

/**
 * Check the public GitHub release feed. This never needs a Harpy account or
 * token and rejects malformed responses so a proxy cannot make the UI offer a
 * bogus update.
 */
export async function checkForUpdate({ timeout = 8_000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error('release feed returned ' + response.status)
    const release = await response.json()
    if (!release || typeof release !== 'object') throw new Error('invalid release feed')
    return releaseResult(release)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
