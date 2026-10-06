/**
 * 成片序列: turn N finished clips into one film, on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `seq` node was the one piece of the graph that was pure decoration. It sat
 * on the canvas, accepted a `jobs` fan-in from every shot, was validated, was
 * counted, and produced **nothing**: it is a local node, and the executor's
 * scheduler only ever dispatches network nodes. Both finished 60-second films in
 * this workspace were concatenated by hand with an ffmpeg command line that
 * lived in a shell history, not in the plugin.
 *
 * That is the same failure mode as the `take` node before the frame hand-off was
 * wired up — a shape that draws a promise the runtime does not keep — and it is
 * worse here, because the promise is the *deliverable*. A graph that renders 12
 * shots and cannot hand back a film has not done the job.
 *
 * WHAT IT DOES
 * ------------
 * Probe every clip, then pick the cheapest concat that is actually correct:
 *
 *   1. **copy** — when every clip already agrees on codec, resolution and
 *      audio presence, remux them with the concat demuxer and `-c copy`. No
 *      re-encode, no generation loss, seconds instead of minutes.
 *   2. **normalize** — otherwise re-encode each clip to a common profile
 *      (largest even width/height, padded rather than cropped, a silent stereo
 *      track added where a clip has no audio) and *then* copy-concat. Fixing
 *      the inputs first is what makes the copy step safe; concatenating
 *      mismatched streams directly is how a film ends up with a track that
 *      plays silence for half its length.
 *
 * A `manifest.json` is written next to the film, because "which take of shot 7
 * is in this cut" is a question the film itself cannot answer.
 *
 * Everything process-shaped is injectable, so the tests prove the behaviour with
 * neither ffmpeg nor the filesystem.
 */
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** Round down to the nearest even integer — H.264 chroma planes require it. */
export function even(value) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 2) return 2
  return parsed % 2 === 0 ? parsed : parsed - 1
}

/**
 * Where to find `ffprobe`, given the configured `ffmpegPath`.
 *
 * The plugin only ever had a setting for ffmpeg, because only ffmpeg was ever
 * needed. Composing a film needs ffprobe too, and they ship together — so
 * deriving it from ffmpeg's own path is more reliable than a second setting the
 * user has to discover and fill in. A bare `ffmpeg` stays bare `ffprobe` and
 * resolves on PATH, which is what makes the WinGet install work unchanged.
 */
export function ffprobeFrom(ffmpegPath) {
  const raw = typeof ffmpegPath === 'string' && ffmpegPath.trim().length > 0 ? ffmpegPath.trim() : 'ffmpeg'
  const dir = dirname(raw)
  const base = basename(raw)
  if (!/^ffmpeg(\.exe)?$/iu.test(base)) return 'ffprobe'
  const probe = base.replace(/^ffmpeg/iu, 'ffprobe')
  return dir === '.' || dir.length === 0 ? probe : join(dir, probe)
}

/** `"24/1"` → 24. `avg_frame_rate` is a rational string, and `"0/0"` is normal. */export function parseRate(value) {
  const text = String(value ?? '')
  const [numerator, denominator] = text.split('/')
  const top = Number(numerator)
  const bottom = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return null
  return top / bottom
}

/**
 * The concat demuxer's list format.
 *
 * Paths go in single quotes, so a quote inside a path has to be closed, escaped
 * and reopened. Backslashes are flipped to forward slashes because a Windows
 * path in a quoted concat entry is one of the few places ffmpeg's own escaping
 * rules still surprise you.
 */
export function escapeConcatPath(filePath) {
  return String(filePath ?? '').replace(/\\/gu, '/').replace(/'/gu, "'\\''")
}

export function concatListContent(paths) {
  return `${paths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n')}\n`
}

/**
 * `-c copy` concat. `-safe 0` is required for the absolute paths the plugin
 * writes; without it the demuxer silently refuses every entry.
 */
export function concatArgs({ listPath, outPath }) {
  return [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ]
}

/**
 * Re-encode one clip onto the common profile.
 *
 * `pad` rather than `crop`: cropping a shot to fit would silently reframe it,
 * and a film whose framing changes between shots for no editorial reason is a
 * worse outcome than two black bars.
 */
export function normalizeArgs({ input, output, profile }) {
  const { width, height, fps, hasAudio } = profile
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease`
  const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  const args = ['-y', '-v', 'error', '-i', input]
  // A clip with no audio track gets silent stereo, so every input to the copy
  // step has the same stream layout.
  if (hasAudio !== true) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
  args.push(
    '-vf', `${scale},${pad},setsar=1,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  )
  if (hasAudio === true) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  } else {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  }
  args.push('-movflags', '+faststart', output)
  return args
}

/** ffprobe one clip. Returns a row rather than throwing: a bad clip must name itself. */
export async function probeClip({ filePath, ffprobePath = 'ffprobe', run = defaultRun }) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: '探测失败：没有文件路径' }
  }
  let stdout
  try {
    const result = await run(ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ])
    stdout = result?.stdout ?? result
  } catch (error) {
    return { ok: false, error: `探测失败：${message(error)}` }
  }
  let data
  try {
    data = JSON.parse(String(stdout ?? ''))
  } catch {
    return { ok: false, error: '探测失败：ffprobe 没有返回 JSON' }
  }
  const streams = Array.isArray(data?.streams) ? data.streams : []
  const video = streams.find((stream) => stream?.codec_type === 'video') ?? null
  if (video === null) return { ok: false, error: '探测失败：这个文件里没有视频流' }
  const audio = streams.find((stream) => stream?.codec_type === 'audio') ?? null
  return {
    ok: true,
    codec: typeof video.codec_name === 'string' ? video.codec_name : null,
    width: even(video.width),
    height: even(video.height),
    fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate) ?? 24,
    hasAudio: audio !== null,
    durationSec: Number(data?.format?.duration) || Number(video.duration) || 0,
  }
}

/**
 * Turn a `seq` node's upstream into "what to cut" and "what is missing".
 *
 * Ordering is `shotIndex`, NOT topology. Generation order and film order are two
 * different axes in this workspace and collapsing them is the mistake the graph
 * schema was built to prevent; a film cut in dispatch order would reorder itself
 * whenever the scheduler picked a different ready node.
 *
 * A shot that failed is reported in `missing` and does NOT stop the export.
 * Refusing to produce anything until every shot is perfect means one
 * guardrail-blocked render costs you the other eleven — with each shot being a
 * separately paid call, that is the worst possible trade. The caller names the
 * missing shots in the receipt instead of staying silent about a short film.
 *
 * @param {Array<{id:string, node:object|null, job:object|null}>} rows
 * @param {Set<string>} shotTypes  which node types carry an editorial position
 */
export function orderClips(rows, shotTypes) {
  const fed = (Array.isArray(rows) ? rows : [])
    .filter((row) => row !== null && row !== undefined && row.node !== null && row.node !== undefined)
    .filter((row) => shotTypes.has(row.node.type))
    .sort((a, b) => ((a.node.shotIndex ?? 1e9) - (b.node.shotIndex ?? 1e9))
      || String(a.id).localeCompare(String(b.id)))

  const clips = []
  const missing = []
  for (const row of fed) {
    const job = row.job
    if (job !== null && job !== undefined && job.status === 'completed'
      && typeof job.filePath === 'string' && job.filePath.length > 0) {
      clips.push({
        filePath: job.filePath,
        nodeId: row.id,
        shotIndex: row.node.shotIndex ?? null,
        model: job.model ?? null,
        title: typeof row.node.title === 'string' ? row.node.title : null,
      })
    } else {
      missing.push(row.id)
    }
  }
  return { clips, missing, expected: fed.length }
}

/** The common profile every clip will be forced onto. Largest wins; padding fills the rest. */export function commonProfile(probed) {
  return {
    width: even(Math.max(...probed.map((clip) => clip.width))),
    height: even(Math.max(...probed.map((clip) => clip.height))),
    fps: Math.max(...probed.map((clip) => clip.fps || 24)) || 24,
    hasAudio: probed.some((clip) => clip.hasAudio === true),
  }
}

/**
 * Do these clips already share a stream layout?
 *
 * Audio presence has to match too. Two clips of the same codec where one has an
 * audio track and one does not will copy-concat into a film that plays silence
 * from the second clip onward — no error, no warning, just a broken track.
 */
export function isUniform(probed) {
  if (probed.length === 0) return true
  const first = probed[0]
  return probed.every((clip) =>
    clip.codec === first.codec
    && clip.width === first.width
    && clip.height === first.height
    && clip.hasAudio === first.hasAudio)
}

/**
 * Concatenate `clips` into `outPath`.
 *
 * @param {object} options
 * @param {Array<{filePath:string, nodeId?:string, shotIndex?:number|null, model?:string|null, title?:string}>} options.clips
 *   In film order. The caller owns the ordering — this module has no opinion
 *   about what "shot 7" means.
 * @param {string} options.outPath             absolute path of the film to write
 * @param {string} options.workDir             scratch dir for the concat list + intermediates
 * @param {string} [options.manifestPath]      where to write the JSON manifest
 * @param {string} [options.ffmpegPath]
 * @param {string} [options.ffprobePath]
 * @param {(file:string,args:string[])=>Promise<{stdout?:string}>} [options.run]
 * @param {object} [options.fs]
 * @param {object} [options.fsx]               extra fs injection: {stat}
 * @param {string} [options.title]
 * @returns {Promise<{ok:boolean, filePath?:string, bytes?:number, durationSec?:number,
 *   mode?:string, manifest?:object, manifestPath?:string|null, error?:string}>}
 */
export async function composeSequence(options) {
  const {
    clips,
    outPath,
    workDir,
    manifestPath = null,
    ffmpegPath = 'ffmpeg',
    ffprobePath = 'ffprobe',
    run = defaultRun,
    title = null,
    fs = { mkdir, writeFile, rm },
    fsx = { stat },
  } = options

  if (!Array.isArray(clips) || clips.length === 0) {
    return { ok: false, error: '没有可拼接的镜头：成片需要至少一条已完成的镜头' }
  }
  if (typeof outPath !== 'string' || outPath.length === 0) {
    return { ok: false, error: '没有给出成片输出路径' }
  }

  const probed = []
  for (const clip of clips) {
    const info = await probeClip({ filePath: clip.filePath, ffprobePath, run })
    if (info.ok !== true) {
      return { ok: false, error: `${clip.nodeId ?? clip.filePath}：${info.error}` }
    }
    probed.push({ ...clip, ...info })
  }

  const profile = commonProfile(probed)
  const mode = isUniform(probed) ? 'copy' : 'normalize'
  const scratch = typeof workDir === 'string' && workDir.length > 0 ? workDir : dirname(outPath)

  try {
    await fs.mkdir(scratch, { recursive: true })
    await fs.mkdir(dirname(outPath), { recursive: true })
  } catch (error) {
    return { ok: false, error: `成片失败：无法创建输出目录（${message(error)}）` }
  }

  /*
   * Absolute paths, always.
   *
   * The concat demuxer resolves a RELATIVE entry against the LIST FILE's own
   * directory, not against the process working directory. A list written into
   * `<saveDir>/.sequence-work/` that holds `generated-videos/s05.mp4` therefore
   * becomes `<saveDir>/.sequence-work/generated-videos/s05.mp4`, and ffmpeg fails
   * with "Impossible to open" — which is precisely what the first real run of
   * this module produced, on the twelve paid shots it was written to assemble.
   * Resolving here means the caller can pass whichever form it happens to have.
   */
  let list = probed.map((clip) => resolve(clip.filePath))
  if (mode === 'normalize') {
    list = []
    for (let index = 0; index < probed.length; index += 1) {
      const target = resolve(join(scratch, `norm_${String(index).padStart(3, '0')}.mp4`))
      try {
        await run(ffmpegPath, normalizeArgs({ input: probed[index].filePath, output: target, profile }))
      } catch (error) {
        return { ok: false, error: `成片失败：${probed[index].nodeId ?? `第 ${index + 1} 条`} 转码出错（${message(error)}）` }
      }
      list.push(target)
    }
  }

  const listPath = resolve(join(scratch, 'concat.txt'))
  try {
    await fs.writeFile(listPath, concatListContent(list))
    await run(ffmpegPath, concatArgs({ listPath, outPath }))
  } catch (error) {
    return { ok: false, error: `成片失败：拼接出错（${message(error)}）` }
  }

  let bytes = null
  try {
    bytes = (await fsx.stat(outPath)).size
  } catch (error) {
    return { ok: false, error: `成片失败：拼接后读不到输出文件（${message(error)}）` }
  }

  const durationSec = probed.reduce((sum, clip) => sum + (Number(clip.durationSec) || 0), 0)
  const manifest = {
    title,
    film: outPath,
    createdAt: new Date().toISOString(),
    mode,
    profile,
    clipCount: probed.length,
    durationSec,
    clips: probed.map((clip) => ({
      nodeId: clip.nodeId ?? null,
      shotIndex: clip.shotIndex ?? null,
      title: clip.title ?? null,
      model: clip.model ?? null,
      filePath: clip.filePath,
      durationSec: clip.durationSec,
      width: clip.width,
      height: clip.height,
      codec: clip.codec,
      hasAudio: clip.hasAudio,
    })),
  }

  if (typeof manifestPath === 'string' && manifestPath.length > 0) {
    try {
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    } catch (error) {
      // The film exists; a missing manifest is a degraded receipt, not a failed
      // export. Report it through the manifest path being null.
      return { ok: true, filePath: outPath, bytes, durationSec, mode, manifest, manifestPath: null, warning: `清单写入失败：${message(error)}` }
    }
  }

  // Intermediates are worthless once the copy-concat has run.
  if (mode === 'normalize') await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})

  return { ok: true, filePath: outPath, bytes, durationSec, mode, manifest, manifestPath }
}

function message(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr ?? '').trim() || message(error)))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export const sequenceInternals = { even, parseRate, escapeConcatPath, concatListContent, concatArgs, normalizeArgs, commonProfile, isUniform, orderClips, ffprobeFrom, defaultRun }
