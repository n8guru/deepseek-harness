/**
 * Raw `<img>` / `<video>` / `<audio>` / `<iframe>` tags in assistant markdown
 * render as real media, built from a closed allowlist (never the author's
 * markup): only `http(s)` or root-relative `/local/` sources survive, attributes
 * are rebuilt from a fixed set, and every other tag (script, style, on*
 * handlers, srcdoc, …) stays literal text. Closing media tags are dropped
 * because each opener already renders as a complete element.
 */

import { Fragment } from 'react'
import type { Key, ReactNode } from 'react'
import { normalizeUri } from 'micromark-util-sanitize-uri'
import css from './MarkdownText.module.css'

const TAG = /<(img|video|audio|iframe)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<\/(?:video|audio|iframe)\s*>/gi
const ATTR = /([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi
const SANDBOX = new Set(['allow-same-origin', 'allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-forms'])

function mediaUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const url = normalizeUri(raw.replace(/&amp;/g, '&').trim())
  if (/^\/local\/[^/]/.test(url) && !/\.\.|%(?:2f|5c)/i.test(url)) return url
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, location.origin).origin === location.origin
  } catch {
    return false
  }
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of source.matchAll(ATTR)) out[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

const size = (v: string | undefined) => (v !== undefined && /^\d{1,4}%?$/.test(v) ? v : undefined)

function element(tag: string, a: Record<string, string>, key: Key): ReactNode {
  const src = mediaUrl(a.src)
  if (src === undefined) return undefined
  const width = size(a.width)
  const height = size(a.height)
  switch (tag) {
    case 'img':
      return <img key={key} className={css.image} src={src} alt={a.alt ?? ''} width={width} height={height}
        loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    case 'video':
      return <video key={key} className={css.image} src={src} poster={mediaUrl(a.poster)} width={width} height={height}
        controls loop={'loop' in a} muted={'muted' in a} playsInline preload="metadata" />
    case 'audio':
      return <audio key={key} src={src} controls loop={'loop' in a} preload="metadata" />
    default: {
      // A same-origin frame never gets scripts; cross-origin frames are
      // isolated by the origin boundary itself.
      const own = sameOrigin(src)
      const asked = (a.sandbox ?? 'allow-scripts allow-same-origin allow-popups allow-forms')
        .split(/\s+/).filter(t => SANDBOX.has(t) && !(own && t === 'allow-scripts'))
      return <iframe key={key} className={css.frame} src={src} title={a.title ?? 'embedded content'}
        sandbox={asked.join(' ')} width={width ?? '100%'} height={height ?? '480'}
        loading="lazy" referrerPolicy="no-referrer" allowFullScreen />
    }
  }
}

/** Safe media elements for a raw HTML node, or `undefined` when it holds none (caller keeps it literal). */
export function renderRawMedia(value: string, key: Key): ReactNode | undefined {
  const parts: ReactNode[] = []
  let last = 0
  let made = false
  for (const m of value.matchAll(TAG)) {
    const el = m[1] === undefined ? null : element(m[1].toLowerCase(), attrs(m[2] ?? ''), parts.length)
    if (el === undefined) continue // unsafe source: leave the tag as literal text
    made ||= el !== null
    if (m.index > last) parts.push(value.slice(last, m.index))
    if (el !== null) parts.push(el)
    last = m.index + m[0].length
  }
  if (!made && last === 0) return undefined
  if (last < value.length) parts.push(value.slice(last))
  return <Fragment key={key}>{parts}</Fragment>
}
