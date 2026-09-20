/**
 * Browser-owned durable client identity for prompt/presence RPC provenance.
 *
 * The harness is reached from several surfaces at once (a desktop browser, a
 * tablet, a phone). Transport ids cannot answer "which machine is the human
 * at": an `rpcId` is minted per frame. This module mints ONE stable id per
 * browser profile so the Host can track the active surface and device-scoped
 * capabilities — microphone capture, spoken playback — can follow the human
 * instead of every open client acting simultaneously.
 *
 * The id is an opaque random string. It carries no account, hardware, or
 * network identity, and is never sent anywhere but this harness.
 */

const ID_KEY = 'dsh.client.id'
const LABEL_KEY = 'dsh.client.label'

/** Read a localStorage key, tolerating privacy modes that throw on access. */
function readStored(key: string): string | undefined {
  try {
    const value = globalThis.localStorage?.getItem(key)
    return value === null || value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Non-persistent contexts still get a per-load id from the cache below.
  }
}

let cachedId: string | undefined

/**
 * The stable id of this client surface.
 * @returns An opaque id, persistent across reloads where storage allows.
 */
export function clientId(): string {
  if (cachedId !== undefined) return cachedId
  const stored = readStored(ID_KEY)
  if (stored !== undefined) {
    cachedId = stored
    return stored
  }
  const minted = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  writeStored(ID_KEY, minted)
  cachedId = minted
  return minted
}

/** Best-effort human-readable device name, from the platform hints available. */
function derivedLabel(): string {
  const nav: { userAgent?: string; platform?: string } | undefined = globalThis.navigator
  const ua = nav?.userAgent ?? ''
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  if (/Linux/i.test(ua)) return 'Linux desktop'
  return 'browser'
}

/**
 * The display name for this client surface. An operator-set label wins over
 * the derived one, so a machine can be named something meaningful.
 * @returns A short label, never empty.
 */
export function clientLabel(): string {
  return readStored(LABEL_KEY) ?? derivedLabel()
}

/**
 * Override this surface's display name.
 * @param label - operator-chosen name; blank restores the derived label.
 */
export function setClientLabel(label: string): void {
  writeStored(LABEL_KEY, label.trim())
}
