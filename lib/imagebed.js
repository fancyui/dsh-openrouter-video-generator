/**
 * Frame hand-off: turn a finished clip into a public image URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other continuity mechanism the API offers is closed to us:
 *
 *   - `previous_job_id` — the only model that prices it (`flux-3-video`) is
 *     blocked by the workspace guardrail, and `seedance-2.5` answers 400
 *     `does not support previous_job_id`;
 *   - a video reference — `/videos/{id}/content` is bearer-guarded, so a
 *     provider cannot fetch it (401 without the key, and handing our key to a
 *     third-party host is not an option);
 *   - `take` 取帧 — the node existed in the canvas, was drawable and
 *     connectable, and produced nothing: `take` is a `process` node, so the
 *     executor never dispatched it and `job.frameUrl` was read but never
 *     written.
 *
 * What IS left is an IMAGE: sample a frame from the clip that just finished and
 * hand it to the next shot as its first (or last) frame. That works, and it is
 * the only mechanism measured to survive end to end (`frames` port →
 * `frame_images`).
 *
 * The API accepts only a **public https URL** there — no local path, no data
 * URL. So this module has exactly two jobs: cut the frame out with ffmpeg, and
 * put it somewhere a provider can fetch without our credentials.
 *
 * Everything process- and network-shaped is injectable, so the tests can prove
 * the behaviour with neither ffmpeg, nor a network, nor money.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** The two frame slots the API understands. */
export const FRAME_SLOTS = ['first_frame', 'last_frame']

/** How far back to seek before dumping frames, when fishing for the last one. */
export const DEFAULT_FRAME_SEEK_SECONDS = 0.6

/** Guard against runaway recursion on a hostile response body. */
const MAX_PICK_DEPTH = 6

/**
 * The ffmpeg plan for one frame.
 *
 * `first_frame` is exact: the first decoded frame is the first frame.
 *
 * `last_frame` is deliberately NOT `-sseof -0.15` + `-frames:v 1`. That idiom
 * yields the first frame *at or after* the seek point — i.e. a frame from
 * several frames before the end. Measured on a 24 fps clip, the frame it
 * returned scored SSIM 0.928 against the true final frame: close enough to look
 * right in isolation, and exactly the kind of quiet inaccuracy that makes a
 * seam almost seamless.
 *
 * Instead we seek back a fraction of a second, dump the whole tail as an image
 * sequence, and take the LAST file written. That is byte-identical to the true
 * final frame (SSIM 1.000000, verified against an exhaustive `reverse` decode).
 * The tail is ~15 files, so it stays cheap even for a 15-second clip.
 *
 * @returns {{mode:'single'|'sequence', parts:string|null, args:string[]}}
 */
export function framePlan({ videoPath, which = 'first_frame', outPath, seekSeconds = DEFAULT_FRAME_SEEK_SECONDS }) {
  if (which === 'last_frame') {
    const parts = `${outPath}.parts`
    const back = Number.isFinite(Number(seekSeconds)) && Number(seekSeconds) > 0
      ? Number(seekSeconds)
      : DEFAULT_FRAME_SEEK_SECONDS
    return {
      mode: 'sequence',
      parts,
      args: ['-y', '-v', 'error', '-sseof', `-${back}`, '-i', videoPath, join(parts, 'f_%05d.png')],
    }
  }
  return {
    mode: 'single',
    parts: null,
    args: ['-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-update', '1', outPath],
  }
}

/** Best public URL in an image-bed response. `[{src}]`, `{url}`, `{data:{src}}` all occur. */
export function pickUrl(payload, depth = 0) {
  if (depth > MAX_PICK_DEPTH) return null
  if (typeof payload === 'string') return /^https?:\/\//iu.test(payload) ? payload : null
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = pickUrl(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  if (payload === null || typeof payload !== 'object') return null
  // Ordered: a response may carry several urls and the asset is the first one.
  // Falling through to a thumbnail would silently chain from the wrong image.
  for (const key of ['src', 'url', 'location', 'image', 'data', 'result', 'files']) {
    if (!(key in payload)) continue
    const found = pickUrl(payload[key], depth + 1)
    if (found !== null) return found
  }
  return null
}

/** The upload endpoint, with folder and response shape as query parameters. */
export function uploadUrl(baseUrl, folder) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/u, '')
  if (base.length === 0) return null
  return `${base}/upload?uploadFolder=${encodeURIComponent(folder ?? 'test')}&returnFormat=full`
}

/**
 * Cut one frame out of a local clip, to exactly `outPath`.
 *
 * @returns {Promise<{ok:boolean, filePath?:string, error?:string}>}
 */
export async function extractFrame(options) {
  const {
    videoPath,
    which = 'first_frame',
    outPath,
    seekSeconds = DEFAULT_FRAME_SEEK_SECONDS,
    ffmpegPath = 'ffmpeg',
    run = defaultRun,
    fs = { mkdir, readdir, rename, rm },
  } = options

  if (typeof videoPath !== 'string' || videoPath.length === 0) {
    return { ok: false, error: '取帧失败：上游没有可用的本地文件' }
  }
  if (typeof outPath !== 'string' || outPath.length === 0) {
    return { ok: false, error: '取帧失败：没有给出输出路径' }
  }

  const plan = framePlan({ videoPath, which, outPath, seekSeconds })
  try {
    await fs.mkdir(dirname(outPath), { recursive: true })
    if (plan.parts !== null) await fs.mkdir(plan.parts, { recursive: true })
  } catch (error) {
    return { ok: false, error: `取帧失败：无法创建输出目录（${message(error)}）` }
  }

  try {
    await run(ffmpegPath, plan.args)
  } catch (error) {
    return { ok: false, error: `取帧失败：ffmpeg 返回错误（${message(error)}）` }
  }

  if (plan.mode === 'single') return { ok: true, filePath: outPath }

  // Sequence mode: the last file written is the true last frame.
  try {
    const names = (await fs.readdir(plan.parts)).filter((name) => name.endsWith('.png')).sort()
    if (names.length === 0) return { ok: false, error: '取帧失败：ffmpeg 没有写出任何帧' }
    await fs.rename(join(plan.parts, names[names.length - 1]), outPath)
  } catch (error) {
    return { ok: false, error: `取帧失败：整理输出时出错（${message(error)}）` }
  } finally {
    const drop = typeof fs.rm === 'function' ? fs.rm : rm
    await drop(plan.parts, { recursive: true, force: true }).catch(() => {})
  }
  return { ok: true, filePath: outPath }
}

/**
 * Put one image on a public image bed and return its URL.
 *
 * The `User-Agent` is not cosmetic. The bed in use fronts itself with a
 * Cloudflare Managed Challenge that answers 403 + an HTML interstitial to every
 * ordinary client and lets exactly one agent string through, so a plain request
 * fails in a way that looks like a bad endpoint. A 403 whose body is HTML is
 * therefore reported as the challenge it is, not parsed as JSON.
 *
 * @returns {Promise<{ok:boolean, url?:string, error?:string}>}
 */
export async function uploadFrame(options) {
  const {
    filePath,
    baseUrl,
    folder = 'test',
    userAgent = 'gobelagent',
    token = null,
    fileName = null,
    fetchImpl = globalThis.fetch,
    readFileImpl = readFile,
  } = options

  const endpoint = uploadUrl(baseUrl, folder)
  if (endpoint === null) {
    return { ok: false, error: '上传失败：没有配置图床地址（imageBedUrl），首尾帧续接无法进行' }
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: '上传失败：当前运行时没有 fetch' }
  }

  let bytes
  try {
    bytes = await readFileImpl(filePath)
  } catch (error) {
    return { ok: false, error: `上传失败：读不到帧文件（${message(error)}）` }
  }

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), fileName ?? basename(filePath))

  const headers = {}
  if (typeof userAgent === 'string' && userAgent.length > 0) headers['User-Agent'] = userAgent
  if (typeof token === 'string' && token.length > 0) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetchImpl(endpoint, { method: 'POST', body: form, headers })
  } catch (error) {
    return { ok: false, error: `上传失败：${message(error)}（${endpoint}）` }
  }

  const contentType = String(response?.headers?.get?.('content-type') ?? '')
  const text = await safeText(response)

  if (contentType.includes('text/html')) {
    return {
      ok: false,
      error: '上传失败：图床返回了 HTML 而不是 JSON（多半是 Cloudflare 校验页）。'
        + `请确认 User-Agent 为 ${userAgent}，或改用无需校验的图床。（${endpoint}）`,
    }
  }

  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: `上传失败：响应不是 JSON（HTTP ${response?.status ?? '?'}）：${text.slice(0, 160)}` }
  }

  const url = pickUrl(payload)
  if (url === null) {
    return { ok: false, error: `上传失败：响应里没有可用的 URL：${text.slice(0, 160)}` }
  }
  return { ok: true, url }
}

/**
 * Cut a frame and publish it, in one step: the whole chain — command
 * construction, tail pick, upload, URL extraction — is testable with an
 * injected `run` and `fetchImpl`.
 */
export async function cutAndPublish(options) {
  const {
    videoPath,
    which = 'first_frame',
    outPath,
    fileName = null,
    config = {},
    extract = extractFrame,
    upload = uploadFrame,
  } = options

  const cut = await extract({
    videoPath,
    which,
    outPath,
    seekSeconds: config.imageBedFrameSeek,
    ffmpegPath: config.ffmpegPath,
  })
  if (!cut.ok) return cut

  const up = await upload({
    filePath: cut.filePath,
    baseUrl: config.imageBedUrl,
    folder: config.imageBedFolder,
    userAgent: config.imageBedUserAgent,
    token: config.imageBedToken,
    fileName,
  })
  if (!up.ok) return { ok: false, error: up.error, filePath: cut.filePath }
  return { ok: true, url: up.url, filePath: cut.filePath }
}

function message(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

async function safeText(response) {
  try {
    return await response.text()
  } catch (error) {
    return `<读取响应失败：${message(error)}>`
  }
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr ?? '').trim() || message(error)))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export const imagebedInternals = { framePlan, pickUrl, uploadUrl, defaultRun }
