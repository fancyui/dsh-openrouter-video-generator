/**
 * test-interact.mjs — does the workspace actually RESPOND to input?
 *
 * preview.mjs proves the shell renders. It cannot prove a node can be dragged,
 * because it renders to an HTML string and throws the element tree away: every
 * event handler in it is unverified. That gap is exactly what shipped: the node
 * library rows had no onClick at all and nodes could not be moved, and every
 * existing test stayed green.
 *
 * So this harness keeps the element tree, keeps a real listener registry on the
 * fake window, dispatches real events, and asserts on the WRITE the interaction
 * produced — a drag that only updated a style string would pass a DOM assertion
 * while leaving the document unchanged.
 *
 * Run: node test-interact.mjs
 */
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${error.message}`) }
}

const realTimeout = globalThis.setTimeout.bind(globalThis)

/* ================================================================== *
 * React stand-in (same contract preview.mjs uses, effectDeps included)
 * ================================================================== */

function createReact() {
  let current = null
  const depsChanged = (previous, next) => {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return true
    return false
  }
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  const slotOf = () => {
    if (current === null) throw new Error('hook outside render')
    return current
  }
  const useState = (initial) => {
    const slot = slotOf()
    const index = slot.cursor++
    if (!(index in slot.values)) slot.values[index] = typeof initial === 'function' ? initial() : initial
    return [slot.values[index], (next) => {
      slot.values[index] = typeof next === 'function' ? next(slot.values[index]) : next
      slot.dirty = true
    }]
  }
  const useRef = (initial) => {
    const slot = slotOf()
    const index = slot.cursor++
    if (!(index in slot.refs)) slot.refs[index] = { current: initial }
    return slot.refs[index]
  }
  const useMemo = (fn, deps) => {
    const slot = slotOf()
    const index = slot.cursor++
    const previous = slot.memos[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) slot.memos[index] = { value: fn(), deps }
    return slot.memos[index].value
  }
  const useCallback = (fn, deps) => {
    const slot = slotOf()
    const index = slot.cursor++
    const previous = slot.callbacks[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) slot.callbacks[index] = { fn, deps }
    return slot.callbacks[index].fn
  }
  const useEffect = (fn, deps) => {
    const slot = slotOf()
    const index = slot.cursor++
    const previous = slot.effectDeps[index]
    if (previous === undefined || depsChanged(previous, deps)) {
      slot.effectDeps[index] = deps
      slot.pendingEffects.push(fn)
    }
  }
  return {
    createElement, useState, useRef, useMemo, useCallback, useEffect,
    Component: function Component() {}, Fragment: Symbol('Fragment'),
    __internal: { get current() { return current }, set current(v) { current = v } },
  }
}

const React = createReact()
const componentState = new Map()
const effectCleanups = []
let pendingEffects = []

function callComponent(type, props) {
  const key = type.name ?? 'anonymous'
  const slot = componentState.get(key) ?? {
    cursor: 0, values: [], refs: {}, memos: {}, callbacks: {}, effects: [], effectDeps: {}, pendingEffects: [], dirty: false,
  }
  slot.cursor = 0
  slot.pendingEffects = []
  const previous = React.__internal.current
  React.__internal.current = slot
  const output = type(props)
  React.__internal.current = previous
  componentState.set(key, slot)
  for (const effect of slot.pendingEffects) pendingEffects.push(effect)
  return output
}

async function flushEffects(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    const queue = pendingEffects.splice(0, pendingEffects.length)
    for (const effect of queue) {
      const cleanup = effect()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    }
    await new Promise((resolve) => realTimeout(resolve, 0))
  }
}

/* ================================================================== *
 * tree helpers
 * ================================================================== */

const findAll = (node, predicate, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (node.type !== undefined && node.props !== undefined && predicate(node)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findAll(child, predicate, out)
  return out
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return Array.isArray(node.children) ? node.children.map(textOf).join('') : ''
}

/* ================================================================== *
 * environment
 * ================================================================== */

const listeners = new Map()
const dispatchWindow = (type, event) => {
  for (const fn of listeners.get(type) ?? []) fn(event)
}

const makeDom = () => {
  const byId = new Map()
  const makeEl = (tag) => ({
    tagName: tag, id: '', className: '', textContent: '', innerHTML: '', style: {}, children: [], dataset: {},
    appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child); return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child) },
    remove() {},
    setAttribute(name, value) { this[name] = value },
    getAttribute(name) { return this[name] ?? null },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 14, right: 120, bottom: 14 } },
  })
  const document = {
    head: makeEl('head'),
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => makeEl(tag),
    addEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] },
    body: makeEl('body'),
  }
  return { document, byId, makeEl }
}

const dom = makeDom()

/* ================================================================== *
 * the commit model
 * ================================================================== */

/**
 * React attaches refs and mutates the real DOM at COMMIT — after the render that
 * produced the elements. So `worldRef.current` is null during the first render,
 * and the ports of a node that was just rendered are not queryable until the
 * commit creating them has finished.
 *
 * Reproducing that ordering is the entire point. A mock whose "DOM" answers
 * eagerly cannot observe the defect where the wire layer is measured during
 * render and then cached empty: it would report wires that the browser never
 * draws.
 */
const committed = new Map()
const worldEl = {
  querySelector(selector) {
    return committed.get(String(selector).replace(/^#/u, '')) ?? null
  },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 2400, height: 1400, right: 2400, bottom: 1400 }),
}

/** Apply one commit: register ids, lay out ports, attach refs. */
const commit = (tree) => {
  committed.clear()
  const walk = (node, owning) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child, owning); return }
    if (typeof node !== 'object' || node.type === undefined) return

    const props = node.props ?? {}
    let nextOwning = owning
    if (typeof props.id === 'string' && props.id.startsWith('ov-node-')) {
      nextOwning = {
        left: Number.parseFloat(props.style?.left ?? '0') || 0,
        top: Number.parseFloat(props.style?.top ?? '0') || 0,
      }
    }

    let element = null
    if (typeof props.id === 'string') {
      element = dom.makeEl(node.type)
      element.id = props.id
      if (props.id.startsWith('ov-port-') && nextOwning !== null) {
        const isIn = props.id.startsWith('ov-port-in-')
        // Real layout decides these; deriving them from the owning node keeps
        // the geometry distinct and stable without inventing a layout engine.
        const left = nextOwning.left + (isIn ? 0 : 176)
        const top = nextOwning.top + 52
        element.getBoundingClientRect = () => ({ left, top, width: 8, height: 8, right: left + 8, bottom: top + 8 })
      }
      committed.set(props.id, element)
    }

    if (props.ref !== undefined) {
      const target = props.className === 'dsh-ov-world' ? worldEl : (element ?? dom.makeEl(node.type))
      if (typeof props.ref === 'function') props.ref(target)
      else if (props.ref !== null && typeof props.ref === 'object') props.ref.current = target
    }

    if (Array.isArray(node.children)) for (const child of node.children) walk(child, nextOwning)
  }
  walk(tree, null)
}

/** Every fetch, with the method and the parsed body — the assertions live here. */
const calls = []
/** Flip to make POST /config fail the way a missing settings service does. */
let configPostFails = false
/**
 * The Host's stored plugin config, modelled rather than canned.
 *
 * A stub that answers every read with a fixed object makes "the save persisted"
 * indistinguishable from "the save did nothing", which is exactly the bug the
 * key tests exist to catch. Saving here has to be observable on the next read.
 */
const storedConfig = {
  concurrency: 2, budgetUsd: 30, model: 'google/veo-3.1-fast', models: [],
  imageBedUrl: '', imageBedFolder: 'test', imageBedUserAgent: 'gobelagent',
  // The Host's own node registry. Mutable so a skew test can withhold a type.
  nodeTypes: ['script', 'prompt', 'ref', 'cast', 'scene', 'generate', 'extend', 'edit', 'upscale', 'take', 'seq', 'note', 'group', 'template'],
}
let storedKey = ''
/* Two knobs on the snapshot the Host reports, so a test can reproduce states the
   fixture never has: a FAILED shot (nothing in it fails), and a run that is live
   because somebody else started it. */
let failNode = null
let snapshotIsRunning = false
/* A node mid-generation. The reported symptom was that an agent-driven run showed
   NO 生成中 and NO progress, so the check has to be able to make one live. */
let liveNode = null
const publicConfig = () => ({
  config: { ...storedConfig, hasImageBedToken: false },
  key: storedKey.length === 0
    ? { hasKey: false, prefix: '', suffix: '', looksValid: false }
    : { hasKey: true, prefix: storedKey.slice(0, 9), suffix: storedKey.slice(-4), looksValid: true },
})
/**
 * The Host's stored graph document.
 *
 * The stub used to answer every read with the ORIGINAL `FAKE_GRAPH`, so a write
 * that appended a node round-tripped straight back out of existence. A test that
 * only looked at the POST body could not tell that apart from a working save —
 * and the canvas really did still show three nodes afterwards. Modelling the
 * persistence is what makes "clicking a library row puts a node on the canvas"
 * an assertable claim rather than a claim about a request body.
 */
let persistedGraph = null
/**
 * The Host's project list, modelled rather than canned.
 *
 * `/graphs` used to answer with one fixed entry for ever, so a delete test could
 * not tell "the project was removed" from "the list never changed" — the same
 * reason `persistedGraph` exists one screen up. Deleting has to be observable on
 * the next read, or the assertion is about a request body and nothing else.
 */
const twoProjects = () => ([
  { id: 'graph_test', title: '交互测试', nodes: 6, edges: 5, updatedAt: 2 },
  { id: 'graph_old', title: '旧项目', nodes: 3, edges: 2, updatedAt: 1 },
])
let storedGraphs = twoProjects()
let newGraphSeq = 0
const graphRows = () => storedGraphs.map((g) => ({ ...g, state: 'idle' }))
globalThis.fetch = async (url, options) => {
  const path = String(url)
  const method = (options?.method ?? 'GET').toUpperCase()
  const body = options?.body === undefined ? undefined : JSON.parse(options.body)
  calls.push({ path, method, body })
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload })

  if (path.endsWith('/config') && method === 'GET') {
    return json({ ok: true, ...publicConfig() })
  }
  if (path.endsWith('/config') && method === 'POST') {
    // The Host reports failures as HTTP 200 + {ok:false}, so a resolving fetch is
    // NOT success — the client has to read the body. Not reading it is how a save
    // that persisted nothing still reported 已保存.
    if (configPostFails) {
      return json({ ok: false, error: '设置服务不可用：当前 DSH 运行时没有挂载可写的配置编辑器，因此密钥无法保存。' })
    }
    const patch = body?.config ?? {}
    if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) storedKey = patch.apiKey
    for (const [key, value] of Object.entries(patch)) if (key !== 'apiKey') storedConfig[key] = value
    return json({ ok: true, ...publicConfig() })
  }
  if (path.endsWith('/config/key') && method === 'DELETE') {
    storedKey = ''
    return json({ ok: true, ...publicConfig() })
  }
  if (path.endsWith('/bed/test') && method === 'POST') {
    return json({ ok: true, url: 'https://img.example.com/file/test/probe.png', message: '图床可用' })
  }
  if (path.endsWith('/test')) {
    return json({ ok: true, message: '密钥可用，视频模型目录有 42 个模型' })
  }
  if (path.endsWith('/graphs')) return json({ ok: true, graphs: graphRows() })
  if (path.endsWith('/graph/delete') && method === 'POST') {
    const id = body?.id ?? ''
    const existed = storedGraphs.some((g) => g.id === id)
    storedGraphs = storedGraphs.filter((g) => g.id !== id)
    return existed
      ? json({ ok: true, id, graphs: graphRows() })
      : json({ ok: false, error: `没有这个图：${id}` })
  }
  if (path.endsWith('/graph/new') && method === 'POST') {
    newGraphSeq += 1
    const id = 'graph_new' + newGraphSeq
    const graph = { ...FAKE_GRAPH, id, title: body?.title ?? '未命名项目', nodes: [], edges: [] }
    storedGraphs = [{ id, title: graph.title, nodes: 0, edges: 0, updatedAt: 9 }, ...storedGraphs]
    persistedGraph = graph
    return json({ ok: true, graph })
  }
  if (path.includes('/graph?id=')) {
    return json({
      ok: true, graph: persistedGraph ?? FAKE_GRAPH,
      states: {
        n_script: 'idle',
        n_g1: 'completed',
        n_g2: liveNode === 'n_g2' ? 'in_progress' : (failNode === 'n_g2' ? 'failed' : 'idle'),
      },
      /* One REAL finished clip. Without it the strip, the table thumbnail and the
         preview modal all render their empty state, and a test of "click a clip
         to play it" would be asserting on a slot that never had a clip in it. */
      jobs: [{
        id: 'vid_s01', nodeId: 'n_g1', status: 'completed', cost: 0.8,
        filePathRelative: 'generated-videos/s01.mp4', error: null, model: 'google/veo-3.1-fast',
      }, ...(failNode === null ? [] : [{
        id: 'vid_dead', nodeId: failNode, status: 'failed', cost: null,
        filePathRelative: null, error: 'provider 400', model: 'google/veo-3.1-fast',
      }])],
      ceilings: { n_g1: 0.8, n_g2: 0.8 }, ceilingTotal: 1.6, unknownCount: 0,
      spentUsd: 0.8, budgetUsd: 30,
      counts: {
        total: 2, completed: 1, running: snapshotIsRunning === true ? 1 : 0,
        failed: failNode === null ? 0 : 1, skipped: 0, idle: failNode === null ? 1 : 0,
      },
      totalSeconds: 16, running: snapshotIsRunning === true, aborted: false, report: null,
      catalogLoaded: true, catalogError: null,
    })
  }
  if (path.endsWith('/graph') && method === 'POST') {
    // The Host stores what it was sent; a stub that forgets makes every save
    // look identical to a save that persisted nothing.
    if (body?.graph) persistedGraph = body.graph
    return json({ ok: true, graph: body?.graph ?? null, errors: [], warnings: [] })
  }
  // ONE catalogued model, so the inspector's model-driven controls have something
  // to be driven by. An empty catalog silently turned every such control into its
  // fallback, which is how the duplicate duration field hid: the test fixture had
  // no model, so only one of the two controls ever rendered.
  if (path.endsWith('/models')) {
    return json({
      ok: true, loaded: true, error: null,
      models: [{
        id: 'google/veo-3.1-fast',
        supported_durations: [4, 6, 8],
        supported_resolutions: ['720p', '1080p'],
        supported_aspect_ratios: ['16:9', '9:16'],
        pricing_skus: { duration_seconds: '0.10' },
      }],
    })
  }
  return json({ ok: false, error: 'unexpected path ' + path })
}

const FAKE_GRAPH = {
  version: 1, id: 'graph_test', title: '交互测试', createdAt: 1, updatedAt: 2,
  project: { model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9', duration: 8, generateAudio: true, seed: null },
  budget: { usd: 30, onExceed: 'refuse' }, concurrency: 2,
  nodes: [
    { id: 'n_script', type: 'script', title: '分镜', x: 20, y: 20, w: 186, shotIndex: null, fields: { text: '1. 开场' } },
    { id: 'n_g1', type: 'generate', title: '开场', x: 260, y: 20, w: 190, shotIndex: 1, fields: { prompt: '晨光', model: 'google/veo-3.1-fast', duration: 8 } },
    { id: 'n_g2', type: 'generate', title: '特写', x: 260, y: 210, w: 190, shotIndex: 2, fields: { prompt: '微距', model: 'google/veo-3.1-fast', duration: 8 } },
    {
      id: 'n_cast1', type: 'cast', title: 'TOM', x: 20, y: 260, w: 190, shotIndex: null,
      fields: { name: 'TOM', description: '蓝灰色家猫，圆脸，黄眼睛', source: 'https://img.example.com/tom.png' },
    },
    { id: 'n_take1', type: 'take', title: '取帧 1→2', x: 20, y: 400, w: 190, shotIndex: null, fields: { frame: 'last_frame', slot: 'first_frame' } },
    { id: 'n_ref1', type: 'ref', title: '参考 1', x: 20, y: 520, w: 190, shotIndex: null, fields: { source: 'https://img.example.com/style.png', kind: 'image' } },
  ],
  edges: [
    { id: 'e1', from: 'n_g1', fromPort: 'job', to: 'n_g2', toPort: 'brief', label: '' },
    // A character DEFINED once and wired to both shots — the reusable case.
    { id: 'e2', from: 'n_cast1', fromPort: 'asset', to: 'n_g1', toPort: 'refs', label: '' },
    { id: 'e3', from: 'n_cast1', fromPort: 'asset', to: 'n_g2', toPort: 'refs', label: '' },
    // And a real frame chain, so the sequence view has a mechanism to report.
    { id: 'e4', from: 'n_g1', fromPort: 'job', to: 'n_take1', toPort: 'job', label: '' },
    { id: 'e5', from: 'n_take1', fromPort: 'image', to: 'n_g2', toPort: 'frames', label: '' },
  ],
  run: { state: 'idle', startedAt: null, lastRunAt: null },
}

/**
 * Every interval the workspace installs, with its period.
 *
 * The client's state refresh is a timer, so a test of "does it notice a run it did
 * not start" has to see the timer. The stub used to discard it, which made the bug
 * structurally invisible: `setInterval(() => 0)` cannot distinguish "polls every
 * 4s" from "never polls at all".
 */
const intervals = []
let intervalSeq = 0
const liveIntervals = new Set()

globalThis.window = {
  __ModuleLoader__: { load: (entry) => { loadedEntry = entry } },
  addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
  removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== fn)) },
  setTimeout: () => 0, clearTimeout() {},
  setInterval(fn, ms) { intervalSeq += 1; intervals.push({ id: intervalSeq, fn, ms }); liveIntervals.add(intervalSeq); return intervalSeq },
  clearInterval(id) { liveIntervals.delete(id) },
  CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, (ch) => '\\' + ch) },
  document: dom.document,
}
globalThis.document = dom.document
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}
globalThis.setInterval = globalThis.window.setInterval
globalThis.clearInterval = globalThis.window.clearInterval

let loadedEntry = null
console.log('interact: drive the real client half with real events\n')

const { readFile } = await import('node:fs/promises')
const clientSource = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
const factory = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', clientSource)
factory(globalThis.window, dom.document, globalThis.fetch, globalThis.setTimeout, globalThis.clearTimeout, globalThis.setInterval, globalThis.clearInterval)

const exports = loadedEntry.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

/** Render and drain effects until the graph has landed. */
async function boot() {
  let tree = null
  for (let round = 0; round < 12; round += 1) {
    tree = callComponent(exports.Workspace, {})
    commit(tree)
    await flushEffects(2)
    if (findAll(tree, (el) => el.props?.id === 'ov-node-n_g1').length > 0) return tree
  }
  throw new Error('the graph never bootstrapped — no node rendered after 12 rounds')
}

/** Switch back to the canvas view and settle. View state persists across tests. */
async function showCanvas() {
  let tree = callComponent(exports.Workspace, {})
  const tab = findAll(tree, (el) => el.type === 'button' && textOf(el) === '画布')[0]
  if (tab) { tab.props.onClick(); await flushEffects(1) }
  return settle(2)
}

/**
 * Render and drain effects for a fixed number of rounds.
 *
 * Needed because some state only becomes correct one commit AFTER the one that
 * produced the elements — anything measured from the DOM, in particular.
 */
async function settle(rounds = 4) {
  let tree = null
  for (let round = 0; round < rounds; round += 1) {
    tree = callComponent(exports.Workspace, {})
    commit(tree)
    await flushEffects(2)
  }
  return tree
}

const find = (tree, predicate) => findAll(tree, predicate)[0]
/** Find by a data-* attribute value, which is how the newer controls are addressed. */
const findByAttr = (tree, attr, value) => findAll(tree, (el) => el.props?.[attr] === value)[0]

/* ------------------------------------------------------------------ */

let tree = null

await check('the workspace bootstraps a graph with draggable nodes', async () => {
  tree = await boot()
  assert.ok(find(tree, (el) => el.props?.id === 'ov-node-n_g1'), 'n_g1 must render')
})

await check('the WIRE LAYER is actually drawn — ports measured after commit, not during render', async () => {
  // The reported defect: nodes appeared in the workbench with no connecting
  // lines. `edges` was a useMemo that measured the DOM DURING render, so on the
  // render that first produced the nodes the ports did not exist yet, an empty
  // list was cached, and no dependency changed afterwards to recompute it.
  // Nothing re-measured, so the wires were simply never drawn.
  tree = await settle(4)
  const svg = find(tree, (el) => el.props?.className === 'dsh-ov-edges')
  assert.ok(svg, 'the edge layer must render at all')

  const paths = (svg.children ?? []).filter((child) => child !== null && typeof child === 'object' && child.type === 'path')
  assert.equal(paths.length, FAKE_GRAPH.edges.length,
    `expected ${FAKE_GRAPH.edges.length} wire(s) for ${FAKE_GRAPH.edges.length} edge(s), drew ${paths.length}`)
  assert.match(String(paths[0].props.d), /^M[\d.-]+,[\d.-]+ C/u,
    'the wire must be a real measured curve, not a placeholder')
  assert.notEqual(String(paths[0].props.d), 'M0,0 C0,0 0,0 0,0', 'the wire must not collapse to the origin')
})

await check('a node carries a real onMouseDown (not just a style)', () => {
  const node = find(tree, (el) => el.props?.id === 'ov-node-n_g1')
  assert.equal(typeof node.props.onMouseDown, 'function', 'the node has no mousedown handler at all')
  assert.ok('data-drag' in node.props, 'the node must expose its drag state')
})

await check('DRAGGING a node moves it and WRITES the new position', async () => {
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  const node = find(tree, (el) => el.props?.id === 'ov-node-n_g1')
  const stop = { stopPropagation() {} }

  node.props.onMouseDown({ ...stop, button: 0, clientX: 300, clientY: 100 })
  // 3px of slop is ignored; this is well past it. zoom.k is 0.9.
  dispatchWindow('mousemove', { clientX: 345, clientY: 118 })
  dispatchWindow('mouseup', { clientX: 345, clientY: 118 })
  await new Promise((resolve) => realTimeout(resolve, 5))

  const writes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph'))
  assert.equal(writes.length, before + 1, 'a completed drag must produce exactly one graph write (not one per mousemove)')
  const saved = writes[writes.length - 1].body.graph.nodes.find((n) => n.id === 'n_g1')
  assert.equal(saved.x, 310, `expected x 260 + round(45/0.9)=50 → 310, got ${saved.x}`)
  assert.equal(saved.y, 40, `expected y 20 + round(18/0.9)=20 → 40, got ${saved.y}`)
})

await check('a drag below the slop threshold is treated as a click and writes NOTHING', async () => {
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  const node = find(tree, (el) => el.props?.id === 'ov-node-n_g2')
  node.props.onMouseDown({ stopPropagation() {}, button: 0, clientX: 400, clientY: 400 })
  dispatchWindow('mousemove', { clientX: 401, clientY: 401 })
  dispatchWindow('mouseup', { clientX: 401, clientY: 401 })
  await new Promise((resolve) => realTimeout(resolve, 5))
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length, before,
    'a 1px wobble must not rewrite the document')
})

await check('selecting another node shows THAT node\'s prompt — the inspector is not stale', async () => {
  // Reported: click 分镜, then 追逐 (right panel shows 追逐), then 智取 — the
  // heading changed to 智取 but the prompt text was still 追逐's. The fields were
  // uncontrolled and keyed by FIELD name, so React reused the same DOM element
  // for the new node and `defaultValue` — applied at mount only — kept the old
  // text. Asserting on `value` is what makes this observable: an uncontrolled
  // field carries `defaultValue`, so it fails here even though it "looked" bound.
  const clickNode = async (id) => {
    const node = find(tree, (el) => el.props?.id === 'ov-node-' + id)
    assert.ok(node, `node ${id} must be on the canvas`)
    node.props.onMouseDown({ stopPropagation() {}, button: 0, clientX: 420, clientY: 320 })
    dispatchWindow('mousemove', { clientX: 420, clientY: 320 })
    dispatchWindow('mouseup', { clientX: 420, clientY: 320 })
    return settle(3)
  }

  const onA = await clickNode('n_g1')
  const areasA = findAll(onA, (el) => el.type === 'textarea')
  assert.ok(areasA.some((el) => el.props.value === '晨光'),
    'selecting n_g1 must show n_g1\'s prompt in a CONTROLLED field')

  tree = await clickNode('n_g2')
  const areasB = findAll(tree, (el) => el.type === 'textarea')
  assert.ok(areasB.some((el) => el.props.value === '微距'),
    'the inspector must show the newly selected node\'s prompt')
  assert.ok(!areasB.some((el) => el.props.value === '晨光'),
    'the previous node\'s prompt must not linger after switching nodes')
})

await check('the node library rows are actually clickable', () => {
  const rows = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
  assert.ok(rows.length >= 8, `expected the full library, saw ${rows.length}`)
  for (const row of rows) {
    assert.equal(typeof row.props.onClick, 'function', `library row「${textOf(row)}」has no onClick — it is decorative`)
    assert.equal(row.props['data-add'], '1')
  }
})

await check('CLICKING a library row appends that node type and selects it', async () => {
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  const row = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
    .find((el) => textOf(el).includes('生成'))
  assert.ok(row, 'the 生成 row must exist in the library')
  row.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const writes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph'))
  assert.equal(writes.length, before + 1, 'adding a node must write the graph')
  const saved = writes[writes.length - 1].body
  assert.equal(saved.allowInvalid, true, 'a half-wired node must be allowed to exist — else the library is unusable')
  const added = saved.graph.nodes.filter((n) => n.type === 'generate')
  assert.equal(added.length, 3, 'the clicked type must be appended')
  const fresh = added[added.length - 1]
  assert.equal(fresh.fields.model, 'google/veo-3.1-fast', 'a new network node inherits the project model')
  assert.equal(fresh.fields.duration, 8, 'a new network node inherits the project duration')
  assert.notEqual(fresh.x, undefined, 'the new node needs a canvas position')
  // The node has to be ON THE CANVAS, not merely in a request body. The stub now
  // persists what it is sent, so a save that posts and then round-trips back out
  // of existence can no longer pass this: the canvas really did still show three
  // nodes while the POST body claimed four.
  tree = await settle(2)
  assert.equal(findAll(tree, (el) => el.props?.id === 'ov-node-' + fresh.id).length, 1,
    'the clicked node must actually appear on the canvas after the save')

  // The run toolbar floats over the canvas's top-left. A node dropped under it
  // is invisible, which is exactly what the first node of every graph used to be.
  assert.ok(fresh.y >= 60, `a new node must land BELOW the floating toolbar (y=${fresh.y})`)
})

await check('the canvas origin clears the floating toolbar', () => {
  const world = find(tree, (el) => el.props?.className === 'dsh-ov-world')
  assert.ok(world, 'the canvas world element must render')
  const transform = world.props.style?.transform ?? ''
  const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform)
  assert.ok(match, `the world must be positioned by a transform, saw "${transform}"`)
  const offsetY = Number(match[2])
  // Toolbar: absolute at top:10, roughly 34px tall → its bottom edge is ~44px.
  assert.ok(offsetY >= 50,
    `the world must start below the toolbar; offsetY=${offsetY} puts a node authored at (20,20) behind the buttons`)
})

/* ------------------------------------------------------------------ *
 * settings dialog
 *
 * These six assertions used to target two full-width strips under the top bar.
 * The key and the image bed are configured once and then never touched, so they
 * were permanent chrome paying rent for a dialog — and moving them into one also
 * gave the model shortlist and a live image-bed PROBE somewhere to live.
 *
 * Everything is reached through `data-act` / `data-field` markers rather than
 * through button text, so renaming a label cannot silently disable a test.
 * ------------------------------------------------------------------ */

const byAct = (root, act) => findAll(root, (el) => el.props?.['data-act'] === act)[0]
const byField = (root, field) => findAll(root, (el) => el.props?.['data-field'] === field)[0]

const openSettings = async () => {
  tree = callComponent(exports.Workspace, {})
  const opener = byAct(tree, 'open-settings')
  assert.ok(opener, 'the top bar must offer a 设置 button')
  opener.props.onClick()
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  const dialog = find(tree, (el) => el.props?.className === 'dsh-ov-settings')
  assert.ok(dialog, 'clicking 设置 must open the settings dialog')
  return dialog
}

await check('the 设置 button opens a dialog holding BOTH the key and the image bed', async () => {
  // The dialog is reached from the workspace, not from a plugin settings panel,
  // because the image bed IS the frame-chaining on-switch and the user composes
  // the film here.
  tree = callComponent(exports.Workspace, {})
  assert.ok(!find(tree, (el) => el.props?.className === 'dsh-ov-settings'),
    'the dialog must be closed until it is asked for')
  const dialog = await openSettings()
  assert.ok(byField(dialog, 'apiKey'), 'the dialog must hold the OpenRouter key field')
  assert.ok(byField(dialog, 'bedUrl'), 'the dialog must hold the image-bed address')
  assert.ok(byField(dialog, 'bedFolder'), 'the dialog must hold the upload folder')
  assert.ok(byField(dialog, 'bedUserAgent'), 'the dialog must hold the User-Agent')
  assert.ok(byField(dialog, 'bedToken'), 'the dialog must hold the bed token field')
  assert.ok(byAct(dialog, 'close'), 'the dialog must be closable')
})

await check('the API key field is wired to POST /config', async () => {
  const dialog = await openSettings()
  const input = byField(dialog, 'apiKey')
  assert.equal(typeof input.props.onChange, 'function')
  input.props.onChange({ target: { value: 'sk-or-v1-' + 'a'.repeat(48) } })

  // The state update needs a re-render before the button becomes enabled.
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})

  const saveButton = byAct(tree, 'save-key')
  assert.ok(saveButton, 'the 保存 button must render')
  assert.equal(saveButton.props.disabled, false, 'the button must enable once a key is typed')
  saveButton.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const post = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).pop()
  assert.ok(post, 'saving the key must POST to /config')
  assert.match(post.body.config.apiKey, /^sk-or-v1-a{48}$/)
})

await check('the key status is visible WITHOUT opening anything — and leaks no part of the key', async () => {
  // "is there a key" and "is there a bed" explain most failures, so they stay on
  // the top bar as chips even though the inputs moved into the dialog. Closed is
  // the state that matters: the chips must be true with the dialog shut.
  tree = callComponent(exports.Workspace, {})
  const closer = byAct(tree, 'close')
  if (closer) { closer.props.onClick(); await flushEffects(1); tree = callComponent(exports.Workspace, {}) }
  assert.ok(!find(tree, (el) => el.props?.className === 'dsh-ov-settings'), 'the dialog must be shut for this check')

  const top = find(tree, (el) => el.props?.className === 'dsh-ov-top')
  assert.ok(top, 'the top bar must render')
  const pills = findAll(top, (el) => el.props?.className === 'dsh-ov-pill')
  const text = pills.map(textOf).join(' | ')
  assert.match(text, /密钥/, `the key status must be on the top bar; saw "${text}"`)
  assert.match(text, /图床/, `the bed status must be on the top bar; saw "${text}"`)

  // The chip says WHETHER, never WHICH. The previous revision printed
  // `prefix…suffix`, which put four real characters of a live credential into
  // every screenshot, recording and bug report — and nobody acts on the
  // difference between sk-or-a…aaaa and sk-or-b…bbbb. The lamp is the signal.
  assert.ok(storedKey.length > 0, 'this check needs a stored key to be meaningful')
  assert.ok(!text.includes(storedKey.slice(0, 9)), 'the top bar must not print the key prefix')
  assert.ok(!text.includes(storedKey.slice(-4)), 'the top bar must not print the key suffix')

  const keyPill = pills.filter((pill) => textOf(pill).includes('密钥'))[0]
  assert.match(textOf(keyPill), /已配置/, 'a configured key must say so in words')
  const keyLamp = findAll(keyPill, (el) => el.props?.className === 'dsh-ov-dot')[0]
  assert.ok(keyLamp, 'a configured key must carry a lamp')
  assert.equal(keyLamp.props['data-ok'], '1', 'configured = green')
  assert.equal(keyLamp.props['data-err'], '0', 'and NOT the error colour')

  // The unconfigured state is the other half, and the bed is empty in this
  // fixture — so the red lamp is assertable here without inventing a state.
  const bedPill = pills.filter((pill) => textOf(pill).includes('图床'))[0]
  assert.match(textOf(bedPill), /未配置/)
  const bedLamp = findAll(bedPill, (el) => el.props?.className === 'dsh-ov-dot')[0]
  assert.equal(bedLamp.props['data-err'], '1', 'an unconfigured bed = red lamp')
  assert.equal(bedLamp.props['data-ok'], '0')
})


await check('saving a malformed key is refused locally, without a round trip', async () => {
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).length
  const dialog = await openSettings()
  byField(dialog, 'apiKey').props.onChange({ target: { value: 'nope' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  byAct(tree, 'save-key').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).length, before,
    'a key that cannot start with sk-or- must not be sent anywhere')
})

await check('a FAILED save reports the reason instead of claiming 已保存', async () => {
  // The Host answers failures with HTTP 200 + {ok:false}, so the fetch resolves.
  // A client that only checks "did the request throw" shows 已保存 while nothing
  // was stored — which is precisely the reported bug.
  configPostFails = true
  try {
    const barBefore = textOf(find(tree, (el) => el.props?.className === 'dsh-ov-top'))
    const dialog = await openSettings()
    byField(dialog, 'apiKey').props.onChange({ target: { value: 'sk-or-v1-' + 'b'.repeat(48) } })
    await flushEffects(1)
    tree = callComponent(exports.Workspace, {})
    byAct(tree, 'save-key').props.onClick()
    await new Promise((resolve) => realTimeout(resolve, 5))
    tree = callComponent(exports.Workspace, {})

    const toast = findAll(tree, (el) => el.props?.className === 'dsh-ov-toast')[0]
    assert.ok(toast, 'a failed save must surface something to the user')
    const shown = textOf(toast)
    assert.match(shown, /设置服务/, `expected the Host's reason, got: "${shown}"`)
    assert.ok(!/已保存/.test(shown), `a failed save must not claim success; it said "${shown}"`)

    const barAfter = textOf(find(tree, (el) => el.props?.className === 'dsh-ov-top'))
    assert.equal(barAfter, barBefore, 'a failed save must leave the key state untouched')
  } finally {
    configPostFails = false
  }
})

await check('once a key exists the UI offers 清除, and it DELETEs', async () => {
  // The previous assertion saved a key, so keyInfo now reports hasKey.
  const dialog = await openSettings()
  const clearButton = byAct(dialog, 'clear-key')
  assert.ok(clearButton, 'a configured key must be clearable from the UI')
  clearButton.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/config/key')), '清除 must DELETE /config/key')
})

await check('the image bed is settable from the workspace, because it IS the chaining switch', async () => {
  // Without a public URL for a sampled frame there is no first-frame hand-off:
  // the chained shot silently becomes an independent take. So this is the
  // mechanism's on-switch, not a decoration, and it has to be reachable where
  // the user actually composes the film.
  const dialog = await openSettings()
  byField(dialog, 'bedUrl').props.onChange({ target: { value: 'https://img.example.com/' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})

  const save = byAct(tree, 'save-bed')
  assert.ok(save, 'the bed must be savable')
  assert.equal(save.props.disabled, false, 'a non-empty base URL must enable the save button')
  save.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const post = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).pop()
  assert.equal(post.body.config.imageBedUrl, 'https://img.example.com',
    'the trailing slash must be stripped: a doubled segment breaks the upload URL')
  assert.equal(post.body.config.imageBedFolder, 'test')
  assert.equal(post.body.config.imageBedUserAgent, 'gobelagent')

  // Same rule as the key chip: it says WHETHER a bed exists, not WHERE it is.
  // The hostname told the reader nothing they act on and put a private endpoint
  // on screen whenever the workspace was screenshotted.
  tree = callComponent(exports.Workspace, {})
  const bedPill = findAll(find(tree, (el) => el.props?.className === 'dsh-ov-top'),
    (el) => el.props?.className === 'dsh-ov-pill').filter((pill) => textOf(pill).includes('图床'))[0]
  assert.match(textOf(bedPill), /已配置/, 'a saved bed must say so')
  assert.ok(!textOf(bedPill).includes('img.example.com'), 'the bed chip must not print the address')
})

await check('the bed can be PROBED, because a 403 HTML challenge is invisible until three shots in', async () => {
  // The failure this guards: a Cloudflare-fronted bed answers 403 with an HTML
  // interstitial to the wrong User-Agent, and the survey showed it three shots
  // into a film as a chained shot that quietly became an independent take. The
  // probe sends the UNSAVED draft, so the button tests what is on screen.
  const dialog = await openSettings()
  byField(dialog, 'bedUserAgent').props.onChange({ target: { value: 'some-other-agent' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})

  const probeButton = byAct(tree, 'test-bed')
  assert.ok(probeButton, 'the bed must be probeable')
  probeButton.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const post = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/bed/test')).pop()
  assert.ok(post, '测试连通 must POST /bed/test')
  assert.equal(post.body.userAgent, 'some-other-agent', 'the probe must test the draft, not the saved value')
  assert.match(post.body.url, /img\.example\.com/)
})

await check('the model shortlist can be built, defaulted and trimmed from the dialog', async () => {
  // `model` was a single value and the node picker offered the whole catalog.
  // A shortlist with one marked default is the missing half.
  let dialog = await openSettings()
  byField(dialog, 'modelInput').props.onChange({ target: { value: 'heygen/heygen-video-1' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  byAct(tree, 'add-model').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const add = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).pop()
  assert.deepEqual(add.body.config.models, ['heygen/heygen-video-1'], 'adding a model must save the list')
  assert.equal(add.body.config.model, 'heygen/heygen-video-1',
    'the first model added becomes the default, so the project is not left pointing at a model the user removed')

  dialog = await openSettings()
  assert.ok(findAll(dialog, (el) => el.props?.className === 'dsh-ov-mrow').length >= 1,
    'the added model must be listed')

  byAct(dialog, 'remove-model').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  const remove = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/config')).pop()
  assert.deepEqual(remove.body.config.models, [], 'removing must save the trimmed list')
})

await check('a 参考素材 node exposes the frame SLOT, so first_last is expressible', async () => {
  // The API takes a `frame_type` PER IMAGE, so `first_last` needs two sources
  // that disagree about their slot. While `frames` was single-input the second
  // wire evicted the first, and while the slot was read off the consumer there
  // was nowhere to say it at all. This is the control that closes that gap.
  const row = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
    .find((el) => textOf(el).includes('参考素材'))
  assert.ok(row, 'the 参考素材 row must exist in the library: '
    + JSON.stringify(findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype').map((el) => textOf(el))))
  row.props.onClick()
  tree = await settle(3)

  const selects = findAll(tree, (el) => el.type === 'select')
  const slot = selects.find((s) => findAll(s, (el) => el.type === 'option')
    .some((o) => o.props.value === 'reference'))
  assert.ok(slot, 'the ref node must offer a slot selector — without it the LAST-frame slot is unreachable; '
    + 'saw ' + JSON.stringify(selects.map((s) => findAll(s, (el) => el.type === 'option').map((o) => o.props.value))))
  assert.deepEqual(findAll(slot, (el) => el.type === 'option').map((o) => o.props.value),
    ['first_frame', 'last_frame', 'reference'],
    'the options must come from the node schema, not a hardcoded first/last pair')
})

await check('clicking 角色 in the library adds a node with all THREE character fields', () => {
  // It used to be born as `{}` — no name, no image, no description — so the very
  // first save wrote an empty node. A character node without its image field is
  // the exact shape of the reported bug.
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  const row = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
    .find((el) => textOf(el).includes('角色'))
  assert.ok(row, 'the 角色 row must exist in the library')
  row.props.onClick()
  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph'))[before]
  assert.ok(write, 'adding a character must write the graph')
  const added = write.body.graph.nodes.filter((node) => node.type === 'cast').pop()
  assert.ok(added, 'the node must be saved AS a cast node')
  for (const key of ['name', 'description', 'source']) {
    assert.ok(key in added.fields, `a new character must carry ${key}`)
  }
  // Undo, so the roster tests below start from a known graph.
  persistedGraph = { ...persistedGraph, nodes: persistedGraph.nodes.filter((node) => node.id !== added.id) }
})

/* ------------------------------------------------------------------ *
 * 角色库 roster
 * ------------------------------------------------------------------ */

const openCast = async () => {
  tree = callComponent(exports.Workspace, {})
  const opener = byAct(tree, 'open-cast')
  assert.ok(opener, 'the top bar must offer a 设定 button')
  opener.props.onClick()
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  const dialog = find(tree, (el) => el.props?.className === 'dsh-ov-settings' && textOf(el).includes('设定库'))
  assert.ok(dialog, 'clicking 设定 must open the roster')
  return dialog
}

await check('the roster shows a character with name, IMAGE and description — all three', async () => {
  // The reported symptom: a character had exactly one text box and no image.
  // A character without an image is a description; a character without a
  // description is a picture. Both are needed, so both are on the row.
  const dialog = await openCast()
  const card = findAll(dialog, (el) => el.props?.className === 'dsh-ov-castcard')
  assert.equal(card.length, 1, `expected the one defined character, saw ${card.length}`)

  const name = byField(card[0], 'cast-name')
  const source = byField(card[0], 'cast-source')
  const description = byField(card[0], 'cast-description')
  assert.ok(name, 'a character needs a name field')
  assert.ok(source, 'a character needs an IMAGE field — this is the reported gap')
  assert.ok(description, 'a character needs a description field')
  assert.equal(name.props.value, 'TOM')
  assert.equal(source.props.value, 'https://img.example.com/tom.png')
  assert.match(description.props.value, /蓝灰色家猫/u)
})

await check('editing a character writes the graph, and the value round-trips', async () => {
  const dialog = await openCast()
  const card = findAll(dialog, (el) => el.props?.className === 'dsh-ov-castcard')[0]
  byField(card, 'cast-source').props.onChange({ target: { value: 'https://img.example.com/tom-sheet-v2.png' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  byField(findAll(tree, (el) => el.props?.className === 'dsh-ov-castcard')[0], 'cast-source').props.onBlur()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  const node = write.body.graph.nodes.find((n) => n.id === 'n_cast1')
  assert.equal(node.fields.source, 'https://img.example.com/tom-sheet-v2.png')

  // Put it back so later assertions see the original.
  const dialog2 = await openCast()
  const card2 = findAll(dialog2, (el) => el.props?.className === 'dsh-ov-castcard')[0]
  byField(card2, 'cast-source').props.onChange({ target: { value: 'https://img.example.com/tom.png' } })
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})
  byField(findAll(tree, (el) => el.props?.className === 'dsh-ov-castcard')[0], 'cast-source').props.onBlur()
  await new Promise((resolve) => realTimeout(resolve, 5))
})

await check('「添加角色」 appends ANOTHER character — 角色1, 角色2, …', async () => {
  const dialog = await openCast()
  byAct(dialog, 'add-cast').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  const castNodes = write.body.graph.nodes.filter((n) => n.type === 'cast')
  assert.equal(castNodes.length, 2, 'adding a character must append a NEW cast node, not overwrite the first')
  assert.equal(castNodes[1].fields.name, '角色 2')
  assert.equal(castNodes[0].fields.name, 'TOM', 'the existing character must be untouched')
})

await check('one character can be wired to MANY shots — that is what makes it reusable', async () => {
  const dialog = await openCast()
  // Remove the wires first by deleting and re-adding? No: assert the button is
  // there and that clicking it on an ALREADY fully wired character is refused
  // rather than duplicating edges.
  const before = findAll(dialog, (el) => el.props?.className === 'dsh-ov-castcard')[0]
  assert.match(textOf(before), /出场 2 镜/u, 'the roster must say how many shots a character is in')
  assert.ok(findAll(before, (el) => el.props['data-act'] === 'unwire-shot').length === 2,
    'and offer a per-shot un-wire, so a call sheet can be edited')

  const writes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  byAct(dialog, 'wire-all').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length, writes,
    'wiring an already-wired character must not write a graph full of duplicate edges')
})

await check('un-wiring a character from ONE shot leaves the others alone', async () => {
  const dialog = await openCast()
  const card = findAll(dialog, (el) => el.props?.className === 'dsh-ov-castcard')[0]
  findAll(card, (el) => el.props['data-act'] === 'unwire-shot')[0].props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  const refs = write.body.graph.edges.filter((e) => e.from === 'n_cast1' && e.toPort === 'refs')
  assert.equal(refs.length, 1, 'exactly one wire must remain — a call sheet, not all-or-nothing')
})

/* ------------------------------------------------------------------ *
 * wiring on the canvas
 * ------------------------------------------------------------------ */

await check('the canvas ACCUMULATES on a multi-input port instead of evicting', async () => {
  // `refs` used to be single-input on both halves, so wiring a second reference
  // silently deleted the first — and a shot can need the cat AND the mouse. The
  // assertion is TWO wires surviving, which is the only shape that can tell
  // "accumulate" from "replace".
  tree = await showCanvas()
  const clickPort = async (outId, inId) => {
    const out = find(tree, (el) => el.props?.id === outId)
    assert.ok(out, `${outId} must render`)
    out.props.onClick({ stopPropagation() {} })
    // The gesture is two steps and `armed` lives in state, so the drop needs a
    // render in between — otherwise it reads a stale closure where nothing is armed.
    tree = await settle(1)
    const into = find(tree, (el) => el.props?.id === inId)
    assert.ok(into, `${inId} must render`)
    into.props.onClick({ stopPropagation() {} })
    await new Promise((resolve) => realTimeout(resolve, 5))
    // Re-render so the NEXT gesture starts from a closure where nothing is armed.
    tree = await settle(1)
  }

  await clickPort('ov-port-out-n_cast1-asset', 'ov-port-in-n_g1-refs')
  await clickPort('ov-port-out-n_ref1-asset', 'ov-port-in-n_g1-refs')

  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  const refs = write.body.graph.edges.filter((e) => e.to === 'n_g1' && e.toPort === 'refs')
  assert.equal(refs.length, 2,
    `the character and the style reference must BOTH survive; saw ${refs.map((e) => e.from).join(', ')}`)
})

/* ------------------------------------------------------------------ *
 * sequence view: the REAL mechanism
 * ------------------------------------------------------------------ */

await check('the sequence view names the ACTUAL continuity, not the dead `link` flag', async () => {
  // `link` only ever meant `previous_job_id`, which is unusable in this
  // workspace — so a fully frame-chained film displayed 独立起幅 on every row.
  tree = callComponent(exports.Workspace, {})
  const seqTab = findAll(tree, (el) => el.type === 'button' && textOf(el) === '顺序')[0]
  assert.ok(seqTab, 'the 顺序 tab must exist')
  seqTab.props.onClick()
  await flushEffects(1)
  tree = callComponent(exports.Workspace, {})

  const chained = findByAttr(tree, 'data-continuity', 'frames')
  const hard = findByAttr(tree, 'data-continuity', 'cut')
  assert.ok(chained, 'shot 2 is fed by a take and must say so')
  assert.match(textOf(chained), /取帧接龙/u)
  assert.ok(hard, 'shot 1 has nothing feeding it and must say so')
  assert.match(textOf(hard), /硬切/u)
})

await check('the sequence view has a 角色 column, so a shot\'s cast is visible without clicking', () => {
  tree = callComponent(exports.Workspace, {})
  const cell = findByAttr(tree, 'data-cast', 'TOM')
  assert.ok(cell, 'the character wired into a shot must be listed on that shot\'s row')
  assert.match(textOf(cell), /TOM/u)
})

await check('the inspector turns a chained shot into a HARD CUT in one click', async () => {
  // Every transition chained is a film with no transitions. The control is the
  // topology itself — a boolean field would lie the moment a wire is deleted by
  // hand, which is a normal thing to do on a canvas.
  tree = await showCanvas()
  const node = find(tree, (el) => el.props?.id === 'ov-node-n_g2')
  assert.ok(node, 'n_g2 must be on the canvas')
  node.props.onMouseDown({ stopPropagation() {}, button: 0, clientX: 420, clientY: 320 })
  dispatchWindow('mousemove', { clientX: 420, clientY: 320 })
  dispatchWindow('mouseup', { clientX: 420, clientY: 320 })
  tree = await settle(2)

  const button = byAct(tree, 'unlink-frames')
  assert.ok(button, 'a chained shot must offer 改成硬切')
  button.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  assert.equal(write.body.graph.edges.filter((e) => e.to === 'n_g2' && e.toPort === 'frames').length, 0,
    'the first frame must be gone')
  assert.equal(write.body.graph.nodes.filter((n) => n.type === 'take').length, 0,
    'the take node must go with it, not be left dangling')
})

await check('a client newer than the Host REFUSES to offer a type the Host cannot honour', async () => {
  // The reported symptom was a 角色 node that came back as an empty 注释 with a
  // single text field and no image. The cause was a Host that predates `cast`.
  // Offering the type anyway is what produced it, so the offer is what is fixed.
  const full = storedConfig.nodeTypes
  try {
    storedConfig.nodeTypes = full.filter((type) => type !== 'cast')
    // The config is fetched once at mount, so a changed answer needs a mounted
    // component — clearing the hook slots is exactly a fresh mount.
    componentState.clear()
    tree = await boot()
    const rows = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
    assert.ok(!rows.some((row) => textOf(row).includes('角色')),
      'a node type the Host does not know must not be offered')
    const skew = byAct(tree, 'skew-warning')
    assert.ok(skew, 'and the skew must be announced, not silently swallowed')
    assert.match(textOf(skew), /cast/u, 'the warning must NAME the type')
  } finally {
    storedConfig.nodeTypes = full
    componentState.clear()
    tree = await boot()
  }
})

await check('with a matching Host there is no skew warning at all', () => {
  assert.ok(!byAct(tree, 'skew-warning'), 'a matched client/host pair must not cry wolf')
  const rows = findAll(tree, (el) => el.props?.className === 'dsh-ov-ntype')
  assert.ok(rows.some((row) => textOf(row).includes('角色')), 'and 角色 must be offered')
})

/* ------------------------------------------------------------------ *
 * 改名 / 删除 — and the cast description that described a draft that
 * no longer exists.
 * ------------------------------------------------------------------ */

/** Select a node the way a user does: mousedown + mouseup in place. */
async function selectNode(id) {
  const node = find(tree, (el) => el.props?.id === 'ov-node-' + id)
  assert.ok(node, `node ${id} must be on the canvas`)
  node.props.onMouseDown({ stopPropagation() {}, button: 0, clientX: 420, clientY: 320 })
  dispatchWindow('mousemove', { clientX: 420, clientY: 320 })
  dispatchWindow('mouseup', { clientX: 420, clientY: 320 })
  return settle(3)
}

/**
 * Put the stored document back to the pristine fixture.
 *
 * Twenty tests ran before these and several of them WROTE: the roster un-wired a
 * character, a library click appended a node, a port click added a wire. A test
 * that asserts "n_g1 has 3 wires" while reading whatever those left behind is
 * asserting about the test order, not about the product — and it fails the
 * moment a test above it changes.
 */
async function resetGraph() {
  persistedGraph = JSON.parse(JSON.stringify(FAKE_GRAPH))
  storedGraphs = twoProjects()
  componentState.clear()
  tree = await boot()
  return tree
}

await check('the 角色 inspector does NOT claim the node is global and needs no wires', async () => {
  // Reported verbatim: "这是全局节点：不用连线。图中每个「角色」节点的描述都会被原样
  // 插进每一条镜头提示词". That was the FIRST draft. Once a character is a node you
  // wire into the shots it appears in, the sentence is not a simplification — it
  // tells the reader their definitions are live while they are inert.
  tree = await showCanvas()
  tree = await selectNode('n_cast1')
  const note = find(tree, (el) => el.props?.className === 'dsh-ov-note'
    && /可复用的角色定义/u.test(textOf(el)))
  assert.ok(note, 'the cast inspector must explain what the node IS')
  const text = textOf(note)
  assert.ok(!/全局/u.test(text), 'the cast node is NOT global — saying so is the reported bug')
  assert.match(text, /连线/u, 'it must say the wiring is what makes the character appear')
  assert.match(text, /出场/u, 'and that scope is the shots it is wired to')
  // The full five-line explanation still exists, one hover away. It was cut from
  // the panel because it answered four questions the reader had not asked yet,
  // directly above the fields they actually came for — not because it was wrong.
  assert.match(String(note.props.title ?? ''), /input_references/u,
    'the detail must still be reachable, as the note hover title')
})

await check('the cast inspector reports the wiring it can SEE, not a promise about the whole graph', async () => {
  tree = await resetGraph()
  tree = await selectNode('n_cast1')
  const kv = findAll(tree, (el) => el.props?.className === 'dsh-ov-kv' && /当前出场/u.test(textOf(el)))[0]
  assert.ok(kv, 'the wired-shot count must be visible on the node itself')
  assert.match(textOf(kv), /2 镜/u, 'TOM is wired into both shots in this graph')
  assert.match(textOf(kv), /#1/u)
  assert.match(textOf(kv), /#2/u)
})

await check('a character wired to NOTHING says it is doing nothing, instead of looking configured', async () => {
  tree = await resetGraph()
  const trimmed = JSON.parse(JSON.stringify(persistedGraph))
  trimmed.edges = trimmed.edges.filter((e) => e.from !== 'n_cast1')
  persistedGraph = trimmed
  componentState.clear()
  tree = await boot()
  tree = await selectNode('n_cast1')
  const warn = findAll(tree, (el) => el.props?.['data-kind'] === 'warn' && /这个角色现在不起作用/u.test(textOf(el)))[0]
  assert.ok(warn, 'an unwired character is the silent-nothing case and must be called out')
  assert.match(textOf(warn), /接到全部镜头|拉线/u, 'and it must say how to fix it')
})

await check('the first-frame warning fires only when a character is wired to THAT shot', async () => {
  // It used to fire on "any cast node exists anywhere in the graph", so a
  // landscape shot in a film that happens to have a cat was told its character
  // reference was being overridden by its own first frame.
  tree = await resetGraph()
  tree = await selectNode('n_g2')
  assert.ok(byAct(tree, 'frames-over-refs'), 'n_g2 has BOTH a first frame and a wired character — it must warn')
  /* One warning per case. A character-wired shot must not ALSO get the generic
     "frames 与 refs 都接了" bar: two boxes saying the same rule is noise, and the
     character one is the one that says what to do about it. */
  assert.ok(!findAll(tree, (el) => el.props?.['data-kind'] === 'warn'
    && /frames 与 refs 都接了/u.test(textOf(el))).length,
    'the generic refs warning must not stack on top of the character-specific one')

  const trimmed = JSON.parse(JSON.stringify(persistedGraph))
  trimmed.edges = trimmed.edges.filter((e) => !(e.from === 'n_cast1' && e.to === 'n_g2'))
  persistedGraph = trimmed
  componentState.clear()
  tree = await boot()
  tree = await selectNode('n_g2')
  assert.equal(byAct(tree, 'frames-over-refs'), undefined,
    'with no character wired in, a first frame overrides nothing — the warning must be gone')
})

await check('the 重命名 button gives the node an editable title, and Enter WRITES it', async () => {
  tree = await resetGraph()
  tree = await showCanvas()
  tree = await selectNode('n_script')
  const button = byAct(tree, 'rename-node')
  assert.ok(button, 'a node you cannot rename keeps whatever name its creator gave it')
  button.props.onClick()
  tree = await settle(2)

  const input = byAct(tree, 'rename-input')
  assert.ok(input, 'renaming must produce a real editable field')
  assert.equal(input.props.value, '分镜', 'it must start from the CURRENT title')

  input.props.onChange({ target: { value: '第一幕 · 开场' } })
  tree = await settle(2)
  assert.equal(byAct(tree, 'rename-input').props.value, '第一幕 · 开场', 'typing must show up in the field')

  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  const field = byAct(tree, 'rename-input')
  field.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  /* A real browser ALSO fires blur as the field unmounts. Both must not write:
     without the write-once guard the same rename is sent twice. */
  field.props.onBlur()
  await new Promise((resolve) => realTimeout(resolve, 5))

  const writes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph'))
  assert.equal(writes.length, before + 1,
    'Enter commits ONCE — the input unmounts and fires blur too, so a missing write-once guard sends the rename twice')
  const saved = writes[writes.length - 1].body.graph.nodes.find((n) => n.id === 'n_script')
  assert.equal(saved.title, '第一幕 · 开场', 'the title must reach the document, not just the canvas')
})

await check('renaming is also available by double-clicking the title ON the canvas', async () => {
  tree = await resetGraph()
  tree = await showCanvas()
  const span = findByAttr(tree, 'data-node', 'n_g2')
  assert.ok(span && span.props['data-act'] === 'node-title',
    'the node title must be addressable as the rename target')
  assert.equal(typeof span.props.onDoubleClick, 'function', 'a title with no double-click handler is not renameable')
  assert.equal(textOf(span), '特写')

  span.props.onDoubleClick({ stopPropagation() {} })
  tree = await settle(2)
  const input = byAct(tree, 'rename-input')
  assert.ok(input, 'double-clicking the title must open the same inline field')
  assert.equal(input.props.value, '特写', 'it must start from the node\'s current title')
  assert.equal(input.props['data-node'], 'n_g2', 'the field must belong to the node that was double-clicked')

  // Escape abandons the edit.
  input.props.onChange({ target: { value: '不要这个' } })
  tree = await settle(1)
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  byAct(tree, 'rename-input').props.onKeyDown({ key: 'Escape', preventDefault() {} })
  tree = await settle(2)
  await new Promise((resolve) => realTimeout(resolve, 5))
  assert.equal(byAct(tree, 'rename-input'), undefined, 'Escape must close the field')
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length, before,
    'Escape must write nothing — a cancelled rename is not a rename')
})

await check('the Delete key does NOT delete the node while you are typing in a prompt', async () => {
  tree = await resetGraph()
  tree = await showCanvas()
  tree = await selectNode('n_g1')
  dispatchWindow('keydown', { key: 'Backspace', target: { tagName: 'TEXTAREA' }, preventDefault() {} })
  tree = await settle(2)
  assert.equal(byAct(tree, 'delete-confirm'), undefined,
    'backspacing a character out of a prompt must not delete the node being edited')
  dispatchWindow('keydown', { key: 'Delete', target: { tagName: 'INPUT' }, preventDefault() {} })
  tree = await settle(2)
  assert.equal(byAct(tree, 'delete-confirm'), undefined)
})

await check('Delete asks FIRST, and states the cost, before anything is removed', async () => {
  tree = await showCanvas()
  tree = await selectNode('n_g1')
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  dispatchWindow('keydown', { key: 'Delete', target: { tagName: 'BODY' }, preventDefault() {} })
  tree = await settle(2)

  const bar = byAct(tree, 'delete-confirm')
  assert.ok(bar, 'Delete must produce a confirmation, not an immediate removal')
  const text = textOf(bar)
  assert.match(text, /3 条连线/u, `n_g1 has 3 wires on it, got: ${text}`)
  assert.match(text, /上游 1 个/u, 'n_cast1 feeds it and must be named as affected')
  assert.match(text, /下游 2 个/u, 'n_g2 and n_take1 lose an input and must be named')
  assert.ok(byAct(tree, 'delete-confirm-yes'), 'the confirm button must exist')
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length, before,
    'nothing may be written while the confirmation is up — the bar is a question, not an action')
})

await check('cancelling the confirmation removes nothing', async () => {
  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  byAct(tree, 'delete-confirm-no').props.onClick()
  tree = await settle(2)
  assert.equal(byAct(tree, 'delete-confirm'), undefined, '取消 must close the bar')
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length, before,
    '取消 must write nothing')
})

await check('confirming removes the node AND its wires — and leaves downstream alone', async () => {
  // The cancel test above closed the bar, so reopen it the way the user would.
  dispatchWindow('keydown', { key: 'Delete', target: { tagName: 'BODY' }, preventDefault() {} })
  tree = await settle(2)
  byAct(tree, 'delete-confirm-yes').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  const write = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).pop()
  const graph = write.body.graph
  assert.ok(!graph.nodes.some((n) => n.id === 'n_g1'), 'the node must be gone')
  assert.equal(graph.edges.filter((e) => e.from === 'n_g1' || e.to === 'n_g1').length, 0,
    'the wires must go WITH the node — a dangling edge survives the round trip and the canvas keeps drawing it')
  assert.ok(graph.nodes.some((n) => n.id === 'n_g2'), 'downstream must NOT be cascaded: one click must not take out a paid chain')
  assert.ok(graph.nodes.some((n) => n.id === 'n_take1'), 'the now-orphaned take node stays; preflight is what reports it')
  assert.ok(graph.nodes.some((n) => n.id === 'n_cast1'), 'the character definition is reusable and must survive')
})

await check('deleting an UNUSED node — the reported case — costs nothing and just works', async () => {
  // n_ref1 is wired to nothing: exactly the node that could previously only be
  // removed by editing graphs.json by hand.
  tree = await showCanvas()
  tree = await selectNode('n_ref1')
  byAct(tree, 'delete-node').props.onClick()
  tree = await settle(2)
  const bar = byAct(tree, 'delete-confirm')
  assert.ok(bar, 'the button must also confirm')
  assert.match(textOf(bar), /0 条连线/u, `an unwired node has no wires to report, got: ${textOf(bar)}`)
  assert.ok(!/失去/u.test(textOf(bar)), 'and nothing is affected — the bar must not imply damage')

  const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph')).length
  byAct(tree, 'delete-confirm-yes').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  const writes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/graph'))
  assert.equal(writes.length, before + 1, 'exactly one write')
  assert.ok(!writes[writes.length - 1].body.graph.nodes.some((n) => n.id === 'n_ref1'), 'the unused node must be gone')
})

/* ------------------------------------------------------------------ *
 * 项目：列出 / 切换 / 新建 / 删除 —— 「清空工作台」缺的那一环
 * ------------------------------------------------------------------ */

const projectRows = (root) => findAll(root, (el) => el.props?.className === 'dsh-ov-graphrow')

await check('the workspace exposes the PROJECT list — it was fetched on mount and then thrown away', async () => {
  tree = await resetGraph()
  const pick = byAct(tree, 'open-projects')
  assert.ok(pick, 'the title must open the project list; without it nothing can be seen, switched or cleared')
  pick.props.onClick()
  tree = await settle(2)

  const rows = projectRows(tree)
  assert.equal(rows.length, 2, `every stored project must be listed, saw ${rows.length}`)
  assert.ok(rows.some((row) => row.props['data-graph'] === 'graph_test'), 'including the one that is open')
  assert.ok(rows.some((row) => row.props['data-graph'] === 'graph_old'), 'and the ones that are not')
})

await check('deleting a project ASKS first, and states what is lost', async () => {
  const before = calls.filter((c) => c.path.endsWith('/graph/delete')).length
  const button = findAll(tree, (el) => el.props?.['data-act'] === 'graph-delete'
    && el.props?.['data-graph'] === 'graph_old')[0]
  assert.ok(button, 'a non-current project needs a delete control')
  button.props.onClick()
  tree = await settle(2)

  const warn = byAct(tree, 'graph-delete-warn')
  assert.ok(warn, 'deletion must be confirmed — one click removes a graph document for good')
  assert.match(textOf(warn), /不可撤销/u, 'and it must say so')
  assert.match(textOf(warn), /3 个节点/u, 'it must state what is being thrown away')
  assert.equal(calls.filter((c) => c.path.endsWith('/graph/delete')).length, before,
    'the confirm is a question, not an action')
})

await check('cancelling removes nothing', async () => {
  byAct(tree, 'graph-delete-no').props.onClick()
  tree = await settle(2)
  assert.ok(!byAct(tree, 'graph-delete-warn'), '取消 must close the confirm')
  assert.equal(calls.filter((c) => c.path.endsWith('/graph/delete')).length, 0, '取消 must send nothing')
})

await check('confirming DELETEs through the Host, and the row actually disappears', async () => {
  const button = findAll(tree, (el) => el.props?.['data-act'] === 'graph-delete'
    && el.props?.['data-graph'] === 'graph_old')[0]
  button.props.onClick()
  tree = await settle(2)
  byAct(tree, 'graph-delete-yes').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  tree = await settle(3)

  const del = calls.filter((c) => c.path.endsWith('/graph/delete')).pop()
  assert.equal(del.body.id, 'graph_old', 'the delete must go through the Host — the store caches in memory')
  assert.equal(projectRows(tree).length, 1, 'the list must come back from the Host already updated')
  assert.ok(!projectRows(tree).some((row) => row.props['data-graph'] === 'graph_old'),
    'the deleted project must leave the list')
})

await check('deleting the OPEN project moves to a live one, never to a graph the Host no longer has', async () => {
  tree = await resetGraph()
  tree = await showCanvas()
  byAct(tree, 'open-projects').props.onClick()
  tree = await settle(2)

  const button = findAll(tree, (el) => el.props?.['data-act'] === 'graph-delete'
    && el.props?.['data-graph'] === 'graph_test')[0]
  assert.ok(button, 'the OPEN project must be deletable too — that is how a workspace gets cleared')
  button.props.onClick()
  tree = await settle(2)
  byAct(tree, 'graph-delete-yes').props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  tree = await settle(3)

  const remaining = projectRows(tree)
  assert.equal(remaining.length, 1, 'one project should be left')
  assert.equal(remaining[0].props['data-graph'], 'graph_old')
  assert.match(textOf(remaining[0]), /当前打开/u,
    'the open project must have moved — leaving it pointed at a deleted graph makes every later save fail')
})

await check('新建项目 creates an empty one through the Host', async () => {
  const before = calls.filter((c) => c.path.endsWith('/graph/new')).length
  const button = byAct(tree, 'new-graph')
  assert.ok(button, 'the project list needs a way to start a new one')
  button.props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  tree = await settle(3)
  assert.equal(calls.filter((c) => c.path.endsWith('/graph/new')).length, before + 1)
  // Starting a project CLOSES the list and puts you on the new canvas, so the
  // list has to be reopened to see it — that is the intended flow, not a defect.
  assert.ok(!byAct(tree, 'new-graph'), 'the list must close and put you on the new project')
  tree = await showCanvas()
  byAct(tree, 'open-projects').props.onClick()
  tree = await settle(2)
  assert.equal(projectRows(tree).length, 2, 'the new project must appear in the list')
  const current = projectRows(tree).filter((row) => row.props['data-current'] === '1')
  assert.equal(current.length, 1, 'exactly one project is open')
  assert.match(textOf(current[0]), /未命名项目/u, 'and it must be the one just created')
})

await check('a finished node shows its clip, and a 角色/场景/素材 node shows its picture', async () => {
  tree = await resetGraph()
  tree = await showCanvas()

  // The stand-in tree has no back-pointers, so locate the thumb by walking the
  // node element that contains it — the one thing a DOM query would have given us.
  const thumbOf = (id) => {
    const node = findAll(tree, (el) => el.props?.id === 'ov-node-' + id)[0]
    assert.ok(node, 'node ' + id + ' must render')
    return findAll(node, (el) => el.props?.className === 'dsh-ov-thumb')[0]
  }

  // A completed shot: a real <video>, letterboxed rather than cropped.
  const g1 = thumbOf('n_g1')
  assert.ok(g1, 'a completed shot must have a preview box')
  assert.equal(g1.props['data-media'], '1', 'a completed clip is MEDIA, not an empty slot')
  const g1Video = findAll(g1, (el) => el.type === 'video')[0]
  assert.ok(g1Video, 'the finished clip must actually render a <video>')
  assert.match(g1Video.props.src, /\/content\?id=vid_s01/, 'and it must point at THAT job')

  // An un-run shot stays an empty slot — the box must not pretend otherwise.
  const g2 = thumbOf('n_g2')
  assert.equal(g2.props['data-media'], '0', 'a shot with no clip is not media')
  assert.equal(findAll(g2, (el) => el.type === 'video').length, 0)

  // The character node: a public image URL used to render as nothing at all, so
  // you could not tell which cat a node was without opening the URL.
  const cast = thumbOf('n_cast1')
  assert.equal(cast.props['data-asset'], '1', 'a 角色 node with an image URL must show it')
  const castImg = findAll(cast, (el) => el.type === 'img')[0]
  assert.ok(castImg, 'the character sheet must render as an <img>')
  assert.equal(castImg.props.src, 'https://img.example.com/tom.png')
  assert.equal(castImg.props.loading, 'lazy', 'the canvas must not fetch every sheet eagerly')

  const ref = thumbOf('n_ref1')
  assert.equal(ref.props['data-asset'], '1', 'a 参考素材 node is an image too')
  assert.equal(findAll(ref, (el) => el.type === 'img')[0].props.src, 'https://img.example.com/style.png')

  // A path the provider could never fetch must NOT be previewed: it would render
  // a broken-image glyph and promise a request that can never be sent.
  const broken = JSON.parse(JSON.stringify(FAKE_GRAPH))
  broken.nodes.find((n) => n.id === 'n_cast1').fields.source = 'C:\\local\\cat.png'
  broken.nodes.find((n) => n.id === 'n_ref1').fields.kind = 'video'
  persistedGraph = broken
  componentState.clear()
  tree = await boot()
  assert.equal(findAll(tree, (el) => el.props?.id === 'ov-node-n_cast1').length, 1)
  assert.equal(findAll(findAll(tree, (el) => el.props?.id === 'ov-node-n_cast1')[0], (el) => el.type === 'img').length,
    0, 'a local path is not a public URL and must not be previewed as one')
  assert.equal(findAll(findAll(tree, (el) => el.props?.id === 'ov-node-n_ref1')[0], (el) => el.type === 'img').length,
    0, 'a ref node declared as a video is not an image')
})

await check('clicking a finished clip opens it in a player — and an unfinished one just selects it', async () => {
  tree = await resetGraph()
  tree = await showCanvas()

  const strip = (id) => find(tree, (el) => el.props?.className === 'dsh-ov-strip'
    && el.props['data-node'] === id)
  assert.equal(findAll(tree, (el) => el.props?.className === 'dsh-ov-strip').length, 2,
    'both shots must have a bottom-strip slot')
  assert.equal(strip('n_g1').props['data-ready'], '1', 'the clip that exists is playable')
  assert.equal(strip('n_g2').props['data-ready'], '0', 'the one that does not is not')

  // before: nothing is open
  assert.ok(!byAct(tree, 'clip-modal'), 'no player may be open on a fresh canvas')

  strip('n_g1').props.onClick()
  tree = await settle(2)
  const modal = byAct(tree, 'clip-modal')
  assert.ok(modal, 'clicking a finished clip must open the player')
  const player = find(modal, (el) => el.type === 'video')
  assert.ok(player, 'the player must hold a real <video>')
  assert.match(player.props.src, /\/content\?id=vid_s01/, 'playing THAT clip, not the film')
  assert.equal(player.props.controls, true, 'with controls — it is a player, not a poster')
  const modalText = textOf(modal)
  assert.match(modalText, /#1/, 'the modal must say which shot this is')
  const meta = textOf(find(modal, (el) => el.props?.className === 'dsh-ov-pmeta'))
  assert.match(meta, /8s/, 'and its requested length')
  assert.match(meta, /\$0\.80/, 'and what it actually cost')
  assert.match(meta, /取帧接龙|硬切|续接/, 'and how it joins its neighbour')

  // A slot with no clip must NOT open an empty player — it still means "select me".
  byAct(tree, 'clip-close').props.onClick()
  tree = await settle(2)
  assert.ok(!byAct(tree, 'clip-modal'), 'closing must actually close')
  strip('n_g2').props.onClick()
  tree = await settle(2)
  assert.ok(!byAct(tree, 'clip-modal'), 'an unfinished shot must not open a player that plays nothing')
  const inspector = textOf(find(tree, (el) => el.props?.className === 'dsh-ov-right'))
  assert.match(inspector, /特写/, 'it must select that shot instead, so you land where you meant to')

  // The sequence table's thumbnail is the same affordance and must not diverge.
  const seqTab = findAll(tree, (el) => el.type === 'button' && textOf(el) === '顺序')[0]
  seqTab.props.onClick()
  tree = await settle(3)
  const cell = find(tree, (el) => el.props?.className === 'dsh-ov-th'
    && findAll(el, (child) => child.props?.['data-media'] === '1').length > 0)
  assert.ok(cell, 'the sequence table must mark the playable thumbnail')
  findAll(cell, (child) => child.props?.['data-media'] === '1')[0].props.onClick({ stopPropagation() {} })
  tree = await settle(2)
  assert.ok(byAct(tree, 'clip-modal'), 'the table thumbnail must open the SAME player')
  assert.match(find(byAct(tree, 'clip-modal'), (el) => el.type === 'video').props.src, /vid_s01/)
})

await check('EVERY node type the library offers says what the node is FOR', async () => {
  // 角色 and 场景 explained themselves and every other type opened to a stack of
  // fields with nothing saying what the node does or which port feeds it. This is
  // the whole library, not a sample: a new type with no blurb fails here.
  const library = ['script', 'prompt', 'ref', 'cast', 'scene', 'generate',
    'extend', 'edit', 'upscale', 'take', 'seq', 'note', 'group', 'template']
  const idOf = {
    script: 'n_script', ref: 'n_ref1', cast: 'n_cast1', generate: 'n_g1', take: 'n_take1',
  }
  const built = JSON.parse(JSON.stringify(FAKE_GRAPH))
  const extras = library.filter((type) => idOf[type] === undefined)
  built.nodes = built.nodes.concat(extras.map((type, index) => ({
    id: 'n_x_' + type, type, title: type, x: 20 + (index % 5) * 210, y: 620 + Math.floor(index / 5) * 190,
    w: 190, shotIndex: null,
    fields: type === 'scene' ? { name: '天台', description: '黄昏，硬光' }
      : type === 'generate' ? { prompt: 'x', duration: 8 } : {},
  })))
  // No wires: this is about what each panel SAYS, and a wired graph would add
  // warnings that could be mistaken for the blurb.
  built.edges = []
  persistedGraph = built
  componentState.clear()
  tree = await boot()
  tree = await showCanvas()

  const missing = []
  const seen = {}
  for (const type of library) {
    const id = idOf[type] ?? 'n_x_' + type
    tree = await selectNode(id)
    const note = findAll(tree, (el) => el.props?.['data-act'] === 'node-blurb')[0]
    const text = note === undefined ? '' : textOf(note).trim()
    seen[type] = text
    if (text.length < 8) missing.push(type + ' ("' + text + '")')
  }
  assert.deepEqual(missing, [], 'node types that open to a panel with no statement of what they do')
  // And the blurb must say what the node does, not merely repeat its label.
  for (const type of library) {
    assert.notEqual(seen[type], type, type + ' blurb must be a sentence, not the type name')
  }
  // The full story stays reachable on hover rather than being deleted.
  tree = await selectNode('n_cast1')
  const castNote = findAll(tree, (el) => el.props?.['data-act'] === 'node-blurb')[0]
  assert.match(String(castNote.props.title ?? ''), /input_references/u,
    'the long explanation must survive as the hover title')
})

await check('a 角色/场景/素材 inspector shows the picture, not just the URL', async () => {
  tree = await resetGraph()
  tree = await showCanvas()

  tree = await selectNode('n_cast1')
  const card = findAll(tree, (el) => el.props?.['data-act'] === 'node-asset-image')[0]
  assert.ok(card, 'a 角色 node with an image URL must show the image on its own panel')
  const img = find(card, (el) => el.type === 'img')
  assert.equal(img.props.src, 'https://img.example.com/tom.png')
  assert.equal(img.props.loading, undefined, 'the inspector image is in view — no need to defer it')

  tree = await selectNode('n_ref1')
  const refCard = findAll(tree, (el) => el.props?.['data-act'] === 'node-asset-image')[0]
  assert.ok(refCard, 'a 参考素材 node is an image too')

  // A shot has no reference image of its own; it must not invent one.
  tree = await selectNode('n_g1')
  assert.equal(findAll(tree, (el) => el.props?.['data-act'] === 'node-asset-image').length, 0,
    'a generate node has no sheet to show')

  // A local path and a video ref are not previewable images.
  const broken = JSON.parse(JSON.stringify(FAKE_GRAPH))
  broken.nodes.find((n) => n.id === 'n_cast1').fields.source = 'C:\\local\\cat.png'
  broken.nodes.find((n) => n.id === 'n_ref1').fields.kind = 'video'
  persistedGraph = broken
  componentState.clear()
  tree = await boot()
  tree = await showCanvas()
  tree = await selectNode('n_cast1')
  assert.equal(findAll(tree, (el) => el.props?.['data-act'] === 'node-asset-image').length, 0,
    'a local path is not a public URL and must not be drawn as one')
  tree = await selectNode('n_ref1')
  assert.equal(findAll(tree, (el) => el.props?.['data-act'] === 'node-asset-image').length, 0,
    'a ref node declared as a video is not an image')
})

await check('a generate node has exactly ONE duration control', async () => {
  // It had two: a plain number input from the field table AND the
  // supported_durations control appended after it — both writing `duration`, both
  // on screen, and both agreeing until you used one of them. The field table now
  // yields to the dynamic control whenever the model advertises its durations.
  tree = await resetGraph()
  tree = await showCanvas()
  tree = await selectNode('n_g1')

  const durationFields = findAll(tree, (el) => el.props?.['data-field'] === 'duration')
  assert.equal(durationFields.length, 1,
    'a shot must expose duration once, not twice — saw ' + durationFields.length)
  assert.equal(findAll(durationFields[0], (el) => el.type === 'select').length, 1,
    'the surviving control is the model-driven one')
  const labels = findAll(tree, (el) => el.type === 'label').map(textOf)
    .filter((text) => text.includes('时长'))
  assert.deepEqual(labels, ['时长'], 'and it is labelled once: ' + JSON.stringify(labels))
  // The control must write the SAME field the request reads.
  const control = find(durationFields[0], (el) => el.type === 'select')
  assert.deepEqual(control.props.onChange !== undefined, true)
  assert.ok(control.props.value.length > 0, 'and start on a value the model actually supports')
})

await check('a model with no advertised durations still gets a plain duration input', async () => {
  // The fallback path matters: an un-catalogued or hand-typed model has nothing to
  // constrain the value with, and losing the control entirely would make duration
  // unreachable — which is worse than the duplicate it replaced.
  tree = await resetGraph()
  const built = JSON.parse(JSON.stringify(persistedGraph))
  built.project.model = 'someone/hand-typed-model'
  for (const node of built.nodes) if (node.type === 'generate') delete node.fields.model
  persistedGraph = built
  componentState.clear()
  tree = await boot()
  tree = await showCanvas()
  tree = await selectNode('n_g1')

  const durationFields = findAll(tree, (el) => el.props?.['data-field'] === 'duration')
  assert.equal(durationFields.length, 1, 'still exactly one control')
  assert.equal(findAll(durationFields[0], (el) => el.type === 'input').length, 1,
    'and with no catalog entry it is the plain number input')
})

await check('the key and bed chips are two more doors into 设置 — each addressable', async () => {
  // They are not decoration: both chips are the fastest way to the thing they
  // report on. They also must NOT share the 设置 button's act name, or deleting
  // that button stops being a detectable failure.
  tree = await resetGraph()
  tree = await showCanvas()
  assert.equal(findAll(tree, (el) => el.props?.['data-act'] === 'open-settings').length, 1,
    'exactly one 设置 button owns open-settings')
  tree = await showCanvas()

  byAct(tree, 'open-settings-key').props.onClick()
  tree = await settle(2)
  assert.ok(byAct(tree, 'save-key'), 'the 密钥 chip must open the dialog')
  byAct(tree, 'close').props.onClick()
  tree = await settle(2)

  byAct(tree, 'open-settings-bed').props.onClick()
  tree = await settle(2)
  assert.ok(byAct(tree, 'save-bed'), 'the 图床 chip must open it too')
  byAct(tree, 'close').props.onClick()
  await settle(2)
})

await check('the toolbar has ONE subset-run control, and it says what the subset is', async () => {
  // `▶ 运行选中` read as "just this one" while actually dispatching the selection
  // PLUS its whole downstream chain — a mid-film shot could quietly spend ten
  // nodes' worth. And `▶▶ 运行下游` sat beside it doing the SAME thing, except it
  // did nothing at all: it computed the subset and printed a toast. Two controls
  // for one decision, one of them a lie.
  tree = await resetGraph()
  tree = await showCanvas()
  tree = await selectNode('n_g1')

  const buttons = findAll(tree, (el) => el.props?.['data-act'] === 'run-selected')
  assert.equal(buttons.length, 1, 'exactly one subset-run control')
  assert.match(textOf(buttons[0]), /下游/u,
    'and its label must admit that downstream is included: ' + JSON.stringify(textOf(buttons[0])))

  const allActs = findAll(tree, (el) => typeof el.props?.['data-act'] === 'string')
    .map((el) => el.props['data-act'])
  assert.ok(!allActs.includes('run-downstream'), 'the dead 运行下游 control must be gone')

  // Nothing has failed in this fixture, so there is nothing to retry — and a
  // disabled button that promises a retry would be the same lie in a new place.
  assert.equal(findAll(tree, (el) => el.props?.['data-act'] === 'retry-failed').length, 0,
    'no retry control when nothing has failed')

  // What it actually sends: a SEED, not a scope.
  const before = calls.filter((c) => c.path.endsWith('/graph/run')).length
  buttons[0].props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  const sent = calls.filter((c) => c.path.endsWith('/graph/run'))[before]
  assert.deepEqual(sent.body.only, ['n_g1'], 'the selected node is the seed')
  assert.equal(sent.body.retry_failed, undefined, 'a plain run must NOT retry failures')
})

await check('a failed shot can be RETRIED from the workspace — it could not before', async () => {
  // With retryFailed false a failed node short-circuits and the run ends, so
  // clicking run again skipped it for ever. `retry_failed` existed on the agent
  // tool and in the executor and was unreachable from the panel: the workspace had
  // no way at all to recover a dead shot.
  tree = await resetGraph()
  tree = await showCanvas()
  // Fail n_g2 in the snapshot the Host reports.
  failNode = 'n_g2'
  componentState.clear()
  tree = await boot()
  tree = await showCanvas()
  tree = await selectNode('n_g2')

  const retry = findAll(tree, (el) => el.props?.['data-act'] === 'retry-failed')
  assert.equal(retry.length, 1, 'a failed shot must offer a retry')
  assert.match(textOf(retry[0]), /1 镜/u, 'and say how many it will re-submit')

  const before = calls.filter((c) => c.path.endsWith('/graph/run')).length
  retry[0].props.onClick()
  await new Promise((resolve) => realTimeout(resolve, 5))
  const sent = calls.filter((c) => c.path.endsWith('/graph/run'))[before]
  assert.equal(sent.body.retry_failed, true, 'the retry must actually ask the Host to retry')
  assert.deepEqual(sent.body.only, ['n_g2'], 'scoped to the selection and its downstream')
})

await check('the workspace watches the Host even for a run it did not start', async () => {
  // THE reported bug: an agent called openrouter_video_run, the videos were
  // generated, and no node showed 生成中, no shot showed progress — then the whole
  // finished film appeared at once. The 4s interval was installed only when the
  // client's OWN snapshot said `running`, a self-fulfilling condition: a run
  // started elsewhere is invisible, so the snapshot stays idle, so it never polls.
  await resetGraph()
  tree = await boot()
  await settle(2)

  const live = () => intervals.filter((row) => liveIntervals.has(row.id))
  assert.ok(live().length > 0,
    'a poll interval must be installed while the snapshot says NOTHING is running')
  const idle = live()[live().length - 1].ms
  assert.ok(idle > 0 && idle <= 15000, 'and at a sane idle period, saw ' + idle + 'ms')

  // And it must tighten once a run is known to be live. Fire the heartbeat the way
  // the browser would — that IS the mechanism: nothing else in the client fetches
  // the snapshot, so without a beat an externally started run is never seen.
  snapshotIsRunning = true
  liveNode = 'n_g2'
  live()[live().length - 1].fn()
  await new Promise((resolve) => realTimeout(resolve, 5))
  tree = await settle(3)
  assert.ok(live().some((row) => row.ms === 4000),
    'a live run must be watched at 4s; installed periods were '
      + JSON.stringify(live().map((row) => row.ms)))

  // And the beat must actually SHOW the run it did not start: this is the reported
  // symptom — videos generated, no 生成中 anywhere, no per-shot progress.
  const top = textOf(find(tree, (el) => el.props?.className === 'dsh-ov-top'))
  assert.match(top, /运行中\s*1/u, 'the run must appear in the top bar: ' + top)
  const nodeCard = findAll(tree, (el) => el.props?.id === 'ov-node-n_g2')[0]
  assert.equal(nodeCard.props['data-state'], 'in_progress',
    'the generating node must be marked in_progress, so its border and label change')
  assert.match(textOf(nodeCard), /生成中/u, 'and its preview box must say 生成中')
  // The strip, not the node's title span — `data-node` is on both.
  const strip = findAll(tree, (el) => el.props?.className === 'dsh-ov-strip'
    && el.props['data-node'] === 'n_g2')[0]
  assert.match(textOf(strip), /◌/u,
    'the bottom strip must show that shot as running, saw ' + JSON.stringify(textOf(strip)))
  snapshotIsRunning = false
  liveNode = null
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
