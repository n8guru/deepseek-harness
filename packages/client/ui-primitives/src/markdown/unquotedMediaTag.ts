/**
 * micromark ends an unquoted attribute value at `/`, so `<img src=https://x/a.png>`
 * (the way models routinely write media tags) never parses as inline HTML and
 * leaks out as text plus an autolink. This text construct recognises a complete
 * `<img|video|audio|iframe …>` opening tag on one line, `/` allowed inside
 * unquoted values, and emits the standard `htmlText` token so mdast gets an
 * ordinary `html` node (rendered or kept literal by rawMedia.tsx). Anything
 * else (other tags, multi-line tags, unterminated tags) falls through to the
 * stock construct.
 */

import { markdownLineEnding, markdownSpace } from 'micromark-util-character'
import { codes } from 'micromark-util-symbol'
import type { Code, Construct, Extension, State, Tokenizer } from 'micromark-util-types'

const MEDIA = new Set(['img', 'video', 'audio', 'iframe'])

const tokenizeMediaTag: Tokenizer = function (effects, ok, nok) {
  let name = ''
  let quote: Code = null
  let afterEquals = false

  return start

  function start(code: Code): State | undefined {
    /* v8 ignore next -- this text construct is dispatched only for `<`. */
    if (code !== codes.lessThan) return nok(code)
    effects.enter('htmlText')
    effects.enter('htmlTextData')
    effects.consume(code)
    return tagName
  }

  function tagName(code: Code): State | undefined {
    if (code !== null && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      name += String.fromCharCode(code).toLowerCase()
      effects.consume(code)
      return tagName
    }
    if (MEDIA.has(name) && (code === codes.greaterThan || code === codes.slash || markdownSpace(code))) return body(code)
    return nok(code)
  }

  function body(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) return nok(code)
    if (quote !== null) {
      if (code === quote) quote = null
      afterEquals = false
      effects.consume(code)
      return body
    }
    if (code === codes.lessThan) return nok(code)
    if (code === codes.greaterThan) {
      effects.consume(code)
      effects.exit('htmlTextData')
      effects.exit('htmlText')
      return ok
    }
    if ((code === codes.quotationMark || code === codes.apostrophe) && afterEquals) quote = code
    if (!markdownSpace(code)) afterEquals = code === codes.equalsTo
    effects.consume(code)
    return body
  }
}

const mediaTag: Construct = { name: 'unquotedMediaTag', tokenize: tokenizeMediaTag }

const extension: Extension = { text: { [codes.lessThan]: mediaTag } }

/** Text-level extension that lets media tags carry unquoted URL attributes. */
export function unquotedMediaTag(): Extension {
  return extension
}
