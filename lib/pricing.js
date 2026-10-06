/**
 * Cost CEILINGS — not estimates, not quotes (plan §3.9).
 *
 * The plan forbids inventing a pricing formula, and it is right to: `pricing_skus`
 * mixes at least six units, `cents_*` keys are 100× their unprefixed cousins,
 * and Seedance is priced per *token* with an unpublished conversion. The
 * official cookbook's `getLowestAdvertisedPrice()` does `Math.min` across all
 * SKUs — comparing USD/second against USD/token — and its "cheapest model"
 * ranking is an artefact of that bug. We do not repeat it.
 *
 * But a long video is 20+ paid calls, so "no formula" cannot mean "no number".
 * The resolution is to compute an UPPER BOUND:
 *
 *   - dispatch by key prefix, so units are never mixed in one sum
 *   - use the model's MOST EXPENSIVE supported resolution, not the requested
 *     one — overestimating is safe, underestimating is not
 *   - respect `minimum_cents_per_generation` (aleph-2 floors at $0.56, so a
 *     2-second edit still costs $0.56)
 *   - token-priced models are counted as UNKNOWN and reported as such — never
 *     as zero, because a zero silently corrupts every total it touches
 *
 * The real number always comes back from `usage.cost` after the fact.
 */

/** SKU key prefixes whose values are USD per output second. */
const USD_PER_SECOND = [
  /^duration_seconds/,
  /^text_to_video_duration_seconds/,
  /^image_to_video_duration_seconds/,
  /^reference_duration_seconds/,
]

/** SKU key prefixes whose values are CENTS per output second (÷100). */
const CENTS_PER_SECOND = [
  /^cents_per_second_output/,
  /^cents_per_video_output_second/,
  /^cents_per_second_video_continuation/,
]

/** SKUs priced per output token — unit cannot be converted without the provider formula. */
const PER_TOKEN = /^video_tokens/

const CENTS_PER_MP_SECOND = /^cents_per_megapixel_second/
const MINIMUM_CENTS = /^minimum_cents_per_generation$/
const FLAT_USD = /^(reference_images|cents_per_image_input)$/

/**
 * Test one pattern, accepting either a RegExp or an array of them.
 *
 * The prefix tables above are deliberately written both ways (a single pattern
 * is a RegExp, several are an array), and mixing the two by hand is exactly how
 * a `.test is not a function` crash ships. Normalising in ONE place means the
 * two spellings can never diverge again.
 */
const matches = (pattern, key) =>
  Array.isArray(pattern) ? pattern.some((re) => re.test(key)) : pattern.test(key)

/** Nominal pixel counts for the resolutions the API exposes, used for MP·s maths. */
export const RESOLUTION_PIXELS = {
  '360p': 640 * 360,
  '480p': 854 * 480,
  '720p': 1280 * 720,
  '768p': 1024 * 768,
  '1080p': 1920 * 1080,
  '1K': 1024 * 1024,
  '2K': 2048 * 1080,
  '4K': 3840 * 2160,
}

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Classify one SKU key. Returning the unit is the whole point — the plan's
 * "unit ambiguity is a live trap" warning is about code that reads the value
 * without reading the key.
 */
export function unitOf(key) {
  if (typeof key !== 'string') return 'unknown'
  if (matches(MINIMUM_CENTS, key)) return 'cents-floor'
  if (matches(CENTS_PER_MP_SECOND, key)) return 'cents-per-mp-second'
  if (matches(PER_TOKEN, key)) return 'usd-per-token'
  if (matches(CENTS_PER_SECOND, key)) return 'cents-per-second'
  if (matches(USD_PER_SECOND, key)) return 'usd-per-second'
  if (matches(FLAT_USD, key)) return 'flat'
  return 'unknown'
}

/** Does this key describe CONTINUATION pricing (plan §0.5.2 constraint B)? */
export const isContinuationKey = (key) => typeof key === 'string' && /continuation/.test(key)

/**
 * Everything we can say about one model's price without inventing anything.
 *
 * @returns {{
 *   known: boolean,
 *   reason: string|null,
 *   perSecond: {usd: number, key: string, resolution: string|null}|null,
 *   continuationPerSecond: {usd: number, key: string}|null,
 *   mpSecondCents: number|null,
 *   floorUsd: number|null,
 *   hasTokenPricing: boolean
 * }}
 */
export function describePricing(model) {
  const skus = model?.pricing_skus
  const result = {
    known: false,
    reason: null,
    perSecond: null,
    continuationPerSecond: null,
    mpSecondCents: null,
    floorUsd: null,
    hasTokenPricing: false,
  }
  if (skus === null || typeof skus !== 'object') {
    result.reason = '模型没有 pricing_skus'
    return result
  }

  let best = null
  let bestContinuation = null

  for (const [key, raw] of Object.entries(skus)) {
    const value = num(raw)
    if (value === null) continue
    const unit = unitOf(key)

    if (unit === 'usd-per-token') {
      result.hasTokenPricing = true
      continue
    }
    if (unit === 'cents-floor') {
      result.floorUsd = value / 100
      continue
    }
    if (unit === 'cents-per-mp-second') {
      result.mpSecondCents = Math.max(result.mpSecondCents ?? 0, value)
      continue
    }
    if (unit === 'usd-per-second' || unit === 'cents-per-second') {
      const usd = unit === 'cents-per-second' ? value / 100 : value
      // Deliberately the MAX across resolution variants: an upper bound, not a quote.
      const bucket = isContinuationKey(key) ? 'continuation' : 'plain'
      if (bucket === 'continuation') {
        if (bestContinuation === null || usd > bestContinuation.usd) {
          bestContinuation = { usd, key, resolution: resolutionFromKey(key) }
        }
      } else if (best === null || usd > best.usd) {
        best = { usd, key, resolution: resolutionFromKey(key) }
      }
    }
  }

  result.perSecond = best
  result.continuationPerSecond = bestContinuation
  // A model is "known" only if we can produce a per-second ceiling for it.
  result.known = best !== null
  if (!result.known) {
    result.reason = result.hasTokenPricing
      ? '按 token 计价，token→秒换算未公开'
      : '没有可用的每秒计价 SKU'
  }
  return result
}

/** Pull a resolution hint out of a SKU key like `duration_seconds_with_audio_1080p`. */
function resolutionFromKey(key) {
  const match = /_(360p|480p|720p|768p|1080p|1K|2K|4K)(?:_|$)/.exec(key)
  return match === null ? null : match[1]
}

/**
 * The ceiling for one node, in USD. `null` means "unknown magnitude" and MUST
 * be surfaced as such rather than treated as 0.
 *
 * `kind` is 'continuation' for `extend` nodes, which pulls the continuation SKU
 * — on flux-3-video that is $0.41/s against a $0.17/s base, so getting this
 * wrong understates the most expensive leg of a long video by 2.4×.
 */
export function nodeCeiling({ model, seconds, kind = 'plain' }) {
  if (model === null || model === undefined) {
    return { usd: null, source: 'no-model', reason: '没有指定模型' }
  }
  const pricing = describePricing(model)
  const secondsValue = Number(seconds)

  if (Number.isFinite(secondsValue) && secondsValue > 0) {
    const perSecond = kind === 'continuation'
      ? (pricing.continuationPerSecond ?? pricing.perSecond)
      : pricing.perSecond

    if (perSecond !== null) {
      let usd = perSecond.usd * secondsValue
      if (pricing.floorUsd !== null) usd = Math.max(usd, pricing.floorUsd)
      return {
        usd,
        source: kind === 'continuation' && pricing.continuationPerSecond !== null ? 'continuation-per-second' : 'per-second',
        sku: perSecond.key,
        reason: null,
      }
    }

    if (pricing.mpSecondCents !== null) {
      // MP·s needs pixels, and we take the largest supported resolution so the
      // figure stays an upper bound.
      const resolution = largestResolution(model)
      const pixels = RESOLUTION_PIXELS[resolution] ?? RESOLUTION_PIXELS['720p']
      const mpSeconds = (pixels / 1_000_000) * secondsValue
      const usd = (pricing.mpSecondCents / 100) * mpSeconds
      return { usd, source: 'per-mp-second', sku: `cents_per_megapixel_second@${resolution}`, reason: null }
    }
  }

  return {
    usd: null,
    source: pricing.hasTokenPricing ? 'per-token' : 'unknown',
    reason: pricing.reason ?? '无法计算量级',
  }
}

/** The most expensive resolution a model advertises — the safe side of an upper bound. */
export function largestResolution(model) {
  const list = Array.isArray(model?.supported_resolutions) ? model.supported_resolutions : []
  let best = null
  let bestPixels = -1
  for (const name of list) {
    const pixels = RESOLUTION_PIXELS[name]
    if (pixels === undefined) continue
    if (pixels > bestPixels) { bestPixels = pixels; best = name }
  }
  return best
}

/**
 * Sum ceilings across a set of network nodes.
 *
 * Returns the total, the per-node breakdown, and — crucially — how many nodes
 * could not be priced. The plan is explicit that those must never be folded in
 * as zero, so they are reported alongside instead.
 */
export function ceilingFor(nodes) {
  const rows = []
  let total = 0
  let unknown = 0

  for (const node of nodes) {
    const entry = nodeCeiling({ model: node.model, seconds: node.seconds, kind: node.kind })
    if (entry.usd === null) {
      unknown += 1
      rows.push({ ...node, usd: null, unknown: true, source: entry.source, reason: entry.reason })
    } else {
      total += entry.usd
      rows.push({ ...node, usd: entry.usd, unknown: false, source: entry.source, reason: null })
    }
  }

  return { total, unknown, rows, complete: unknown === 0 }
}

export const pricingInternals = {
  unitOf, isContinuationKey, RESOLUTION_PIXELS, USD_PER_SECOND, CENTS_PER_SECOND,
}
