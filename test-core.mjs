/**
 * Executor + graph + pricing unit tests.
 *
 * These three modules hold every rule that protects the user's money, so they
 * are tested directly rather than through the plugin surface:
 *
 *   - over-budget refuses and makes **zero** network calls (plan §6 test 4)
 *   - resume never re-submits a job that already exists (plan §6 test 3)
 *   - all six API statuses are understood, `cancelled`/`expired` included
 *   - pricing never folds an unknown magnitude in as zero (plan §3.9)
 *   - graph validation rejects cycles / bad types / empty required ports
 *
 * Run: node test-core.mjs
 */
import assert from 'node:assert/strict'
import {
  emptyGraph, normalizeGraph, validate, canConnect, topoOrder, findCycle, shots, dependencies,
  resolveModel, resolveDuration, resolveSeed, nodeId, NODE_TYPES, isNetworkNode, pricingKind, frameSlotOf,
} from './lib/graph.js'
import { runGraph, rehydrate, summarize, NODE_STATE, nodeStateFor, expandSubset } from './lib/exec.js'
import { describePricing, nodeCeiling, ceilingFor, unitOf, largestResolution } from './lib/pricing.js'

let passed = 0
let failed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

function makeGraph() {
  const graph = emptyGraph('测试片')
  graph.nodes = [
    { id: 'n_script', type: 'script', title: '分镜', fields: { text: '1. 开场' }, x: 0, y: 0 },
    { id: 'n_g1', type: 'generate', title: '开场', shotIndex: 1, fields: { prompt: 'a', model: 'google/veo-3.1-fast' }, x: 0, y: 0 },
    { id: 'n_g2', type: 'generate', title: '特写', shotIndex: 2, fields: { prompt: 'b', model: 'google/veo-3.1-fast' }, x: 0, y: 0 },
    { id: 'n_d1', type: 'edit', title: '编辑', shotIndex: 3, fields: { prompt: 'c', model: 'black-forest-labs/flux-video-edit' }, x: 0, y: 0 },
  ]
  graph.edges = [
    { id: 'e1', from: 'n_script', fromPort: 'shots', to: 'n_g1', toPort: 'brief' },
    { id: 'e2', from: 'n_g1', fromPort: 'job', to: 'n_d1', toPort: 'video' },
  ]
  return normalizeGraph(graph)
}

/** A catalog entry shaped like the live `/videos/models` payload. */
const CATALOG = {
  loaded: true,
  byId: {
    'google/veo-3.1-fast': {
      id: 'google/veo-3.1-fast',
      supported_durations: [4, 6, 8],
      supported_resolutions: ['720p', '1080p', '4K'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_frame_images: ['first_frame', 'last_frame'],
      upscale_factor: null,
      pricing_skus: { duration_seconds: '0.10', duration_seconds_with_audio: '0.12' },
    },
    'black-forest-labs/flux-video-edit': {
      id: 'black-forest-labs/flux-video-edit',
      supported_durations: [4, 8],
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9'],
      supported_frame_images: null,
      upscale_factor: null,
      pricing_skus: { cents_per_second_output: '3' },
    },
    'openai/sora-2-pro': {
      id: 'openai/sora-2-pro',
      supported_durations: [4, 8, 12],
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      // The concrete trap from the plan: null means it cannot do image-to-video.
      supported_frame_images: null,
      upscale_factor: null,
      pricing_skus: { duration_seconds_720p: '0.30' },
    },
    'bytedance/seedance-2.5': {
      id: 'bytedance/seedance-2.5',
      supported_durations: [4, 8, 30],
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9'],
      supported_frame_images: ['first_frame'],
      upscale_factor: null,
      pricing_skus: { video_tokens: '0.0000012' },
    },
    'black-forest-labs/flux-3-video': {
      id: 'black-forest-labs/flux-3-video',
      supported_durations: [8],
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9'],
      supported_frame_images: ['first_frame'],
      upscale_factor: null,
      pricing_skus: {
        cents_per_second_output: '17',
        cents_per_second_video_continuation_720p: '41',
      },
    },
    'black-forest-labs/flux-video-upscale': {
      id: 'black-forest-labs/flux-video-upscale',
      supported_durations: [8],
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9'],
      supported_frame_images: null,
      upscale_factor: { min: 1.5, max: 3 },
      pricing_skus: { cents_per_megapixel_second_precise: '7.5', cents_per_megapixel_second_creative: '10.5' },
    },
    'runway/aleph-2': {
      id: 'runway/aleph-2',
      supported_durations: [8],
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9'],
      supported_frame_images: null,
      upscale_factor: null,
      pricing_skus: { cents_per_second_output: '28', minimum_cents_per_generation: '56' },
    },
  },
}

/* ================================================================== *
 * graph: structure & rules
 * ================================================================== */

test('normalizeGraph drops dangling edges and duplicate single-port edges', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [{ id: 'a', type: 'generate' }, { id: 'b', type: 'extend' }],
    edges: [
      { from: 'a', fromPort: 'job', to: 'b', toPort: 'job' },
      { from: 'a', fromPort: 'job', to: 'b', toPort: 'job' },   // duplicate single-input port
      { from: 'a', fromPort: 'job', to: 'ghost', toPort: 'job' }, // dangling
    ],
  })
  assert.equal(graph.edges.length, 1, 'duplicate and dangling edges must both be removed')
  assert.equal(graph.nodes.length, 2)
})

test('refs takes MANY edges, so a shot can carry two characters at once', () => {
  // `refs` used to be single-input, and the dedupe here is what enforced it:
  // wiring a second reference EVICTED the first, silently. A shot with the cat
  // AND the mouse could only ever carry one of them, and `plan` with two
  // `reference_image_urls` built a graph that used one. The API takes an array
  // of `input_references`, so the graph was the only thing in the way.
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'c1', type: 'cast', fields: { name: 'TOM', source: 'https://x/tom.png' } },
      { id: 'c2', type: 'cast', fields: { name: 'JERRY', source: 'https://x/jerry.png' } },
      { id: 'g', type: 'generate', shotIndex: 1, fields: {} },
    ],
    edges: [
      { id: 'e1', from: 'c1', fromPort: 'asset', to: 'g', toPort: 'refs' },
      { id: 'e2', from: 'c2', fromPort: 'asset', to: 'g', toPort: 'refs' },
    ],
  })
  assert.equal(graph.edges.filter((e) => e.to === 'g' && e.toPort === 'refs').length, 2,
    'both reference edges must survive normalization')
})

test('an UNKNOWN node type survives the round trip instead of being rewritten to `note`', () => {
  // This line used to map anything unrecognised to `note`, which is DESTRUCTIVE:
  // a client that knows a type the running Host does not (the Host half does not
  // hot-reload) POSTs a `cast` node, has it downgraded on the way in, and gets it
  // back as an empty 注释 with one text field and no image. The data is gone and
  // nothing says why. Refusing is correct; corrupting is not.
  const graph = normalizeGraph({
    version: 1,
    nodes: [{ id: 'x', type: 'from-the-future', fields: { keep: 'me' } }],
    edges: [],
  })
  assert.equal(graph.nodes[0].type, 'from-the-future', 'the type must be preserved so a restart can revive it')
  assert.equal(graph.nodes[0].fields.keep, 'me', 'and its fields with it')

  const result = validate(graph)
  assert.ok(result.errors.some((error) => error.code === 'bad-type'),
    'and validate must REFUSE it, rather than let a run quietly do nothing')
})

test('a node with no type at all still falls back to `note`', () => {
  const graph = normalizeGraph({ version: 1, nodes: [{ id: 'x' }], edges: [] })
  assert.equal(graph.nodes[0].type, 'note')
})

test('topoOrder returns a valid order and null on a cycle', () => {
  const graph = makeGraph()
  const order = topoOrder(graph)
  assert.ok(order !== null)
  assert.ok(order.indexOf('n_script') < order.indexOf('n_g1'))
  assert.ok(order.indexOf('n_g1') < order.indexOf('n_d1'))

  const cyclic = normalizeGraph({
    version: 1,
    nodes: [{ id: 'a', type: 'generate' }, { id: 'b', type: 'generate' }],
    edges: [
      { from: 'a', fromPort: 'job', to: 'b', toPort: 'brief' },
      { from: 'b', fromPort: 'job', to: 'a', toPort: 'brief' },
    ],
  })
  assert.equal(topoOrder(cyclic), null)
  assert.ok(findCycle(cyclic) !== null)
})

test('canConnect enforces the port type table', () => {
  const graph = makeGraph()
  // job → video is legal (a job's artefact IS a video)
  assert.equal(canConnect(graph, 'n_g1', 'job', 'n_d1', 'video').ok, true)
  // text → frames is not
  const bad = canConnect(graph, 'n_script', 'brief', 'n_g1', 'frames')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /类型不兼容/)
  // a cycle is refused
  const cyc = canConnect(graph, 'n_d1', 'job', 'n_g1', 'brief')
  assert.equal(cyc.ok, false)
})

test('validate flags empty required ports, cycles and bad models', () => {
  const graph = makeGraph()
  // n_d1 (edit) requires its `video` port; drop the edge that fills it.
  graph.edges = graph.edges.filter((e) => e.to !== 'n_d1')
  const result = validate(graph, { catalog: CATALOG })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.code === 'missing-required'), 'required port must be reported')
})

test('validate catches a model that cannot do image-to-video (sora-2-pro)', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'r', type: 'ref' },
      { id: 'g', type: 'generate', fields: { model: 'openai/sora-2-pro' } },
    ],
    edges: [{ from: 'r', fromPort: 'asset', to: 'g', toPort: 'frames' }],
  })
  const result = validate(graph, { catalog: CATALOG })
  assert.ok(result.errors.some((e) => e.code === 'mode-unsupported'),
    'sora-2-pro has supported_frame_images=null and must be refused locally')
})

test('validate rejects an unsupported duration and lists what IS supported', () => {
  const graph = makeGraph()
  graph.nodes.find((n) => n.id === 'n_g1').fields.duration = 7   // veo-3.1-fast: 4/6/8 only
  const result = validate(graph, { catalog: CATALOG })
  const err = result.errors.find((e) => e.code === 'bad-duration')
  assert.ok(err, 'duration outside supported_durations must be refused')
  assert.match(err.message, /4, 6, 8/, 'the supported list must be carried back to the user')
})

test('validate warns when frames and refs are both wired (the provider refuses that pair)', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'r', type: 'ref' },
      { id: 'g', type: 'generate', fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [
      { from: 'r', fromPort: 'asset', to: 'g', toPort: 'frames' },
      { from: 'r', fromPort: 'asset', to: 'g', toPort: 'refs' },
    ],
  })
  const result = validate(graph, { catalog: CATALOG })
  assert.ok(result.warnings.some((w) => w.code === 'frames-over-refs'))
})

test('a take-node chain WITHOUT an image bed is reported, not silently ignored', () => {
  // `take` runs now (ffmpeg cuts the frame, the image bed publishes it), so the
  // only remaining way for this wire to do nothing is a missing image bed: a
  // frame with no public URL is a frame no provider can fetch. The warning had
  // to become CONDITIONAL rather than disappear, because unconditional silence
  // on a degrading wire is exactly the defect the original warning removed.
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 's1', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
      { id: 't', type: 'take' },
      { id: 's2', type: 'generate', shotIndex: 2, fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [
      { from: 's1', fromPort: 'job', to: 't', toPort: 'job' },
      { from: 't', fromPort: 'image', to: 's2', toPort: 'frames' },
    ],
  })
  const result = validate(graph, { catalog: CATALOG, imageBed: false })
  const warning = result.warnings.find((w) => w.code === 'frame-chaining-needs-imagebed')
  assert.ok(warning, 'a wired take node with no image bed must be reported')
  assert.equal(warning.nodeId, 's2', 'the warning names the shot that loses continuity')
  assert.match(warning.message, /imageBedUrl/u, 'it names the setting that fixes it')
})

test('a take-node chain WITH an image bed is not warned about — that path works now', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 's1', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
      { id: 't', type: 'take' },
      { id: 's2', type: 'generate', shotIndex: 2, fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [
      { from: 's1', fromPort: 'job', to: 't', toPort: 'job' },
      { from: 't', fromPort: 'image', to: 's2', toPort: 'frames' },
    ],
  })
  const result = validate(graph, { catalog: CATALOG, imageBed: true })
  assert.equal(result.warnings.some((w) => w.code.startsWith('frame-chaining')), false)
})

test('a wired ref node is NOT reported as unavailable (that path is implemented)', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'r', type: 'ref', fields: { source: 'https://example.com/cat.png' } },
      { id: 'g', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [{ from: 'r', fromPort: 'asset', to: 'g', toPort: 'refs' }],
  })
  const result = validate(graph, { catalog: CATALOG, imageBed: false })
  assert.equal(result.warnings.some((w) => w.code.startsWith('frame-chaining')), false)
})

test('frames takes MANY edges, so first_last mode is expressible at all', () => {
  // `frames` used to be single-input, and the dedupe in `normalizeGraph` is
  // what enforced it: wiring a second frame EVICTED the first. The API's
  // `supported_frame_images` includes `first_last`, so the canvas could not
  // express a mode the API supports — the second wire silently won and the
  // result was a first-frame-only chain the user never asked for.
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'a', type: 'ref', fields: { source: 'https://example.com/a.png', slot: 'first_frame' } },
      { id: 'b', type: 'ref', fields: { source: 'https://example.com/b.png', slot: 'last_frame' } },
      { id: 'g', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
    ],
    edges: [
      { id: 'e1', from: 'a', fromPort: 'asset', to: 'g', toPort: 'frames' },
      { id: 'e2', from: 'b', fromPort: 'asset', to: 'g', toPort: 'frames' },
    ],
  })
  assert.equal(graph.edges.filter((e) => e.to === 'g' && e.toPort === 'frames').length, 2,
    'both frame edges must survive normalization')
})

test('the frame SLOT belongs to the source node, not the consumer', () => {
  // The API takes `frame_type` per image. Reading it off the consumer meant
  // reading `node.fields.frameType`, a field no node type declares — always
  // undefined, so every wired frame became a first frame and a last frame was
  // not expressible.
  assert.equal(frameSlotOf({ type: 'ref', fields: { slot: 'last_frame' } }), 'last_frame')
  assert.equal(frameSlotOf({ type: 'ref', fields: { slot: 'first_frame' } }), 'first_frame')
  assert.equal(frameSlotOf({ type: 'ref', fields: {} }), 'first_frame')
  assert.equal(frameSlotOf({ type: 'take', fields: {} }), 'first_frame')
  assert.equal(frameSlotOf(undefined), 'first_frame')
})

test('link:continue makes a shot DEPEND on the previous one, so they cannot run concurrently', () => {
  // The scheduling half of the bug. `previous_job_id` must be the previous
  // shot's COMPLETED job id, so the shot cannot start before that job exists —
  // but `link` produced no edge and the executor only reads edges, so two
  // "continued" shots were dispatched at the same time and the flag was always
  // null by the time the request was built.
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'a', type: 'generate', shotIndex: 1, fields: {} },
      { id: 'b', type: 'generate', shotIndex: 2, link: 'continue', fields: {} },
      { id: 'c', type: 'generate', shotIndex: 3, fields: {} },
    ],
    edges: [],
  })
  assert.deepEqual(dependencies(graph, 'a'), [], 'the first shot waits for nothing')
  assert.deepEqual(dependencies(graph, 'b'), ['a'], 'a continued shot waits for its predecessor')
  assert.deepEqual(dependencies(graph, 'c'), [], 'an independent shot is still independent')
})

test('a continued shot is priced at the continuation SKU, not the base one', () => {
  // flux-3-video: $0.17/s base against $0.41/s continuation. Pricing a
  // `generate` node with link=continue as `plain` understates the most expensive
  // leg of a long film by 2.4x while still presenting the total as an upper bound.
  const base = normalizeGraph({ version: 1, nodes: [{ id: 'a', type: 'generate', fields: {} }], edges: [] })
  const cont = normalizeGraph({ version: 1, nodes: [{ id: 'b', type: 'generate', link: 'continue', fields: {} }], edges: [] })
  const ext = normalizeGraph({ version: 1, nodes: [{ id: 'e', type: 'extend', fields: {} }], edges: [] })
  assert.equal(pricingKind(base.nodes[0]), 'plain')
  assert.equal(pricingKind(cont.nodes[0]), 'continuation')
  assert.equal(pricingKind(ext.nodes[0]), 'continuation', 'extend was already continuation — unchanged')
})

test('validate flags a cross-model adjacency but not a joined one', () => {
  const base = {
    version: 1,
    nodes: [
      { id: 'a', type: 'generate', shotIndex: 1, fields: { model: 'google/veo-3.1-fast' } },
      { id: 'b', type: 'generate', shotIndex: 2, fields: { model: 'kwaivgi/kling-v3.0-std' } },
    ],
    edges: [],
  }
  // Without a link: a real discontinuity → warn.
  const loose = validate(normalizeGraph(base), { catalog: CATALOG })
  assert.ok(loose.warnings.some((w) => w.code === 'model-switch'))

  // With an explicit continuation link: expected, so stay quiet.
  const joined = structuredClone(base)
  joined.nodes[1].link = 'continue'
  const linked = validate(normalizeGraph(joined), { catalog: CATALOG })
  assert.equal(linked.warnings.some((w) => w.code === 'model-switch'), false,
    'a joined model switch is intentional and must not be flagged')
})

test('shotIndex is independent of topology', () => {
  const graph = normalizeGraph({
    version: 1,
    nodes: [
      { id: 'a', type: 'generate', shotIndex: 3, fields: {} },
      { id: 'b', type: 'generate', shotIndex: 1, fields: {} },
      { id: 'c', type: 'generate', fields: {} },   // no editorial position
    ],
    edges: [{ from: 'a', fromPort: 'job', to: 'b', toPort: 'brief' }],
  })
  const ordered = shots(graph)
  assert.deepEqual(ordered.map((n) => n.shotIndex), [1, 3], 'film order comes from shotIndex, not from edges')
  assert.equal(ordered.length, 2, 'a node without shotIndex is not in the film')
})

test('resolve* falls back to the project spec, then per-node override wins', () => {
  const graph = makeGraph()
  graph.project.model = 'PROJECT_MODEL'
  graph.project.duration = 6
  const node = graph.nodes.find((n) => n.id === 'n_g2')
  assert.equal(resolveModel(graph, node), 'google/veo-3.1-fast', 'node field wins')
  node.fields.model = undefined
  assert.equal(resolveModel(graph, node), 'PROJECT_MODEL', 'project spec is the fallback')
  assert.equal(resolveDuration(graph, node), 6)
})

test('seed policy: base + shotIndex, and null when unlocked', () => {
  const graph = makeGraph()
  assert.equal(resolveSeed(graph, graph.nodes.find((n) => n.id === 'n_g1')), null)
  graph.project.seed = 1000
  assert.equal(resolveSeed(graph, graph.nodes.find((n) => n.id === 'n_g1')), 1001)
  assert.equal(resolveSeed(graph, graph.nodes.find((n) => n.id === 'n_g2')), 1002)
})

/* ================================================================== *
 * executor: money-safety
 * ================================================================== */

test('over budget refuses dispatch and makes ZERO network calls', async () => {
  const graph = makeGraph()
  let submits = 0, polls = 0, downloads = 0
  const states = new Map()
  const jobs = new Map()

  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { submits += 1; return { id: 'x', status: 'pending' } },
    poll: async () => { polls += 1; return { status: 'completed' } },
    download: async () => { downloads += 1; return { filePath: '/tmp/x.mp4' } },
    buildRequest: () => ({}),
    ceilingOf: () => 5,
    budgetUsd: 1,          // ceiling (3 nodes × $5) far exceeds this
    abortOnExceed: true,
    sleep: async () => {},
  })

  assert.equal(submits, 0, 'budget gate must refuse BEFORE any request')
  assert.equal(polls, 0)
  assert.equal(downloads, 0)
  assert.equal(report.paused, true)
  assert.match(report.pauseReason, /超过预算/)
  assert.equal(report.ceilingUsd, 15)
})

test('budget gate does not fire when the ceiling fits', async () => {
  const graph = makeGraph()
  let submits = 0
  const report = await runGraph({
    graph, states: new Map(), jobs: new Map(),
    submit: async () => { submits += 1; return { id: `job${submits}`, status: 'pending' } },
    poll: async () => ({ status: 'completed', usage: { cost: 0.8 } }),
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    ceilingOf: () => 1,
    budgetUsd: 100,
    sleep: async () => {},
  })
  assert.equal(submits, 3, 'all three network nodes should be submitted')
  assert.equal(report.paused, false)
  assert.equal(report.completed.length, 3)
})

test('RESUME: a ledger with in-flight jobs re-attaches and never re-submits', async () => {
  const graph = makeGraph()
  // The node is IN FLIGHT (submitted, not finished). This is the case that
  // matters: a restart must re-attach polling, not submit a second paid job.
  // (An already-COMPLETED node is skipped by the scheduler anyway, so testing
  // that case alone does not exercise the resume path at all — which is exactly
  // why the first version of this test survived a mutation that disabled resume.)
  const states = rehydrate(graph, new Map([
    ['n_g1', { id: 'job_existing_1', nodeId: 'n_g1', status: 'in_progress' }],
  ]))
  assert.equal(states.get('n_g1'), NODE_STATE.IN_PROGRESS)

  const submittedIds = []
  const jobs = new Map([
    ['n_g1', { id: 'job_existing_1', nodeId: 'n_g1', graphId: graph.id, status: 'in_progress' }],
  ])
  await runGraph({
    graph, states, jobs,
    submit: async (node) => { submittedIds.push(node.id); return { id: `new_${node.id}`, status: 'pending' } },
    poll: async (job) => ({ status: 'completed', usage: { cost: 0.1 } }),
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    sleep: async () => {},
  })

  assert.equal(submittedIds.includes('n_g1'), false,
    'a node whose job was already submitted must never be submitted a second time')
  assert.equal(jobs.get('n_g1').id, 'job_existing_1',
    'the original job id must be preserved exactly — it is the resume handle')
  // And it must have actually reached a terminal state via polling, proving the
  // existing job was re-attached rather than ignored.
  assert.equal(states.get('n_g1'), NODE_STATE.COMPLETED,
    'the in-flight job must be polled to completion, not abandoned')
})

test('RESUME: a completed job is re-attached, not re-run', async () => {
  const graph = makeGraph()
  const jobs = new Map([
    ['n_g1', { id: 'job_done', nodeId: 'n_g1', status: 'completed', cost: 0.8 }],
  ])
  const states = rehydrate(graph, jobs)
  assert.equal(states.get('n_g1'), NODE_STATE.COMPLETED)

  let submits = 0
  const report = await runGraph({
    graph, states, jobs,
    submit: async () => { submits += 1; return { id: 'x', status: 'pending' } },
    poll: async () => ({ status: 'completed' }),
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    sleep: async () => {},
  })
  assert.equal(submits, 2, 'only the two nodes without a completed job are submitted')
  assert.equal(report.spentUsd, 0.8, 'the already-spent cost is carried into the report')
})

test('a completed job is downloaded IMMEDIATELY, in the same pass', async () => {
  // The plan (§2 ①) is explicit: the job TTL is unpublished, and a 23-shot film
  // can be generated across days, so a finished clip must hit disk the moment it
  // is seen — not lazily, not on the next run.
  //
  // Nodes run concurrently, so the global event order interleaves. What must
  // hold is the order WITHIN each node: submit → poll… → download, with the
  // download directly following the poll that saw completion.
  const graph = makeGraph()
  const events = []
  const jobs = new Map()
  await runGraph({
    graph, states: new Map(), jobs,
    concurrency: 2,
    submit: async (node) => { events.push('submit:' + node.id); return { id: `j_${node.id}`, status: 'pending' } },
    poll: async (job) => { events.push('poll:' + job.nodeId); return { status: 'completed', usage: { cost: 0.5 } } },
    download: async (job) => { events.push('download:' + job.nodeId); return { filePath: `/tmp/${job.nodeId}.mp4` } },
    buildRequest: () => ({}),
    sleep: async () => {},
  })

  for (const id of ['n_g1', 'n_g2', 'n_d1']) {
    const own = events.filter((event) => event.endsWith(':' + id))
    assert.deepEqual(own, ['submit:' + id, 'poll:' + id, 'download:' + id],
      `${id} must be submitted, polled to completion, then downloaded — in that order, with nothing skipped`)
  }

  // The saved path must reach the ledger, since that is what the UI and the
  // manifest read.
  assert.equal(jobs.get('n_g1').filePath, '/tmp/n_g1.mp4')
})

test('a download failure is a FAILURE, not a silent completion', async () => {
  const graph = makeGraph()
  const jobs = new Map()
  const report = await runGraph({
    graph, states: new Map(), jobs,
    submit: async (node) => ({ id: `j_${node.id}`, status: 'pending' }),
    poll: async () => ({ status: 'completed', usage: { cost: 0.5 } }),
    download: async () => { throw new Error('410 gone') },
    buildRequest: () => ({}),
    sleep: async () => {},
  })
  assert.equal(report.completed.length, 0, 'a job whose bytes could not be saved is not a success')
  // n_g1 and n_g2 both fail on download; n_d1 depends on the failed n_g1 and is
  // therefore skipped rather than attempted.
  assert.equal(report.failed.length, 2)
  assert.ok(report.skipped.includes('n_d1'))
  assert.match(jobs.get('n_g1').error, /下载失败/)
})

test('all six statuses map correctly, cancelled and expired included', () => {
  assert.equal(nodeStateFor('pending'), NODE_STATE.IN_PROGRESS)
  assert.equal(nodeStateFor('in_progress'), NODE_STATE.IN_PROGRESS)
  assert.equal(nodeStateFor('completed'), NODE_STATE.COMPLETED)
  assert.equal(nodeStateFor('failed'), NODE_STATE.FAILED)
  assert.equal(nodeStateFor('cancelled'), NODE_STATE.FAILED)
  assert.equal(nodeStateFor('expired'), NODE_STATE.FAILED)
})

test('a failed upstream SKIPS its dependant but leaves siblings running', async () => {
  const graph = makeGraph()   // n_g1 → n_d1, and n_g2 independent
  const report = await runGraph({
    graph, states: new Map(), jobs: new Map(),
    submit: async (node) => ({ id: `job_${node.id}`, status: 'pending' }),
    poll: async (job) => (job.nodeId === 'n_g1'
      ? { status: 'failed', error: 'provider said no' }
      : { status: 'completed', usage: { cost: 0.5 } }),
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    sleep: async () => {},
  })
  assert.ok(report.failed.includes('n_g1'))
  assert.ok(report.skipped.includes('n_d1'), 'the dependant of a failed node is skipped')
  assert.ok(report.completed.includes('n_g2'),
    'the independent sibling MUST still complete — one bad shot must not sink the film')
})

test('expired is terminal, not a timeout', async () => {
  const graph = makeGraph()   // n_g1 → n_d1, plus independent n_g2
  const report = await runGraph({
    graph, states: new Map(), jobs: new Map(),
    submit: async (node) => ({ id: `j_${node.id}`, status: 'pending' }),
    poll: async () => ({ status: 'expired', error: 'Job exceeded maximum time to live' }),
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    sleep: async () => {},
  })
  // n_g1 and n_g2 are submitted; n_d1 depends on the failed n_g1 and is skipped.
  assert.equal(report.dispatched.length, 2)
  assert.equal(report.failed.length, 2, 'expired is terminal, so it is a failure not a pending job')
  assert.ok(report.skipped.includes('n_d1'), 'the dependant of an expired job cannot run')
})

test('abort stops dispatching new nodes but lets in-flight ones finish', async () => {
  const graph = makeGraph()
  const control = { aborted: false }
  const states = new Map()
  const seen = []
  const report = await runGraph({
    graph, states, jobs: new Map(),
    concurrency: 1,
    submit: async (node) => { seen.push(node.id); return { id: `j_${node.id}`, status: 'pending' } },
    poll: async () => { control.aborted = true; return { status: 'completed', usage: { cost: 0.1 } } },
    download: async () => ({ filePath: '/tmp/a.mp4' }),
    buildRequest: () => ({}),
    control,
    sleep: async () => {},
  })
  assert.equal(report.aborted, true)
  assert.ok(seen.length < 3, 'abort must stop dispatching further nodes')
})

test('partial run: only the chosen node and its downstream are touched', () => {
  const graph = makeGraph()
  const subset = expandSubset(graph, ['n_g1'])
  assert.deepEqual([...subset].sort(), ['n_d1', 'n_g1'])
  assert.equal(subset.has('n_g2'), false, 'a sibling outside the branch is untouched')
})

test('summarize derives counts from state, never from hand-kept numbers', () => {
  const graph = makeGraph()
  const states = new Map([['n_g1', NODE_STATE.COMPLETED], ['n_g2', NODE_STATE.IN_PROGRESS]])
  const result = summarize(graph, states)
  assert.equal(result.total, 3)
  assert.equal(result.completed, 1)
  assert.equal(result.running, 1)
  assert.equal(result.idle, 1)
  assert.equal(result.completed + result.running + result.idle + result.failed + result.skipped, result.total)
})

/* ================================================================== *
 * pricing: ceilings, not quotes
 * ================================================================== */

test('unitOf reads the KEY, so cents are never mistaken for dollars', () => {
  assert.equal(unitOf('duration_seconds'), 'usd-per-second')
  assert.equal(unitOf('duration_seconds_with_audio_1080p'), 'usd-per-second')
  assert.equal(unitOf('cents_per_second_output'), 'cents-per-second')
  assert.equal(unitOf('cents_per_second_video_continuation_720p'), 'cents-per-second')
  assert.equal(unitOf('video_tokens'), 'usd-per-token')
  assert.equal(unitOf('cents_per_megapixel_second_precise'), 'cents-per-mp-second')
  assert.equal(unitOf('minimum_cents_per_generation'), 'cents-floor')
})

test('a cents_ SKU is divided by 100 (the 100× trap)', () => {
  const pricing = describePricing(CATALOG.byId['black-forest-labs/flux-video-edit'])
  // "3" under cents_per_second_output is $0.03/s, not $3/s
  assert.equal(pricing.perSecond.usd, 0.03)
})

test('the per-second ceiling takes the MOST EXPENSIVE variant (upper bound)', () => {
  const pricing = describePricing({
    supported_resolutions: ['720p', '1080p'],
    pricing_skus: { duration_seconds_720p: '0.10', duration_seconds_1080p: '0.50' },
  })
  assert.equal(pricing.perSecond.usd, 0.50, 'an upper bound must not be the cheap variant')
})

test('continuation pricing is picked for extend nodes (the 2.4× leg)', () => {
  const model = CATALOG.byId['black-forest-labs/flux-3-video']
  const plain = nodeCeiling({ model, seconds: 8, kind: 'plain' })
  const cont = nodeCeiling({ model, seconds: 8, kind: 'continuation' })
  assert.equal(plain.usd, 1.36, '$0.17/s × 8s')
  assert.equal(cont.usd, 3.28, '$0.41/s × 8s — the continuation SKU')
  assert.ok(cont.usd > plain.usd)
})

test('minimum_cents_per_generation is honoured as a floor', () => {
  const model = CATALOG.byId['runway/aleph-2']
  const two = nodeCeiling({ model, seconds: 2 })
  assert.equal(two.usd, 0.56, 'a 2s edit still costs the $0.56 floor')
  const ten = nodeCeiling({ model, seconds: 10 })
  // $0.28/s × 10s; compare with tolerance because 0.28 is not exact in binary.
  assert.ok(Math.abs(ten.usd - 2.80) < 1e-9, 'above the floor, the per-second rate applies')
})

test('token-priced models are UNKNOWN, never zero', () => {
  const model = CATALOG.byId['bytedance/seedance-2.5']
  const entry = nodeCeiling({ model, seconds: 8 })
  assert.equal(entry.usd, null, 'an unknown magnitude must be null, not 0')
  assert.equal(entry.source, 'per-token')

  const summary = ceilingFor([
    { id: 'a', model: CATALOG.byId['google/veo-3.1-fast'], seconds: 8, kind: 'plain' },
    { id: 'b', model, seconds: 8, kind: 'plain' },
  ])
  assert.equal(summary.unknown, 1, 'the unknown node is counted separately')
  assert.equal(summary.total, 0.96, 'and contributes nothing to the total')
  assert.equal(summary.complete, false)
})

test('MP·s pricing uses the largest supported resolution', () => {
  const model = CATALOG.byId['black-forest-labs/flux-video-upscale']
  assert.equal(largestResolution(model), '1080p', 'the safe side of an upper bound')
  const entry = nodeCeiling({ model, seconds: 8 })
  // 0.105 cents/MP·s ÷ 100 × (1920×1080/1e6 × 8s) = $0.0174...
  const expected = (10.5 / 100) * ((1920 * 1080 / 1_000_000) * 8)
  assert.ok(Math.abs(entry.usd - expected) < 1e-9)
  assert.equal(entry.source, 'per-mp-second')
})

test('a model with no pricing_skus is unknown rather than free', () => {
  const entry = nodeCeiling({ model: { id: 'x', pricing_skus: null }, seconds: 8 })
  assert.equal(entry.usd, null)
  const noModel = nodeCeiling({ model: null, seconds: 8 })
  assert.equal(noModel.usd, null)
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
