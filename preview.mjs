/**
 * preview.mjs — render the REAL lib/client.js and assert on the DOM.
 *
 * This loads the actual client module (not a copy), drives it with a small
 * React stand-in that executes hooks, and writes an HTML page plus a DOM dump.
 * Assertions run against the produced DOM, never against source text: the
 * reference implementation learned that grepping source goes green on CSS class
 * names that no longer render anything (`NOTES.md`「预览与断言的几个陷阱」).
 *
 * Two traps carried over deliberately:
 *   - `<style>` must be stripped before asserting, or the plugin's own
 *     stylesheet satisfies `includes()` no matter what rendered
 *   - object-typed props are still skipped EXCEPT `style`, which is serialized:
 *     skipping it was silently dropping every canvas node's `left`/`top`, so the
 *     preview could not show a positioning bug (it piled all nodes in one spot)
 *     and the page still looked like it had rendered
 *
 * Run: node preview.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${error.message}`) }
}

/* FIRST, before anything loads the module: the stylesheet lives in a template
   literal, so ONE backtick inside it — including inside a comment — ends the
   string early and surfaces as `Unexpected identifier 'whatever'` from somewhere
   unrelated, usually six failing checks later. This reports the line instead.
   Hit three times in one session while restyling the workspace. */
await check('the stylesheet template literal is not cut short by a stray backtick', async () => {
  const BT = String.fromCharCode(96)
  const lines = (await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')).split('\n')
  const start = lines.findIndex((line) => line.includes('const CSS = ' + BT))
  const end = lines.findIndex((line, index) => index > start && line.trim() === BT)
  assert.ok(start >= 0 && end > start, 'could not locate the stylesheet block')
  const offenders = []
  for (let i = start + 1; i < end; i += 1) if (lines[i].includes(BT)) offenders.push(i + 1)
  assert.deepEqual(offenders, [],
    'backtick(s) inside the CSS template literal, at line(s) ' + offenders.join(', ')
      + ' — each one breaks the whole client module')
})

/* ================================================================== *
 * a tiny React stand-in that actually runs hooks
 * ================================================================== */

function createReact() {
  let current = null

  /** Shallow dependency comparison, the way React does it. */
  const depsChanged = (previous, next) => {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return true
    return false
  }

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  })

  const hookState = () => {
    if (current === null) throw new Error('hook called outside render')
    return current
  }

  const useState = (initial) => {
    const slot = hookState()
    const index = slot.cursor++
    if (!(index in slot.values)) slot.values[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      slot.values[index] = typeof next === 'function' ? next(slot.values[index]) : next
      slot.dirty = true
    }
    return [slot.values[index], set]
  }

  const useRef = (initial) => {
    const slot = hookState()
    const index = slot.cursor++
    if (!(index in slot.refs)) slot.refs[index] = { current: initial }
    return slot.refs[index]
  }

  const useMemo = (fn, deps) => {
    const slot = hookState()
    const index = slot.cursor++
    const previous = slot.memos[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) {
      slot.memos[index] = { value: fn(), deps }
    }
    return slot.memos[index].value
  }

  const useCallback = (fn, deps) => {
    const slot = hookState()
    const index = slot.cursor++
    const previous = slot.callbacks[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) {
      slot.callbacks[index] = { fn, deps }
    }
    return slot.callbacks[index].fn
  }

  const useEffect = (fn, deps) => {
    const slot = hookState()
    const index = slot.cursor++
    const previous = slot.effectDeps[index]
    // Effects re-run when their deps change — ignoring deps would silently freeze
    // every dependent value at its first-render state, which is exactly how this
    // renderer fooled itself into reporting a working shell with no graph.
    if (previous === undefined || depsChanged(previous, deps)) {
      slot.effectDeps[index] = deps
      slot.pendingEffects.push(fn)
    }
  }

  // Class-based components in this codebase? None — only function components.
  const Component = function Component() {}
  const Fragment = Symbol('Fragment')

  return {
    createElement, useState, useRef, useMemo, useCallback, useEffect,
    Component, Fragment,
    __internal: { get current() { return current }, set current(value) { current = value } },
  }
}

/* ================================================================== *
 * renderer: walk the element tree into HTML
 * ================================================================== */

const ATTR_MAP = {
  className: 'class',
  htmlFor: 'for',
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
}

function renderToHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(renderToHtml).join('')
  if (typeof node.type === 'function') return renderToHtml(callComponent(node.type, node.props))
  if (node.type === null) return node.children.map(renderToHtml).join('')

  const attrs = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (typeof value === 'function') continue
    if (key === 'key') continue
    // `style` is an object, and a flat "skip objects" rule silently dropped the
    // one prop that carries every canvas node's position — so the preview piled
    // all the nodes in one place and could not show a layout bug. Serialize it.
    if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null && v !== false)
        .map(([prop, v]) => `${prop.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())}:${v}`)
        .join(';')
      if (css.length > 0) attrs.push(`style="${escapeHtml(css)}"`)
      continue
    }
    if (typeof value === 'object') continue
    const name = ATTR_MAP[key] ?? key
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }

  // Void elements must not get a closing tag.
  const voidTags = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source'])
  const inner = node.children.map(renderToHtml).join('')
  if (voidTags.has(node.type)) return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${node.type}>`
}

const React = createReact()
const componentState = new Map()

/** Drain every effect a render recorded, so the bootstrap's fetch can land. */
const pendingEffectQueue = []

function callComponent(type, props, slotKey) {
  const key = slotKey ?? type.name ?? 'anonymous'
  const previousSlot = componentState.get(key)
  const slot = previousSlot ?? {
    cursor: 0, values: [], refs: {}, memos: {}, callbacks: {}, effects: [], effectDeps: {}, pendingEffects: [], dirty: false,
  }
  slot.cursor = 0
  slot.pendingEffects = []
  const previous = React.__internal.current
  React.__internal.current = slot
  const output = type(props)
  React.__internal.current = previous
  componentState.set(key, slot)
  for (const effect of slot.pendingEffects) pendingEffectQueue.push(effect)
  return output
}

/** Run queued effects and let their promises settle. */
async function flushEffects(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    const queue = pendingEffectQueue.splice(0, pendingEffectQueue.length)
    for (const effect of queue) {
      const cleanup = effect()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    }
    // Let the fetch promises resolve.
    await new Promise((resolve) => realSetTimeout(resolve, 0))
  }
}

const effectCleanups = []
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

/* ================================================================== *
 * the fake page environment
 * ================================================================== */

/** A DOM-ish stub good enough for the client's bootstrap effects. */
function makeDom() {
  const byId = new Map()
  const created = []
  const makeEl = (tag) => {
    const el = {
      tagName: tag, id: '', className: '', textContent: '', innerHTML: '',
      style: {}, children: [], dataset: {},
      appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child); return child },
      removeChild(child) { this.children = this.children.filter((c) => c !== child) },
      remove() {},
      setAttribute(name, value) { this[name] = value },
      getAttribute(name) { return this[name] ?? null },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null },
      querySelectorAll() { return [] },
      getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 14, right: 120, bottom: 14 } },
    }
    return el
  }
  const head = makeEl('head')
  const document = {
    head,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => { const el = makeEl(tag); created.push(el); return el },
    addEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    body: makeEl('body'),
  }
  return { document, byId, created, head }
}

/* ================================================================== *
 * run
 * ================================================================== */

console.log('preview: render the real client half\n')

const dom = makeDom()

// The API the client calls. Responses are shaped exactly like the Host's.
const FAKE_GRAPH = {
  version: 1,
  id: 'graph_test',
  title: '预览项目',
  createdAt: 1, updatedAt: 2,
  project: { model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9', duration: 8, generateAudio: true, seed: null },
  budget: { usd: 30, onExceed: 'refuse' },
  concurrency: 2,
  nodes: [
    { id: 'n_script', type: 'script', title: '分镜', x: 20, y: 20, w: 186, shotIndex: null, fields: { text: '1. 开场' } },
    { id: 'n_g1', type: 'generate', title: '开场', x: 260, y: 20, w: 190, shotIndex: 1, fields: { prompt: '晨光', model: 'google/veo-3.1-fast', duration: 8 } },
    { id: 'n_g2', type: 'generate', title: '特写', x: 260, y: 210, w: 190, shotIndex: 2, fields: { prompt: '微距', model: 'google/veo-3.1-fast', duration: 8 } },
    { id: 'n_seq', type: 'seq', title: '成片序列', x: 520, y: 20, w: 190, shotIndex: null, inputs: [], fields: {} },
  ],
  edges: [
    { id: 'e1', from: 'n_script', fromPort: 'shots', to: 'n_g1', toPort: 'brief', label: '' },
    { id: 'e2', from: 'n_g1', fromPort: 'job', to: 'n_seq', toPort: 'jobs', label: '' },
  ],
  run: { state: 'idle', startedAt: null, lastRunAt: null },
}

const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  const path = String(url)
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload })
  if (path.endsWith('/config')) {
    return json({ ok: true, config: { concurrency: 2, budgetUsd: 30, model: 'google/veo-3.1-fast' }, key: { hasKey: false } })
  }
  if (path.endsWith('/graphs')) return json({ ok: true, graphs: [{ id: 'graph_test', title: '预览项目' }] })
  if (path.includes('/graph?id=')) {
    return json({
      ok: true, graph: FAKE_GRAPH,
      states: { n_script: 'idle', n_g1: 'completed', n_g2: 'in_progress', n_seq: 'idle' },
      jobs: [{ id: 'S2wge1oFOBzIj1PpFcFu', nodeId: 'n_g1', status: 'completed', cost: 0.8, filePathRelative: 'generated-videos/s01.mp4', error: null, model: 'google/veo-3.1-fast' }],
      ceilings: { n_g1: 0.8, n_g2: null },
      ceilingTotal: 0.8, unknownCount: 1, spentUsd: 0.8, budgetUsd: 30,
      counts: { total: 2, completed: 1, running: 1, failed: 0, skipped: 0, idle: 0 },
      totalSeconds: 16, running: false, aborted: false, report: null,
      catalogLoaded: true, catalogError: null,
    })
  }
  if (path.endsWith('/models')) {
    return json({
      ok: true, loaded: true, error: null,
      models: [{
        id: 'google/veo-3.1-fast', supported_durations: [4, 6, 8],
        supported_resolutions: ['720p', '1080p', '4K'], supported_aspect_ratios: ['16:9', '9:16'],
        pricing_skus: { duration_seconds: '0.10' },
      }],
    })
  }
  return json({ ok: false, error: 'unexpected path ' + path })
}

globalThis.window = {
  __ModuleLoader__: { load: (entry) => { loadedEntry = entry } },
  addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, (ch) => '\\' + ch) },
  document: dom.document,
}
globalThis.document = dom.document
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

let loadedEntry = null
const clientSource = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./lib/client.js', import.meta.url), 'utf8'))

// Execute the client module in this environment. It is a CJS-factory wrapper, so
// evaluate it as a script with the expected globals in place.
await check('the client module registers and exports a workspace', async () => {
  const factory = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', clientSource)
  factory(globalThis.window, dom.document, globalThis.fetch, globalThis.setTimeout, globalThis.clearTimeout, globalThis.setInterval, globalThis.clearInterval)
  assert.ok(loadedEntry !== null, 'window.__ModuleLoader__.load was never called')
  assert.equal(loadedEntry.id, 'dsh-openrouter-video')
  const exports = loadedEntry.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.Workspace, 'function')
})

await check('slots register a sidebar entry and a main view under the SAME key', async () => {
  const exports = loadedEntry.factory((name) => (name === 'react' ? React : null))
  const registrations = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject(name, generator) {
        const iterator = generator()
        let step = iterator.next()
        while (!step.done) {
          registrations.push({ slot: name, spec: step.value })
          step = iterator.next()
        }
        return () => {}
      },
      register(spec) { registrations.push({ slot: spec.name, spec }); return () => {} },
    },
  }
  exports.apply(ctx)

  // Registration goes through `slots.inject(...)` + `register`, so collect from
  // the generator call above.
  const entry = registrations.find((row) => row.slot === 'sidebar.panellist')
  const main = registrations.find((row) => row.slot === 'main')
  assert.ok(entry, 'a sidebar.panellist registration is required')
  assert.ok(main, 'a main registration is required')
  assert.equal(entry.spec.id, main.spec.key, 'the panel id and the main key MUST be the same string')
})

await check('rendering the Workspace produces a DOM with the workspace shell', async () => {
  const exports = loadedEntry.factory((name) => (name === 'react' ? React : null))
  const tree = callComponent(exports.Workspace, {})
  const html = renderToHtml(tree)
  assert.ok(html.length > 500, `rendered HTML looks empty (${html.length} chars)`)

  // Strip <style> before asserting: the plugin's own stylesheet contains many of
  // the class names, so leaving it in would make these assertions pass always.
  const withoutStyle = html.replace(/<style[\s\S]*?<\/style>/g, '')
  assert.ok(!withoutStyle.includes('dsh-ov-toast') || withoutStyle.includes('data-kind'),
    'style stripping must have removed the stylesheet')
  assert.match(withoutStyle, /dsh-ov-root/, 'the workspace root must render')
  assert.match(withoutStyle, /dsh-ov-top/, 'the top bar must render')
  assert.match(withoutStyle, /画布/, 'the canvas/sequence switch must render')
  assert.match(withoutStyle, /顺序/, 'the sequence view toggle must render')
  assert.match(withoutStyle, /节点库/, 'the node library must render')
})

await check('bootstrapped render actually contains the NODES and the PORTS', async () => {
  const exports = loadedEntry.factory((name) => (name === 'react' ? React : null))

  // First render schedules the bootstrap effects; flush them so the fetch
  // results land in state; re-render until the tree stops changing.
  callComponent(exports.Workspace, {}, 'Workspace')
  await flushEffects()

  let html = ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tree = callComponent(exports.Workspace, {}, 'Workspace')
    html = renderToHtml(tree).replace(/<style[\s\S]*?<\/style>/g, '')
    await flushEffects(2)
  }

  // The whole point of the workspace. If these are absent the preview is only
  // proving that an empty shell renders — the "declared but not in effect" trap.
  assert.match(html, /id="ov-node-n_g1"/, 'the generate node must actually render')
  assert.match(html, /id="ov-node-n_script"/, 'the script node must actually render')
  assert.match(html, /id="ov-node-n_seq"/, 'the sequence node must actually render')
  assert.equal((html.match(/class="dsh-ov-node"/g) ?? []).length, 4, 'all four nodes must render')
  assert.match(html, /dsh-ov-edges/, 'the edge layer must render')

  // Ports must exist with the ids the measurement code relies on.
  assert.match(html, /id="ov-port-in-n_g1-brief"/, 'input ports need their measured ids')
  assert.match(html, /id="ov-port-out-n_g1-job"/, 'output ports need their measured ids')
  assert.equal((html.match(/id="ov-port-/g) ?? []).length, 12, 'every declared port must render a dot')

  // And the derived numbers must be present, not placeholders.
  assert.match(html, /#1/, 'shot badges must render')
  assert.match(html, /16s/, 'the derived total duration must render')
  assert.match(html, /\$0\.80/, 'the actual cost must render')
  assert.match(html, /量级未知/, 'the unknown-magnitude node must be labelled as such, not as zero')

  // Deliberately NOT asserted: `<path>` elements. Edge geometry comes from
  // measuring the real DOM, and this string renderer has no layout engine, so
  // every port measures to the same fallback rect. That is the CORRECT design —
  // computing coordinates arithmetically was the prototype's bug — so the
  // no-arithmetic rule is asserted in the next test instead.
})

await check('port geometry is MEASURED, never computed arithmetically', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /const portPosition = React\.useCallback/, 'port position must be a callback')
  assert.match(source, /getBoundingClientRect\(\)/, 'measurement must come from the DOM')
  assert.ok(!/node\.y \+ 30 \+ i \* 22/.test(source),
    'port coordinates must NOT be computed arithmetically — that is a second source of truth')
  // Assert the PROPERTY (both endpoints come from a measured port) rather than the
  // spelling of the container. Asserting `useMemo` here was a source-shape check
  // that broke on a refactor while proving nothing about behaviour; the timing
  // that actually matters — measure AFTER commit — is covered by test-interact's
  // "the WIRE LAYER is actually drawn" case.
  assert.match(source, /portPosition\(edge\.from, edge\.fromPort, 'out'\)/u,
    'the wire must START at a measured output port')
  assert.match(source, /portPosition\(edge\.to, edge\.toPort, 'in'\)/u,
    'the wire must END at a measured input port')
})

await check('sequence view renders the shot table when selected', async () => {
  const exports = loadedEntry.factory((name) => (name === 'react' ? React : null))
  callComponent(exports.Workspace, {}, 'Workspace')
  await flushEffects()
  let tree = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    tree = callComponent(exports.Workspace, {}, 'Workspace')
    await flushEffects(2)
  }
  // Flip the view through the button's handler, which is what a user does.
  const findButton = (node, label, found = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return found
    if (Array.isArray(node)) { node.forEach((child) => findButton(child, label, found)); return found }
    const children = Array.isArray(node.children) ? node.children : []
    if (node.type === 'button' && children.some((child) => child === label)) found.push(node)
    children.forEach((child) => findButton(child, label, found))
    return found
  }
  const sequenceButton = findButton(tree, '顺序')[0]
  assert.ok(sequenceButton, 'the sequence toggle must be a real button')
  sequenceButton.props.onClick()
  const after = renderToHtml(callComponent(exports.Workspace, {}, 'Workspace')).replace(/<style[\s\S]*?<\/style>/g, '')
  assert.match(after, /dsh-ov-table/, 'the sequence table must render')
  assert.match(after, /独立起幅|续接|编辑/, 'the link column must explain how each shot joins the previous one')
  assert.match(after, /观感断层|量级未知/, 'the footer must surface seams and unknown magnitudes')
})

await check('write the preview page for a human to open', async () => {
  const exports = loadedEntry.factory((name) => (name === 'react' ? React : null))
  const first = callComponent(exports.Workspace, {})
  // The sequence check above flips the SHARED component slot to the sequence
  // view, so the page would otherwise show a view nobody asked for. Put it back
  // on the canvas — the canvas is the thing worth eyeballing.
  const findButton = (node, label, found = []) => {
    if (node === null || typeof node !== 'object') return found
    if (Array.isArray(node)) { node.forEach((child) => findButton(child, label, found)); return found }
    const children = Array.isArray(node.children) ? node.children : []
    if (node.type === 'button' && children.some((child) => child === label)) found.push(node)
    children.forEach((child) => findButton(child, label, found))
    return found
  }
  const canvasButton = findButton(first, '画布')[0]
  assert.ok(canvasButton, 'the 画布 toggle must be a real button')
  canvasButton.props.onClick()
  const body = renderToHtml(callComponent(exports.Workspace, {}))
  assert.match(body, /id="ov-node-n_g1"/, 'the preview page must show the canvas with its nodes')

  // The page must carry BOTH stylesheets, or it is not a layout check at all:
  // without the plugin's own CSS the markup renders as an unstyled vertical
  // list, and without the theme tokens every `var(--dsw-alias-*)` lookup
  // resolves to nothing. The page would still "render" and prove nothing —
  // which is exactly what it used to do, and why an obvious layout problem
  // (a 148px input crammed into a non-wrapping top bar) could hide in it.
  const { readFile } = await import('node:fs/promises')
  const clientSource = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
  const cssMatch = /const CSS = `([\s\S]*?)`\n/.exec(clientSource)
  assert.ok(cssMatch, 'could not extract the plugin stylesheet from lib/client.js')
  const pluginCss = cssMatch[1]
  assert.match(pluginCss, /\.dsh-ov-root\{/, 'the extracted CSS must be the real stylesheet')

  const themeCss = await readFile(new URL('./preview-theme.css', import.meta.url), 'utf8')
  assert.match(themeCss, /--dsw-alias-bg-base:var\(--dsw-static-neutral-bluish-950\)/,
    'the theme must be the DARK set: the light block declares the same roles first and produces invisible text')

  const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-openrouter-video preview</title>
<style>body{margin:0;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;height:100vh}
#root{height:100vh}
${themeCss}
${pluginCss}
</style></head>
<body><div id="root">${body}</div>
</body></html>`

  const outDir = join(tmpdir(), 'orv-preview')
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, 'preview.html')
  await writeFile(file, page, 'utf8')
  assert.ok(page.includes('.dsh-ov-root{'), 'the page must inline the plugin stylesheet')
  assert.ok(page.includes('--dsw-alias-bg-base:'), 'the page must inline the theme tokens')
  console.log(`       wrote ${file}`)
})

await check('every generated frame is shown WHOLE — the previews never crop', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
  const css = /const CSS = `([\s\S]*?)`\n/.exec(source)?.[1]
  assert.ok(css, 'could not extract the plugin stylesheet')

  // Three places render a generated frame: the node card, the sequence table's
  // thumbnail, and the bottom strip. `object-fit:cover` crops it — invisibly,
  // because the middle of a frame still looks like a frame. A preview whose job
  // is "show me what was generated" must letterbox instead.
  for (const selector of [
    '\\.dsh-ov-thumb img,\\.dsh-ov-thumb video',
    '\\.dsh-ov-th img,\\.dsh-ov-th video',
    '\\.dsh-ov-strip img,\\.dsh-ov-strip video',
  ]) {
    const rule = new RegExp(selector + '\\{([^}]*)\\}').exec(css)
    assert.ok(rule, 'missing the media-sizing rule for ' + selector)
    assert.match(rule[1], /object-fit:contain/, selector + ' must letterbox the frame')
    assert.ok(!/object-fit:cover/.test(rule[1]), selector + ' must not crop the frame')
  }

  // A configured secret is a LAMP. Asserting the rule exists is asserting that
  // "configured" is not merely "not red" — an absence of a colour is not a state.
  assert.match(css, /\.dsh-ov-dot\[data-ok="1"\]\{background:var\(--dsw-alias-state-success-primary\)\}/,
    'a configured key/bed needs a green lamp of its own')

  // No rule may paint WHITE text on a light fill. brand-primary is the near-white
  // accent in the dark set, so `background:brand-primary; color:#fff` renders an
  // invisible label — and that is what the active view tab and every primary
  // button shipped. Scanned as a property over the whole sheet rather than pinned
  // to two selectors, so the next control cannot reintroduce it either.
  const lightFill = /background:\s*var\(--dsw-alias-(?:brand-primary|button-primary-fill)\b/
  // Comments are stripped first: several of them quote the broken pairing as the
  // reason they exist, and a scan that reads its own documentation as a violation
  // is a scan that will be deleted rather than fixed.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = cssNoComments.match(/[^{}]+\{[^}]*\}/g) ?? []
  assert.ok(rules.length > 40, 'the stylesheet must have been parsed, not silently empty')
  for (const rule of rules) {
    if (!lightFill.test(rule)) continue
    assert.ok(!/color:\s*#fff\b/iu.test(rule),
      'white text on a light fill is invisible, in ' + rule.split('{')[0].trim())
  }
  // ...and the two controls that DO wear that fill must take their label from the
  // token designed to pair with it.
  for (const selector of ['\\.dsh-ov-seg button\\[data-on="1"\\]', '\\.dsh-ov-btn\\[data-kind="primary"\\]']) {
    const rule = new RegExp(selector + '\\{([^}]*)\\}').exec(css)
    assert.ok(rule, 'missing the primary-fill rule ' + selector)
    assert.match(rule[1], /label-primary-foreground/, selector + ' must use the paired foreground token')
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
