/**
 * dsh-openrouter-video — Host half.
 *
 * The video counterpart to dsh-openrouter-imagen-v2, with the four structural
 * differences the plan calls out (§2):
 *
 *   1. **async tasks, not a synchronous response.** `POST /videos` → 202 → poll
 *      → download. So there is a job ledger, and it is written at *submit* time.
 *   2. **Host-side polling.** The docs say to poll from a server route rather
 *      than the browser; a page that owns the poll loses the job when it closes.
 *   3. **a validation gate before the paid call.** A Veo 4K shot is $0.60+ and a
 *      long film is 20+ of them.
 *   4. **a graph document and a DAG executor** — the layer that makes "long
 *      video" mean something other than "one more 8-second clip".
 *
 * The workspace is an addition, not a replacement: a conversation can still call
 * `openrouter_generate_video` with no UI involved.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, dirname, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JobStore, GraphStore, jobId as newJobId, isTerminal, TERMINAL_FAIL, errorMessage, defaultDataDir } from './store.js'
import { bufferedSkill } from './skills.js'
import {
  emptyGraph, normalizeGraph, validate, canConnect, shots, findNode, isNetworkNode,
  resolveModel, resolveDuration, resolveResolution, resolveAspect, resolveSeed,
  topoOrder, downstreamOf, upstreamOf, graphInternals, NODE_TYPES, NETWORK_TYPES, SHOT_TYPES, GRAPH_VERSION,
  pricingKind, frameSlotOf,
} from './graph.js'
import { runGraph, rehydrate, summarize, expandSubset, NODE_STATE } from './exec.js'
import { nodeCeiling, ceilingFor, describePricing, largestResolution } from './pricing.js'
import { cutAndPublish, uploadFrame } from './imagebed.js'
import { composeSequence, ffprobeFrom, orderClips } from './sequence.js'
import { bibleFor, applyCast, describeCast } from './cast.js'

/** Namespace = this plugin row's id; dsh ≥ 0.1.7 keys configurable entries by it. */
const NS = 'openrouter-video'
const API_PATH = '/openrouter-video/api'
const API_BASE = (process.env.OPENROUTER_VIDEO_API_BASE ?? '').trim() || 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 600_000
const DEFAULT_SAVE_DIR = 'generated-videos'
/** Refuse to buffer anything larger than this into memory. */
const MAX_INLINE_BYTES = 512 * 1024 * 1024

/**
 * Join a request path onto the API base — WITHOUT losing the base path.
 *
 * `new URL('/videos', 'https://openrouter.ai/api/v1')` is `https://openrouter.ai/videos`:
 * a leading slash resolves against the ORIGIN and discards `/api/v1`. A relative
 * path is worse — it truncates the last base segment. Both request the wrong
 * endpoint, and a wrong endpoint on openrouter.ai answers **HTTP 200 with the
 * 171 KB marketing page**, so `response.ok` is true and the only symptom is a
 * JSON parse failure swallowed by a catch. That combination hid a bug that broke
 * every single call the plugin makes, so the join is explicit here.
 */
const resolveApiUrl = (path, base = API_BASE) => {
  if (typeof path !== 'string' || path.length === 0) throw new Error('空的请求路径')
  if (/^https?:\/\//iu.test(path)) return new URL(path)
  return new URL(`${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`)
}

/**
 * Drop keys whose value is `undefined`.
 *
 * A tool's return value is validated as lossless JSON. `{ error: undefined }`
 * survives in memory but vanishes through `JSON.stringify`, so a result carrying
 * one is rejected at the harness boundary — which is how the entire dry-run path
 * came to fail with "value is not lossless JSON" while every direct `execute()`
 * test passed.
 */
const defined = (object) => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined),
)

/**
 * Download guard. `unsigned_urls` are NOT presigned — they want the same bearer
 * token — but a response may point at third-party storage instead, and attaching
 * our key to a foreign host would leak it. The plan's trap #7.
 */
const isOpenRouterUrl = (url) => typeof url === 'string' && url.startsWith('https://openrouter.ai/api/')

/** Media types we are willing to write, by extension. */
const EXT_FOR_MEDIA = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
}

export const Config = Schema.object({
  apiKey: Schema.string().role('secret').volatile(),
  model: Schema.string().default('google/veo-3.1-fast').volatile(),
  /**
   * The user's own shortlist of models — the difference between a picker with
   * four options and a picker with the entire OpenRouter video catalog in it.
   * `model` above stays the default; this is only what the dropdown offers.
   */
  models: Schema.array(Schema.string()).default([]).volatile(),
  resolution: Schema.string().default('720p').volatile(),
  aspectRatio: Schema.string().default('16:9').volatile(),
  duration: Schema.number().default(8).volatile(),
  generateAudio: Schema.boolean().default(true).volatile(),
  concurrency: Schema.number().default(2).volatile(),
  budgetUsd: Schema.number().default(30).volatile(),
  abortOnExceed: Schema.boolean().default(true).volatile(),
  /** https | dataurl-try | off — see the plan §7 decision on asset delivery. */
  urlMode: Schema.string().default('https').volatile(),
  pollIntervalMs: Schema.number().default(30_000).volatile(),
  maxPollAttempts: Schema.number().default(60).volatile(),
  splitRatio: Schema.number().default(0.18).volatile(),
  saveDir: Schema.string().default(DEFAULT_SAVE_DIR).volatile(),
  /**
   * Where a sampled frame is published so a provider can actually fetch it.
   *
   * This is what makes first/last-frame chaining work at all: `previous_job_id`
   * is unusable for us and a video reference is bearer-guarded, so the only
   * continuity primitive left is an image at a public https URL. Empty disables
   * the whole mechanism — and says so, rather than silently degrading a chained
   * shot into an independent take.
   */
  imageBedUrl: Schema.string().default('').volatile(),
  imageBedFolder: Schema.string().default('test').volatile(),
  /** Not cosmetic: a Cloudflare-challenged bed lets exactly one agent string through. */
  imageBedUserAgent: Schema.string().default('gobelagent').volatile(),
  imageBedToken: Schema.string().role('secret').volatile(),
  /** How far back to seek before dumping the tail frames that end in the last frame. */
  imageBedFrameSeek: Schema.number().default(0.6).volatile(),
  ffmpegPath: Schema.string().default('ffmpeg').volatile(),
  /** Where job/graph JSON lives. Empty = the plugin's own data dir; tests pass a temp dir. */
  dataDir: Schema.string().default('').volatile(),
  skills: Schema.boolean().default(true).volatile(),
})

const WRITABLE = [
  'apiKey', 'model', 'models', 'resolution', 'aspectRatio', 'duration', 'generateAudio', 'concurrency',
  'budgetUsd', 'abortOnExceed', 'urlMode', 'pollIntervalMs', 'maxPollAttempts',
  'splitRatio', 'saveDir', 'skills',
  'imageBedUrl', 'imageBedFolder', 'imageBedUserAgent', 'imageBedToken',
  'imageBedFrameSeek', 'ffmpegPath',
]

/**
 * A 1×1 PNG, for the image-bed connectivity probe. Generated here rather than
 * kept as a file, because a probe asset that can go missing is a probe that
 * reports the wrong thing.
 */
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function proxyFromEnv() {
  const pick = (name) => {
    const value = process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }
  return { http: pick('http_proxy'), https: pick('https_proxy') }
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Is the film on the ledger the one this graph would cut NOW?
 *
 * The whole rule, in one place, because it was wrong in one place: the cache used
 * to hold purely on `status === 'completed'`, so an INCOMPLETE film — cut from the
 * shots that happened to finish — was cached exactly like a complete one. Fixing
 * the failed shot and re-running then did nothing: the receipt said 完成 while the
 * delivered file was still a shot short. Re-running could never fix it, and the
 * only escape was deleting the mp4 by hand.
 *
 * Comparing the clip SET covers both directions: a permanently broken shot does
 * not spray a new file on every resume, and finishing it (or re-rendering any shot
 * into a new take) DOES rebuild the film.
 *
 * `clips` is absent on records written before this rule, so those re-cut once and
 * are then stable. Local ffmpeg, no money.
 */
function sequenceIsCurrent(record, clipKeys) {  const recorded = Array.isArray(record?.sequence?.clips) ? record.sequence.clips : null
  if (recorded === null) return false
  return recorded.join('|') === (Array.isArray(clipKeys) ? clipKeys : []).join('|')
}

/** A filename stem safe on Windows and POSIX alike. */
function fileStem(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return fallback
  /*
   * An ALLOW list, not a deny list.
   *
   * The deny list caught the characters that break a filesystem and nothing else,
   * so a project called 「猫咪跳街舞 · 30s · 6 镜 · 场景一致 + 1 处接龙」 produced
   * `猫咪跳街舞-·-30s-·-6-镜-·-场景一致-+-1-处接龙-….mp4` — perfectly legal,
   * unpleasant to read, and awkward to type into any other tool. Letters and
   * digits (any script), `_` and `-` survive; everything else is a separator. A
   * deny list can only ever catch the characters someone thought of.
   */
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return cleaned.slice(0, 80) || fallback
}

/** Confirm a directory, refusing anything outside the session workspace. */
function resolveSaveDir(saveDir, cwd) {
  const root = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const raw = typeof saveDir === 'string' && saveDir.trim().length > 0 ? saveDir.trim() : DEFAULT_SAVE_DIR
  const resolved = isAbsolute(raw) ? raw : join(root, raw)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`保存目录必须在会话工作目录内：${saveDir}。越界会被拒绝，而不是被改写。`)
  }
  return { absolute: resolved, relative: rel.length === 0 ? '.' : rel }
}

function positiveInt(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** The short display name for a model id — derived, never stored twice. */
const shortModel = (id) => (typeof id === 'string' ? id.split('/').pop() : '')

/* ================================================================== *
 * plugin
 * ================================================================== */

export function apply(ctx, config) {
  /* ---- reading config ------------------------------------------------
   * DSH hands `apply` a config whose fields may be reactive accessors (each
   * carrying `.get()`) or plain values, depending on how the row was composed.
   * Reading only `config.x?.get?.()` — which is what the reference does —
   * silently collapses a plain value onto the fallback. That is invisible for
   * settings that have a sane default and fatal for the key, which has none: a
   * key sitting right there in the profile still reads as "未配置".
   * ------------------------------------------------------------------- */
  const field = (key, fallback) => {
    const raw = config === null || config === undefined ? undefined : config[key]
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
    return value === undefined || value === null ? fallback : value
  }

  const readConfig = () => ({
    apiKey: String(field('apiKey', '') ?? '').trim(),
    model: field('model', 'google/veo-3.1-fast'),
    models: (Array.isArray(field('models', [])) ? field('models', []) : [])
      .filter((id) => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim()),
    resolution: field('resolution', '720p'),
    aspectRatio: field('aspectRatio', '16:9'),
    duration: field('duration', 8),
    generateAudio: field('generateAudio', true) !== false,
    concurrency: field('concurrency', 2),
    budgetUsd: field('budgetUsd', 30),
    abortOnExceed: field('abortOnExceed', true) !== false,
    urlMode: field('urlMode', 'https'),
    pollIntervalMs: field('pollIntervalMs', 30_000),
    maxPollAttempts: field('maxPollAttempts', 60),
    splitRatio: field('splitRatio', 0.18),
    saveDir: field('saveDir', DEFAULT_SAVE_DIR),
    imageBedUrl: String(field('imageBedUrl', '') ?? '').trim().replace(/\/+$/u, ''),
    imageBedFolder: String(field('imageBedFolder', 'test') ?? 'test').trim() || 'test',
    imageBedUserAgent: String(field('imageBedUserAgent', 'gobelagent') ?? 'gobelagent').trim(),
    imageBedToken: String(field('imageBedToken', '') ?? '').trim(),
    imageBedFrameSeek: Number.isFinite(Number(field('imageBedFrameSeek', 0.6)))
      ? Math.max(0.1, Number(field('imageBedFrameSeek', 0.6)))
      : 0.6,
    ffmpegPath: String(field('ffmpegPath', 'ffmpeg') ?? 'ffmpeg').trim() || 'ffmpeg',
    dataDir: field('dataDir', ''),
    skills: field('skills', true) !== false,
  })

  /* ---- writing config ------------------------------------------------
   * There is exactly ONE supported way to persist a plugin setting: the
   * `settings` service. Mutating the config object we were handed does
   * nothing — and written as `config.apiKey?.set?.(value)` it does nothing
   * *quietly*, returning a cheerful `ok: true` while the key never changes.
   * That is why saving a key left the UI saying "未配置". An unavailable
   * editor is an error, never a no-op.
   * ------------------------------------------------------------------- */
  const settingsEditor = () => {
    const service = ctx.get('settings')
    if (service === undefined || typeof service.update !== 'function') {
      throw new Error('设置服务不可用：当前 DSH 运行时没有挂载可写的配置编辑器，因此密钥无法保存。')
    }
    return service
  }

  /* ---- persistence -------------------------------------------------
   * The data directory is resolved ONCE here and handed to the stores as a
   * path. imagen-v2 hardcoded `join(homedir(), '.dsh', ...)` inside the store
   * construction, which meant `npm run smoke` instantiated plugin instances
   * pointed at the user's real history file and `store.clear()` deleted it
   * (`NOTES.md`「当前最严重的一条，尚未修」). Injectable ends that class of bug.
   */
  const dataDirOf = () => {
    const configured = readConfig().dataDir
    if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
    return defaultDataDir(homedir())
  }
  const jobStore = new JobStore(join(dataDirOf(), 'jobs.json'))
  const graphStore = new GraphStore(join(dataDirOf(), 'graphs.json'))
  void jobStore.load()
  void graphStore.load()

  /** Live execution state, per graph. Not persisted — the ledger is. */
  const runs = new Map() // graphId → { states: Map, control: {aborted}, startedAt, lastReport }

  /* ---- outbound HTTP (proxy aware, owned by this fiber) ---- */

  let pool = null
  const getPool = async () => {
    if (pool !== null) return pool
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici')
    const { http, https } = proxyFromEnv()
    const dispatcher = http === null && https === null
      ? undefined
      : new EnvHttpProxyAgent({ httpProxy: http ?? undefined, httpsProxy: https ?? undefined })
    pool = { fetch: undiciFetch, dispatcher }
    return pool
  }
  ctx.effect(
    () => () => {
      const current = pool
      pool = null
      void current?.dispatcher?.close?.()
    },
    'openrouter-video: http pool',
  )

  const effectiveKey = (keyOverride) => {
    const { apiKey } = readConfig()
    const chosen = typeof keyOverride === 'string' && keyOverride.trim().length > 0 ? keyOverride.trim() : apiKey
    if (typeof chosen !== 'string' || chosen.trim().length === 0) {
      throw new Error('未配置 API Key：请先在设置里填入 OpenRouter 密钥')
    }
    return chosen.trim()
  }

  async function callApi(path, { method = 'GET', body, keyOverride, raw = false } = {}) {
    const key = effectiveKey(keyOverride)
    const { fetch: doFetch, dispatcher } = await getPool()
    const response = await doFetch(resolveApiUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    })
    if (raw) return response
    const text = await response.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = null }
    if (!response.ok) {
      // Carry the server's own sentence back verbatim. The plan is explicit that
      // a 400 listing supported values must reach the user unedited, and that a
      // continuation failure must not be rewritten into something friendlier.
      const detail = data?.error?.message ?? data?.error ?? text.slice(0, 400)
      const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
      error.status = response.status
      error.retryAfter = response.headers.get('retry-after')
      throw error
    }
    return data
  }

  /* ---- model catalog ------------------------------------------------
   * `GET /videos/models` works WITHOUT authentication (verified live), so the
   * model picker and the parameter panel are populated even before a key is
   * configured.
   */
  const catalog = { loaded: false, at: 0, models: [], byId: {}, error: null }

  async function refreshCatalog(force = false) {
    if (catalog.loaded && !force && Date.now() - catalog.at < 10 * 60_000) return catalog
    const url = resolveApiUrl('/videos/models')
    try {
      const { fetch: doFetch, dispatcher } = await getPool()
      const response = await doFetch(url, {
        signal: AbortSignal.timeout(60_000),
        ...(dispatcher === undefined ? {} : { dispatcher }),
      })
      if (!response.ok) throw new Error(`模型目录返回 ${response.status}`)
      // A wrong path on this host answers 200 with an HTML page, so `ok` alone is
      // not evidence of a usable response. Requiring JSON turns that trap into a
      // message that names the URL it actually asked for.
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!type.includes('json')) {
        throw new Error(`${url.href} 返回的不是 JSON（${type || '无 content-type'}，HTTP ${response.status}）—— 请求打到了错误端点`)
      }
      const data = await response.json()
      const models = Array.isArray(data?.data) ? data.data : []
      catalog.models = models
      catalog.byId = Object.fromEntries(models.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]))
      catalog.loaded = true
      catalog.at = Date.now()
      catalog.error = null
    } catch (error) {
      catalog.loaded = false
      catalog.error = `${errorMessage(error)}（${url.href}）`
    }
    return catalog
  }

  /* ---- per-node request building ------------------------------------ */

  /**
   * Translate a graph node into the POST /videos body.
   *
   * The rules the plan singles out (§1):
   *   - `frame_images` and `input_references` are MUTUALLY EXCLUSIVE, and not as a
   *     precedence: the provider refuses the combination (measured 400), so a shot
   *     that has both is sent WITH THE FRAMES AND WITHOUT THE REFERENCES
   *   - `previous_job_id` is passed back EXACTLY as stored — never parsed, never
   *     reformatted (trap #5)
   */
  function buildNodeRequest(graph, node, jobMap) {
    const model = resolveModel(graph, node)
    const body = { model }

    /*
     * The character bible goes in the PROMPT, not only in a reference image.
     *
     * The cat changed appearance in every shot of a 12-shot film even though the
     * model, the style prompt and the chaining were all constant — because each
     * shot's prompt was written in its own breath and re-described the cat
     * slightly differently. A model cannot hold an identity the prompt keeps
     * redefining, so the fixed description is repeated verbatim on every request.
     *
     * Scoped to the settings WIRED INTO THIS SHOT — its characters and its
     * scene — not to the whole graph. Different shots have different characters
     * in them; a graph-wide fan-out would pin a mouse onto a shot the mouse is
     * not in. The wiring IS the switch — a shot with nothing wired in gets an
     * empty list here, so there is no second per-node boolean to fall out of
     * sync with the wires. `applyCast` is idempotent per block, so a resumed run
     * does not stack a second copy onto the first and inflate a token-priced
     * bill with every retry.
     */
    const cast = bibleFor(graph, node.id)
    const prompt = applyCast(node.fields?.prompt, cast)
    if (typeof prompt === 'string' && prompt.trim().length > 0) body.prompt = prompt.trim()

    const duration = resolveDuration(graph, node)
    if (Number.isInteger(duration) && duration > 0) body.duration = duration

    const resolution = resolveResolution(graph, node)
    if (typeof resolution === 'string' && resolution.length > 0) body.resolution = resolution

    const aspect = resolveAspect(graph, node)
    if (typeof aspect === 'string' && aspect.length > 0) body.aspect_ratio = aspect

    // Only send `generate_audio` to a model whose own catalog entry accepts it.
    // The catalog is the model's declaration of what it takes, and sending a
    // parameter it marks unsupported is at best ignored and at worst a 400 that
    // burns a submission round. `heygen/heygen-video-1` declares
    // `generate_audio: false` while still rendering audio on its own.
    // An unloaded catalog (entry === null) keeps the previous behaviour rather
    // than silently changing the request shape.
    const entry = catalog.byId[model] ?? null
    const wantsAudio = typeof node.fields?.generateAudio === 'boolean'
      ? node.fields.generateAudio
      : graph.project.generateAudio === true
    if (entry === null || entry.generate_audio !== false) body.generate_audio = wantsAudio

    const seed = resolveSeed(graph, node)
    if (Number.isInteger(seed)) body.seed = seed

    // structured passthrough for the editing legs
    if (node.type === 'upscale') {
      if (Number.isFinite(Number(node.fields?.upscaleFactor))) body.upscale_factor = Number(node.fields.upscaleFactor)
      if (node.fields?.creativity !== undefined) body.creativity = Number(node.fields.creativity)
    }

    // Inputs arrive as edges. Resolve each into the field it feeds.
    const frames = []
    const references = []
    let previousJobId = null

    for (const edge of graph.edges) {
      if (edge.to !== node.id) continue
      const upstream = findNode(graph, edge.from)
      if (upstream === null) continue
      const upstreamJob = jobMap.get(edge.from) ?? null
      const assetUrl = assetUrlFor(graph, upstream, upstreamJob)

      if (edge.toPort === 'frames' && assetUrl !== null) {
        // Which SLOT the image fills is a property of the source node, because
        // the API takes it per image. Reading it off the consumer (as
        // `node.fields.frameType`) meant reading a field no node type declares,
        // so every wired frame became a first frame and `first_last` was not
        // expressible from the canvas at all.
        const frameType = frameSlotOf(upstream)
        const already = frames.some((f) => f.image_url.url === assetUrl && f.frame_type === frameType)
        if (!already) frames.push({ type: 'image_url', image_url: { url: assetUrl }, frame_type: frameType })
      } else if (edge.toPort === 'refs' && assetUrl !== null) {
        references.push({ type: 'image_url', image_url: { url: assetUrl } })
      } else if (edge.toPort === 'video' && assetUrl !== null) {
        references.push({ type: 'video_url', video_url: { url: assetUrl } })
      } else if (edge.toPort === 'job' && upstreamJob !== null) {
        previousJobId = upstreamJob.id
      }
    }

    /* `link: 'continue'` means "this shot carries on from the previous shot".
     *
     * The sequence view has always shown that column, badged it 续接 #N, and
     * counted hard seams from it — but the value never reached the request:
     * `previous_job_id` was only ever derived from an incoming `job` edge, and a
     * `generate` node has no `job` port. So the control was decorative, every
     * "joined" shot was in fact an independent take, and the film had hard cuts
     * nobody asked for while the UI reported otherwise.
     *
     * Explicit wiring still wins: a real `job` edge is a stronger statement than
     * an editorial flag, so this only fills the gap when nothing was wired.
     */
    if (previousJobId === null && (node.link === 'continue' || node.link === 'edit')) {
      const ordered = shots(graph)
      const position = ordered.findIndex((shot) => shot.id === node.id)
      // Walk back to the nearest EARLIER shot that actually produced a job. A
      // skipped or failed predecessor cannot be continued from — the API takes a
      // completed job id and nothing else — so fall through to an independent
      // take rather than sending a reference that would be rejected.
      for (let i = position - 1; i >= 0; i -= 1) {
        const candidate = jobMap.get(ordered[i].id) ?? null
        if (candidate !== null && candidate.status === 'completed' && typeof candidate.id === 'string') {
          previousJobId = candidate.id
          break
        }
      }
    }

    // A `take` node's frame is resolved through the same `assetFor` path as
    // everything else (the materialiser writes `job.frameUrl` onto the take
    // node's own ledger record), so there is no second pass to run here. There
    // used to be one, and it was dead: it re-pushed what the loop above had
    // already pushed and deduped against it.

    // A wired `cast` node reaches `input_references` through the edge loop above,
    // exactly like a `ref` node — one mechanism, not two. There used to be a
    // second, graph-wide injection here that added every character in the graph
    // to every shot; it is gone because it put characters into scenes they were
    // not in, and because two paths to the same field is how they drift.

    /*
     * `frame_images` and `input_references` are MUTUALLY EXCLUSIVE in practice,
     * and not in the way this workspace documented.
     *
     * The plan said "frame_images takes precedence over input_references — both
     * given, the request is treated as image-to-video", and the canvas warned
     * accordingly. Measured against `heygen/heygen-video-1`: a request carrying
     * both is REFUSED outright —
     *
     *   "HeyGen Video 1 image-to-video does not accept input_references
     *    alongside a first_frame image; pass the image as an input_reference
     *    instead to use reference-to-video"
     *
     * So the combination is not a soft precedence the provider resolves, it is a
     * 400. A chained shot that also had a character or scene wired lost the whole
     * render — the film came out a shot short and cost a submission round. (The
     * first frame wins, because a `frames` wire is an explicit instruction about
     * continuity and the shot cannot be rendered at all otherwise.)
     *
     * The drop is announced by `validate` and by the run receipt, both derived
     * from the graph rather than from a value threaded back out of here — the
     * request builder is required to produce a request, and nothing else.
     */
    if (frames.length > 0) body.frame_images = frames
    else if (references.length > 0) body.input_references = references
    if (previousJobId !== null) body.previous_job_id = previousJobId

    return body
  }

  /** The URL a node contributes downstream, or null. */
  function assetFor(graph, node, job) {
    if (node.type === 'ref' || node.type === 'cast' || node.type === 'scene') {
      const source = node.fields?.source
      return typeof source === 'string' && source.length > 0 ? source : null
    }
    if (node.type === 'take') {
      // A frame taken from a completed job. The plan's §7 decision: we do NOT
      // assume OpenRouter will materialise its own bearer-guarded /content URL
      // for a provider to fetch, so this only works when the job exposes a
      // plain URL, and otherwise the node reports why it cannot run.
      const url = job?.frameUrl ?? null
      return typeof url === 'string' && url.length > 0 ? url : null
    }
    if (job === null) return null
    const urls = Array.isArray(job.unsigned_urls) ? job.unsigned_urls : []
    return typeof urls[0] === 'string' ? urls[0] : null
  }

  const assetUrlFor = (graph, node, job) => assetFor(graph, node, job)

  /* ---- the real network operations the executor is handed ---- */

  async function submitJob(node, request) {
    const data = await callApi('/videos', { method: 'POST', body: request })
    if (data === null || typeof data.id !== 'string' || data.id.length === 0) {
      throw new Error('提交成功但响应里没有 id；无法跟踪这个任务')
    }
    return { id: data.id, status: typeof data.status === 'string' ? data.status : 'pending' }
  }

  async function pollJob(record) {
    const path = typeof record.polling_url === 'string' && record.polling_url.length > 0
      ? record.polling_url
      : `/videos/${encodeURIComponent(record.id)}`
    return callApi(path, { method: 'GET' })
  }

  async function downloadJob(record, cwd) {
    const urls = Array.isArray(record.unsigned_urls) ? record.unsigned_urls : []
    const first = urls.find((url) => typeof url === 'string' && url.length > 0)
      ?? `/videos/${encodeURIComponent(record.id)}/content?index=0`

    const { fetch: doFetch, dispatcher } = await getPool()
    // Only attach the key when the URL is OpenRouter's own. A third-party host
    // in `unsigned_urls` must not receive the user's credential (trap #7).
    const headers = isOpenRouterUrl(first) || first.startsWith('/')
      ? { Authorization: `Bearer ${effectiveKey()}` }
      : undefined
    const response = await doFetch(resolveApiUrl(first), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`下载失败 ${response.status}：${detail.slice(0, 200)}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_INLINE_BYTES) {
      throw new Error(`产物过大（${(buffer.byteLength / 1048576).toFixed(0)} MB），拒绝一次性读入内存`)
    }

    // Read the extension from the ACTUAL content type: seedance-2.5 exposes an
    // `output_format` passthrough, so a `.mp4` suffix is not safe to assume.
    const mediaType = (response.headers.get('content-type') ?? 'video/mp4').split(';')[0].trim()
    const extension = EXT_FOR_MEDIA[mediaType] ?? (mediaType.startsWith('video/') ? '.mp4' : '.bin')

    const { absolute, relative: relDir } = resolveSaveDir(readConfig().saveDir, cwd)
    await mkdir(absolute, { recursive: true })
    const shot = record.shotIndex ?? null
    const prefix = shot === null ? 'clip' : `s${String(shot).padStart(2, '0')}`
    const name = `${prefix}_${fileStem(record.nodeId, 'take')}_${stamp()}${extension}`
    const target = join(absolute, name)
    await writeFile(target, buffer)

    return {
      filePath: target,
      filePathRelative: join(relDir, name),
      mediaType,
      bytes: buffer.byteLength,
    }
  }

  /* ---- frame hand-off: the only working continuity mechanism ------ */

  /**
   * Give every `take` node fed by `upstream` a public frame URL.
   *
   * The executor calls this the moment a network node finishes downloading —
   * BEFORE it reports COMPLETED — so by the time the consumer of a `take` is
   * dispatched the frame URL is already on the ledger.
   *
   * That ordering is necessary but NOT sufficient, and believing otherwise cost
   * this feature its entire effect on a real film: publishing before COMPLETED
   * only helps if something actually WAITS for COMPLETED. `readyNodes` treats a
   * non-network dependency as instantly satisfied, so a `take` sitting between
   * two shots was transparent and the pair was dispatched concurrently — every
   * downstream shot began before its upstream frame existed and silently became
   * an independent take. `readyNodes` now walks through local nodes, so a `take`
   * is a real gate. Both halves are required; neither alone chains anything.
   *
   * `jobMap` is the executor's nodeId → ledger map. It is a parameter, not a
   * closure over `startRun`'s local, because that is precisely how this function
   * was broken: it referenced an out-of-scope `jobMap`, threw
   * "jobMap is not defined" on every single call, and `publishFrames` recorded
   * that as a per-take error nobody printed. The run reported「完成 12，失败 0」
   * while chaining did nothing at all.
   *
   * Idempotent per take node: an existing `frameUrl` short-circuits, so a
   * resumed run re-uploads nothing.
   *
   * @returns {Promise<object[]>} one row per take node, for the run receipt
   */
  async function materializeFrames(graph, upstream, upstreamJob, settings, cwd, jobMap) {
    const takes = graph.edges
      .filter((edge) => edge.from === upstream.id && edge.toPort === 'job')
      .map((edge) => findNode(graph, edge.to))
      .filter((node) => node !== null && node.type === 'take')
    if (takes.length === 0) return []

    const videoPath = typeof upstreamJob?.filePath === 'string' && upstreamJob.filePath.length > 0
      ? upstreamJob.filePath
      : null
    const { absolute: saveRoot } = resolveSaveDir(settings.saveDir, cwd)
    const results = []

    for (const take of takes) {
      const existing = jobMap.get(take.id)
      if (existing !== null && existing !== undefined
        && typeof existing.frameUrl === 'string' && existing.frameUrl.length > 0) {
        results.push({ nodeId: take.id, frameUrl: existing.frameUrl, cached: true })
        continue
      }
      if (videoPath === null) {
        results.push({ nodeId: take.id, error: '上游没有下载到本地文件，无法抽帧' })
        continue
      }
      if (settings.imageBedUrl.length === 0) {
        results.push({
          nodeId: take.id,
          error: '没有配置图床地址（imageBedUrl）；抽出来的帧没有公开 URL，provider 取不到，'
            + '这一镜会退化成独立生成',
        })
        continue
      }

      const which = take.fields?.frame === 'last_frame' ? 'last_frame' : 'first_frame'
      const outPath = join(saveRoot, 'frames', `${fileStem(take.id, 'frame')}_${which}_${stamp()}.png`)
      const cut = await cutAndPublish({
        videoPath,
        which,
        outPath,
        fileName: basename(outPath),
        config: settings,
      })
      if (!cut.ok) {
        results.push({ nodeId: take.id, error: cut.error, framePath: cut.filePath ?? null })
        continue
      }

      const record = {
        // A fresh id per capture, so re-taking a frame appends to the ledger
        // rather than overwriting the history of what was chained when.
        id: `frame:${take.id}:${Date.now().toString(36)}`,
        nodeId: take.id,
        graphId: graph.id,
        model: null,
        status: 'completed',
        cost: 0,
        frameUrl: cut.url,
        framePath: cut.filePath,
        frameSlot: frameSlotOf(take),
        sourceJobId: typeof upstreamJob?.id === 'string' ? upstreamJob.id : null,
        submittedAt: Date.now(),
        error: null,
      }
      jobMap.set(take.id, record)
      await jobStore.upsert(record)
      results.push({ nodeId: take.id, frameUrl: cut.url, framePath: cut.filePath, slot: record.frameSlot })
    }
    return results
  }

  /* ---- 成片序列: cut the film the graph has been promising ------ */

  /**
   * Compose a `seq` node's film from the shots that actually finished.
   *
   * The executor calls this once per `seq` node after the scheduler has drained.
   * `seq` is a LOCAL node — free, no network — so nothing else would ever run it.
   *
   * A SHOT THAT FAILED DOES NOT BLOCK THE EXPORT. Refusing to cut anything until
   * every shot is perfect means one guardrail-blocked shot costs you the other
   * eleven, which is the opposite of useful when each shot is a separate paid
   * render. Instead the film is cut from what exists and the missing shots are
   * NAMED in the receipt — silence about a short film would be the real bug.
   *
   * Idempotent: a film already on the ledger is not re-cut on every resume. The
   * file has to still exist on disk for that short-circuit to hold, so deleting
   * the mp4 makes the next run rebuild it.
   */
  async function materializeSequence(graph, seqNode, jobMap, settings, cwd) {
    /*
     * Film order is `shotIndex`, NOT topology — the same invariant the sequence
     * view is built on. `orderClips` also decides which shots are missing, and a
     * missing shot is NAMED rather than allowed to kill the export.
     *
     * The clip list is computed BEFORE the cache check, because "is a film on the
     * ledger" is not the question. "Is it built from exactly these clips" is.
     */
    const rows = [...upstreamOf(graph, [seqNode.id])]
      .map((id) => ({ id, node: findNode(graph, id), job: jobMap.get(id) ?? null }))
    const { clips, missing, expected } = orderClips(rows, SHOT_TYPES)

    if (clips.length === 0) {
      return { nodeId: seqNode.id, error: expected === 0 ? '这个成片节点上游没有任何镜头' : '没有任何已完成的镜头可以拼接' }
    }

    const clipKeys = clips.map((clip) => `${clip.nodeId}:${basename(clip.filePath)}`)

    const existing = jobMap.get(seqNode.id)
    if (existing !== null && existing !== undefined && existing.status === 'completed'
      && typeof existing.filePath === 'string' && existing.filePath.length > 0) {
      /*
       * Idempotent — but NOT by "the ledger says completed".
       *
       * An INCOMPLETE film used to be cached exactly like a complete one. So the
       * moment a failed shot was fixed and re-run, the composer found the short
       * film on the ledger and skipped: the receipt said 完成 while the exported
       * file was still a shot short, and re-running could never fix it. The only
       * escape was deleting the mp4 by hand — which is not something a user can be
       * expected to discover, and it shipped a 26.3s "30s" film.
       *
       * The cache now holds only while the clip set is unchanged. That single rule
       * covers both directions: a permanently broken shot does not spray a new
       * file on every resume, and finishing it (or re-rendering any shot into a
       * new take) DOES rebuild the film.
       *
       * `sequence.clips` is absent on records written before this rule, so those
       * re-cut once and are then stable — local ffmpeg, no money.
       */
      const sameSet = sequenceIsCurrent(existing, clipKeys)
      if (sameSet) {
        try {
          const info = await stat(existing.filePath)
          return {
            nodeId: seqNode.id,
            cached: true,
            filePath: existing.filePath,
            filePathRelative: existing.filePathRelative ?? null,
            bytes: info.size,
            durationSec: existing.sequence?.durationSec ?? null,
            count: existing.sequence?.count ?? null,
            expected: existing.sequence?.expected ?? null,
            missing: existing.sequence?.missing ?? [],
            manifestPath: existing.sequence?.manifestPath ?? null,
          }
        } catch { /* the film was deleted — fall through and cut it again */ }
      }
    }

    const { absolute: saveRoot, relative: relDir } = resolveSaveDir(settings.saveDir, cwd)
    const stem = fileStem(graph.title, 'sequence')
    const at = stamp()
    const outPath = join(saveRoot, `${stem}-${at}.mp4`)
    const manifestPath = join(saveRoot, `${stem}-${at}-manifest.json`)

    const result = await composeSequence({
      clips,
      outPath,
      manifestPath,
      workDir: join(saveRoot, '.sequence-work'),
      ffmpegPath: settings.ffmpegPath,
      ffprobePath: ffprobeFrom(settings.ffmpegPath),
      title: graph.title,
    })
    if (result.ok !== true) return { nodeId: seqNode.id, error: result.error, missing }

    const record = {
      // A fresh id per cut, so re-cutting after a re-render appends to the ledger
      // instead of overwriting the record of the film that was already delivered.
      id: `seq:${seqNode.id}:${Date.now().toString(36)}`,
      nodeId: seqNode.id,
      graphId: graph.id,
      model: null,
      status: 'completed',
      cost: 0,
      filePath: result.filePath,
      filePathRelative: join(relDir, basename(result.filePath)),
      mediaType: 'video/mp4',
      sequence: {
        count: clips.length,
        expected,
        missing,
        complete: missing.length === 0,
        /* WHICH clips this cut was made from. The cache check compares against
           this, because "the ledger says completed" is not the same claim as
           "this film contains the shots that exist now". */
        clips: clipKeys,
        durationSec: result.durationSec,
        mode: result.mode,
        bytes: result.bytes,
        manifestPath: result.manifestPath,
      },
      submittedAt: Date.now(),
      error: null,
    }
    jobMap.set(seqNode.id, record)
    await jobStore.upsert(record)

    return {
      nodeId: seqNode.id,
      filePath: result.filePath,
      filePathRelative: record.filePathRelative,
      bytes: result.bytes,
      durationSec: result.durationSec,
      mode: result.mode,
      count: clips.length,
      expected,
      missing,
      manifestPath: result.manifestPath,
      warning: result.warning ?? null,
    }
  }

  /* ---- running a graph --------------------------------------------- */

  function stateOf(graphId) {
    const run = runs.get(graphId)
    return run ?? null
  }

  async function startRun(graph, options = {}) {
    const settings = readConfig()
    const jobMap = jobStore.byNode(graph.id)

    // Resume: seed state from the ledger so nothing already paid for is re-run.
    const existing = runs.get(graph.id)
    const states = options.fresh === true || existing === undefined
      ? rehydrate(graph, jobMap)
      : existing.states
    const control = existing?.control ?? { aborted: false }
    control.aborted = false

    if (options.fresh === true) {
      // An explicit fresh run clears terminal states but KEEPS completed jobs,
      // because re-running a completed shot is a spending decision, not a reset.
      for (const node of graph.nodes) {
        if (!isNetworkNode(node)) continue
        if (states.get(node.id) === NODE_STATE.FAILED) states.set(node.id, NODE_STATE.IDLE)
      }
    }

    const run = { states, control, startedAt: Date.now(), report: null, running: true }
    runs.set(graph.id, run)
    graph.run = { ...graph.run, state: 'running', startedAt: run.startedAt }
    await graphStore.put(graph)

    const cwd = options.cwd ?? process.cwd()
    const record = { nodeId: null, shotIndex: null }

    // The ceiling is computed per node here and handed in, so the executor never
    // needs to know about pricing — and so the budget gate can be tested with a
    // trivial `ceilingOf`.
    const ceilings = new Map()
    for (const node of graph.nodes) {
      if (!isNetworkNode(node)) continue
      const model = catalog.byId[resolveModel(graph, node)] ?? { id: resolveModel(graph, node), pricing_skus: null }
      const entry = nodeCeiling({
        model,
        seconds: resolveDuration(graph, node),
        kind: pricingKind(node),
      })
      ceilings.set(node.id, entry.usd)
    }

    const only = Array.isArray(options.only) && options.only.length > 0
      ? expandSubset(graph, options.only)
      : null

    try {
      const report = await runGraph({
        graph,
        states,
        jobs: jobMap,
        submit: async (node, request) => submitJob(node, request),
        poll: async (job) => pollJob(job),
        download: async (job) => downloadJob({ ...job, shotIndex: findNode(graph, job.nodeId)?.shotIndex ?? null }, cwd),
        buildRequest: (node) => buildNodeRequest(graph, node, jobMap),
        materializeFrames: (node, jobRecord) => materializeFrames(graph, node, jobRecord, settings, cwd, jobMap),
        materializeSequence: (node) => materializeSequence(graph, node, jobMap, settings, cwd),
        ceilingOf: (id) => ceilings.get(id) ?? null,
        budgetUsd: settings.budgetUsd,
        abortOnExceed: settings.abortOnExceed,
        retryFailed: options.fresh === true,
        concurrency: settings.concurrency,
        pollIntervalMs: settings.pollIntervalMs,
        maxPollAttempts: settings.maxPollAttempts,
        only,
        control,
        onState: (id, state, detail) => {
          const existingJob = jobMap.get(id)
          if (existingJob !== undefined && existingJob !== null) {
            // Write a COPY, never the record in place.
            //
            // `jobMap.get(id)` can be the very object the executor is holding as
            // its working record, so mutating `.status` here rewrites a value
            // the executor is about to branch on. That aliasing turned "the poll
            // saw completed" into an endless re-dispatch loop that polled the
            // same job 244 times and never finished. The executor no longer
            // trusts the object either, but a callback that silently rewrites
            // its caller's data is a bug wherever it is read.
            const next = {
              ...existingJob,
              status: state === NODE_STATE.COMPLETED ? 'completed'
                : state === NODE_STATE.FAILED ? 'failed'
                : state === NODE_STATE.IN_PROGRESS ? 'in_progress'
                : existingJob.status,
            }
            if (detail?.cost !== undefined) next.cost = detail.cost
            jobMap.set(id, next)
            void jobStore.upsert(next)
          }
        },
      })
      run.report = report
      run.running = false
      graph.run = { ...graph.run, state: report.aborted ? 'aborted' : (report.paused ? 'paused' : 'done'), lastRunAt: Date.now() }
      await graphStore.put(graph)
      return { report, states }
    } catch (error) {
      run.running = false
      run.error = errorMessage(error)
      graph.run = { ...graph.run, state: 'error', lastRunAt: Date.now() }
      await graphStore.put(graph)
      throw error
    }
  }

  /** Re-attach polling for every graph that had work in flight when we booted. */
  async function resumeInFlight() {
    const pending = jobStore.inFlight()
    if (pending.length === 0) return
    const byGraph = new Map()
    for (const job of pending) {
      if (typeof job.graphId !== 'string') continue
      const list = byGraph.get(job.graphId) ?? []
      list.push(job)
      byGraph.set(job.graphId, list)
    }
    for (const [graphId] of byGraph) {
      const graph = graphStore.get(graphId)
      if (graph === null) continue
      const normalized = normalizeGraph(graph)
      try {
        await startRun(normalized, { cwd: process.cwd() })
      } catch (error) {
        console.warn(`[openrouter-video] cannot resume graph ${graphId}: ${errorMessage(error)}`)
      }
    }
  }

  /* ================================================================== *
   * agent tools
   * ================================================================== */

  const AGENT_MONEY_RULE =
    '每次调用都会用用户自己的 OpenRouter 额度真实计费，提示词与素材会离开本机发往 OpenRouter。'
    + '**长视频 = N 条短镜头拼起来，费用是 N 倍**：一条 8 秒镜头约 $0.16–$3.20（取决于模型），'
    + '三分钟成片约 23 条。所以先预检、看成本上界，再决定要不要真跑。'

  const singleTool = defineTool({
    name: 'openrouter_generate_video',
    description:
      '通过 OpenRouter Video API 生成或编辑**一条**视频（POST /api/v1/videos）。'
      + '文生视频、首帧/首尾帧图生视频、参考图引导、源视频编辑、续接延长、超分都走这里。\n\n'
      + AGENT_MONEY_RULE + '\n\n'
      + '**要长视频请用 `openrouter_video_plan` 建图**，不要在这里循环调用 —— 图才有续跑、成本闸门和衔接管理。\n\n'
      + '本工具会阻塞等待到出片（视频通常 30 秒到数分钟）。超时不会伪装成失败：回执会说明任务仍在服务端运行并给出 job id。',
    parameters: {
      prompt: { type: 'string', description: '视频内容描述。写镜头语言：景别、运镜、光线、时长内能讲多少事。' },
      mode: {
        type: 'string',
        enum: ['text', 'first_frame', 'first_last', 'reference', 'edit', 'extend', 'upscale'],
        description: '生成模式。默认 text。选 edit/extend/upscale 时必须配 model 与相应输入。',
      },
      model: { type: 'string', description: '模型 id。留空用工作台默认。必须支持所选 mode，越界会在本地被拒。' },
      duration: { type: 'number', description: '时长（秒）。必须在该模型的 supported_durations 内，否则本地拒绝并列出支持值。' },
      resolution: { type: 'string', description: '分辨率。必须在该模型的 supported_resolutions 内。' },
      aspect_ratio: { type: 'string', description: '画幅比。必须在该模型的 supported_aspect_ratios 内。' },
      first_frame_url: { type: 'string', description: '首帧图 https URL（mode=first_frame / first_last）。' },
      last_frame_url: { type: 'string', description: '尾帧图 https URL（mode=first_last）。' },
      reference_images: { type: 'array', items: { type: 'string' }, description: '参考图 https URL 列表。' },
      source_video_url: { type: 'string', description: '源视频 https URL（mode=edit）。' },
      previous_job_id: { type: 'string', description: '要续接的已完成任务 id（mode=extend）。必须是本插件记录过的任务，**原样回传，不要改写格式**。' },
      upscale_factor: { type: 'number', description: '放大倍数 1.5–3（mode=upscale）。' },
      creativity: { type: 'number', enum: [0, 1], description: '超分创意度 0 或 1（mode=upscale）。' },
      generate_audio: { type: 'boolean', description: '是否生成音频。留空用工作台默认。' },
      seed: { type: 'number', description: '固定种子。用户点名了才填。' },
      save_dir: { type: 'string', description: '保存目录，**相对会话工作目录**。越界报错而不是改写。' },
      wait: { type: 'boolean', description: '是否阻塞等待出片。默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          jobId: { type: 'string' },
          status: { type: 'string' },
          model: { type: 'string' },
          cost: { type: 'number' },
          filePath: { type: 'string' },
          filePathRelative: { type: 'string' },
          elapsedMs: { type: 'number' },
          ceilingUsd: { type: 'number' },
          unknownCeiling: { type: 'boolean' },
        },
      },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `视频生成失败：${value?.error ?? '未知错误'}` }]
        const parts = [`已完成一条视频（模型 ${value.model}`]
        if (value.status !== 'completed') parts.push(`，状态 ${value.status}`)
        if (typeof value.elapsedMs === 'number') parts.push(`，耗时 ${Math.round(value.elapsedMs / 1000)} 秒`)
        if (typeof value.cost === 'number') parts.push(`，费用 $${value.cost.toFixed(4)}`)
        parts.push('）。')
        if (typeof value.filePath === 'string') parts.push(`\n文件：${value.filePath}`)
        // The relative path is the string that goes INTO the artefact.
        if (typeof value.filePathRelative === 'string') parts.push(`\n相对会话目录：${value.filePathRelative}`)
        if (typeof value.jobId === 'string') parts.push(`\njob id：${value.jobId}`)
        if (value.status !== 'completed' && typeof value.jobId === 'string') {
          parts.push('\n注意：任务仍在服务端运行并继续计费；Video API 没有取消端点，无法中止。')
        }
        return [{ type: 'text', text: parts.join('') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const settings = readConfig()
      const cwd = exec?.agent?.session?.header?.cwd
      const mode = typeof args?.mode === 'string' ? args.mode : 'text'

      try {
        await refreshCatalog(false)
        const modelId = typeof args?.model === 'string' && args.model.length > 0 ? args.model : settings.model
        const entry = catalog.byId[modelId] ?? null
        if (catalog.loaded && entry === null) throw new Error(`模型不在线上目录里：${modelId}`)

        const duration = positiveInt(args?.duration) ?? settings.duration
        const resolution = typeof args?.resolution === 'string' && args.resolution.length > 0 ? args.resolution : settings.resolution
        const aspect = typeof args?.aspect_ratio === 'string' && args.aspect_ratio.length > 0 ? args.aspect_ratio : settings.aspectRatio

        // Local validation BEFORE spending: the plan's most expensive lesson.
        if (entry !== null) {
          if (Array.isArray(entry.supported_durations) && entry.supported_durations.length > 0
              && !entry.supported_durations.includes(duration)) {
            throw new Error(`${modelId} 不支持 ${duration}s；支持：${entry.supported_durations.join(', ')}`)
          }
          if (Array.isArray(entry.supported_resolutions) && entry.supported_resolutions.length > 0
              && !entry.supported_resolutions.includes(resolution)) {
            throw new Error(`${modelId} 不支持 ${resolution}；支持：${entry.supported_resolutions.join(', ')}`)
          }
          if (Array.isArray(entry.supported_aspect_ratios) && entry.supported_aspect_ratios.length > 0
              && !entry.supported_aspect_ratios.includes(aspect)) {
            throw new Error(`${modelId} 不支持画幅 ${aspect}；支持：${entry.supported_aspect_ratios.join(', ')}`)
          }
          if ((mode === 'first_frame' || mode === 'first_last') && entry.supported_frame_images === null) {
            throw new Error(`${modelId} 不支持图生视频（supported_frame_images 为空）`)
          }
          if (mode === 'upscale' && (entry.upscale_factor === null || entry.upscale_factor === undefined)) {
            throw new Error(`${modelId} 不是超分模型`)
          }
        }

        const body = { model: modelId, duration, resolution, aspect_ratio: aspect }
        if (typeof args?.prompt === 'string' && args.prompt.trim().length > 0) body.prompt = args.prompt.trim()
        if (typeof args?.generate_audio === 'boolean') body.generate_audio = args.generate_audio
        else body.generate_audio = settings.generateAudio
        if (Number.isInteger(Number(args?.seed))) body.seed = Number(args.seed)

        const frames = []
        if (typeof args?.first_frame_url === 'string' && args.first_frame_url.length > 0) {
          frames.push({ type: 'image_url', image_url: { url: args.first_frame_url }, frame_type: 'first_frame' })
        }
        if (typeof args?.last_frame_url === 'string' && args.last_frame_url.length > 0) {
          frames.push({ type: 'image_url', image_url: { url: args.last_frame_url }, frame_type: 'last_frame' })
        }
        if (frames.length > 0) body.frame_images = frames

        const refs = []
        for (const url of Array.isArray(args?.reference_images) ? args.reference_images : []) {
          if (typeof url === 'string' && url.length > 0) refs.push({ type: 'image_url', image_url: { url } })
        }
        if (typeof args?.source_video_url === 'string' && args.source_video_url.length > 0) {
          refs.push({ type: 'video_url', video_url: { url: args.source_video_url } })
        }
        if (refs.length > 0) body.input_references = refs

        if (typeof args?.previous_job_id === 'string' && args.previous_job_id.length > 0) {
          // Only accept an id we actually recorded and saw complete. Never
          // validate the FORMAT — the documented prefix matches no real id.
          await jobStore.load()
          const known = jobStore.find(args.previous_job_id)
          if (known === null) {
            throw new Error(`previous_job_id 不在本机任务账本里：${args.previous_job_id}。续接只能用本插件记录过的任务 id。`)
          }
          if (known.status !== 'completed') {
            throw new Error(`previous_job_id 对应的任务还不是 completed（当前 ${known.status}）`)
          }
          body.previous_job_id = known.id
        }

        if (mode === 'upscale') {
          if (Number.isFinite(Number(args?.upscale_factor))) body.upscale_factor = Number(args.upscale_factor)
          if (args?.creativity !== undefined) body.creativity = Number(args.creativity)
        }

        const ceiling = nodeCeiling({
          model: entry ?? { id: modelId, pricing_skus: null },
          seconds: duration,
          kind: mode === 'extend' ? 'continuation' : 'plain',
        })
        if (settings.abortOnExceed && ceiling.usd !== null && ceiling.usd > settings.budgetUsd) {
          throw new Error(`成本上界 $${ceiling.usd.toFixed(2)} 超过预算 $${settings.budgetUsd.toFixed(2)}；已拒绝提交，未发出任何请求`)
        }

        const submitStarted = Date.now()
        const submitted = await submitJob(null, body)
        const now = Date.now()
        // Persist AT SUBMIT TIME. A user who closes DSH during the wait must
        // still find this job on the next boot.
        await jobStore.upsert({
          id: submitted.id,
          nodeId: null,
          graphId: null,
          model: modelId,
          mode,
          status: submitted.status,
          submittedAt: now,
          cost: null,
          filePath: null,
          error: null,
        })

        const shouldWait = args?.wait !== false
        if (!shouldWait) {
          return defined({
            ok: true, jobId: submitted.id, status: submitted.status, model: modelId,
            ceilingUsd: ceiling.usd ?? undefined, unknownCeiling: ceiling.usd === null,
            elapsedMs: Date.now() - started,
          })
        }

        let record = { id: submitted.id, status: submitted.status, polling_url: null, unsigned_urls: null }
        let attempts = 0
        while (!isTerminal(record.status) && attempts < settings.maxPollAttempts) {
          await new Promise((resolve) => setTimeout(resolve, settings.pollIntervalMs))
          attempts += 1
          const fresh = await pollJob(record)
          record = { ...record, ...fresh }
          const stored = jobStore.find(record.id)
          if (stored !== null) {
            await jobStore.upsert({
              ...stored,
              status: record.status,
              cost: typeof record.usage?.cost === 'number' ? record.usage.cost : stored.cost,
              error: typeof record.error === 'string' ? record.error : null,
              unsigned_urls: record.unsigned_urls ?? stored.unsigned_urls,
            })
          }
          if (TERMINAL_FAIL.has(record.status)) {
            return { ok: false, error: record.error ?? record.status, jobId: record.id, status: record.status, model: modelId }
          }
        }

        if (record.status !== 'completed') {
          // Never dress a timeout up as a failure: the job is still running and
          // still billing.
          return {
            ok: false,
            error: `轮询超时（${attempts} 次）。任务仍在服务端运行并继续计费，无法取消。job id ${submitted.id}`,
            jobId: submitted.id, status: record.status, model: modelId,
            elapsedMs: Date.now() - started,
          }
        }

        const saved = await downloadJob({
          ...record,
          nodeId: fileStem(args?.file_name, 'clip'),
          shotIndex: null,
        }, cwd)
        const stored = jobStore.find(record.id)
        if (stored !== null) {
          await jobStore.upsert({ ...stored, status: 'completed', cost: record.usage?.cost ?? stored.cost, ...saved })
        }

        return defined({
          ok: true,
          jobId: submitted.id,
          status: 'completed',
          model: modelId,
          cost: typeof record.usage?.cost === 'number' ? record.usage.cost : undefined,
          filePath: saved.filePath,
          filePathRelative: saved.filePathRelative,
          elapsedMs: Date.now() - started,
          submitMs: now - submitStarted,
          ceilingUsd: ceiling.usd ?? undefined,
        })
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })

  const graphTool = defineTool({
    name: 'openrouter_video_graph',
    description:
      '读写长视频的**图文档**（graph.json）。图是唯一真相源：节点 + 连线，'
      + '一个节点 = 一次生成/编辑，一条边 = 产物怎么流向下游。'
      + '长视频 = 二十几个镜头节点 + 参考素材扇出 + 编辑链，用图才能"改一个镜头只重跑它和它的下游"。\n\n'
      + 'action=get 读整图；action=set 用整图替换（适合一次性建出 20 个镜头）；'
      + 'action=add_node / connect / disconnect / remove 做增量修改；action=list 列出所有图；'
      + '**action=remove_graph 删掉一整个项目**（连它的图文档一起，不可撤销）。\n\n'
      + '所有写操作走与画布**同一个校验器**，非法图会被当场拒绝并说明原因，而不是等到执行时才炸。',
    parameters: {
      action: { type: 'string', enum: ['get', 'set', 'add_node', 'connect', 'disconnect', 'remove', 'remove_graph', 'list'], required: true, description: '要做什么。remove 删一个**节点**；remove_graph 删一整个**项目（图）**。' },
      graph_id: { type: 'string', description: '图 id。get/set/add_node/connect/disconnect/remove/remove_graph 需要。' },
      graph: { type: 'object', additionalProperties: true, description: 'action=set 时的整图 JSON。' },
      node: { type: 'object', additionalProperties: true, description: 'action=add_node 时的节点对象（type 必填）。' },
      edge: { type: 'object', additionalProperties: true, description: 'action=connect 时的边 {from, fromPort, to, toPort}。' },
      edge_id: { type: 'string', description: 'action=disconnect 时要删除的边 id。' },
      node_id: { type: 'string', description: 'action=remove 时要删除的节点 id。' },
      title: { type: 'string', description: 'action=set 时的项目名（graph JSON 里没有 title 时用）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' }, graph: { type: 'object', additionalProperties: true }, graphs: { type: 'array' } } },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `图操作失败：${value?.error ?? '未知错误'}` }]
        if (Array.isArray(value.graphs)) {
          /* A delete answers with the list too, and an empty list is ambiguous:
             "本机还没有任何图" reads like a pristine workbench, not like "已删除
             甲". The user cannot tell a successful clear from a no-op. */
          const removed = typeof value.removed === 'string' && value.removed.length > 0
            ? `已删除项目 ${value.removed}。\n`
            : ''
          if (value.graphs.length === 0) {
            return [{ type: 'text', text: `${removed}本机现在没有任何图。用 action=set 或 openrouter_video_plan 建一个。` }]
          }
          return [{ type: 'text', text: removed + value.graphs.map((g) => `${g.id}　${g.title}　${g.nodes} 节点 / ${g.edges} 边　${g.state}`).join('\n') }]
        }
        const graph = value.graph ?? {}
        const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0
        const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0
        const parts = [`图 ${graph.id ?? ''}（${graph.title ?? ''}）：${nodeCount} 个节点 / ${edgeCount} 条边。`]
        if (Array.isArray(graph.nodes)) {
          for (const node of graph.nodes) {
            const shotTag = node.shotIndex === null || node.shotIndex === undefined ? '' : ` #${node.shotIndex}`
            parts.push(`\n· ${node.id} [${node.type}]${shotTag} ${node.title ?? ''}`)
          }
        }
        return [{ type: 'text', text: parts.join('') }]
      },
    },
    async execute(args) {
      try {
        const action = args?.action
        await graphStore.load()

        if (action === 'list') {
          return { ok: true, graphs: graphSummaries() }
        }

        if (action === 'set') {
          const incoming = args?.graph !== null && typeof args?.graph === 'object' ? args.graph : null
          if (incoming === null) throw new Error('action=set 需要 graph 参数')
          const graph = normalizeGraph({
            ...incoming,
            ...(typeof args?.title === 'string' && incoming.title === undefined ? { title: args.title } : {}),
          })
          const result = validate(graph, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
          if (!result.ok) {
            throw new Error(`图不合法：${result.errors.map((e) => e.message).join('；')}`)
          }
          await graphStore.put(graph)
          return { ok: true, graph, warnings: result.warnings }
        }

        const id = args?.graph_id
        if (typeof id !== 'string' || id.length === 0) throw new Error(`${action} 需要 graph_id`)
        const stored = graphStore.get(id)
        if (stored === null) throw new Error(`没有这个图：${id}`)
        const graph = normalizeGraph(stored)

        if (action === 'get') return { ok: true, graph }

        if (action === 'remove_graph') {
          /*
           * Delete a whole PROJECT.
           *
           * `GraphStore.remove` has existed since the first draft with nothing
           * ever calling it: no route, no tool action, no button. A workbench
           * could therefore only accumulate graphs — and because the store loads
           * ONCE into memory, tidying `graphs.json` by hand is silently reverted
           * by the very next write. Clearing the workspace has to go through the
           * Host, so it has to exist here.
           */
          await graphStore.load()
          await graphStore.remove(id)
          return { ok: true, removed: id, graphs: graphSummaries() }
        }

        if (action === 'add_node') {
          const node = args?.node
          if (node === null || typeof node !== 'object') throw new Error('action=add_node 需要 node 参数')
          if (typeof node.type !== 'string' || NODE_TYPES[node.type] === undefined) {
            throw new Error(`未知节点类型：${node.type ?? '（空）'}；可用：${Object.keys(NODE_TYPES).join(', ')}`)
          }
          if (typeof node.id !== 'string' || graph.nodes.some((n) => n.id === node.id)) {
            throw new Error(`节点 id 缺失或重复：${node.id ?? '（空）'}`)
          }
          graph.nodes.push(node)
          const next = normalizeGraph(graph)
          const result = validate(next, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
          // A half-built graph legitimately has empty required ports, so only a
          // hard structural failure blocks the write.
          if (result.errors.some((e) => e.code === 'cycle' || e.code === 'dup-id')) {
            throw new Error(`不能写入：${result.errors.map((e) => e.message).join('；')}`)
          }
          await graphStore.put(next)
          return { ok: true, graph: next, warnings: result.warnings }
        }

        if (action === 'connect') {
          const edge = args?.edge
          if (edge === null || typeof edge !== 'object') throw new Error('action=connect 需要 edge 参数')
          const check = canConnect(graph, edge.from, edge.fromPort, edge.to, edge.toPort)
          if (!check.ok) throw new Error(`不能连接：${check.reason}`)
          graph.edges.push({
            id: typeof edge.id === 'string' ? edge.id : `e_${Date.now().toString(36)}`,
            from: edge.from, fromPort: edge.fromPort, to: edge.to, toPort: edge.toPort,
            label: typeof edge.label === 'string' ? edge.label : '',
          })
          const next = normalizeGraph(graph)
          await graphStore.put(next)
          return defined({ ok: true, graph: next, warning: check.warn ?? undefined })
        }

        if (action === 'disconnect') {
          const edgeId = args?.edge_id
          if (typeof edgeId !== 'string' || edgeId.length === 0) throw new Error('action=disconnect 需要 edge_id')
          graph.edges = graph.edges.filter((e) => e.id !== edgeId)
          const next = normalizeGraph(graph)
          await graphStore.put(next)
          return { ok: true, graph: next }
        }

        if (action === 'remove') {
          const nodeId = args?.node_id
          if (typeof nodeId !== 'string' || nodeId.length === 0) throw new Error('action=remove 需要 node_id')
          graph.nodes = graph.nodes.filter((n) => n.id !== nodeId)
          graph.edges = graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
          const next = normalizeGraph(graph)
          await graphStore.put(next)
          return { ok: true, graph: next }
        }

        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })

  const planTool = defineTool({
    name: 'openrouter_video_plan',
    description:
      '**长视频的高层入口**：把一段脚本或镜头表直接展开成完整的图。'
      + '给它 6 条镜头描述，它建出「分镜节点 + N 个生成节点 + 参考素材扇出 + 成片序列节点」并连好线，'
      + '返回图 id 与成本上界。**这一步不花任何钱**，只是建图。\n\n'
      + '默认还会在相邻镜头之间插入「取帧」节点（上一镜的末帧 → 下一镜的首帧），'
      + '这是本工作区唯一实测可用的衔接机制；手连 23 条镜头 = 22 个节点 + 44 条边。'
      + '传 `chain: "none"` 可以关掉。**注意取帧需要配置图床**（`imageBedUrl`），否则会明确警告并退化成独立生成。\n\n'
      + '建完用 `openrouter_video_run` 预检并执行。这是做长视频的正确起点 —— '
      + '不要用 `openrouter_generate_video` 循环 20 次，那样没有续跑、没有成本闸门、没有衔接管理。',
    parameters: {
      script: { type: 'string', description: '脚本或镜头表（自由文本）。会存进分镜节点，也用于自动分镜。' },
      shots: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            title: { type: 'string' },
            prompt: { type: 'string' },
            duration: { type: 'number' },
            link: { type: 'string', enum: ['none', 'continue', 'edit'] },
            chain: {
              type: 'string',
              enum: ['frames', 'none'],
              description:
                '这一镜要不要接上一镜的末帧。默认跟随整片的 chain。\n\n'
                + '**传 "none" 就是一次硬切/转场**：这一镜独立起幅，不接上一镜。'
                + '一整片每一处都接龙 = 一次剪辑点都没有；通常几条硬切是对的（换场景、换时间、要一个明确的转场）。\n\n'
                + '这一镜如果同时接了角色参考图，参考图在它身上**才真正生效** —— '
                + '因为 frame_images 与 input_references **不能同发**：provider 会拒绝整个请求（实测 400），'
                + '插件只好丢掉参考图、只发首帧。',
            },
            cast: {
              type: 'array',
              items: { type: 'string' },
              description:
                '这一镜出场的角色名（对应 `cast[].name`）。\n\n'
                + '给了这一条就**替换**默认的「本片全部角色」，不是并集 —— 所以「这一镜没有老鼠」是能表达的。'
                + '不写则这一镜带上全部角色。',
            },
          },
        },
        description: '镜头列表。每条至少给 prompt。给了 shots 就不必给 script。',
      },
      title: { type: 'string', description: '项目名。' },
      model: { type: 'string', description: '全片默认模型。' },
      duration: { type: 'number', description: '每镜默认时长（秒）。' },
      resolution: { type: 'string', description: '项目分辨率。' },
      aspect_ratio: { type: 'string', description: '项目画幅。' },
      reference_image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: '风格/主体参考图，会作为 ref 节点扇出到所有镜头。\n\n'
          + '给 https URL，**或者给会话工作目录内的本机文件路径**（例如图像工具刚出的那张图）——'
          + '本机文件会被自动发布到工作台配置的图床，并换成它返回的公开 URL，因为 API 只取 https。',
      },
      cast: {
        type: 'array',
        description:
          '角色库：每个角色一个 {name, description, image_url}，建成可复用的 cast 节点，然后**按镜头连线**。\n\n'
          + '默认会把每个角色连到所有镜头；某一镜用 `shots[].cast: ["TOM"]` 声明自己的出场角色，'
          + '就覆盖默认（**替换，不是并集**）——所以「这一镜没有老鼠」是能表达的。\n\n'
          + 'description 会被**原样插进**它出场镜头的提示词开头。写**固定外形**，不写动作和情绪：'
          + '毛色、体型、眼睛、穿戴、标志性特征。写"一只蓝灰色的家猫，圆脸，黄眼睛，白肚皮，脖子上一条红领结"，'
          + '不要写"一只看起来很狡猾的猫"。\n\n'
          + '注意 frame_images 与 input_references **不能同发**：provider 会拒绝整个请求'
          + '（实测 heygen 回 400「does not accept input_references alongside a first_frame image」），'
          + '插件只发首帧、把参考图丢掉，所以参考图真正生效的是硬切/转场那些镜头。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string', description: '角色名，如 TOM。' },
            description: { type: 'string', description: '固定外形描述，它出场的每条提示词都会原样重复。' },
            image_url: { type: 'string', description: '角色参考图 https URL（角色三视图/定妆图最好）。' },
            image_file: {
              type: 'string',
              description: '角色参考图的**本机文件路径**（会话工作目录内），例如图像工具刚生成的那张。'
                + '会被自动发布到图床并换成公开 URL。给了 image_file 就用它，忽略 image_url。',
            },
          },
        },
      },
      scenes: {
        type: 'array',
        description:
          '**场景库**：每个场景一个 {name, description, image_url|image_file}，建成可复用的 `scene` 节点，'
          + '连到**发生在这个场景里的**镜头 refs 口（默认连到所有镜头）。\n\n'
          + '**为什么需要它**：没有它的时候，6 个独立硬切镜头里角色是稳的（固定描述在起作用），'
          + '**场景却在漂** —— 每一镜的涂鸦墙、墙面、时间光线都不一样，因为除了各写各的提示词之外没有别的东西钉住它。'
          + '「角色不能漂」和「地点不能漂」是同一个需求，一部片子里两样都有。\n\n'
          + 'description 会被**原样插进**它出场镜头的提示词开头（和 cast 同一个机制、同一个幂等保护）。'
          + '写**固定的地点 / 时间 / 光线 / 材质**：'
          + '"黄昏的城市屋顶，右侧一面满涂鸦的混凝土墙，地面是裂缝水泥，低角度硬光，暖色轮廓光，24fps 3D 动画"；'
          + '不要写这一镜里发生的事（那属于 shots[].prompt）。\n\n'
          + 'image_url / image_file 给一张**环境空镜参考图**（不要带角色，否则模型可能照着它复制一个人出来）。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string', description: '场景名，如 天台。' },
            description: { type: 'string', description: '固定场景描述（地点/时间/光线/材质），它出场的每条提示词都会原样重复。' },
            image_url: { type: 'string', description: '环境空镜参考图 https URL。' },
            image_file: {
              type: 'string',
              description: '环境空镜参考图的**本机文件路径**（会话工作目录内）。会被自动发布到图床并换成公开 URL。',
            },
          },
        },
      },
      budget_usd: { type: 'number', description: '成本上界闸门（美元）。超出会拒绝派发。' },
      chain: {
        type: 'string',
        enum: ['frames', 'none'],
        description: '衔接方式。frames（默认）在相邻镜头间插「取帧」节点做首尾帧接龙；none 只建独立镜头。',
      },
      generate_audio: {
        type: 'boolean',
        description: '这一部片是否生成音频。留空用工作台默认。\n\n'
          + 'seedance-2.5 这类模型会在**输出音频**上撞内容审核：'
          + '「The request failed because the output audio may be related to copyright restrictions」'
          + '——提交后由服务端判 failed（不计费），但整部片子一镜都出不来。给它传 false 即可绕开。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' }, graphId: { type: 'string' }, shotCount: { type: 'number' }, ceilingUsd: { type: 'number' }, unknownCount: { type: 'number' }, catalogError: { oneOf: [{ type: 'string' }, { type: 'null' }] } } },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `建图失败：${value?.error ?? '未知错误'}` }]
        const parts = [`已建图 ${value.graphId}：${value.shotCount} 条镜头，总时长 ${value.totalSeconds} 秒。`]
        // Only attribute an unknown magnitude to token pricing when the catalog
        // actually says so. A missing catalog makes every node unpriceable, and
        // silently presenting that as "$0.00, token-priced" is how a broken
        // request path reads as a free render.
        if (value.catalogError) {
          parts.push(`\n\n**模型目录没加载成功，成本上界算不出来**：${value.catalogError}`)
          parts.push('\n这不代表免费 —— 上界未知，先修好目录再执行。')
        } else {
          parts.push(`\n成本上界 ≈ $${Number(value.ceilingUsd ?? 0).toFixed(2)}`)
          if (value.unknownCount > 0) parts.push(`，另有 ${value.unknownCount} 个节点量级未知（按 token 计价或没有可用的每秒 SKU）`)
          parts.push('。\n**这是上界不是报价**，实账以 usage.cost 为准。')
        }
        if (value.chainedCount > 0) {
          parts.push(`\n\n已插入 ${value.chainedCount} 个「取帧」节点做首尾帧接龙（上一镜末帧 → 下一镜首帧）`)
          parts.push(value.imageBedConfigured === true
            ? '；图床已配置，接龙可用。'
            : '；**但图床还没配** —— 不配的话抽出的帧没有公开 URL，接龙会退化成独立生成。'
              + '工作台顶部「图床」一行填基地址即可。')
        } else if (value.chainMode === 'none') {
          parts.push('\n\n未做衔接：每条镜头都是独立起幅（`chain: "none"`）。')
        }
        for (const spec of [{ kind: 'cast', label: '角色' }, { kind: 'scene', label: '场景' }]) {
          const rows = Array.isArray(value.cast) ? value.cast.filter((row) => row.kind === spec.kind) : []
          if (rows.length === 0) continue
          parts.push(`\n\n已建 ${rows.length} 个${spec.label}节点（可复用；连到哪些镜头的 refs 口，就只在哪些镜头出场）：`)
          for (const row of rows) {
            const bits = []
            if (row.hasDescription === true) bits.push('固定描述已插进它出场镜头的提示词')
            if (row.hasImage === true) bits.push('参考图作为 input_references 发给它出场的镜头')
            parts.push(`\n· ${row.name}（${bits.join(' · ') || '空'}）`)
          }
        }
        if (Array.isArray(value.published) && value.published.length > 0) {
          parts.push('\n\n已发布到图床（本机文件 → 公开 URL，API 只取 https）：')
          for (const row of value.published) parts.push(`\n· ${row.label}：${row.file} → ${row.url}`)
        }
        for (const note of Array.isArray(value.notes) ? value.notes : []) parts.push(`\n· ${note}`)
        parts.push('\n\n下一步：用 `openrouter_video_run`（默认 dry-run）预检并执行。')
        return [{ type: 'text', text: parts.join('') }]
      },
    },
    async execute(args, exec) {
      try {
        await refreshCatalog(false)
        const settings = readConfig()
        const cwd = exec?.agent?.session?.header?.cwd

        /*
         * A reference image must be a PUBLIC https URL: the API fetches it
         * itself and accepts neither a local path nor a data URL. But the way a
         * character sheet actually gets made here is the image tool, which writes
         * a LOCAL file — so the two halves had no seam, and the workflow stopped
         * one step short of the only thing the reference is for.
         *
         * A bare local path is therefore published to the configured image bed
         * and the URL it returns is what goes into the graph. The path is bounded
         * to the session working directory, and the receipt names every URL that
         * was minted, because "somewhere on the internet" is not an answer.
         */
        const published = []
        const toPublicUrl = async (value, label) => {
          const raw = typeof value === 'string' ? value.trim() : ''
          if (raw.length === 0) return ''
          if (/^https?:\/\//iu.test(raw)) return raw
          if (settings.imageBedUrl.length === 0) {
            throw new Error(`${label}给的是本机文件（${raw}），但工作台没有配置图床地址，`
              + '本机文件发不出公开 URL——provider 只能自己去取 https。'
              + '请先在工作台顶部「图床」一行填基地址，或直接给 https URL。')
          }
          const root = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
          const absolute = isAbsolute(raw) ? raw : join(root, raw)
          const rel = relative(root, absolute)
          if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error(`${label}只能读会话工作目录内的文件：${raw}`)
          }
          const up = await uploadFrame({
            filePath: absolute,
            baseUrl: settings.imageBedUrl,
            folder: settings.imageBedFolder,
            userAgent: settings.imageBedUserAgent,
            token: settings.imageBedToken,
          })
          if (up.ok !== true) throw new Error(`${label}发布到图床失败：${up.error}`)
          published.push({ label, file: raw, url: up.url })
          return up.url
        }
        const rawShots = Array.isArray(args?.shots) ? args.shots : []
        const scriptText = typeof args?.script === 'string' ? args.script : ''

        // If only a script was given, split it into shots on numbered lines.
        // Deliberately crude and transparent: the agent can always pass `shots`
        // explicitly when it wants control.
        let entries = rawShots
        if (entries.length === 0 && scriptText.length > 0) {
          entries = scriptText
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => ({ prompt: line.replace(/^\s*\d+[.、)]\s*/u, ''), title: line.replace(/^\s*\d+[.、)]\s*/u, '').slice(0, 18) }))
        }
        if (entries.length === 0) throw new Error('需要 shots 或 script 至少一个')

        const model = typeof args?.model === 'string' && args.model.length > 0 ? args.model : settings.model
        const projectDuration = positiveInt(args?.duration) ?? settings.duration
        const graph = emptyGraph(typeof args?.title === 'string' && args.title.length > 0 ? args.title : '未命名长片')
        graph.project = {
          model,
          resolution: typeof args?.resolution === 'string' && args.resolution.length > 0 ? args.resolution : settings.resolution,
          aspectRatio: typeof args?.aspect_ratio === 'string' && args.aspect_ratio.length > 0 ? args.aspect_ratio : settings.aspectRatio,
          duration: projectDuration,
          generateAudio: typeof args?.generate_audio === 'boolean' ? args.generate_audio : settings.generateAudio,
          seed: null,
        }
        if (Number.isFinite(Number(args?.budget_usd))) graph.budget = { usd: Number(args.budget_usd), onExceed: 'refuse' }
        graph.concurrency = settings.concurrency

        const scriptId = 'n_script'
        graph.nodes.push({
          id: scriptId, type: 'script', title: '分镜', x: 20, y: 20,
          fields: { text: scriptText.length > 0 ? scriptText : entries.map((s, i) => `${i + 1}. ${s.prompt ?? ''}`).join('\n') },
        })

        // One ref node per reference image, fanning out to every shot — the
        // single most valuable thing the graph does (plan §3.8).
        const refIds = []
        const refUrls = Array.isArray(args?.reference_image_urls) ? args.reference_image_urls : []
        for (const [index, entry] of refUrls.entries()) {
          if (typeof entry !== 'string' || entry.trim().length === 0) continue
          const url = await toPublicUrl(entry, `第 ${index + 1} 张参考图`)
          const id = `n_ref${refIds.length + 1}`
          refIds.push(id)
          graph.nodes.push({
            id, type: 'ref', title: `参考 ${refIds.length}`, x: 20, y: 120 + (refIds.length - 1) * 110,
            fields: { source: url, kind: 'image' },
          })
        }

        /*
         * Bible nodes — characters AND scenes. Each is one DEFINITION (a fixed
         * description plus an optional reference image), wired to the shots it
         * applies to (below) — not fanned out graph-wide.
         *
         * This comment used to claim the opposite ("deliberately NOT wired to
         * anything: the Host reads every `cast` node off the graph and applies it
         * to every shot"). That was the FIRST draft. The code beneath it had
         * already moved on, so the comment described a mechanism that no longer
         * existed — the same defect that shipped a 角色 node explaining it was
         * global. Corrected here rather than left to mislead the next reader.
         *
         * `scenes` is the same node shape on purpose. A film has two things that
         * must not drift; giving the place its own mechanism would mean fixing
         * scene drift once and character drift never.
         */
        const castCreated = []
        const bibleInputs = [
          { kind: 'cast', rows: Array.isArray(args?.cast) ? args.cast : [], names: [], descriptions: [], sources: [] },
          { kind: 'scene', rows: Array.isArray(args?.scenes) ? args.scenes : [], names: [], descriptions: [], sources: [] },
        ]
        for (const spec of bibleInputs) {
          const fallback = spec.kind === 'cast' ? '角色' : '场景'
          spec.rows.forEach((row, index) => {
            if (row === null || typeof row !== 'object') return
            const name = typeof row.name === 'string' && row.name.trim().length > 0
              ? row.name.trim()
              : `${fallback} ${index + 1}`
            const description = typeof row.description === 'string' ? row.description.trim() : ''
            /* `image_file` is the local-file form: a picture this machine just
               generated. It is published to the image bed and becomes the URL. */
            const source = typeof row.image_file === 'string' && row.image_file.trim().length > 0
              ? row.image_file
              : row.image_url
            spec.sources.push(source)
            spec.names.push(name)
            spec.descriptions.push(description)
          })
        }
        /* Sequential and awaited in order: publishing is a network call, and a
           numbered list in the receipt is easier to read than a shuffled one. */
        for (const spec of bibleInputs) {
          const fallback = spec.kind === 'cast' ? '角色' : '场景'
          for (let index = 0; index < spec.names.length; index += 1) {
            const name = spec.names[index]
            const description = spec.descriptions[index]
            const image = await toPublicUrl(spec.sources[index], `${fallback}「${name}」的参考图`)
            if (description.length === 0 && image.length === 0) continue
            const id = `n_${spec.kind}${index + 1}`
            graph.nodes.push({
              id, type: spec.kind, title: name,
              x: 20, y: 120 + (refIds.length + castCreated.length) * 110,
              fields: { name, description, source: image },
            })
            castCreated.push({ id, kind: spec.kind, name, hasDescription: description.length > 0, hasImage: image.length > 0 })
          }
        }

        const generatorIds = []
        const biblesWiredByShot = new Map()
        const unknownCastNames = new Set()
        entries.forEach((entry, index) => {
          const shotNumber = index + 1
          const id = `n_s${String(shotNumber).padStart(2, '0')}`
          generatorIds.push(id)
          const fields = { prompt: typeof entry?.prompt === 'string' ? entry.prompt : '' , model }
          if (Number.isFinite(Number(entry?.duration))) fields.duration = Number(entry.duration)
          graph.nodes.push({
            id, type: 'generate', title: typeof entry?.title === 'string' && entry.title.length > 0 ? entry.title : `镜头 ${shotNumber}`,
            shotIndex: shotNumber, x: 260 + (index % 4) * 230, y: 20 + Math.floor(index / 4) * 210,
            link: typeof entry?.link === 'string' ? entry.link : null,
            fields,
          })
          graph.edges.push({ id: `e_brief_${shotNumber}`, from: scriptId, fromPort: 'brief', to: id, toPort: 'brief' })
          for (const refId of refIds) {
            graph.edges.push({ id: `e_${refId}_${shotNumber}`, from: refId, fromPort: 'asset', to: id, toPort: 'refs' })
          }

          /*
           * What is true of THIS shot.
           *
           * An explicit per-shot `cast: ["TOM"]` REPLACES the default roster for
           * the CHARACTERS in this shot rather than unioning with it. "The mouse
           * is not in this shot" is a real editorial statement, and a union would
           * make it inexpressible — which is the whole reason the character bible
           * is wired per shot instead of fanned out graph-wide.
           *
           * SCENES ARE NOT SUBJECT TO THE ROSTER. A shot happening somewhere else
           * is a different scene node, not the absence of one, so filtering the
           * scenes by a character list would silently strip the rooftop off every
           * shot that names a character — which is all of them.
           */
          const declared = Array.isArray(entry?.cast)
            ? entry.cast.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
            : null
          const characters = castCreated.filter((row) => row.kind === 'cast')
          const scenes = castCreated.filter((row) => row.kind === 'scene')
          if (declared !== null) {
            for (const name of declared) {
              if (!characters.some((row) => row.name === name)) unknownCastNames.add(name)
            }
          }
          const forThisShot = [
            ...scenes,
            ...(declared === null ? characters : characters.filter((row) => declared.includes(row.name))),
          ]
          for (const row of forThisShot) {
            graph.edges.push({ id: `e_${row.id}_${shotNumber}`, from: row.id, fromPort: 'asset', to: id, toPort: 'refs' })
          }
          biblesWiredByShot.set(id, forThisShot.map((row) => row.name))
        })

        const seqId = 'n_seq'
        graph.nodes.push({
          id: seqId, type: 'seq', title: '成片序列',
          x: 260 + (entries.length % 4) * 230, y: 20 + Math.ceil(entries.length / 4) * 210,
          fields: { naming: 's{idx}_take{n}' },
        })
        generatorIds.forEach((id, index) => {
          graph.edges.push({ id: `e_seq_${index + 1}`, from: id, fromPort: 'job', to: seqId, toPort: 'jobs' })
        })

        /* ---- continuity wiring ----------------------------------------
         * `chain: 'frames'` (the default) inserts 取帧 between consecutive shots:
         * shot N-1 → take → shot N's `frames` port. It is the ONLY continuity
         * mechanism measured to work in this workspace — `previous_job_id` is
         * unusable (the one model that prices it is guardrail-blocked; the other
         * answers 400) and a video reference is bearer-guarded — and hand-wiring
         * it across a 23-shot film is 22 nodes and 44 edges.
         *
         * Measured on a 24 fps pair: SSIM 0.949 across the seam, against 0.420
         * for two independent shots and 0.970 for two adjacent frames *inside*
         * one clip. So the seam lands at the intra-shot continuity ceiling.
         *
         * The image bed is the switch, and a missing one is not silent: the
         * frames survive as `warning`s and `validate` says so.
         */
        const chainMode = args?.chain === 'none' ? 'none' : 'frames'
        // Whether the model can take a frame at all. `sora-2-pro` declares
        // `supported_frame_images: null`, which `validate` treats as a hard
        // ERROR — so building a take chain for it would fail with "这是插件的
        // bug", which is exactly the wrong message for a model limitation.
        const modelEntry = catalog.loaded === true ? (catalog.byId[model] ?? null) : null
        const frameCapable = catalog.loaded !== true
          || (modelEntry !== null
            && Array.isArray(modelEntry.supported_frame_images)
            && modelEntry.supported_frame_images.includes('first_frame'))
        const notes = []
        const chained = []

        if (chainMode === 'frames' && entries.length > 1 && !frameCapable) {
          notes.push(`${model} 不支持首帧图生视频，已跳过取帧接龙（这一片会是独立镜头）`)
        } else if (chainMode === 'frames' && entries.length > 1) {
          for (let index = 1; index < entries.length; index += 1) {
            const previousId = generatorIds[index - 1]
            const shotId = generatorIds[index]
            const shotNode = graph.nodes.find((node) => node.id === shotId) ?? null
            const entry = entries[index]

            /*
             * A per-shot `chain: 'none'` is a HARD CUT, and it is not an
             * afterthought: a film that chains every single transition has no
             * transitions at all. Chaining every adjacent pair means the camera
             * never cuts — which is exactly what a 12-shot film did before this
             * switch existed.
             *
             * It is also where a character reference finally does its job: the
             * API applies `frame_images` OVER `input_references`, so a shot that
             * carries a first frame cannot receive its character sheet. An
             * unchained shot can.
             */
            if (entry?.chain === 'none') {
              const names = biblesWiredByShot.get(shotId) ?? []
              notes.push(`${shotId} 声明了 chain="none"：硬切，不接上一镜末帧`
                + (names.length > 0
                  ? `；它接的 ${names.join('、')} 参考图在这一镜才真正生效（接了首帧就拿不到参考图）`
                  : ''))
              continue
            }

            // An explicit per-shot `link` OUTRANKS the graph-wide default.
            //
            // That shot asked for `previous_job_id`, and sending a first frame
            // alongside it is not a documented combination — so one of the two
            // has to yield, and the specific instruction beats the general one.
            // Clearing the flag instead would silently rewrite what the caller
            // asked for, which is how a continuity control becomes decorative.
            if (shotNode !== null && (shotNode.link === 'continue' || shotNode.link === 'edit')) {
              notes.push(`${shotId} 声明了 link=${shotNode.link}，这一镜不做取帧接龙（两条衔接机制不能同时发）`)
              continue
            }

            const takeId = `n_take${String(index).padStart(2, '0')}`
            graph.nodes.push({
              id: takeId,
              type: 'take',
              title: `取帧 ${index}→${index + 1}`,
              x: (shotNode?.x ?? 260) + 20,
              y: (shotNode?.y ?? 20) + 105,
              fields: { frame: 'last_frame', slot: 'first_frame' },
            })
            graph.edges.push({ id: `e_take_in_${index}`, from: previousId, fromPort: 'job', to: takeId, toPort: 'job' })
            graph.edges.push({ id: `e_take_out_${index}`, from: takeId, fromPort: 'image', to: shotId, toPort: 'frames' })
            chained.push({ from: previousId, to: shotId, via: takeId })
          }
        }

        if (castCreated.length > 0) {
          const noDescription = castCreated.filter((row) => row.hasDescription !== true)
          if (noDescription.length > 0) {
            notes.push(`${noDescription.map((row) => row.name).join('、')} 只给了参考图、没给固定外形描述——`
              + '参考图只在没接首帧的镜头里生效，其余镜头仍会各自描述一遍角色，长相就会随镜头漂移')
          }
          if (unknownCastNames.size > 0) {
            notes.push(`镜头里点名了但角色库里没有的角色：${[...unknownCastNames].join('、')}——`
              + '先在 cast 里定义它们，否则这些镜头不会带上任何角色设定')
          }
          const perShot = [...biblesWiredByShot.entries()]
            .map(([id, names]) => `${id}(${names.length === 0 ? '无角色' : names.join('/')})`)
          notes.push(`角色已按镜头连线（不是全局扇出）：${perShot.join('、')}`)
          if (chained.length > 0) {
            notes.push(`其中 ${chained.length} 个镜头接了首帧；frame_images 与 input_references 不能同发`
              + '（provider 会拒绝整个请求，实测 400），这些镜头拿不到角色参考图，'
              + '靠接龙 + 提示词里原样重复的固定描述保持一致；'
              + '要某个角色在某一镜真正靠参考图定住，就把那一镜设成硬切（chain: "none"）')
          }
        }

        const normalized = normalizeGraph(graph)
        const result = validate(normalized, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
        if (!result.ok) {
          throw new Error(`建出的图不合法（这是插件的 bug，请报告）：${result.errors.map((e) => e.message).join('；')}`)
        }

        await graphStore.put(normalized)

        const ceilings = normalized.nodes.filter(isNetworkNode).map((node) => {
          const entry = catalog.byId[resolveModel(normalized, node)] ?? { id: resolveModel(normalized, node), pricing_skus: null }
          return nodeCeiling({ model: entry, seconds: resolveDuration(normalized, node), kind: pricingKind(node) }).usd
        })
        const known = ceilings.filter((value) => value !== null)
        const totalSeconds = entries.reduce((sum, entry) => sum + (positiveInt(entry?.duration) ?? projectDuration), 0)

        return {
          ok: true,
          graphId: normalized.id,
          shotCount: entries.length,
          totalSeconds,
          ceilingUsd: known.reduce((a, b) => a + b, 0),
          unknownCount: ceilings.length - known.length,
          catalogError: catalog.error ?? null,
          chainMode,
          chainedCount: chained.length,
          chained,
          imageBedConfigured: settings.imageBedUrl.length > 0,
          cast: castCreated,
          published,
          seqNodeId: seqId,
          notes,
          warnings: result.warnings,
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })

  const runTool = defineTool({
    name: 'openrouter_video_run',
    description:
      '执行一张图。**默认 dry-run：只预检、报成本上界，不花任何钱。**\n\n'
      + '要真跑必须显式传 dry_run=false —— agent 花用户的钱时，默认值必须是不花钱的那个。\n\n'
      + '执行是**可续跑**的：中途关掉 DSH 再启动会从断点继续，已完成的任务不会重复提交、不会重复花钱。'
      + '没有取消端点，所以 `abort` 只能"停止派发新节点"，在飞的任务会继续跑、继续计费。',
    parameters: {
      graph_id: { type: 'string', required: true, description: '图 id。' },
      dry_run: { type: 'boolean', description: '默认 true。true 只预检并返回成本上界，不提交任何请求。' },
      only: { type: 'array', items: { type: 'string' }, description: '只跑这些节点及其下游（改一个镜头只重跑它，是图相对表单的核心优势）。' },
      retry_failed: { type: 'boolean', description: '重跑失败的镜头，已完成的保持不变。默认 false —— 失败的节点会被跳过，否则重跑一次图表就等于把失败的镜头又提交了一遍。' },
      abort: { type: 'boolean', description: '传 true 表示中止正在进行的派发（不取消在飞任务）。' },
      save_dir: { type: 'string', description: '保存目录，相对会话工作目录。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' }, dryRun: { type: 'boolean' }, ceilingUsd: { type: 'number' }, unknownCount: { type: 'number' }, catalogError: { oneOf: [{ type: 'string' }, { type: 'null' }] }, dispatched: { type: 'number' }, completed: { type: 'number' }, failed: { type: 'number' }, spentUsd: { type: 'number' } } },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `执行失败：${value?.error ?? '未知错误'}` }]
        if (value.dryRun === true) {
          const parts = ['预检通过（**没有提交任何请求，没有花钱**）。']
          if (value.catalogError) {
            parts.push(`\n\n**模型目录没加载成功，成本上界算不出来**：${value.catalogError}`)
            parts.push('\n上界未知不等于免费，先修好目录再执行。')
          } else {
            parts.push(`\n成本上界 ≈ $${Number(value.ceilingUsd ?? 0).toFixed(2)}`)
            if (value.unknownCount > 0) parts.push(`，另有 ${value.unknownCount} 个节点量级未知（按 token 计价或没有可用的每秒 SKU）`)
          }
          parts.push(`\n执行节点 ${value.plannedCount} 个，总时长 ${value.totalSeconds} 秒。`)
          if (Array.isArray(value.warnings) && value.warnings.length > 0) {
            parts.push(`\n\n注意：\n· ${value.warnings.join('\n· ')}`)
          }
          parts.push('\n\n要真跑请显式传 dry_run=false。')
          return [{ type: 'text', text: parts.join('') }]
        }
        const parts = [`执行结束：完成 ${value.completed ?? 0}，失败 ${value.failed ?? 0}，跳过 ${value.skipped ?? 0}。`]
        if (typeof value.spentUsd === 'number') parts.push(`\n实账 $${value.spentUsd.toFixed(2)}`)
        if (value.paused === true) parts.push(`\n**已暂停**：${value.pauseReason ?? ''}`)
        if (value.aborted === true) parts.push('\n已停止派发新节点；在飞任务仍在服务端运行并继续计费。')
        if (Array.isArray(value.stillFailed) && value.stillFailed.length > 0) {
          parts.push(`\n**仍有 ${value.stillFailed.length} 个镜头处于失败状态**：${value.stillFailed.join('、')}`)
          parts.push('\n要重跑它们请传 `retry_failed: true`；已完成的镜头不会被重跑。')
        }
        const publishedCount = Array.isArray(value.framesPublished) ? value.framesPublished.length : 0
        const frameErrCount = Array.isArray(value.frameErrors) ? value.frameErrors.length : 0
        if (publishedCount > 0 || frameErrCount > 0) {
          parts.push(`\n\n取帧接龙：发布 ${publishedCount} 帧`)
          if (frameErrCount > 0) {
            parts.push(`，**失败 ${frameErrCount} 帧**`)
            parts.push('\n这些镜头已经渲染并计费，但下游拿不到首帧，会退化成独立生成（故事会不连贯）。原因：')
            for (const row of value.frameErrors) {
              parts.push(`\n· ${row?.nodeId ?? '?'}：${row?.error ?? '未知错误'}`)
            }
          } else {
            parts.push('，全部成功。')
          }
        }
        if (Array.isArray(value.files) && value.files.length > 0) {
          parts.push('\n\n产物：')
          for (const file of value.files) parts.push(`\n· ${file}`)
        }
        const seqRows = Array.isArray(value.sequences) ? value.sequences : []
        if (seqRows.length > 0) {
          parts.push('\n\n成片序列：')
          for (const row of seqRows) {
            if (typeof row.error === 'string' && row.error.length > 0) {
              parts.push(`\n· ${row.nodeId} 没导出成片：${row.error}`)
              continue
            }
            const bits = []
            if (typeof row.count === 'number') bits.push(`${row.count} 镜`)
            if (typeof row.expected === 'number' && row.expected !== row.count) {
              bits.push(`**缺 ${row.expected - row.count} 镜**（${(row.missing ?? []).join('、')}）`)
            }
            if (typeof row.durationSec === 'number' && row.durationSec > 0) bits.push(`${row.durationSec.toFixed(1)}s`)
            if (row.mode === 'copy') bits.push('直接拼接')
            else if (row.mode === 'normalize') bits.push('统一转码后拼接')
            if (row.cached === true) bits.push('磁盘上已有，未重切')
            parts.push(`\n· ${row.filePathRelative ?? row.filePath ?? row.nodeId}（${bits.join(' · ')}）`)
          }
          if (seqRows.every((row) => typeof row.error !== 'string')) {
            parts.push('\n用 ffmpeg 拼接，成片可直接播放；同名 -manifest.json 记录了每一镜用的是哪个文件。')
          }
        }
        if (value.cast && typeof value.cast === 'object') {
          parts.push(`\n\n角色库：${Array.isArray(value.cast.characters) ? value.cast.characters.length : 0} 个角色`
            + `，${value.cast.descriptions} 个有固定外形描述`
            + (value.cast.images > 0 ? `，${value.cast.images} 个有参考图` : '（都没有参考图）')
            + (Array.isArray(value.cast.characters) && value.cast.characters.length > 0
              ? `：${value.cast.characters.join('、')}`
              : ''))
          if (Array.isArray(value.cast.unused) && value.cast.unused.length > 0) {
            parts.push(`\n**没有接到任何镜头**：${value.cast.unused.join('、')}`
              + ' —— 把它连到出场镜头的 refs 端口；不连就对这条片子完全不起作用')
          }
        }
        return [{ type: 'text', text: parts.join('') }]
      },
    },
    async execute(args, exec) {
      try {
        const graphId = args?.graph_id
        if (typeof graphId !== 'string' || graphId.length === 0) throw new Error('需要 graph_id')
        await graphStore.load()
        await jobStore.load()
        const stored = graphStore.get(graphId)
        if (stored === null) throw new Error(`没有这个图：${graphId}`)
        const graph = normalizeGraph(stored)

        if (args?.abort === true) {
          const run = runs.get(graphId)
          if (run === undefined) throw new Error('这个图当前没有在跑')
          run.control.aborted = true
          return { ok: true, dryRun: false, aborted: true, message: '已停止派发新节点；在飞任务仍在运行并继续计费' }
        }

        const settings = readConfig()

        if (args?.dry_run !== false) {
          await refreshCatalog(false)
          const result = validate(graph, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
          const network = graph.nodes.filter(isNetworkNode)
          const ceilings = network.map((node) => {
            const entry = catalog.byId[resolveModel(graph, node)] ?? { id: resolveModel(graph, node), pricing_skus: null }
            return nodeCeiling({ model: entry, seconds: resolveDuration(graph, node), kind: pricingKind(node) }).usd
          })
          const known = ceilings.filter((value) => value !== null)
          const totalSeconds = network.reduce((sum, node) => sum + resolveDuration(graph, node), 0)
          const overBudget = settings.abortOnExceed
            && known.reduce((a, b) => a + b, 0) > settings.budgetUsd
          return defined({
            ok: result.ok && !overBudget,
            dryRun: true,
            error: !result.ok
              ? result.errors.map((e) => e.message).join('；')
              : overBudget
                ? `成本上界 $${known.reduce((a, b) => a + b, 0).toFixed(2)} 超过预算 $${settings.budgetUsd.toFixed(2)}；执行会被拒绝`
                : undefined,
            ceilingUsd: known.reduce((a, b) => a + b, 0),
            unknownCount: ceilings.length - known.length,
            catalogError: catalog.error ?? null,
            plannedCount: network.length,
            totalSeconds,
            warnings: [...result.errors.map((e) => e.message), ...result.warnings.map((w) => w.message)],
          })
        }

        const cwd = exec?.agent?.session?.header?.cwd
        if (typeof args?.save_dir === 'string' && args.save_dir.length > 0) {
          // Validated here so a bad path is refused before anything is submitted.
          resolveSaveDir(args.save_dir, cwd)
        }

        // A missing key is a PRECONDITION, not a per-node failure. Without this
        // the executor would fail every node and the run would still report
        // ok:true — a receipt claiming success for a run in which nothing
        // happened. Refuse up front instead, having sent nothing.
        effectiveKey()

        // The budget gate is evaluated from ceilings computed off the catalog. A
        // cold process that jumps straight to `dry_run: false` has an empty
        // catalog, so every ceiling is null, the sum is 0, and the gate that
        // exists to protect the balance silently does not apply. Load the catalog
        // first; and if the gate cannot be evaluated while it is enabled, refuse
        // rather than spend unguarded — a gate you cannot evaluate is not a gate.
        await refreshCatalog(false)
        if (settings.abortOnExceed && catalog.loaded !== true) {
          throw new Error(
            `模型目录不可用，预算上界无法评估，已拒绝执行（未发出任何请求）：${catalog.error ?? '未知原因'}`
            + '\n修好网络后重试，或先关掉 abortOnExceed 再执行。',
          )
        }

        const { report } = await startRun(graph, {
          cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
          only: Array.isArray(args?.only) ? args.only : null,
          // `fresh` was implemented but unreachable: nothing in the tool surface
          // or the route ever passed it, so a failed shot could never be retried
          // — the run just skipped it forever and reported nothing done.
          fresh: args?.retry_failed === true,
        })

        const files = jobStore.forGraph(graphId)
          .filter((job) => job.status === 'completed' && typeof job.filePathRelative === 'string')
          .map((job) => job.filePathRelative)

        // Nodes whose LATEST job failed. Without this, re-running a graph after a
        // failure produced "完成 0，失败 0，跳过 0" with ok:true: a receipt that
        // reports success for a run in which nothing happened, and no hint that
        // the shots are still failed or how to retry them.
        const byNode = jobStore.byNode(graphId)
        const stillFailed = [...byNode.entries()]
          .filter(([, job]) => job.status === 'failed')
          .map(([nodeId]) => nodeId)

        // A run in which every node failed produced nothing. Saying ok:true
        // there would be a receipt that claims success for an empty result.
        const attempted = report.completed.length + report.failed.length
        const allFailed = attempted > 0 && report.completed.length === 0

        // Name the reason, not just the node. "全部 1 个节点都失败了：n_s01" is a
        // receipt that tells the user nothing they can act on, and the ledger
        // entry that holds the real sentence was previously not even written.
        const failureDetail = () => {
          const byNode = jobStore.byNode(graphId)
          return report.failed.map((nodeId) => {
            const job = byNode.get(nodeId) ?? null
            return job !== null && typeof job.error === 'string' && job.error.length > 0
              ? `${nodeId}：${job.error}`
              : `${nodeId}：原因未记录`
          }).join('\n· ')
        }

        return defined({
          ok: !allFailed,
          error: allFailed
            ? `全部 ${report.failed.length} 个节点都失败了：\n· ${failureDetail()}`
            : undefined,
          dryRun: false,
          dispatched: report.dispatched.length,
          completed: report.completed.length,
          failed: report.failed.length,
          skipped: report.skipped.length,
          spentUsd: report.spentUsd,
          paused: report.paused,
          pauseReason: report.pauseReason,
          aborted: report.aborted,
          stillFailed,
          files,
          /**
           * The frame hand-off's own outcome.
           *
           * `publishFrames` records a per-take failure instead of failing the
           * shot — correct, since the clip is already rendered and paid for — but
           * nothing ever printed these, so the whole chaining mechanism could be
           * dead while every run reported a clean success. A receipt that cannot
           * report the feature it just exercised is not a receipt.
           */
          frameErrors: report.frameErrors ?? [],
          framesPublished: report.framesPublished ?? [],
          /**
           * What the film export did.
           *
           * Same lesson as `frameErrors` one paragraph up, and it cost this
           * workspace both of its finished films: a node that draws on the canvas
           * and produces nothing is invisible until the receipt says so.
           */
          sequences: report.sequences ?? [],
          sequenceErrors: report.sequenceErrors ?? [],
          cast: describeCast(graph),
        })
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })

  const statusTool = defineTool({
    name: 'openrouter_video_status',
    description:
      '查询图或单个任务的状态与**真实成本**（usage.cost）。'
      + '配 wait=false 的生成调用使用：拿到 job id 后用这个查。\n\n'
      + '注意：Video API **没有取消端点**，所以已提交的任务停不下来；'
      + '这里只能停止本地跟踪，服务端会继续运行并计费。',
    parameters: {
      graph_id: { type: 'string', description: '查整张图的执行状态与逐节点成本。' },
      job_id: { type: 'string', description: '查单个任务。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      render(_args, value) {
        if (value?.ok !== true) return [{ type: 'text', text: `查询失败：${value?.error ?? '未知错误'}` }]
        if (typeof value.lines === 'string') return [{ type: 'text', text: value.lines }]
        return [{ type: 'text', text: JSON.stringify(value).slice(0, 2000) }]
      },
    },
    async execute(args) {
      try {
        await jobStore.load()
        if (typeof args?.job_id === 'string' && args.job_id.length > 0) {
          const job = jobStore.find(args.job_id)
          if (job === null) throw new Error(`账本里没有这个任务：${args.job_id}`)
          return {
            ok: true,
            id: job.id, status: job.status, model: job.model, cost: job.cost ?? null,
            filePath: job.filePath ?? null, error: job.error ?? null,
            lines: `任务 ${job.id}\n状态：${job.status}\n模型：${job.model}`
              + (typeof job.cost === 'number' ? `\n费用：$${job.cost.toFixed(4)}` : '\n费用：尚未回填')
              + (job.filePath ? `\n文件：${job.filePath}` : '')
              + (job.error ? `\n错误：${job.error}` : ''),
          }
        }

        const graphId = args?.graph_id
        if (typeof graphId !== 'string' || graphId.length === 0) throw new Error('需要 graph_id 或 job_id')
        await graphStore.load()
        const stored = graphStore.get(graphId)
        if (stored === null) throw new Error(`没有这个图：${graphId}`)
        const graph = normalizeGraph(stored)
        const jobs = jobStore.forGraph(graphId)
        const states = rehydrate(graph, jobStore.byNode(graphId))
        const counts = summarize(graph, states)
        const spent = jobs.reduce((sum, job) => sum + (typeof job.cost === 'number' ? job.cost : 0), 0)

        const lines = [`图 ${graph.id}（${graph.title}）`]
        lines.push(`节点 ${counts.total} 个执行单元：完成 ${counts.completed} / 进行 ${counts.running} / 失败 ${counts.failed} / 跳过 ${counts.skipped} / 未跑 ${counts.idle}`)
        lines.push(`实账累计 $${spent.toFixed(2)}`)
        for (const node of graph.nodes) {
          if (!isNetworkNode(node)) continue
          const job = jobs.find((row) => row.nodeId === node.id)
          const shot = node.shotIndex === null ? '' : `#${node.shotIndex} `
          lines.push(`· ${shot}${node.id} [${states.get(node.id) ?? 'idle'}]`
            + (job ? ` job ${job.id}` : '')
            + (typeof job?.cost === 'number' ? ` $${job.cost.toFixed(4)}` : ''))
        }
        return { ok: true, graphId, counts, spentUsd: spent, lines: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })

  ctx.effect(() => ctx.tools.register(singleTool), 'openrouter-video: tool generate')
  ctx.effect(() => ctx.tools.register(graphTool), 'openrouter-video: tool graph')
  ctx.effect(() => ctx.tools.register(planTool), 'openrouter-video: tool plan')
  ctx.effect(() => ctx.tools.register(runTool), 'openrouter-video: tool run')
  ctx.effect(() => ctx.tools.register(statusTool), 'openrouter-video: tool status')

  /* ================================================================== *
   * same-origin JSON routes for the workspace
   * ================================================================== */

  const keyPreview = () => {
    const value = typeof readConfig().apiKey === 'string' ? readConfig().apiKey.trim() : ''
    if (value.length === 0) return { hasKey: false, prefix: '', suffix: '', looksValid: false }
    return {
      hasKey: true,
      prefix: value.slice(0, 9),
      suffix: value.length > 13 ? value.slice(-4) : '',
      looksValid: value.startsWith('sk-or-v1-') && value.length >= 40,
    }
  }

  const publicConfig = () => {
    const settings = readConfig()
    return {
      config: {
        model: settings.model,
        models: settings.models,
        resolution: settings.resolution,
        aspectRatio: settings.aspectRatio,
        duration: settings.duration,
        generateAudio: settings.generateAudio,
        concurrency: settings.concurrency,
        budgetUsd: settings.budgetUsd,
        abortOnExceed: settings.abortOnExceed,
        urlMode: settings.urlMode,
        pollIntervalMs: settings.pollIntervalMs,
        maxPollAttempts: settings.maxPollAttempts,
        splitRatio: settings.splitRatio,
        saveDir: settings.saveDir,
        skills: settings.skills,
        imageBedUrl: settings.imageBedUrl,
        imageBedFolder: settings.imageBedFolder,
        imageBedUserAgent: settings.imageBedUserAgent,
        hasImageBedToken: settings.imageBedToken.length > 0,
        imageBedFrameSeek: settings.imageBedFrameSeek,
        ffmpegPath: settings.ffmpegPath,
        /**
         * The Host's own node registry.
         *
         * The client keeps a MIRROR of this table — it cannot import the Host
         * module — and the Host half does not hot-reload. So "a client newer than
         * the running Host" is a normal, reachable state, and it must not present
         * itself as a node that silently comes back as an empty 注释 with a single
         * text field. Publishing the registry lets the client refuse to offer a
         * type this Host cannot honour, and say why.
         */
        nodeTypes: Object.keys(NODE_TYPES),
      },
      key: keyPreview(),
    }
  }

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  }

  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    try { return JSON.parse(text) } catch { throw new Error('请求体不是合法 JSON') }
  }

  /**
   * The project list, in the ONE shape both the tool and the HTTP route return.
   *
   * It used to be written out twice (the tool's `list` action and the `/graphs`
   * route), which is how a field ends up on one and not the other. A project
   * list the user is about to DELETE from is not the place for that.
   */
  const graphSummaries = () => graphStore.list(40).map((g) => ({
    id: g.id,
    title: g.title,
    updatedAt: g.updatedAt ?? null,
    nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
    edges: Array.isArray(g.edges) ? g.edges.length : 0,
    state: g.run?.state ?? 'idle',
  }))

  /** Project the graph + ledger + live state into what the client renders. */
  async function graphView(graphId) {
    await graphStore.load()
    await jobStore.load()
    const raw = graphStore.get(graphId)
    if (raw === null) return null
    const graph = normalizeGraph(raw)
    const run = runs.get(graphId) ?? null
    const states = run?.states ?? rehydrate(graph, jobStore.byNode(graphId))
    const jobs = jobStore.forGraph(graphId)

    const ceilings = {}
    let ceilingTotal = 0
    let unknownCount = 0
    for (const node of graph.nodes) {
      if (!isNetworkNode(node)) continue
      const entry = catalog.byId[resolveModel(graph, node)] ?? { id: resolveModel(graph, node), pricing_skus: null }
      const result = nodeCeiling({
        model: entry,
        seconds: resolveDuration(graph, node),
        kind: pricingKind(node),
      })
      ceilings[node.id] = result.usd
      if (result.usd === null) unknownCount += 1
      else ceilingTotal += result.usd
    }

    const spent = jobs.reduce((sum, job) => sum + (typeof job.cost === 'number' ? job.cost : 0), 0)
    const durations = shots(graph).map((node) => ({ id: node.id, shotIndex: node.shotIndex, seconds: resolveDuration(graph, node) }))

    return {
      graph,
      states: Object.fromEntries(graph.nodes.map((node) => [node.id, states.get(node.id) ?? NODE_STATE.IDLE])),
      jobs: jobs.map((job) => ({
        id: job.id, nodeId: job.nodeId, status: job.status, cost: job.cost ?? null,
        filePath: job.filePath ?? null, filePathRelative: job.filePathRelative ?? null,
        error: job.error ?? null, model: job.model ?? null,
        // The `seq` node's own receipt: how many shots went in, which are
        // missing, how long the film is. Without it the client can only say
        // "there is a file", which is exactly the sort of half-answer that made
        // a broken export look fine for two films.
        sequence: job.sequence ?? null,
      })),
      ceilings,
      ceilingTotal,
      unknownCount,
      spentUsd: spent,
      budgetUsd: graph.budget.usd,
      counts: summarize(graph, states),
      totalSeconds: durations.reduce((sum, row) => sum + row.seconds, 0),
      running: run?.running === true,
      aborted: run?.control?.aborted === true,
      report: run?.report ?? null,
      catalogLoaded: catalog.loaded,
      catalogError: catalog.error,
    }
  }

  async function handleApi(req, res) {
    // Every request passes DSH's own route gate first. `/graph/run` spends
    // money, so this is its only door.
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== null && rejection !== 0) {
        sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未通过浏览器鉴权，请从 DSH 窗口访问' : '该来源不被信任' })
        return
      }
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = (req.method ?? 'GET').toUpperCase()
    const action = url.pathname.slice(API_PATH.length).replace(/^\/+/u, '')

    try {
      // ---- settings ----
      if (action === 'config' && method === 'GET') return sendJson(res, 200, { ok: true, ...publicConfig() })
      if (action === 'config' && method === 'POST') {
        const body = await readBody(req)
        const patch = body?.config ?? body ?? {}
        const next = {}
        for (const key of WRITABLE) {
          if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
          const value = patch[key]
          if (key === 'apiKey') {
            // A blank key means "leave it alone" — the only way to clear one is DELETE.
            if (typeof value !== 'string' || value.trim().length === 0) continue
            if (!value.trim().startsWith('sk-or-')) throw new Error('密钥形态不对，应以 sk-or- 开头')
            next.apiKey = value.trim()
            continue
          }
          if (key === 'models') {
            // A shortlist, not a catalog dump: deduped, trimmed, and capped so a
            // stray "add every model" click cannot write a 400-entry row.
            if (!Array.isArray(value)) continue
            next.models = [...new Set(value
              .filter((id) => typeof id === 'string' && id.trim().length > 0)
              .map((id) => id.trim()))].slice(0, 60)
            continue
          }
          next[key] = value
        }
        if (Object.keys(next).length > 0) await settingsEditor().update(NS, next)
        return sendJson(res, 200, { ok: true, ...publicConfig() })
      }
      if (action === 'config/key' && method === 'DELETE') {
        await settingsEditor().update(NS, { apiKey: '' })
        return sendJson(res, 200, { ok: true, ...publicConfig() })
      }

      if (action === 'bed/test' && method === 'POST') {
        /*
         * A live probe of the image bed, because the failure mode is invisible
         * from the settings field: a Cloudflare-fronted bed answers 403 with an
         * HTML interstitial to the wrong User-Agent, and the only place that
         * shows up is three shots into a film, as a chained shot that silently
         * became an independent take. Being able to press one button and get
         * "403, HTML, it is the challenge" is worth more than any amount of copy
         * explaining that the User-Agent matters.
         *
         * The request body may carry the UNSAVED draft, so the probe tests what
         * is on screen rather than what was last persisted.
         */
        const body = await readBody(req)
        const settings = readConfig()
        const pick = (value, fallback) =>
          typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
        const baseUrl = pick(body?.url, settings.imageBedUrl).replace(/\/+$/u, '')
        if (baseUrl.length === 0) return sendJson(res, 200, { ok: false, error: '还没有填图床地址' })
        const probe = Buffer.from(PROBE_PNG_BASE64, 'base64')
        const up = await uploadFrame({
          filePath: 'probe.png',
          baseUrl,
          folder: pick(body?.folder, settings.imageBedFolder),
          userAgent: pick(body?.userAgent, settings.imageBedUserAgent),
          token: settings.imageBedToken,
          fileName: 'dsh-openrouter-video-probe.png',
          readFileImpl: async () => probe,
        })
        return sendJson(res, 200, up.ok === true
          ? { ok: true, url: up.url, message: `图床可用，帧的公开地址会形如 ${up.url}` }
          : { ok: false, error: up.error })
      }

      // ---- model catalog (works with no key) ----
      if (action === 'models' && method === 'GET') {
        const force = url.searchParams.get('refresh') === '1'
        await refreshCatalog(force)
        return sendJson(res, 200, {
          ok: true,
          models: catalog.models,
          count: catalog.models.length,
          error: catalog.error,
          loaded: catalog.loaded,
        })
      }

      if (action === 'test' && method === 'GET') {
        const key = url.searchParams.get('key') ?? ''
        try {
          const data = await callApi('/videos/models', { keyOverride: key })
          const count = Array.isArray(data?.data) ? data.data.length : 0
          return sendJson(res, 200, { ok: true, message: `密钥可用，视频模型目录有 ${count} 个模型` })
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: errorMessage(error) })
        }
      }

      // ---- graphs ----
      if (action === 'graphs' && method === 'GET') {
        await graphStore.load()
        return sendJson(res, 200, { ok: true, graphs: graphSummaries() })
      }

      if (action === 'graph/delete' && method === 'POST') {
        /*
         * The workbench could not be CLEARED. Deleting a project was impossible
         * from every direction: no route, no tool action, no button — and the
         * store caches graphs in memory after a single load, so emptying
         * `graphs.json` on disk is undone by the next write. This route is the
         * only honest way to remove a project while the Host is running.
         *
         * It returns the updated list so the client does not have to re-fetch
         * and race its own optimistic render.
         */
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id.length === 0) throw new Error('需要 id')
        await graphStore.load()
        const existed = await graphStore.remove(id)
        if (!existed) return sendJson(res, 404, { ok: false, error: `没有这个图：${id}` })
        return sendJson(res, 200, { ok: true, id, graphs: graphSummaries() })
      }

      if (action === 'graph' && method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const view = await graphView(id)
        if (view === null) return sendJson(res, 404, { ok: false, error: '没有这个图' })
        return sendJson(res, 200, { ok: true, ...view })
      }

      if (action === 'graph' && method === 'POST') {
        const body = await readBody(req)
        const incoming = body?.graph ?? null
        if (incoming === null || typeof incoming !== 'object') throw new Error('需要 graph 字段')
        const graph = normalizeGraph(incoming)
        graph.updatedAt = Date.now()
        const result = validate(graph, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
        if (!result.ok && body?.allowInvalid !== true) {
          return sendJson(res, 200, { ok: false, error: result.errors.map((e) => e.message).join('；'), errors: result.errors, warnings: result.warnings })
        }
        await graphStore.put(graph)
        return sendJson(res, 200, { ok: true, graph, errors: result.errors, warnings: result.warnings })
      }

      if (action === 'graph/new' && method === 'POST') {
        const body = await readBody(req)
        const graph = emptyGraph(typeof body?.title === 'string' ? body.title : '未命名项目')
        const settings = readConfig()
        graph.project = {
          model: settings.model, resolution: settings.resolution, aspectRatio: settings.aspectRatio,
          duration: settings.duration, generateAudio: settings.generateAudio, seed: null,
        }
        graph.concurrency = settings.concurrency
        graph.budget = { usd: settings.budgetUsd, onExceed: settings.abortOnExceed ? 'refuse' : 'warn' }
        await graphStore.put(graph)
        return sendJson(res, 200, { ok: true, graph })
      }

      if (action === 'graph/validate' && method === 'POST') {
        const body = await readBody(req)
        const raw = body?.graph ?? (typeof body?.id === 'string' ? graphStore.get(body.id) : null)
        if (raw === null || raw === undefined) throw new Error('需要 graph 或 id')
        const graph = normalizeGraph(raw)
        await refreshCatalog(false)
        const result = validate(graph, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
        // Pricing runs here and ONLY here in the validate path — no submission.
        const network = graph.nodes.filter(isNetworkNode)
        const ceilings = network.map((node) => {
          const entry = catalog.byId[resolveModel(graph, node)] ?? { id: resolveModel(graph, node), pricing_skus: null }
          const priced = nodeCeiling({ model: entry, seconds: resolveDuration(graph, node), kind: pricingKind(node) })
          return { nodeId: node.id, model: resolveModel(graph, node), seconds: resolveDuration(graph, node), usd: priced.usd, source: priced.source, reason: priced.reason }
        })
        const known = ceilings.filter((row) => row.usd !== null)
        const total = known.reduce((sum, row) => sum + row.usd, 0)
        const settings = readConfig()
        return sendJson(res, 200, {
          ok: result.ok,
          errors: result.errors,
          warnings: result.warnings,
          ceilings,
          ceilingTotal: total,
          unknownCount: ceilings.length - known.length,
          budgetUsd: settings.budgetUsd,
          overBudget: settings.abortOnExceed && total > settings.budgetUsd,
          totalSeconds: network.reduce((sum, node) => sum + resolveDuration(graph, node), 0),
        })
      }

      if (action === 'graph/run' && method === 'POST') {
        const body = await readBody(req)
        const id = body?.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('需要 id')
        await graphStore.load()
        const stored = graphStore.get(id)
        if (stored === null) throw new Error('没有这个图')
        const graph = normalizeGraph(stored)
        await refreshCatalog(false)
        const result = validate(graph, { catalog: catalog.loaded ? catalog : null, imageBed: readConfig().imageBedUrl.length > 0 })
        if (!result.ok) {
          return sendJson(res, 200, { ok: false, error: result.errors.map((e) => e.message).join('；'), errors: result.errors })
        }
        const cwd = typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : process.cwd()
        /* `retry_failed` was reachable from the agent tool and from the executor and
           from nowhere else, so the workspace could not retry a dead shot at all:
           with retryFailed false a failed node short-circuits and the run ends, and
           clicking run again skipped it for ever. It is the same flag, read from the
           same place the tool reads it. */
        const { report } = await startRun(graph, {
          cwd,
          only: Array.isArray(body?.only) ? body.only : null,
          fresh: body?.retry_failed === true,
        })
        return sendJson(res, 200, { ok: true, ...(await graphView(id)), report })
      }

      if (action === 'graph/abort' && method === 'POST') {
        const body = await readBody(req)
        const id = body?.id
        const run = runs.get(id)
        if (run === undefined) return sendJson(res, 200, { ok: false, error: '这个图当前没有在跑' })
        run.control.aborted = true
        return sendJson(res, 200, {
          ok: true,
          message: '已停止派发新节点。正在生成的任务在 OpenRouter 侧继续运行并继续计费，无法取消。',
        })
      }

      if (action === 'graph/state' && method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const view = await graphView(id)
        if (view === null) return sendJson(res, 404, { ok: false, error: '没有这个图' })
        return sendJson(res, 200, { ok: true, ...view })
      }

      // ---- job ledger ----
      if (action === 'jobs' && method === 'GET') {
        await jobStore.load()
        const limit = Number(url.searchParams.get('limit'))
        return sendJson(res, 200, { ok: true, jobs: jobStore.list(Number.isFinite(limit) ? limit : 100) })
      }

      if (action === 'content' && method === 'GET') {
        // NOT a general file reader: the id must exist in the ledger and the
        // path must be the one the plugin itself wrote.
        await jobStore.load()
        const id = url.searchParams.get('id') ?? ''
        const job = jobStore.find(id)
        if (job === null) return sendJson(res, 404, { ok: false, error: '没有这个任务记录' })
        if (typeof job.filePath !== 'string' || job.filePath.length === 0) {
          return sendJson(res, 404, { ok: false, error: '这个任务还没有落盘文件' })
        }
        try {
          const bytes = await readFile(job.filePath)
          res.statusCode = 200
          res.setHeader('Content-Type', job.mediaType ?? 'video/mp4')
          res.setHeader('Cache-Control', 'no-store')
          res.end(bytes)
        } catch (error) {
          sendJson(res, 404, { ok: false, error: `读不到文件：${errorMessage(error)}` })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${action}` })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: errorMessage(error) })
    }
  }

  const registerRoute = (service) => {
    if (service === undefined) return
    ctx.effect(() => service.register({ kind: 'prefix', path: API_PATH, handler: handleApi }), 'openrouter-video: api route')
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) registerRoute(webServer)
  else ctx.inject(['webServer'], (webCtx) => registerRoute(webCtx.get('webServer')))

  // Pick up anything that was in flight when DSH last stopped. Deliberately not
  // awaited: resuming must never delay plugin activation.
  void resumeInFlight()

  /* ---- bundled skill ---- */

  if (readConfig().skills !== false) {
    try {
      ctx.plugin(bufferedSkill)
    } catch (error) {
      console.warn(`[openrouter-video] bundled skill not registered: ${errorMessage(error)}`)
    }
  }
}

export const name = 'openrouter-video'

/**
 * Cordis gates the *property* form (`ctx.tools`) behind `inject`: without this,
 * `ctx.tools.register(...)` throws `cannot get property "tools" without inject`
 * while `apply` runs, which marks the whole fiber `failed` — and the visible
 * symptom is a 404 on the route rather than a crash, which is the most
 * expensive lesson in the reference implementation's notes.
 *
 * Everything else — `webServer`, `connection`, `settings`, `attachments` — is
 * read through `ctx.get(...)`, which does not need declaring.
 */
export const inject = ['tools']

export {
  normalizeGraph, validate, canConnect, runGraph, rehydrate, summarize,
  nodeCeiling, describePricing, JobStore, GraphStore,
  NODE_TYPES, NETWORK_TYPES, SHOT_TYPES, GRAPH_VERSION,
  /* Pure and easy to get quietly wrong (it names every delivered file), so it is
     reachable from a test rather than only from a real 30-second render. */
  fileStem,
  /* The composer's cache rule. Exported for the same reason: the bug it now
     encodes (an incomplete film cached as final) is invisible until a user
     finishes a failed shot and watches the film not change. */
  sequenceIsCurrent,
}