/**
 * Frame hand-off tests: `lib/imagebed.js` plus the executor hook that calls it.
 *
 * These cover the layer that makes first/last-frame chaining real, so the
 * assertions are about *why it works*, not about spelling:
 *
 *   - the last frame is the LAST of a dumped tail, not the first frame after a
 *     `-sseof` seek (measured: that idiom lands ~3 frames early)
 *   - a Cloudflare HTML interstitial is reported as a challenge, not as a JSON
 *     parse failure that sends you hunting for a bug in the wrong place
 *   - the frames are published AFTER the download and BEFORE the node is
 *     announced COMPLETED — that ordering is what removes the race with the
 *     downstream shot, and nothing else enforces it
 *   - a frame failure never fails the shot: the clip is rendered and paid for
 *
 * Run: node test-frames.mjs
 */
import assert from 'node:assert/strict'
import {
  framePlan, pickUrl, uploadUrl, extractFrame, uploadFrame, cutAndPublish,
  DEFAULT_FRAME_SEEK_SECONDS,
} from './lib/imagebed.js'
import { runGraph, rehydrate } from './lib/exec.js'
import { emptyGraph, normalizeGraph } from './lib/graph.js'

let passed = 0
let failed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

/* ------------------------------------------------------------------ *
 * ffmpeg command construction
 * ------------------------------------------------------------------ */

test('first_frame is a single frame written straight to the output path', () => {
  const plan = framePlan({ videoPath: 'C:/v/a.mp4', which: 'first_frame', outPath: 'C:/o/f.png' })
  assert.equal(plan.mode, 'single')
  assert.equal(plan.parts, null)
  assert.ok(plan.args.includes('-frames:v'), 'one frame')
  assert.ok(!plan.args.includes('-sseof'), 'no seeking — the first frame is the first frame')
  assert.equal(plan.args[plan.args.length - 1], 'C:/o/f.png')
})

test('last_frame dumps a TAIL and takes the last file, not the first frame past a seek', () => {
  // `-sseof -0.15 -frames:v 1` yields the first frame at or after 0.15 s before
  // the end. On the 24 fps clip this was measured against, that frame scored
  // SSIM 0.928 against the true final frame — an almost-right frame at a seam,
  // which is the worst possible kind of wrong.
  const plan = framePlan({ videoPath: 'C:/v/a.mp4', which: 'last_frame', outPath: 'C:/o/f.png' })
  assert.equal(plan.mode, 'sequence')
  assert.ok(plan.parts.startsWith('C:/o/f.png'), 'the scratch sequence lives beside the output')
  assert.ok(plan.args.includes('-sseof'))
  assert.equal(plan.args[plan.args.indexOf('-sseof') + 1], `-${DEFAULT_FRAME_SEEK_SECONDS}`)
  assert.ok(!plan.args.includes('-frames:v'),
    'a single-frame grab is exactly the bug: it cannot know which frame is last')
  assert.match(plan.args[plan.args.length - 1], /%05d\.png$/u, 'an image sequence, so the tail is decodable')
})

test('last_frame honours a configured seek window', () => {
  const plan = framePlan({ videoPath: 'v.mp4', which: 'last_frame', outPath: 'f.png', seekSeconds: 2 })
  assert.equal(plan.args[plan.args.indexOf('-sseof') + 1], '-2')
})

/* ------------------------------------------------------------------ *
 * extractFrame
 * ------------------------------------------------------------------ */

test('extractFrame picks the LAST name in the dumped tail', async () => {
  // The whole point: several files are written and the last one is the answer.
  // Picking [0] (or letting ffmpeg pick for us) is the bug this guards.
  let moved = null
  const result = await extractFrame({
    videoPath: 'v.mp4',
    which: 'last_frame',
    outPath: 'C:/o/f.png',
    run: async () => ({ stdout: '', stderr: '' }),
    fs: {
      mkdir: async () => {},
      readdir: async () => ['f_00001.png', 'f_00014.png', 'f_00002.png', 'notes.txt'],
      rename: async (from, to) => { moved = { from, to } },
      rm: async () => {},
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.filePath, 'C:/o/f.png')
  assert.match(moved.from, /f_00014\.png$/u, 'sorted, so 00014 wins over 00002')
  assert.equal(moved.to, 'C:/o/f.png')
})

test('extractFrame with an empty tail is a failure, not an empty frame', async () => {
  const result = await extractFrame({
    videoPath: 'v.mp4',
    which: 'last_frame',
    outPath: 'f.png',
    run: async () => ({}),
    fs: { mkdir: async () => {}, readdir: async () => [], rename: async () => {}, rm: async () => {} },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有写出任何帧/u)
})

test('extractFrame reports ffmpeg stderr instead of a generic failure', async () => {
  const result = await extractFrame({
    videoPath: 'v.mp4',
    outPath: 'f.png',
    run: async () => { throw new Error('Invalid data found when processing input') },
    fs: { mkdir: async () => {}, readdir: async () => [], rename: async () => {}, rm: async () => {} },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Invalid data found/u)
})

test('extractFrame refuses without an upstream file rather than guessing', async () => {
  const result = await extractFrame({ videoPath: null, outPath: 'f.png' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有可用的本地文件/u)
})

/* ------------------------------------------------------------------ *
 * image bed
 * ------------------------------------------------------------------ */

test('uploadUrl joins the base without losing a path segment and encodes the folder', () => {
  assert.equal(uploadUrl('https://img.example.com/', 'test'),
    'https://img.example.com/upload?uploadFolder=test&returnFormat=full')
  assert.equal(uploadUrl('https://img.example.com', 'a b/c'),
    'https://img.example.com/upload?uploadFolder=a%20b%2Fc&returnFormat=full')
  assert.equal(uploadUrl('', 'test'), null, 'no base is a disabled mechanism, not a bad URL')
  assert.equal(uploadUrl(null, 'test'), null)
})

test('pickUrl finds the asset in every response shape the beds use', () => {
  assert.equal(pickUrl([{ src: 'https://i/a.png' }]), 'https://i/a.png')
  assert.equal(pickUrl({ url: 'https://i/b.png' }), 'https://i/b.png')
  assert.equal(pickUrl({ data: { src: 'https://i/c.png' } }), 'https://i/c.png')
  assert.equal(pickUrl({ result: [{ url: 'https://i/d.png' }] }), 'https://i/d.png')
  assert.equal(pickUrl({ src: '/relative/a.png' }), null, 'a relative src is not fetchable by a provider')
  assert.equal(pickUrl({ src: 'data:image/png;base64,AAAA' }), null)
  assert.equal(pickUrl({ ok: true }), null)
  assert.equal(pickUrl(null), null)
})

test('a Cloudflare interstitial is named as one, not parsed as JSON', async () => {
  // A challenged bed answers 403 with an HTML page. Reporting this as
  // "Unexpected token '<' in JSON" sends the user to look for a bug in the
  // upload code, when the fix is the User-Agent or a different bed.
  const result = await uploadFrame({
    filePath: 'f.png',
    baseUrl: 'https://img.example.com',
    readFileImpl: async () => Buffer.from('png'),
    fetchImpl: async () => ({
      status: 403,
      headers: { get: () => 'text/html; charset=UTF-8' },
      text: async () => '<!DOCTYPE html><title>Just a moment...</title>',
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Cloudflare/u)
  assert.match(result.error, /gobelagent/u, 'it names the agent string that gets through')
})

test('uploadFrame sends the configured User-Agent and the folder as a query parameter', async () => {
  let seen = null
  const result = await uploadFrame({
    filePath: 'F:/x/f.png',
    baseUrl: 'https://img.example.com',
    folder: 'test',
    userAgent: 'gobelagent',
    token: 'tok',
    readFileImpl: async () => Buffer.from('png'),
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify([{ src: 'https://img.example.com/file/test/x.png' }]),
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://img.example.com/file/test/x.png')
  assert.equal(seen.url, 'https://img.example.com/upload?uploadFolder=test&returnFormat=full')
  assert.equal(seen.init.headers['User-Agent'], 'gobelagent')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
})

test('a missing image bed is refused with the SETTING NAME, before any request', async () => {
  let called = 0
  const result = await uploadFrame({
    filePath: 'f.png',
    baseUrl: '',
    readFileImpl: async () => Buffer.from('png'),
    fetchImpl: async () => { called += 1; return {} },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /imageBedUrl/u)
  assert.equal(called, 0, 'no request is sent when the mechanism is disabled')
})

test('cutAndPublish cuts then publishes, and keeps the frame when the upload fails', async () => {
  const published = await cutAndPublish({
    videoPath: 'v.mp4',
    which: 'last_frame',
    outPath: 'o/f.png',
    config: { imageBedUrl: 'https://i', imageBedFolder: 'test' },
    extract: async () => ({ ok: true, filePath: 'o/f.png' }),
    upload: async ({ filePath }) => ({ ok: true, url: 'https://i/' + filePath }),
  })
  assert.equal(published.ok, true)
  assert.equal(published.url, 'https://i/o/f.png')

  const half = await cutAndPublish({
    videoPath: 'v.mp4',
    outPath: 'o/g.png',
    config: {},
    extract: async () => ({ ok: true, filePath: 'o/g.png' }),
    upload: async () => ({ ok: false, error: '网络不通' }),
  })
  assert.equal(half.ok, false)
  assert.equal(half.filePath, 'o/g.png', 'the cut frame is kept, so the failure is inspectable')
})

/* ------------------------------------------------------------------ *
 * executor hook: the ordering that removes the race
 * ------------------------------------------------------------------ */

function chainGraph() {
  return normalizeGraph({
    version: 1,
    nodes: [
      { id: 's1', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
      { id: 't', type: 'take', fields: { frame: 'last_frame' } },
      { id: 's2', type: 'generate', shotIndex: 2, fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [
      { id: 'e1', from: 's1', fromPort: 'job', to: 't', toPort: 'job' },
      { id: 'e2', from: 't', fromPort: 'image', to: 's2', toPort: 'frames' },
    ],
  })
}

test('frames are published AFTER the download and BEFORE the node is COMPLETED', async () => {
  // Ordering is the whole mechanism. `readyNodes` derives readiness from node
  // state, so the downstream shot cannot be dispatched until this node reports
  // COMPLETED — publishing first means the consumer always sees a URL, with no
  // scheduling edge from `take` and therefore no race to lose.
  const graph = chainGraph()
  const states = new Map()
  const events = []
  await runGraph({
    graph,
    states,
    jobs: new Map(),
    concurrency: 1,
    submit: async (node) => { events.push('submit:' + node.id); return { id: 'j_' + node.id, status: 'pending' } },
    poll: async (job) => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async (job) => { events.push('download:' + job.nodeId); return { filePath: `/tmp/${job.nodeId}.mp4` } },
    buildRequest: () => ({}),
    materializeFrames: async (node, job) => {
      events.push(`frames:${node.id}@${states.get(node.id)}`)
      assert.equal(job.filePath, `/tmp/${node.id}.mp4`, 'the clip must already be on disk')
      return [{ nodeId: 't', frameUrl: 'https://i/f.png' }]
    },
    sleep: async () => {},
  })

  assert.deepEqual(events.filter((e) => e.startsWith('download:')), ['download:s1', 'download:s2'])
  assert.deepEqual(events.filter((e) => e.startsWith('frames:')),
    ['frames:s1@in_progress', 'frames:s2@in_progress'],
    'the hook runs while the node is still working, never after it is announced complete')
})

test('the frame summary lands on the job record and on the report', async () => {
  const graph = chainGraph()
  const jobs = new Map()
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs,
    concurrency: 1,
    submit: async (node) => ({ id: 'j_' + node.id, status: 'pending' }),
    poll: async () => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async () => ({ filePath: '/tmp/x.mp4' }),
    buildRequest: () => ({}),
    materializeFrames: async () => [{ nodeId: 't', frameUrl: 'https://i/f.png' }],
    sleep: async () => {},
  })
  assert.equal(jobs.get('s1').frames[0].frameUrl, 'https://i/f.png')
  assert.deepEqual(report.frameErrors, [])
})

test('a frame failure NEVER fails the shot that was already rendered and paid for', async () => {
  // The video is on disk and the money is spent. Marking the node failed would
  // invite a re-render of a clip that already exists — paying twice to fix a
  // problem that is not with the clip.
  const graph = chainGraph()
  const jobs = new Map()
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs,
    concurrency: 1,
    submit: async (node) => ({ id: 'j_' + node.id, status: 'pending' }),
    poll: async () => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async () => ({ filePath: '/tmp/x.mp4' }),
    buildRequest: () => ({}),
    materializeFrames: async () => { throw new Error('ffmpeg 不在 PATH 里') },
    sleep: async () => {},
  })
  assert.deepEqual(report.failed, [])
  assert.equal(report.completed.includes('s1'), true)
  assert.match(report.frameErrors[0].error, /ffmpeg/u)
})

test('a per-take error is reported without failing the shot either', async () => {
  const graph = chainGraph()
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs: new Map(),
    concurrency: 1,
    submit: async (node) => ({ id: 'j_' + node.id, status: 'pending' }),
    poll: async () => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async () => ({ filePath: '/tmp/x.mp4' }),
    buildRequest: () => ({}),
    materializeFrames: async (node) => (node.id === 's1'
      ? [{ nodeId: 't', error: '没有配置图床地址（imageBedUrl）' }]
      : []),
    sleep: async () => {},
  })
  assert.deepEqual(report.failed, [])
  assert.equal(report.frameErrors.length, 1, 'only the shot that owns a take node reports one')
  assert.match(report.frameErrors[0].error, /imageBedUrl/u)
})

test('a node RESUMED as completed still publishes its frames, before anything is dispatched', async () => {
  // The process can die between the download and the upload. On resume the node
  // rehydrates straight to COMPLETED, so `readyNodes` may consider the shot that
  // depends on its frame ready on the very FIRST dispatch — before `runOne` for
  // the resumed node has run at all. A pre-pass handles it before the scheduler
  // exists; without it the chained shot silently becomes an independent take on
  // every later run.
  const graph = chainGraph()
  const jobs = new Map([
    ['s1', { id: 'j_s1', nodeId: 's1', status: 'completed', cost: 0.1, filePath: '/tmp/s1.mp4' }],
  ])
  const events = []
  await runGraph({
    graph,
    states: rehydrate(graph, jobs),
    jobs,
    concurrency: 1,
    submit: async (node) => { events.push('submit:' + node.id); return { id: 'j_' + node.id, status: 'pending' } },
    poll: async () => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async (job) => { events.push('download:' + job.nodeId); return { filePath: '/tmp/x.mp4' } },
    buildRequest: () => ({}),
    materializeFrames: async (node) => { events.push('frames:' + node.id); return [] },
    sleep: async () => {},
  })
  assert.deepEqual(events.filter((e) => e.endsWith(':s1')), ['frames:s1'],
    'the resumed node is handed to the hook, and is never re-downloaded or re-submitted')
  assert.ok(events.indexOf('frames:s1') < events.indexOf('submit:s2'),
    'its frame is published before the dependent shot can be dispatched')
})

test('an onState that mutates the ledger record in place cannot derail the run', async () => {
  // `onState` is a UI callback, and it is handed the ledger record — which can
  // be the very object the executor is holding as its working copy. A callback
  // that writes `record.status` therefore rewrites the value the executor is
  // about to branch on, and control flow that depends on a callback not
  // mutating its input is not control flow at all.
  //
  // Left unguarded this produced an endless re-dispatch loop: 49 dispatches,
  // 244 polls, every single poll reporting `completed`, and a run that never
  // finished. This test fails by TIMING OUT rather than by asserting, which is
  // exactly why it is a unit test now instead of only an end-to-end hang.
  const graph = chainGraph()
  const jobs = new Map()
  let polls = 0
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs,
    concurrency: 1,
    submit: async (node) => ({ id: 'j_' + node.id, status: 'pending' }),
    poll: async () => { polls += 1; return { status: 'completed', usage: { cost: 0.1 } } },
    download: async () => ({ filePath: '/tmp/x.mp4' }),
    buildRequest: () => ({}),
    retryFailed: false,
    // Deliberately hostile: the shape a naive UI callback takes.
    onState: (id, state) => {
      const record = jobs.get(id)
      if (record) record.status = state === 'completed' ? 'completed' : 'in_progress'
    },
    materializeFrames: async () => [],
    sleep: async () => {},
  })
  assert.deepEqual(report.failed, [])
  assert.equal(report.completed.length, 2, 'both shots must finish, not be re-dispatched forever')
  assert.equal(polls, 2, 'each shot is polled exactly once — a repeat means the loop re-entered')
})

test('a transient poll error is retried, not treated as a dead shot', async () => {
  // WHAT THIS CATCHES
  //
  // The submission had already succeeded — the API minted a job id and billed
  // for it — so treating one network blip as terminal throws away a clip that is
  // sitting finished on the server. That happened for real: a single
  // `fetch failed` while polling marked a 5-second shot as failed, $0.075
  // already spent, and the only in-app remedy was `retry_failed`, which SUBMITS
  // AGAIN and pays twice. On a chained film it also blocks everything downstream.
  //
  // Polling an already-paid job is a GET, so a retry is free and idempotent.
  const graph = chainGraph()
  const jobs = new Map()
  let polls = 0
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs,
    concurrency: 1,
    submit: async (node) => ({ id: 'j_' + node.id, status: 'pending' }),
    poll: async () => {
      polls += 1
      // Every shot's first poll fails at the transport level, the second answers.
      if (polls % 2 === 1) throw new Error('fetch failed')
      return { status: 'completed', usage: { cost: 0.1 } }
    },
    download: async () => ({ filePath: '/tmp/x.mp4' }),
    buildRequest: () => ({}),
    materializeFrames: async () => [],
    sleep: async () => {},
  })
  assert.deepEqual(report.failed, [], 'one blip must not fail a shot that was already submitted and billed')
  assert.equal(report.completed.length, 2, 'both shots still finish')
  assert.equal(polls, 4, `two shots with one blip each: got ${polls} polls`)
})

test('an empty graph still reports a well-formed frameErrors array', async () => {
  const graph = normalizeGraph(emptyGraph('空'))
  const report = await runGraph({
    graph,
    states: new Map(),
    jobs: new Map(),
    submit: async () => ({ id: 'x', status: 'pending' }),
    poll: async () => ({ status: 'completed' }),
    download: async () => ({}),
    buildRequest: () => ({}),
    materializeFrames: async () => [],
    sleep: async () => {},
  })
  assert.deepEqual(report.frameErrors, [])
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
