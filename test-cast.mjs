/**
 * 角色库 tests: `lib/cast.js` and the validation that explains it.
 *
 * Two failures are being fixed, and they are different failures:
 *
 *   1. a 12-shot film rendered with one model, one style prompt and working
 *      first/last-frame chaining (seam SSIM 0.90) still had **a different cat in
 *      every shot** — chaining fixes the transition, not the identity, and each
 *      prompt re-described the cat;
 *   2. the first fix for (1) made the character GLOBAL, which is its own bug:
 *      shot 3 is the cat alone and shot 7 is the cat, the mouse and the dog, so a
 *      graph-wide fan-out hands the provider a reference to a character who is
 *      not in the scene.
 *
 * The assertions below are mostly about (2), because "wired per shot" is the
 * claim that is easy to write and easy to get wrong.
 *
 * Run: node test-cast.mjs
 */
import assert from 'node:assert/strict'
import {
  castLibrary, castFor, castUsage, castPromptBlock, applyCast, castReferences,
  describeCast, bibleFor, sceneLibrary, bibleBlocks, CAST_MARKER, SCENE_MARKER,
} from './lib/cast.js'
import { validate, normalizeGraph, NODE_TYPES } from './lib/graph.js'

let passed = 0
let failed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

const castNode = (id, fields, extra = {}) => ({ id, type: 'cast', x: 0, y: 0, fields, ...extra })
const shotNode = (id, shotIndex, fields = {}) => ({ id, type: 'generate', shotIndex, x: 0, y: 0, fields: { prompt: 'a shot', ...fields } })

const graphOf = (nodes, edges = []) => normalizeGraph({
  id: 'g_cast', title: '角色',
  project: { model: 'm', resolution: '720p', aspectRatio: '16:9', duration: 5, generateAudio: true, seed: null },
  nodes, edges,
})

/** TOM and JERRY defined once; each wired to whichever shots they appear in. */
const rosterGraph = () => graphOf(
  [
    castNode('n_cast1', { name: 'TOM', description: '蓝灰色家猫，圆脸，黄眼睛', source: 'https://x/tom.png' }),
    castNode('n_cast2', { name: 'JERRY', description: '棕色小老鼠，大耳朵', source: 'https://x/jerry.png' }),
    shotNode('n_s01', 1),
    shotNode('n_s02', 2),
  ],
  [
    { id: 'e1', from: 'n_cast1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' },
    { id: 'e2', from: 'n_cast1', fromPort: 'asset', to: 'n_s02', toPort: 'refs' },
    { id: 'e3', from: 'n_cast2', fromPort: 'asset', to: 'n_s02', toPort: 'refs' },
  ],
)

/* ------------------------------------------------------------------ *
 * library
 * ------------------------------------------------------------------ */

test('cast is a registered node type — the canvas, inspector and executor pick it up as data', () => {
  assert.ok(NODE_TYPES.cast, 'cast must exist in NODE_TYPES or a stored cast node loses its ports')
  assert.equal(NODE_TYPES.cast.label, '角色')
  assert.ok(NODE_TYPES.cast.fields.some((field) => field.key === 'description'))
  assert.ok(NODE_TYPES.cast.fields.some((field) => field.key === 'source'), 'a character needs an image field')
})

test('castLibrary reads every character definition, without requiring a single edge', () => {
  const cast = castLibrary(rosterGraph())
  assert.deepEqual(cast.map((row) => row.name), ['TOM', 'JERRY'])
  assert.equal(cast[0].source, 'https://x/tom.png')
})

test('castLibrary orders by canvas position so the roster is stable across a save/load', () => {
  const graph = graphOf([
    castNode('n_castA', { name: 'A', description: 'a' }, { y: 400 }),
    castNode('n_castB', { name: 'B', description: 'b' }, { y: 100 }),
  ])
  assert.deepEqual(castLibrary(graph).map((row) => row.name), ['B', 'A'])
})

test('a disabled cast node stops applying — the toggle has to mean something', () => {
  const graph = graphOf([
    castNode('n_cast1', { name: 'TOM', description: 'x' }),
    castNode('n_cast2', { name: 'JERRY', description: 'y' }, { disabled: true }),
  ])
  assert.deepEqual(castLibrary(graph).map((row) => row.name), ['TOM'])
})

test('an unnamed node falls back to its canvas title, never to an empty label', () => {
  assert.equal(castLibrary(graphOf([castNode('n_cast1', { description: 'x' }, { title: '坏猫' }) ]))[0].name, '坏猫')
})

test('a graph with no cast nodes yields an empty list, not a crash', () => {
  assert.deepEqual(castLibrary(graphOf([])), [])
  assert.deepEqual(castLibrary(null), [])
})

/* ------------------------------------------------------------------ *
 * wiring — the whole point
 * ------------------------------------------------------------------ */

test('castFor returns ONLY the characters wired into that shot', () => {
  const graph = rosterGraph()
  assert.deepEqual(castFor(graph, 'n_s01').map((row) => row.name), ['TOM'])
  assert.deepEqual(castFor(graph, 'n_s02').map((row) => row.name), ['TOM', 'JERRY'])
})

test('THE BUG: a shot does not get a character that is not in it', () => {
  // Shot 1 is the cat alone. Before the cast was wired, every character in the
  // graph was pinned onto every shot — so this prompt carried JERRY and its
  // reference image, describing and depicting a mouse that is not in the scene.
  const graph = rosterGraph()
  const shot1 = applyCast('猫在厨房里追老鼠', castFor(graph, 'n_s01'))
  assert.match(shot1, /TOM/u)
  assert.ok(!shot1.includes('JERRY'), `shot 1 must not carry JERRY: ${shot1}`)

  const shot2 = applyCast('猫和老鼠对峙', castFor(graph, 'n_s02'))
  assert.match(shot2, /TOM/u)
  assert.match(shot2, /JERRY/u)
})

test('a shot with no character wired gets no bible at all', () => {
  const graph = graphOf([castNode('n_cast1', { name: 'TOM', description: 'x' }), shotNode('n_s01', 1)])
  assert.deepEqual(castFor(graph, 'n_s01'), [])
  assert.equal(applyCast('空镜：窗外下雨', castFor(graph, 'n_s01')), '空镜：窗外下雨')
})

test('one definition fans out to many shots — that is what makes it reusable', () => {
  const graph = rosterGraph()
  const usage = castUsage(graph)
  assert.deepEqual(usage.get('n_cast1'), ['n_s01', 'n_s02'], 'TOM is in both shots')
  assert.deepEqual(usage.get('n_cast2'), ['n_s02'], 'JERRY is in one')
})

test('undrawing a wire un-pins the character, because scope is DERIVED not stored', () => {
  // A stored copy of "which shots is this character in" would be a second source
  // of truth and would drift on the very first rewire.
  const graph = rosterGraph()
  graph.edges = graph.edges.filter((edge) => edge.id !== 'e3')
  assert.deepEqual(castFor(graph, 'n_s02').map((row) => row.name), ['TOM'])
})

test('a wire into a port OTHER than refs does not pin the character', () => {
  const graph = graphOf(
    [castNode('n_cast1', { name: 'TOM', description: 'x', source: 'https://x/tom.png' }), shotNode('n_s01', 1)],
    [{ id: 'e1', from: 'n_cast1', fromPort: 'asset', to: 'n_s01', toPort: 'frames' }],
  )
  assert.deepEqual(castFor(graph, 'n_s01'), [], 'a first frame is not a character bible')
})

/* ------------------------------------------------------------------ *
 * prompt block / applyCast
 * ------------------------------------------------------------------ */

test('the block names every described character, under a marker line', () => {
  const block = castPromptBlock([{ kind: 'cast', name: 'TOM', description: '蓝灰色家猫' }, { kind: 'cast', name: 'JERRY', description: '棕色小老鼠' }])
  assert.ok(block.startsWith(CAST_MARKER))
  assert.match(block, /TOM: 蓝灰色家猫/u)
  assert.match(block, /JERRY: 棕色小老鼠/u)
})

test('a character with no description contributes nothing — a bare name pins nothing', () => {
  assert.equal(castPromptBlock([{ kind: 'cast', name: 'TOM', description: '' }]), '')
  assert.equal(castPromptBlock([]), '')
})

test('applyCast prepends the block and keeps the shot prompt intact', () => {
  const applied = applyCast('猫在厨房里追老鼠', [{ kind: 'cast', name: 'TOM', description: '蓝灰色家猫' }])
  assert.ok(applied.startsWith(CAST_MARKER))
  assert.ok(applied.endsWith('猫在厨房里追老鼠'))
})

test('applyCast is IDEMPOTENT — a retry must not stack a second copy of the bible', () => {
  const once = applyCast('镜头', [{ kind: 'cast', name: 'TOM', description: '蓝灰色家猫' }])
  const twice = applyCast(once, [{ kind: 'cast', name: 'TOM', description: '蓝灰色家猫' }])
  assert.equal(twice, once)
  assert.equal(twice.split(CAST_MARKER).length - 1, 1)
})

test('a shot with no character WIRED in gets no bible — the wiring is the switch', () => {
  /* There used to be a per-node `useCast` boolean next to this. It is gone: once
     a character is a node you wire to the shots it appears in, "this shot has no
     cast" IS the absence of a wire. Two controls for one decision is how the
     inspector ends up disagreeing with the request. */
  const graph = {
    nodes: [
      { id: 'n_tom', type: 'cast', x: 0, y: 0, fields: { name: 'TOM', description: '蓝灰色家猫' } },
      { id: 'n_s01', type: 'generate', x: 200, y: 0, shotIndex: 1, fields: { prompt: '猫在厨房里追老鼠' } },
      { id: 'n_s02', type: 'generate', x: 200, y: 120, shotIndex: 2, fields: { prompt: '空镜：窗外下雨' } },
    ],
    edges: [{ id: 'e1', from: 'n_tom', fromPort: 'asset', to: 'n_s01', toPort: 'refs' }],
  }
  assert.ok(applyCast('猫在厨房里追老鼠', castFor(graph, 'n_s01')).startsWith(CAST_MARKER))
  assert.equal(applyCast('空镜：窗外下雨', castFor(graph, 'n_s02')), '空镜：窗外下雨')
})

test('a shot with no prompt of its own still gets the bible', () => {
  const applied = applyCast('', [{ kind: 'cast', name: 'TOM', description: '蓝灰色家猫' }])
  assert.ok(applied.startsWith(CAST_MARKER))
})

test('castReferences dedupes by URL, because a pair sheet is often shared', () => {
  const refs = castReferences([
    { name: 'TOM', source: 'https://x/sheet.png' },
    { name: 'JERRY', source: 'https://x/sheet.png' },
    { name: 'SPIKE', source: null },
  ])
  assert.equal(refs.length, 1)
  assert.deepEqual(refs[0], { type: 'image_url', image_url: { url: 'https://x/sheet.png' } })
})

/* ------------------------------------------------------------------ *
 * describeCast
 * ------------------------------------------------------------------ */

test('describeCast reports what is pinned AND which definitions are doing nothing', () => {
  assert.equal(describeCast(graphOf([])), null)
  const summary = describeCast(rosterGraph())
  assert.deepEqual(summary.characters, ['TOM', 'JERRY'])
  assert.equal(summary.descriptions, 2)
  assert.equal(summary.images, 2)
  assert.deepEqual(summary.unused, [])

  const lonely = describeCast(graphOf([
    castNode('n_cast1', { name: 'TOM', description: 'x' }),
    castNode('n_cast2', { name: 'SPIKE', description: 'y' }),
    shotNode('n_s01', 1),
  ], [{ id: 'e1', from: 'n_cast1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' }]))
  assert.deepEqual(lonely.unused, ['角色「SPIKE」'], 'a defined character wired to nothing is inert and must be named')
})

/* ------------------------------------------------------------------ *
 * validation says the limits out loud
 * ------------------------------------------------------------------ */

test('a character wired to nothing is a warning, because it silently does nothing', () => {
  const graph = graphOf([castNode('n_cast1', { name: 'TOM', description: '蓝灰色家猫' })])
  const warning = validate(graph).warnings.find((row) => row.code === 'cast-unused')
  assert.ok(warning, 'silence here is how "I made a character and nothing happened" becomes a mystery')
  assert.match(warning.message, /TOM/u)
  assert.match(warning.message, /refs/u, 'the message must say what to connect')
})

test('a character with no description is a warning, because the film WILL drift', () => {
  const graph = graphOf(
    [castNode('n_cast1', { name: 'TOM', source: 'https://x/tom.png' }), shotNode('n_s01', 1)],
    [{ id: 'e1', from: 'n_cast1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' }],
  )
  const warning = validate(graph).warnings.find((row) => row.code === 'cast-without-description')
  assert.ok(warning)
  assert.match(warning.message, /固定外形描述/u)
})

test('a shot with BOTH a first frame and a character reference warns — the provider refuses that pair', () => {
  // The provider REFUSES a request carrying both `frame_images` and
  // `input_references` (measured 400), so the plugin drops the references. That is
  // the reason a hard cut is where a character reference actually works.
  // `warned`, not `blocked`: the graph stays legal — the frames are a deliberate
  // continuity instruction and only the references are sacrificed.
  const graph = graphOf(
    [
      castNode('n_cast1', { name: 'TOM', description: '蓝灰色家猫', source: 'https://x/tom.png' }),
      { id: 'n_take1', type: 'take', x: 0, y: 0, fields: { frame: 'last_frame', slot: 'first_frame' } },
      shotNode('n_s01', 1),
      shotNode('n_s02', 2),
    ],
    [
      { id: 'e1', from: 'n_s01', fromPort: 'job', to: 'n_take1', toPort: 'job' },
      { id: 'e2', from: 'n_take1', fromPort: 'image', to: 'n_s02', toPort: 'frames' },
      { id: 'e3', from: 'n_cast1', fromPort: 'asset', to: 'n_s02', toPort: 'refs' },
    ],
  )
  const warning = validate(graph).warnings.find((row) => row.code === 'cast-overridden-by-frames')
  assert.ok(warning)
  // Measured, not theorised: heygen refuses the combination with a 400, so the
  // warning must say the references are DROPPED — not "the provider picks one".
  assert.match(warning.message, /拒绝/u)
  assert.match(warning.message, /丢掉/u)
  assert.match(warning.message, /1 个镜头/u, 'it counts the affected shots rather than hand-waving')
})

test('a fully wired, fully described cast with no chaining raises no cast warning', () => {
  const result = validate(rosterGraph())
  assert.equal(result.warnings.filter((row) => row.code.startsWith('cast-')).length, 0)
  assert.equal(result.ok, true)
})

/* ================================================================== *
 * 场景设定 — 同一个机制，钉住地点
 * ================================================================== */

/** A rooftop plate + the place, wired into two shots, alongside a character. */
const sceneGraph = () => normalizeGraph({
  id: 'g_scene',
  nodes: [
    {
      id: 'n_scene1', type: 'scene', x: 0, y: 0,
      fields: {
        name: '天台',
        description: '黄昏的城市屋顶，右侧一面满涂鸦的混凝土墙，地面裂缝水泥，低角度硬光，暖色轮廓光',
        source: 'https://img.example.com/rooftop-plate.png',
      },
    },
    { id: 'n_cast1', type: 'cast', x: 0, y: 200, fields: { name: 'MOMO', description: '橘白虎斑猫，芥末黄卫衣，反扣红帽' } },
    { id: 'n_s01', type: 'generate', x: 300, y: 0, shotIndex: 1, fields: { prompt: 'Wide, low angle.' } },
    { id: 'n_s02', type: 'generate', x: 300, y: 200, shotIndex: 2, fields: { prompt: 'Medium, orbit.' } },
  ],
  edges: [
    { id: 'e1', from: 'n_scene1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' },
    { id: 'e2', from: 'n_cast1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' },
    { id: 'e3', from: 'n_scene1', fromPort: 'asset', to: 'n_s02', toPort: 'refs' },
  ],
})

test('a 场景 node pins the PLACE with its own marker, and the character keeps its own', () => {
  const rows = bibleFor(sceneGraph(), 'n_s01')
  const blocks = bibleBlocks(rows)
  assert.equal(blocks.length, 2, 'both a scene block and a character block must be produced')
  assert.deepEqual(blocks.map((b) => b.kind), ['scene', 'cast'], 'scene first, in a fixed order')
  assert.equal(blocks[0].marker, SCENE_MARKER)
  assert.equal(blocks[1].marker, CAST_MARKER)

  const pinned = applyCast('Wide, low angle.', rows)
  assert.match(pinned, /【场景设定/u)
  assert.match(pinned, /涂鸦/u, 'the fixed place description must ride along verbatim')
  assert.match(pinned, /【角色设定/u)
  assert.match(pinned, /MOMO: /u)
  assert.ok(pinned.endsWith('Wide, low angle.'), 'the shot prompt must survive untouched')
})

test('scene and character scope are DERIVED from the wires, not shared blindly', () => {
  const graph = sceneGraph()
  assert.deepEqual(sceneLibrary(graph).map((r) => r.name), ['天台'])
  assert.deepEqual(castLibrary(graph).map((r) => r.name), ['MOMO'])
  assert.deepEqual(bibleFor(graph, 'n_s01').map((r) => r.kind).sort(), ['cast', 'scene'])
  // Shot 2 has the place but nobody in it — "MOMO is not in this shot" is spoken
  // by the absence of that wire, and the scene must NOT be dragged along by it.
  assert.deepEqual(bibleFor(graph, 'n_s02').map((r) => r.kind), ['scene'])
  assert.equal(castFor(graph, 'n_s02').length, 0)
})

test('THE FIX: a scene block still lands on a prompt that already carries the character block', () => {
  // The old guard was `text.trimStart().startsWith(CAST_MARKER)`. So once a
  // prompt carried the character bible, a scene added later was silently never
  // applied — the scene kept drifting exactly as before while the code reported
  // it pinned. Idempotence has to be PER BLOCK, not per prompt.
  const graph = sceneGraph()
  const withCastOnly = applyCast('Wide, low angle.', [bibleFor(graph, 'n_s01').find((r) => r.kind === 'cast')])
  assert.ok(withCastOnly.startsWith(CAST_MARKER))
  assert.ok(!withCastOnly.includes(SCENE_MARKER))

  const thenScene = applyCast(withCastOnly, bibleFor(graph, 'n_s01'))
  assert.match(thenScene, /【场景设定/u, 'the scene must still be applied after the fact')
  assert.equal(thenScene.split(SCENE_MARKER).length - 1, 1, 'exactly once')
  assert.equal(thenScene.split(CAST_MARKER).length - 1, 1, 'and the character block must not be doubled')
})

test('applyCast stays idempotent when BOTH blocks are already present', () => {
  const graph = sceneGraph()
  const once = applyCast('镜头', bibleFor(graph, 'n_s01'))
  const twice = applyCast(once, bibleFor(graph, 'n_s01'))
  assert.equal(twice, once)
  assert.equal(twice.split(SCENE_MARKER).length - 1, 1)
  assert.equal(twice.split(CAST_MARKER).length - 1, 1)
})

test('a scene with no description is a warning, because the place will drift', () => {
  const graph = normalizeGraph({
    id: 'g',
    nodes: [
      { id: 'n_scene1', type: 'scene', fields: { name: '天台' } },
      { id: 'n_s01', type: 'generate', shotIndex: 1, fields: { prompt: 'a' } },
    ],
    edges: [{ id: 'e1', from: 'n_scene1', fromPort: 'asset', to: 'n_s01', toPort: 'refs' }],
  })
  const warning = validate(graph).warnings.find((row) => row.code === 'scene-without-description')
  assert.ok(warning, 'a scene with only a reference image must be called out')
  assert.match(warning.message, /固定场景描述/u)
  assert.match(warning.message, /地点 \/ 时间 \/ 光线 \/ 材质/u, 'and it must say what a scene description is for')
})

test('a scene wired to nothing is a warning — the definition is inert until it is on a shot', () => {
  const graph = normalizeGraph({
    id: 'g',
    nodes: [
      { id: 'n_scene1', type: 'scene', fields: { name: '天台', description: '黄昏屋顶' } },
      { id: 'n_s01', type: 'generate', shotIndex: 1, fields: { prompt: 'a' } },
    ],
    edges: [],
  })
  const warning = validate(graph).warnings.find((row) => row.code === 'scene-unused')
  assert.ok(warning, 'a defined scene that is wired to nothing does nothing')
  assert.match(warning.message, /天台/u)
})

test('describeCast reports scenes alongside characters', () => {
  const summary = describeCast(sceneGraph())
  assert.deepEqual(summary.characters, ['MOMO'])
  assert.deepEqual(summary.scenes, ['天台'])
})

test('scene is a registered node type with an asset output, like cast', () => {
  assert.ok(NODE_TYPES.scene, 'the scene node must be in the registry the Host publishes')
  assert.deepEqual(NODE_TYPES.scene.outputs.map((row) => row.port), ['asset'])
  assert.equal(NODE_TYPES.scene.inputs.length, 0)
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
