/**
 * 成片序列 tests: `lib/sequence.js` plus the executor hook that drives it.
 *
 * The `seq` node was the last shape on the canvas that promised something and
 * delivered nothing — it drew a fan-in from every shot, validated, and produced
 * no file, because it is a LOCAL node and the scheduler only ever dispatches
 * network nodes. Both finished films in this workspace were concatenated by hand
 * from a shell. So the assertions here are about the two things that decide
 * whether an automated export is trustworthy:
 *
 *   - **the cheap path is only taken when it is actually correct.** `-c copy`
 *     on clips that disagree about audio presence produces a film that plays
 *     silence, with no error anywhere;
 *   - **film order is `shotIndex`, not topology**, and a missing shot is named
 *     instead of silently shrinking the film.
 *
 * Run: node test-sequence.mjs
 */
import assert from 'node:assert/strict'
import { basename, isAbsolute } from 'node:path'
import {
  even, parseRate, escapeConcatPath, concatListContent, concatArgs, normalizeArgs,
  commonProfile, isUniform, orderClips, ffprobeFrom, probeClip, composeSequence,
} from './lib/sequence.js'
import { runGraph, rehydrate, NODE_STATE } from './lib/exec.js'
import { emptyGraph, normalizeGraph, SHOT_TYPES, upstreamOf } from './lib/graph.js'

let passed = 0
let failed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

/** Pull the paths back out of a concat list. */
const listEntries = (content) => String(content).trim().split('\n')
  .map((line) => line.replace(/^file '/u, '').replace(/'$/u, ''))

/** The composer resolves its own scratch paths, so look outputs up by suffix. */
const writtenEndingWith = (map, suffix) => {
  for (const [key, value] of map) if (key.endsWith(suffix)) return value
  return undefined
}
const concatListOf = (h) => writtenEndingWith(h.written, 'concat.txt')

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

/** One ffprobe-shaped payload. */
const probe = ({ codec = 'h264', width = 1280, height = 720, fps = '24/1', audio = true, duration = 5 } = {}) => ({
  streams: [
    { codec_type: 'video', codec_name: codec, width, height, avg_frame_rate: fps, duration: String(duration) },
    ...(audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
  ],
  format: { duration: String(duration) },
})

/**
 * An injected `run` that answers probes from a table and records every ffmpeg
 * invocation. Nothing touches ffmpeg, the network, or the filesystem.
 */
function harness(probes = {}) {
  const calls = []
  const run = async (file, args) => {
    calls.push({ file, args })
    if (String(file).includes('ffprobe')) {
      const target = args[args.length - 1]
      const info = probes[target]
      if (info === undefined) throw new Error(`no probe fixture for ${target}`)
      if (info === 'boom') throw new Error('ffprobe exploded')
      if (info === 'notjson') return { stdout: 'this is not json' }
      return { stdout: JSON.stringify(info) }
    }
    return { stdout: '' }
  }
  const written = new Map()
  const state = { filmMissing: false, mode: null }
  const key = (path) => String(path).replace(/\\/gu, '/')
  const fs = {
    mkdir: async () => {},
    writeFile: async (path, content) => { written.set(key(path), content) },
    rm: async () => {},
  }
  const fsx = {
    stat: async (path) => {
      if (state.filmMissing && String(path).endsWith('.mp4')) {
        const error = new Error('ENOENT: no such file')
        error.code = 'ENOENT'
        throw error
      }
      return { size: 4096 }
    },
  }
  return { run, calls, written, fs, fsx, state, ffmpegCalls: () => calls.filter((call) => !String(call.file).includes('ffprobe')) }
}

/* ------------------------------------------------------------------ *
 * command construction
 * ------------------------------------------------------------------ */

test('even() rounds down, because H.264 chroma planes need even dimensions', () => {
  assert.equal(even(1281), 1280)
  assert.equal(even(1280), 1280)
  assert.equal(even(1), 2)
  assert.equal(even(undefined), 2)
})

test('parseRate handles rational frame rates and the 0/0 a still image reports', () => {
  assert.equal(parseRate('24/1'), 24)
  assert.equal(parseRate('30000/1001'), 30000 / 1001)
  assert.equal(parseRate('24'), 24)
  assert.equal(parseRate('0/0'), null, 'a variable-frame-rate stream must not become fps 0')
  assert.equal(parseRate(''), null)
})

test('the concat list escapes quotes and flips Windows backslashes', () => {
  // A raw `file 'C:\a\b.mp4'` is the single most common concat-demuxer failure:
  // the backslashes are escape characters inside the quoted entry.
  assert.equal(escapeConcatPath('C:\\v\\a.mp4'), 'C:/v/a.mp4')
  assert.equal(escapeConcatPath("C:/v/it's.mp4"), "C:/v/it'\\''s.mp4")
  assert.equal(concatListContent(['a.mp4', 'b.mp4']), "file 'a.mp4'\nfile 'b.mp4'\n")
})

test('copy-concat passes -safe 0, without which every absolute path is refused', () => {
  const args = concatArgs({ listPath: 'work/concat.txt', outPath: 'film.mp4' })
  assert.ok(args.includes('-f') && args.includes('concat'))
  const safe = args.indexOf('-safe')
  assert.notEqual(safe, -1)
  assert.equal(args[safe + 1], '0')
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy',
    'the whole point is not re-encoding clips that already agree')
})

test('normalize PADS to fit rather than cropping the shot', () => {
  const args = normalizeArgs({
    input: 'a.mp4',
    output: 'n.mp4',
    profile: { width: 1280, height: 720, fps: 24, hasAudio: true },
  })
  const filter = args[args.indexOf('-vf') + 1]
  assert.match(filter, /pad=1280:720/u, 'a tall shot gets bars, not a reframe')
  assert.ok(!filter.includes('crop='), 'cropping would silently reframe the shot')
  assert.match(filter, /force_original_aspect_ratio=decrease/u)
  assert.ok(args.includes('-pix_fmt') && args[args.indexOf('-pix_fmt') + 1] === 'yuv420p')
})

test('a silent clip gets a synthetic stereo track so the copy step stays uniform', () => {
  const args = normalizeArgs({
    input: 'a.mp4',
    output: 'n.mp4',
    profile: { width: 640, height: 480, fps: 24, hasAudio: false },
  })
  assert.ok(args.includes('-f') && args.includes('lavfi'), 'anullsrc generates the silent track')
  assert.ok(args.includes('-shortest'), 'otherwise the infinite silence never ends')
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0'])
})

test('ffprobe is derived from ffmpegPath instead of being a second setting to find', () => {
  // Assertions are path-separator agnostic: the point is that the sibling binary
  // is derived, not that Windows and POSIX agree on how to join a directory.
  assert.equal(ffprobeFrom('ffmpeg'), 'ffprobe')
  assert.equal(ffprobeFrom('ffmpeg.exe'), 'ffprobe.exe')
  assert.match(ffprobeFrom('C:\\WinGet\\Links\\ffmpeg.exe'), /ffprobe\.exe$/u)
  assert.match(ffprobeFrom('/usr/local/bin/ffmpeg'), /ffprobe$/u)
  assert.ok(!ffprobeFrom('/usr/local/bin/ffmpeg').includes('ffmpeg'))
  assert.equal(ffprobeFrom(''), 'ffprobe')
  assert.equal(ffprobeFrom('my-encoder'), 'ffprobe', 'an unknown binary falls back to PATH')
})

/* ------------------------------------------------------------------ *
 * probeClip
 * ------------------------------------------------------------------ */

test('probeClip reads the video stream, not merely the first stream', async () => {
  const { run } = harness({ 'a.mp4': { streams: [{ codec_type: 'audio' }, { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1081, avg_frame_rate: '25/1' }], format: { duration: '6.4' } } })
  const info = await probeClip({ filePath: 'a.mp4', run })
  assert.equal(info.ok, true)
  assert.equal(info.codec, 'hevc')
  assert.equal(info.height, 1080, 'odd dimensions are made even before anything uses them')
  assert.equal(info.durationSec, 6.4)
})

test('a file with no video stream is refused by name, not by crashing', async () => {
  const { run } = harness({ 'a.mp3': { streams: [{ codec_type: 'audio' }], format: {} } })
  const info = await probeClip({ filePath: 'a.mp3', run })
  assert.equal(info.ok, false)
  assert.match(info.error, /没有视频流/u)
})

test('a non-JSON ffprobe reply is reported as such', async () => {
  const { run } = harness({ 'a.mp4': 'notjson' })
  const info = await probeClip({ filePath: 'a.mp4', run })
  assert.equal(info.ok, false)
  assert.match(info.error, /没有返回 JSON/u)
})

/* ------------------------------------------------------------------ *
 * uniformity — the decision that keeps -c copy honest
 * ------------------------------------------------------------------ */

test('clips that agree on codec, size AND audio presence are uniform', () => {
  const clips = [{ codec: 'h264', width: 1280, height: 720, hasAudio: true }, { codec: 'h264', width: 1280, height: 720, hasAudio: true }]
  assert.equal(isUniform(clips), true)
})

test('one clip without audio is NOT uniform, even when the codec and size match', () => {
  // Copy-concatting this pair yields a film that plays silence from the second
  // clip on. No error, no warning, just a broken track — which is exactly the
  // failure the cheap path must not be allowed to produce.
  const clips = [{ codec: 'h264', width: 1280, height: 720, hasAudio: true }, { codec: 'h264', width: 1280, height: 720, hasAudio: false }]
  assert.equal(isUniform(clips), false)
})

test('a different resolution is not uniform', () => {
  assert.equal(isUniform([{ codec: 'h264', width: 1280, height: 720, hasAudio: true }, { codec: 'h264', width: 640, height: 480, hasAudio: true }]), false)
})

test('commonProfile takes the largest frame and adds audio if ANY clip has it', () => {
  const profile = commonProfile([
    { width: 640, height: 480, fps: 24, hasAudio: false },
    { width: 1281, height: 721, fps: 30, hasAudio: true },
  ])
  assert.deepEqual(profile, { width: 1280, height: 720, fps: 30, hasAudio: true })
})

/* ------------------------------------------------------------------ *
 * orderClips — film order and missing shots
 * ------------------------------------------------------------------ */

const shotNode = (id, shotIndex, type = 'generate') => ({ id, type, shotIndex, title: id })
const doneJob = (path) => ({ status: 'completed', filePath: path, model: 'm' })

test('orderClips sorts by shotIndex, not by the order the edges were walked', () => {
  // The ids are deliberately in an order that DISAGREES with the shot indexes.
  // With ids that sort the same way this assertion would pass on an
  // implementation that sorted by id — and the film would then be cut in
  // dispatch order the moment a graph was laid out any other way.
  const { clips } = orderClips([
    { id: 'n_a_late', node: shotNode('n_a_late', 3), job: doneJob('c.mp4') },
    { id: 'n_m_early', node: shotNode('n_m_early', 1), job: doneJob('a.mp4') },
    { id: 'n_z_middle', node: shotNode('n_z_middle', 2), job: doneJob('b.mp4') },
  ], SHOT_TYPES)
  assert.deepEqual(clips.map((clip) => clip.filePath), ['a.mp4', 'b.mp4', 'c.mp4'])
  assert.deepEqual(clips.map((clip) => clip.shotIndex), [1, 2, 3])
})

test('orderClips omits non-shot upstream nodes and names the shots that are missing', () => {
  const { clips, missing, expected } = orderClips([
    { id: 'n_ref1', node: { id: 'n_ref1', type: 'ref', shotIndex: null }, job: null },
    { id: 'n_s01', node: shotNode('n_s01', 1), job: doneJob('a.mp4') },
    { id: 'n_s02', node: shotNode('n_s02', 2), job: { status: 'failed', filePath: null } },
    { id: 'n_s03', node: shotNode('n_s03', 3), job: null },
  ], SHOT_TYPES)
  assert.deepEqual(clips.map((clip) => clip.nodeId), ['n_s01'])
  assert.deepEqual(missing, ['n_s02', 'n_s03'])
  assert.equal(expected, 3, 'expected counts shots, so a short film can be reported as short')
})

test('a completed job with no local file counts as missing, not as a clip', () => {
  // A shot that finished server-side but whose download to disk never happened
  // cannot be concatenated, and pretending otherwise fails inside ffmpeg.
  const { clips, missing } = orderClips([
    { id: 'n_s01', node: shotNode('n_s01', 1), job: { status: 'completed', filePath: null } },
  ], SHOT_TYPES)
  assert.equal(clips.length, 0)
  assert.deepEqual(missing, ['n_s01'])
})

/* ------------------------------------------------------------------ *
 * composeSequence
 * ------------------------------------------------------------------ */

test('uniform clips take the copy path: exactly one ffmpeg call', async () => {
  const h = harness({ 'a.mp4': probe(), 'b.mp4': probe() })
  const result = await composeSequence({
    clips: [{ filePath: 'a.mp4' }, { filePath: 'b.mp4' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'copy')
  assert.equal(h.ffmpegCalls().length, 1, 'no per-clip transcode on the cheap path')
  assert.equal(result.durationSec, 10, 'the film length is the sum of the probed clips')
})

test('mismatched clips are normalized one by one, then copy-concatenated', async () => {
  const h = harness({ 'a.mp4': probe(), 'b.mp4': probe({ width: 640, height: 480 }) })
  const result = await composeSequence({
    clips: [{ filePath: 'a.mp4' }, { filePath: 'b.mp4' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  assert.equal(result.mode, 'normalize')
  const ffmpeg = h.ffmpegCalls()
  assert.equal(ffmpeg.length, 3, 'two normalizations plus the concat')
  assert.match(ffmpeg[0].args[ffmpeg[0].args.length - 1], /norm_000\.mp4$/u)
  assert.match(ffmpeg[1].args[ffmpeg[1].args.length - 1], /norm_001\.mp4$/u)
  // The concat step consumes the INTERMEDIATES, never the originals.
  const list = concatListOf(h)
  assert.match(list, /norm_000\.mp4/u)
  assert.match(list, /norm_001\.mp4/u)
  assert.ok(!list.includes('a.mp4'), 'concatenating the originals would undo the normalization')
})

test('the film is cut in the order the caller gave, not in probe order', async () => {
  const h = harness({ 'a.mp4': probe(), 'b.mp4': probe(), 'c.mp4': probe() })
  await composeSequence({
    clips: [{ filePath: 'c.mp4' }, { filePath: 'a.mp4' }, { filePath: 'b.mp4' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  const entries = listEntries(concatListOf(h))
  assert.deepEqual(entries.map((entry) => basename(entry)), ['c.mp4', 'a.mp4', 'b.mp4'])
})

test('every concat entry is ABSOLUTE — the demuxer resolves them against the LIST FILE', async () => {
  // Measured, on the twelve real paid shots: a list written into
  // `<saveDir>/.sequence-work/` holding `generated-videos/s05.mp4` made ffmpeg
  // look for `<saveDir>/.sequence-work/generated-videos/s05.mp4` and fail with
  // "Impossible to open". Relative entries are a trap, so they are resolved here
  // rather than left to each caller to remember.
  const h = harness({ 'a.mp4': probe(), 'b.mp4': probe() })
  await composeSequence({
    clips: [{ filePath: 'a.mp4' }, { filePath: 'b.mp4' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  for (const entry of listEntries(concatListOf(h))) {
    assert.ok(isAbsolute(entry), `${entry} is relative; ffmpeg would resolve it against the list file's directory`)
  }
})

test('a normalising export also writes absolute intermediate paths', async () => {
  const h = harness({ 'a.mp4': probe(), 'b.mp4': probe({ width: 640, height: 480 }) })
  await composeSequence({
    clips: [{ filePath: 'a.mp4' }, { filePath: 'b.mp4' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  for (const entry of listEntries(concatListOf(h))) {
    assert.ok(isAbsolute(entry), `${entry} is relative`)
  }
})

test('the manifest records which take of which shot is in the cut', async () => {
  const h = harness({ 'a.mp4': probe({ duration: 4 }), 'b.mp4': probe({ duration: 6 }) })
  const result = await composeSequence({
    clips: [
      { filePath: 'a.mp4', nodeId: 'n_s01', shotIndex: 1, model: 'heygen/heygen-video-1', title: '追逐' },
      { filePath: 'b.mp4', nodeId: 'n_s02', shotIndex: 2, model: 'heygen/heygen-video-1', title: '智取' },
    ],
    outPath: 'film.mp4', workDir: 'work', manifestPath: 'film.json',
    run: h.run, fs: h.fs, fsx: h.fsx, title: '猫和老鼠',
  })
  const manifest = JSON.parse(writtenEndingWith(h.written, 'film.json'))
  assert.equal(manifest.clipCount, 2)
  assert.equal(manifest.durationSec, 10)
  assert.equal(manifest.clips[0].nodeId, 'n_s01')
  assert.equal(manifest.clips[1].title, '智取')
  assert.equal(result.manifestPath, 'film.json')
})

test('an empty clip list is refused by name, not by producing a zero-byte film', async () => {
  const h = harness({})
  const result = await composeSequence({ clips: [], outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有可拼接的镜头/u)
  assert.equal(h.calls.length, 0, 'nothing is invoked for an empty export')
})

test('a clip that cannot be probed names itself in the failure', async () => {
  const h = harness({ 'a.mp4': probe(), 'b.mp4': 'boom' })
  const result = await composeSequence({
    clips: [{ filePath: 'a.mp4' }, { filePath: 'b.mp4', nodeId: 'n_s07' }],
    outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /n_s07/u)
})

test('a concat that produced no file is a failure, not a success with no film', async () => {
  // The receipt has to be able to tell "the film is on disk" from "ffmpeg exited
  // zero". A graph that claims a deliverable it cannot stat is worse than one
  // that admits it failed.
  const h = harness({ 'a.mp4': probe() })
  h.state.filmMissing = true
  const result = await composeSequence({
    clips: [{ filePath: 'a.mp4' }], outPath: 'film.mp4', workDir: 'work', run: h.run, fs: h.fs, fsx: h.fsx,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /读不到输出文件/u)
})

/* ------------------------------------------------------------------ *
 * the executor's `seq` pass
 * ------------------------------------------------------------------ */

const seqFixture = () => normalizeGraph({
  id: 'g_seq', title: '序列',
  project: { model: 'm', resolution: '720p', aspectRatio: '16:9', duration: 5, generateAudio: true, seed: null },
  nodes: [
    { id: 'n_s01', type: 'generate', shotIndex: 1, x: 0, y: 0, fields: { prompt: 'a' } },
    { id: 'n_s02', type: 'generate', shotIndex: 2, x: 0, y: 0, fields: { prompt: 'b' } },
    { id: 'n_seq', type: 'seq', x: 0, y: 0, fields: {} },
  ],
  edges: [
    { id: 'e1', from: 'n_s01', fromPort: 'job', to: 'n_seq', toPort: 'jobs' },
    { id: 'e2', from: 'n_s02', fromPort: 'job', to: 'n_seq', toPort: 'jobs' },
  ],
})

const completedJob = (id) => ({ id, nodeId: id, graphId: 'g_seq', status: 'completed', cost: 0.07, filePath: `C:/v/${id}.mp4` })

test('upstreamOf walks transitively — "can I cut the film yet" is not a one-level question', () => {
  const graph = seqFixture()
  graph.nodes.push({ id: 'n_take1', type: 'take', x: 0, y: 0, fields: {} })
  graph.edges.push({ id: 'e3', from: 'n_take1', fromPort: 'image', to: 'n_seq', toPort: 'jobs' })
  graph.edges.push({ id: 'e4', from: 'n_s01', fromPort: 'job', to: 'n_take1', toPort: 'job' })
  const closure = upstreamOf(graph, ['n_seq'])
  assert.ok(closure.has('n_s01'), 'the shot behind the take is upstream of the seq')
  assert.ok(closure.has('n_take1'))
})

test('the seq node composes after the shots, and is announced COMPLETED', async () => {
  const graph = seqFixture()
  const jobs = new Map([['n_s01', completedJob('j1')], ['n_s02', completedJob('j2')]])
  const states = rehydrate(graph, jobs)
  const composed = []
  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { throw new Error('nothing may be submitted on a resumed graph') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async (node) => { composed.push(node.id); return { nodeId: node.id, filePath: 'film.mp4', count: 2, expected: 2 } },
    sleep: async () => {},
  })
  assert.deepEqual(composed, ['n_seq'])
  assert.equal(report.sequences.length, 1)
  assert.equal(states.get('n_seq'), NODE_STATE.COMPLETED)
})

test('"nothing was dispatched this run" must not mean "no film"', async () => {
  // The most common real case: all twelve shots were paid for on an earlier run,
  // the process was restarted, and this run dispatches nothing at all. Composing
  // only when `report.completed` is non-empty would mean the film never lands.
  const graph = seqFixture()
  const jobs = new Map([['n_s01', completedJob('j1')], ['n_s02', completedJob('j2')]])
  const states = rehydrate(graph, jobs)
  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { throw new Error('no submit expected') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async (node) => ({ nodeId: node.id, filePath: 'film.mp4' }),
    sleep: async () => {},
  })
  assert.deepEqual(report.dispatched, [])
  assert.equal(report.sequences.length, 1)
})

test('the composer runs after every shot terminal, never before', async () => {
  const graph = seqFixture()
  const events = []
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs: new Map(),
    submit: async (node) => { events.push(`submit:${node.id}`); return { id: `j_${node.id}`, status: 'pending' } },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({ filePath: 'x.mp4' }),
    buildRequest: () => ({}),
    materializeSequence: async (node) => { events.push(`compose:${node.id}`); return { nodeId: node.id, filePath: 'film.mp4' } },
    sleep: async () => {},
  })
  assert.equal(events.filter((event) => event.startsWith('submit:')).length, 2)
  assert.equal(events[events.length - 1], 'compose:n_seq', 'the film is cut last, after both shots')
  assert.equal(report.sequences.length, 1)
})

test('a sequence failure is reported and does not un-complete the shots', async () => {
  const graph = seqFixture()
  const jobs = new Map([['n_s01', completedJob('j1')], ['n_s02', completedJob('j2')]])
  const states = rehydrate(graph, jobs)
  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { throw new Error('no submit expected') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async (node) => ({ nodeId: node.id, error: 'ffmpeg 不在 PATH 上' }),
    sleep: async () => {},
  })
  assert.equal(report.sequenceErrors.length, 1)
  assert.match(report.sequenceErrors[0].error, /ffmpeg/u)
  assert.equal(states.get('n_seq'), NODE_STATE.FAILED)
  assert.equal(states.get('n_s01'), NODE_STATE.COMPLETED, 'the paid shots are untouched by an export failure')
})

test('a throwing composer is contained rather than failing the whole run', async () => {
  const graph = seqFixture()
  const jobs = new Map([['n_s01', completedJob('j1')], ['n_s02', completedJob('j2')]])
  const states = rehydrate(graph, jobs)
  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { throw new Error('no submit expected') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async () => { throw new Error('磁盘满了') },
    sleep: async () => {},
  })
  assert.equal(report.sequenceErrors.length, 1)
  assert.match(report.sequenceErrors[0].error, /磁盘满了/u)
})

test('a graph with no seq node composes nothing and reports nothing', async () => {
  const graph = emptyGraph('无序列')
  graph.nodes.push({ id: 'n_s01', type: 'generate', shotIndex: 1, x: 0, y: 0, w: 190, disabled: false, maxRetries: 1, fields: { prompt: 'a' }, link: null, urlMode: null })
  const normalized = normalizeGraph(graph)
  const jobs = new Map([['n_s01', completedJob('j1')]])
  const states = rehydrate(normalized, jobs)
  let called = 0
  const report = await runGraph({
    graph: normalized, states, jobs,
    submit: async () => { throw new Error('no submit expected') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async () => { called += 1; return null },
    sleep: async () => {},
  })
  assert.equal(called, 0)
  assert.deepEqual(report.sequences, [])
})

test('`only` keeps the composer inside the subset', async () => {
  // `expandSubset` walks DOWNSTREAM, so a `seq` fed by the selected shot is
  // inside the subset and is cut — that is the point of "run this node and
  // everything derived from it". A `seq` hanging off some OTHER shot is not, and
  // cutting the whole film because one shot was re-run would silently ship a
  // film assembled from takes the user did not ask for.
  const graph = normalizeGraph({
    id: 'g_two', title: '两个序列',
    project: { model: 'm', resolution: '720p', aspectRatio: '16:9', duration: 5, generateAudio: true, seed: null },
    nodes: [
      { id: 'n_s01', type: 'generate', shotIndex: 1, x: 0, y: 0, fields: { prompt: 'a' } },
      { id: 'n_s02', type: 'generate', shotIndex: 2, x: 0, y: 0, fields: { prompt: 'b' } },
      { id: 'n_seqA', type: 'seq', x: 0, y: 0, fields: {} },
      { id: 'n_seqB', type: 'seq', x: 0, y: 0, fields: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_s01', fromPort: 'job', to: 'n_seqA', toPort: 'jobs' },
      { id: 'e2', from: 'n_s02', fromPort: 'job', to: 'n_seqB', toPort: 'jobs' },
    ],
  })
  const jobs = new Map([['n_s01', completedJob('j1')], ['n_s02', completedJob('j2')]])
  const states = rehydrate(graph, jobs)
  const composed = []
  await runGraph({
    graph, states, jobs,
    submit: async () => { throw new Error('no submit expected') },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeSequence: async (node) => { composed.push(node.id); return { nodeId: node.id } },
    only: ['n_s01'],
    sleep: async () => {},
  })
  assert.deepEqual(composed, ['n_seqA'])
})

/* ================================================================== *
 * run
 * ================================================================== */

for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
