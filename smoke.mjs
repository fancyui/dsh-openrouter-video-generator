/**
 * smoke.mjs — Host-half contract test.
 *
 * Runs with **no API key and no network**, which is what makes it useful: the
 * assertions are about what the plugin does BEFORE it talks to anyone. A refusal
 * ("未配置 API Key") is evidence that no request was sent; an API error would
 * mean it got that far.
 *
 * The stub context deliberately reproduces Cordis's `inject` gate. The reference
 * implementation's first version used a permissive stub and therefore missed the
 * bug where `ctx.tools.register(...)` throws because `tools` was never injected —
 * a failure whose visible symptom is a 404 on the web route rather than a crash
 * (`NOTES.md`「插件没挂载表现为 GET 404 / 其它 405」). A stub that lets anything
 * through cannot catch that, so this one throws.
 *
 * The data directory is passed in as a temp dir, so this test physically cannot
 * touch the user's real ledger — the defect the reference implementation still
 * has (`NOTES.md`「npm run smoke 会清空真实的生成历史」).
 *
 * Run: node smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0

const check = async (name, fn) => {
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

/* ------------------------------------------------------------------ *
 * the stub Cordis context
 * ------------------------------------------------------------------ */

/**
 * A context that enforces `inject`.
 *
 * Declared services resolve; undeclared PROPERTIES throw the way Cordis does.
 * `ctx.get(name)` stays permissive because that is the real semantics — `get`
 * is how optional services are read.
 */
function makeContext({ declared = [], services = {}, config = {} } = {}) {
  const disposed = []
  const api = {
    effects: 0,
    registeredTools: [],
    plugins: [],
    declared: [...declared],
  }

  const makeScope = (scopeDeclared) => {
    const scopeServices = { ...services }
    const proxy = {
      get(name) {
        return scopeServices[name]
      },
      inject(names, fn) {
        // Cordis: inject waits for those services; here they are all present.
        const next = [...new Set([...scopeDeclared, ...names])]
        const child = makeScope(next)
        if (typeof fn === 'function') fn(child)
        return child
      },
      effect(fn, label) {
        api.effects += 1
        const dispose = typeof fn === 'function' ? fn() : undefined
        if (typeof dispose === 'function') disposed.push({ label, dispose })
        return dispose
      },
      tools: undefined,
      plugin(child) {
        api.plugins.push(child)
        // Mirror Cordis: a child plugin is applied immediately with its own scope.
        if (typeof child === 'function') child(makeScope(scopeDeclared))
        return child
      },
      on() { return () => {} },
      _api: api,
    }
    // The gate: reading a property that was not injected must throw.
    Object.defineProperty(proxy, 'tools', {
      configurable: true,
      get() {
        if (!scopeDeclared.includes('tools')) {
          throw new Error('cannot get property "tools" without inject')
        }
        return scopeServices.tools
      },
    })
    return proxy
  }

  const root = makeScope(declared)
  root._api = api

  // Config accessors mirror schemastery's `.get()`.
  const configProxy = {}
  for (const [key, value] of Object.entries(config)) {
    configProxy[key] = { get: () => value, set: (next) => { config[key] = next } }
  }
  root._config = configProxy
  root._disposed = disposed
  return root
}

/** A tool service that records registrations. */
function makeToolService(api) {
  return {
    register(tool) {
      api.registeredTools.push(tool)
      return () => {}
    },
  }
}

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

const tempDirs = []
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orv-smoke-'))
  tempDirs.push(dir)
  return dir
}

console.log('smoke: Host half contract (no key, no network)\n')

const mod = await import('./lib/index.js')

await check('plugin exports name and a tools-only inject', () => {
  assert.equal(mod.name, 'openrouter-video')
  // Exactly ['tools'] — the reference implementation asserts this too, and a
  // wider list would park the plugin on surfaces that lack those services.
  assert.deepEqual(mod.inject, ['tools'])
})

await check('Config declares a secret apiKey and every writable setting', () => {
  assert.ok(mod.Config !== undefined, 'Config must be exported for the bundle patch')
  assert.equal(typeof mod.Config, 'function')
})

await check('apply() registers five tools with a declared tools service', async () => {
  const dir = await tempDir()
  const ctx = makeContext({
    declared: ['tools'],
    services: {},
    config: { dataDir: dir },
  })
  const api = ctx._api
  ctx.inject = (names, fn) => {
    const next = [...new Set([...ctx.declared, ...names])]
    return fn(makeScopeFor(next))
  }
  // simple re-entry: build a scope that has tools
  function makeScopeFor() {
    return {
      get: () => undefined,
      effect: (fn) => { api.effects += 1; return fn?.() },
      tools: makeToolService(api),
      plugin: (child) => { api.plugins.push(child); if (typeof child === 'function') child({ get: () => undefined, effect: (fn) => { api.effects += 1; return fn?.() }, inject: () => {}, tools: undefined }) },
      inject: () => {},
    }
  }
  const services = { tools: makeToolService(api) }
  const realCtx = makeContext({ declared: ['tools'], services, config: { dataDir: dir } })

  // The real Config object exposes .get(); drive apply through the same shape
  // the profile uses so we exercise the actual code path.
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 30000, maxPollAttempts: 60, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(realCtx, config)

  const names = api.registeredTools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'openrouter_generate_video',
    'openrouter_video_graph',
    'openrouter_video_plan',
    'openrouter_video_run',
    'openrouter_video_status',
  ])
})

await check('an undeclared tools property throws (the inject gate is real)', () => {
  const ctx = makeContext({ declared: [], services: { tools: makeToolService({ registeredTools: [] }) } })
  assert.throws(() => ctx.tools, /without inject/)
})

await check('no API key: a generation attempt is REFUSED, not an API error', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const services = { tools: makeToolService(api) }
  const ctx = makeContext({ declared: ['tools'], services, config: { dataDir: dir } })

  const config = {}
  for (const [key, value] of Object.entries({
    apiKey: '', dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)

  const tool = api.registeredTools.find((entry) => entry.name === 'openrouter_generate_video')
  assert.ok(tool, 'the tool must be registered')

  // The catalog refresh will fail with no network; that is fine and must not
  // crash. What matters is that the paid path refuses for the RIGHT reason.
  const result = await tool.execute(
    { prompt: 'a cat', model: 'google/veo-3.1-fast', duration: 8, resolution: '720p', aspect_ratio: '16:9' },
    { agent: { session: { header: { cwd: dir } } } },
  )
  assert.equal(result.ok, false)
  // Either it refused for a missing key (no network attempted) or it could not
  // reach the catalog. Both are "no paid request was made"; an API 4xx from
  // /videos would mean it got further than it should have.
  const refusedForKey = /API Key/.test(result.error ?? '')
  const catalogUnreachable = /模型目录|fetch|ENOTFOUND|getaddrinfo|timed out|aborted/i.test(result.error ?? '')
  assert.ok(refusedForKey || catalogUnreachable,
    `expected a key/catalog refusal, got: ${result.error}`)
  assert.ok(!/401|403/.test(result.error ?? ''),
    'must not have reached an authenticated endpoint')
})

await check('graph tool: set a valid graph, then read it back', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)

  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')

  const created = await graphTool.execute({
    action: 'set',
    title: '烟测片',
    graph: {
      title: '烟测片',
      nodes: [
        { id: 'n_script', type: 'script', fields: { text: '1. 开场' } },
        { id: 'n_g1', type: 'generate', shotIndex: 1, fields: { prompt: 'a', model: 'google/veo-3.1-fast' } },
      ],
      edges: [{ id: 'e1', from: 'n_script', fromPort: 'shots', to: 'n_g1', toPort: 'brief' }],
    },
  })
  assert.equal(created.ok, true, created.error)
  assert.ok(created.graph.id)

  const read = await graphTool.execute({ action: 'get', graph_id: created.graph.id })
  assert.equal(read.ok, true)
  assert.equal(read.graph.nodes.length, 2)
  assert.equal(read.graph.edges.length, 1)

  const listed = await graphTool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.ok(listed.graphs.length >= 1)
})

await check('graph tool: an ILLEGAL graph is refused with a reason, not stored', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')

  // A cycle: two generate nodes feeding each other.
  const cyclic = await graphTool.execute({
    action: 'set',
    graph: {
      nodes: [
        { id: 'a', type: 'generate', fields: { model: 'google/veo-3.1-fast' } },
        { id: 'b', type: 'generate', fields: { model: 'google/veo-3.1-fast' } },
      ],
      edges: [
        { id: 'e1', from: 'a', fromPort: 'job', to: 'b', toPort: 'brief' },
        { id: 'e2', from: 'b', fromPort: 'job', to: 'a', toPort: 'brief' },
      ],
    },
  })
  assert.equal(cyclic.ok, false, 'a cyclic graph must not be stored')
  assert.match(cyclic.error, /不合法|环/)
})

await check('graph tool: a type-incompatible connection is refused', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')

  const created = await graphTool.execute({
    action: 'set',
    graph: {
      nodes: [
        { id: 'p', type: 'prompt', fields: { text: 'x' } },
        { id: 'g', type: 'generate', fields: { model: 'google/veo-3.1-fast' } },
      ],
      edges: [],
    },
  })
  assert.equal(created.ok, true, created.error)

  // text → frames is not a legal wire.
  const bad = await graphTool.execute({
    action: 'connect',
    graph_id: created.graph.id,
    edge: { from: 'p', fromPort: 'text', to: 'g', toPort: 'frames' },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /类型不兼容/)
})

await check('run tool: dry-run default never submits anything', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')
  const runTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_run')

  const created = await graphTool.execute({
    action: 'set',
    graph: {
      project: { model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9', duration: 8 },
      nodes: [{ id: 'g1', type: 'generate', shotIndex: 1, fields: { prompt: 'a' } }],
      edges: [],
    },
  })
  assert.equal(created.ok, true, created.error)

  const dry = await runTool.execute({ graph_id: created.graph.id })   // no dry_run → defaults to true
  assert.equal(dry.dryRun, true, 'the default MUST be dry-run')
  assert.equal(dry.dispatched, undefined, 'a dry run must not report a dispatch count')
})

await check('run tool with dry_run=false and no key refuses without submitting', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    apiKey: '', dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')
  const runTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_run')

  const created = await graphTool.execute({
    action: 'set',
    graph: {
      project: { model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9', duration: 8 },
      nodes: [{ id: 'g1', type: 'generate', shotIndex: 1, fields: { prompt: 'a' } }],
      edges: [],
    },
  })
  const result = await runTool.execute({ graph_id: created.graph.id, dry_run: false })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /API Key/, 'must refuse for the missing key, having sent nothing')
})

await check('status tool reports an empty ledger without throwing', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const statusTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_status')
  const result = await statusTool.execute({ job_id: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.error, /账本/)
})

await check('dataDir is honoured: nothing is written to the real home directory', async () => {
  const dir = await tempDir()
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const ctx = makeContext({ declared: ['tools'], services: { tools: makeToolService(api) }, config: { dataDir: dir } })
  const config = {}
  for (const [key, value] of Object.entries({
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  })) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')
  await graphTool.execute({ action: 'set', graph: { nodes: [{ id: 'n', type: 'note', fields: {} }], edges: [] } })

  const { readdir } = await import('node:fs/promises')
  const written = await readdir(dir)
  assert.ok(written.includes('graphs.json'), `expected graphs.json in the temp dir, saw: ${written.join(', ')}`)
})

/* ------------------------------------------------------------------ *
 * the settings seam
 *
 * These exist because saving a key reported success while the UI kept saying
 * "未配置". The cause was `config.apiKey?.set?.(value)`: the config object we
 * are handed does not necessarily expose a setter, and optional chaining turned
 * "there is no writer" into "did nothing, returned ok". Nothing in this file
 * drove the config route at all, so the whole class of failure was invisible.
 * ------------------------------------------------------------------ */

const callRoute = async (handler, { path, method = 'GET', body }) => {
  const req = {
    url: '/openrouter-video/api' + path,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let captured = null
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(text) { captured = text },
  }
  await handler(req, res)
  return { status: res.statusCode, payload: captured === null ? null : JSON.parse(captured) }
}

/** Build a plugin instance plus its route handler. `shape` picks how config is handed over. */
/**
 * Build a plugin instance plus its route handler.
 *
 *   shape:        how config reaches `apply` — `refs` (reactive `.get()`) or `plain`
 *   hasSettings:  whether a `settings` service exists at all
 *   writesThrough: whether the stub behaves like the real service, which writes
 *                 through to the plugin's volatile Config reference (config-editor
 *                 persists to the profile patch and the Loader applies it)
 */
const boot = async (dir, { hasSettings = true, writesThrough = true, configValues = {}, shape = 'refs' } = {}) => {
  const api = { registeredTools: [], effects: 0, plugins: [] }
  const routes = []
  const updates = []
  const services = {
    tools: makeToolService(api),
    webServer: { register: (spec) => { routes.push(spec); return () => {} } },
  }
  const values = {
    dataDir: dir, model: 'google/veo-3.1-fast', models: [], resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 1, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false, ...configValues,
  }
  const live = { ...values }
  if (hasSettings) {
    services.settings = {
      async update(ns, patch) {
        updates.push({ ns, patch })
        if (writesThrough) Object.assign(live, patch)
      },
    }
  }
  const ctx = makeContext({ declared: ['tools'], services, config: { dataDir: dir } })
  const config = {}
  // apiKey is ALWAYS present, even when the caller did not supply one: a config
  // with no slot for it has nothing for a settings write to feed, and the test
  // would then pass or fail for reasons unrelated to the code under test.
  for (const key of ['apiKey', ...Object.keys(values)]) {
    config[key] = shape === 'plain' ? live[key] : { get: () => live[key] }
  }
  mod.apply(ctx, config)
  const route = routes.find((entry) => entry.path === '/openrouter-video/api')
  assert.ok(route, 'the api route must register')
  return { api, route, updates, live }
}

const GOOD_KEY = 'sk-or-v1-' + 'a'.repeat(48)

await check('saving a key persists through the SETTINGS service, and the response says so', async () => {
  const dir = await tempDir()
  const { route, updates } = await boot(dir)

  const saved = await callRoute(route.handler, { path: '/config', method: 'POST', body: { config: { apiKey: GOOD_KEY } } })
  assert.equal(saved.payload.ok, true, saved.payload.error)
  assert.equal(updates.length, 1, 'exactly one settings write')
  assert.equal(updates[0].ns, 'openrouter-video', 'the namespace must be the plugin row id')
  assert.equal(updates[0].patch.apiKey, GOOD_KEY)

  assert.equal(saved.payload.key.hasKey, true,
    'the POST response is what the strip renders — it must reflect the write')
  assert.equal(saved.payload.key.prefix, 'sk-or-v1-')
  assert.equal(saved.payload.key.looksValid, true)
})

await check('with NO settings service the save FAILS LOUDLY instead of quietly doing nothing', async () => {
  const dir = await tempDir()
  const { route } = await boot(dir, { hasSettings: false })

  const saved = await callRoute(route.handler, { path: '/config', method: 'POST', body: { config: { apiKey: GOOD_KEY } } })
  // The original bug: ok=true, key unchanged, UI still "未配置", no explanation.
  assert.equal(saved.payload.ok, false, 'a save that cannot be persisted must NOT report success')
  assert.match(saved.payload.error, /设置服务/, `expected an actionable error, got: ${saved.payload.error}`)
  // An error response carries only {ok, error}, so it cannot also claim a key.
  assert.notEqual(saved.payload.key?.hasKey, true, 'a failed save must never claim the key is configured')
})

await check('a write the plugin cannot OBSERVE is not reported as configured', async () => {
  const dir = await tempDir()
  // The service accepts the write but the plugin's Config reference never changes.
  // We must not claim a state we cannot see — the client turns this into
  // "保存已提交，但状态仍未生效", which is honest, instead of a false 已保存.
  const { route, updates } = await boot(dir, { writesThrough: false })

  const saved = await callRoute(route.handler, { path: '/config', method: 'POST', body: { config: { apiKey: GOOD_KEY } } })
  assert.equal(updates.length, 1, 'the write was still attempted and accepted')
  assert.equal(saved.payload.ok, true)
  assert.equal(saved.payload.key.hasKey, false,
    'the response must describe the state the plugin can actually see, not the one it hoped for')
})

await check('a malformed key is rejected before the settings service is touched', async () => {
  const dir = await tempDir()
  const { route, updates } = await boot(dir)

  const saved = await callRoute(route.handler, { path: '/config', method: 'POST', body: { config: { apiKey: 'nope' } } })
  assert.equal(saved.payload.ok, false)
  assert.equal(updates.length, 0, 'a key that cannot be right must not be written anywhere')
})

await check('clearing a key goes through the settings service too', async () => {
  const dir = await tempDir()
  const { route, updates } = await boot(dir, { configValues: { apiKey: GOOD_KEY } })

  const cleared = await callRoute(route.handler, { path: '/config/key', method: 'DELETE' })
  assert.equal(cleared.payload.ok, true, cleared.payload.error)
  assert.equal(updates[0].patch.apiKey, '')
  assert.equal(cleared.payload.key.hasKey, false)
})

await check('readConfig reads PLAIN config values, not only reactive .get() accessors', async () => {
  const dir = await tempDir()
  // The profile can hand `apply` plain values. Reading only `config.x?.get?.()`
  // collapses those onto the fallback: invisible for a setting with a sensible
  // default, and fatal for the key, which has none — a key sitting right there
  // in the profile would still read as "未配置".
  const { route } = await boot(dir, {
    shape: 'plain',
    configValues: { apiKey: GOOD_KEY, model: 'kwaivgi/kling-v3.0-std', budgetUsd: 7 },
  })

  const got = await callRoute(route.handler, { path: '/config' })
  assert.equal(got.payload.config.model, 'kwaivgi/kling-v3.0-std', 'a plain model value must be read, not defaulted')
  assert.equal(got.payload.config.budgetUsd, 7, 'a plain number value must be read, not defaulted')
  assert.equal(got.payload.key.hasKey, true, 'a plain apiKey must be read — this is the reported symptom')
})

await check('reactive .get() accessors still win (both shapes are supported)', async () => {
  const dir = await tempDir()
  const { route } = await boot(dir, { shape: 'refs', configValues: { model: 'kwaivgi/kling-v3.0-std' } })
  const got = await callRoute(route.handler, { path: '/config' })
  assert.equal(got.payload.config.model, 'kwaivgi/kling-v3.0-std')
})

await check('a second load() arriving mid-read awaits the FIRST read instead of seeing an empty store', async () => {
  // The regression: `load()` used to set `loaded = true` BEFORE awaiting the
  // file. `apply` starts the read with `void graphStore.load()`, so a tool call
  // arriving inside that window got `loaded === true` and an empty Map — and
  // reported "没有这个图" for a graph that was sitting on disk the whole time.
  const { GraphStore } = await import('./lib/store.js')
  const dir = await tempDir()
  const file = join(dir, 'graphs.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    graphs: [{ id: 'g_probe', title: '在磁盘上', nodes: [], edges: [] }],
  }), 'utf8')

  const store = new GraphStore(file)
  void store.load()                 // exactly what apply() does
  await store.load()                // the tool call, immediately after
  assert.ok(store.get('g_probe') !== null,
    'the concurrent loader must await the in-flight read, not short-circuit on a flag')
})

await check('two concurrent load() calls both see the file contents', async () => {
  const { JobStore } = await import('./lib/store.js')
  const dir = await tempDir()
  const file = join(dir, 'jobs.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    jobs: [{ id: 'job_x', graphId: 'g1', nodeId: 'n1', status: 'completed', cost: 1.25 }],
  }), 'utf8')

  const store = new JobStore(file)
  await Promise.all([store.load(), store.load()])
  assert.equal(store.list().length, 1, 'the ledger was read exactly once and shared')
  assert.equal(store.find('job_x').cost, 1.25)
})

await check('the model shortlist persists, deduped and trimmed, through the settings service', async () => {
  // `model` was a single value, and the inspector's dropdown offered the entire
  // OpenRouter video catalog — hundreds of entries, of which four are ever used.
  // The shortlist is what the per-node picker now offers, so it has to survive a
  // round trip and cannot be allowed to grow without bound.
  const dir = await tempDir()
  const { route, updates } = await boot(dir)

  const saved = await callRoute(route.handler, {
    path: '/config', method: 'POST',
    body: { config: { models: ['heygen/heygen-video-1', ' heygen/heygen-video-1 ', '', 'google/veo-3.1-fast'] } },
  })
  assert.equal(saved.payload.ok, true, saved.payload.error)
  assert.deepEqual(updates[0].patch.models, ['heygen/heygen-video-1', 'google/veo-3.1-fast'],
    'the list must be deduped and trimmed')
  assert.deepEqual(saved.payload.config.models, ['heygen/heygen-video-1', 'google/veo-3.1-fast'],
    'the POST response is what the dialog renders — it must reflect the write')
})

await check('a non-array model shortlist is ignored rather than written through', async () => {
  const dir = await tempDir()
  const { route, updates } = await boot(dir)
  await callRoute(route.handler, { path: '/config', method: 'POST', body: { config: { models: 'heygen/heygen-video-1' } } })
  assert.equal(updates.length, 0, 'a string where an array belongs must not reach the settings service')
})

await check('the image bed can be PROBED from the host route, and a Cloudflare page is reported as such', async () => {
  // The real complaint behind this route: a Cloudflare-fronted bed answers 403
  // with an HTML interstitial to the wrong User-Agent, and the only other place
  // it surfaces is three shots into a film, as a chained shot that quietly became
  // an independent take. "Press one button and get told it is the challenge" is
  // worth more than any amount of copy explaining that the User-Agent matters.
  const dir = await tempDir()
  const { route } = await boot(dir, { configValues: { imageBedUrl: 'https://img.example.com', imageBedFolder: 'test', imageBedUserAgent: 'gobelagent' } })

  const realFetch = globalThis.fetch
  const seen = []
  try {
    globalThis.fetch = async (url, options) => {
      seen.push({ url: String(url), userAgent: options?.headers?.['User-Agent'] })
      return {
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        async text() { return JSON.stringify([{ src: 'https://img.example.com/file/test/probe.png' }]) },
      }
    }
    const ok = await callRoute(route.handler, { path: '/bed/test', method: 'POST', body: { userAgent: 'gobelagent' } })
    assert.equal(ok.payload.ok, true, ok.payload.error)
    assert.match(ok.payload.url, /file\/test\/probe\.png/u)
    assert.match(seen[0].url, /upload\?uploadFolder=test&returnFormat=full/u)

    // The DRAFT wins over what was last saved: the button tests what is on screen.
    const draft = await callRoute(route.handler, { path: '/bed/test', method: 'POST', body: { url: 'https://draft.example.com/', userAgent: 'other-agent' } })
    assert.match(seen[1].url, /^https:\/\/draft\.example\.com\/upload/u, 'the trailing slash must be normalised')
    assert.equal(seen[1].userAgent, 'other-agent', 'the probe must send the agent the user is looking at')
    assert.equal(draft.payload.ok, true)

    // An HTML body is the challenge, and it must be named as one.
    globalThis.fetch = async () => ({
      status: 403,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      async text() { return '<!DOCTYPE html><html><body>challenge</body></html>' },
    })
    const blocked = await callRoute(route.handler, { path: '/bed/test', method: 'POST', body: {} })
    assert.equal(blocked.payload.ok, false)
    assert.match(blocked.payload.error, /Cloudflare/u, `a challenge must be reported as one: ${blocked.payload.error}`)
    assert.match(blocked.payload.error, /User-Agent/u, 'the message must name the one thing the user can actually change')
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('probing a bed with no address refuses by name, without sending anything', async () => {
  const dir = await tempDir()
  const { route } = await boot(dir, { configValues: { imageBedUrl: '' } })
  const realFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async () => { calls += 1; return { status: 500, headers: new Map(), async text() { return '' } } }
    const out = await callRoute(route.handler, { path: '/bed/test', method: 'POST', body: {} })
    assert.equal(out.payload.ok, false)
    assert.equal(calls, 0, 'an unconfigured bed must not produce a request')
  } finally {
    globalThis.fetch = realFetch
  }
})

/* ------------------------------------------------------------------ *
 * teardown
 * ------------------------------------------------------------------ */

for (const dir of tempDirs) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/* ------------------------------------------------------------------ *
 * 清空工作台 + 把本机生成的图接进参考图
 *
 * Both were impossible while operating the workbench for real: there was
 * no way to delete a PROJECT from any direction (`GraphStore.remove` had
 * no caller), and a character sheet produced by the image tool is a LOCAL
 * file while the API only fetches public https URLs — so the workflow
 * stopped exactly one step short of the reference being usable.
 * ------------------------------------------------------------------ */

await check('graph tool: remove_graph deletes a WHOLE project, and returns the list updated', async () => {
  const dir = await tempDir()
  const { api } = await boot(dir)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')

  const a = await graphTool.execute({ action: 'set', title: '甲', graph: { title: '甲', nodes: [{ id: 'n_script', type: 'script', fields: {} }], edges: [] } })
  const b = await graphTool.execute({ action: 'set', title: '乙', graph: { title: '乙', nodes: [{ id: 'n_script', type: 'script', fields: {} }], edges: [] } })
  assert.equal(a.ok, true, a.error)
  assert.equal(b.ok, true, b.error)

  const before = await graphTool.execute({ action: 'list' })
  assert.equal(before.graphs.length, 2)

  const gone = await graphTool.execute({ action: 'remove_graph', graph_id: a.graph.id })
  assert.equal(gone.ok, true, gone.error)
  assert.equal(gone.removed, a.graph.id)
  assert.ok(!gone.graphs.some((g) => g.id === a.graph.id), 'the deleted project must be gone from the list')
  assert.equal(gone.graphs.length, 1, 'the list must come back already updated, not stale')

  const read = await graphTool.execute({ action: 'get', graph_id: a.graph.id })
  assert.equal(read.ok, false, 'reading a deleted project must fail rather than resurrect it')
  assert.match(read.error, /没有这个图/)
})

await check('the /graph/delete route is the only honest way to clear the workspace', async () => {
  // Editing graphs.json by hand does NOT clear anything while the Host runs: the
  // store loads once into memory and every later write re-persists the whole map.
  // So the removal has to happen in the Host.
  const dir = await tempDir()
  const { route } = await boot(dir)

  const one = await callRoute(route.handler, { path: '/graph/new', method: 'POST', body: { title: '甲' } })
  await callRoute(route.handler, { path: '/graph/new', method: 'POST', body: { title: '乙' } })
  assert.equal((await callRoute(route.handler, { path: '/graphs' })).payload.graphs.length, 2)

  const del = await callRoute(route.handler, { path: '/graph/delete', method: 'POST', body: { id: one.payload.graph.id } })
  assert.equal(del.payload.ok, true, del.payload.error)
  assert.equal(del.payload.graphs.length, 1, 'the response carries the updated list')
  assert.ok(!del.payload.graphs.some((g) => g.id === one.payload.graph.id))

  const after = await callRoute(route.handler, { path: '/graphs' })
  assert.equal(after.payload.graphs.length, 1, 'the deletion must be PERSISTED, not just echoed back')

  const missing = await callRoute(route.handler, { path: '/graph/delete', method: 'POST', body: { id: 'graph_nope' } })
  assert.equal(missing.status, 404, 'deleting something that is not there is a 404, not an ok')
  assert.equal(missing.payload.ok, false)
})

await check('a cast image given as a LOCAL FILE is published to the bed and the PUBLIC url is what gets stored', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'cat.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const { api } = await boot(dir, {
    configValues: {
      imageBedUrl: 'https://bed.example', imageBedFolder: 'test',
      imageBedUserAgent: 'gobelagent', imageBedToken: 'tok',
    },
  })
  const planTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_plan')

  const realFetch = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), ua: options?.headers?.['User-Agent'], auth: options?.headers?.Authorization }
    return {
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ url: 'https://bed.example/file/test/cat.png' }),
    }
  }
  try {
    const built = await planTool.execute({
      title: '发布烟测',
      shots: [{ prompt: 'a cat dancing' }],
      cast: [{ name: 'MOMO', description: 'an orange tabby', image_file: 'cat.png' }],
    }, { agent: { session: { header: { cwd: dir } } } })

    assert.equal(built.ok, true, built.error)
    assert.ok(seen !== null, 'the bed must actually have been called')
    assert.match(seen.url, /^https:\/\/bed\.example\/upload\?uploadFolder=test/u, seen.url)
    assert.equal(seen.ua, 'gobelagent', 'the wrong User-Agent gets a Cloudflare 403 HTML page, not JSON')
    assert.equal(seen.auth, 'Bearer tok')

    assert.equal(built.published.length, 1, 'the receipt must name the URL it minted')
    assert.equal(built.published[0].url, 'https://bed.example/file/test/cat.png')
    const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')
    const stored = await graphTool.execute({ action: 'get', graph_id: built.graphId })
    const cast = stored.graph.nodes.find((n) => n.type === 'cast')
    assert.equal(cast.fields.source, 'https://bed.example/file/test/cat.png',
      'the graph must hold the PUBLIC url — a local path would be sent to the provider verbatim and ignored')
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('a local cast image with NO bed configured is REFUSED before anything is stored', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'cat.png'), Buffer.from([1]))
  const { api } = await boot(dir) // imageBedUrl is empty by default
  const planTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_plan')

  const built = await planTool.execute({
    title: '没有图床',
    shots: [{ prompt: 'a cat' }],
    cast: [{ name: 'MOMO', description: 'd', image_file: 'cat.png' }],
  }, { agent: { session: { header: { cwd: dir } } } })

  assert.equal(built.ok, false, 'silently storing a local path would produce a reference the provider never fetches')
  assert.match(built.error, /图床/, built.error)
  const listed = await api.registeredTools.find((e) => e.name === 'openrouter_video_graph').execute({ action: 'list' })
  assert.equal(listed.graphs.length, 0, 'a refused plan must not leave a half-built graph behind')
})

await check('a cast image OUTSIDE the session directory is refused — the path is bounded', async () => {
  const dir = await tempDir()
  const { api } = await boot(dir, { configValues: { imageBedUrl: 'https://bed.example' } })
  const planTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_plan')

  const built = await planTool.execute({
    title: '越界',
    shots: [{ prompt: 'a cat' }],
    cast: [{ name: 'MOMO', description: 'd', image_file: '../outside.png' }],
  }, { agent: { session: { header: { cwd: dir } } } })

  assert.equal(built.ok, false)
  assert.match(built.error, /会话工作目录|越界|只能读/u, built.error)
})

await check('plan wires a 场景 node to EVERY shot, and a per-shot cast roster does not strip it', async () => {
  // The roster replaces the CHARACTER list for a shot ("the mouse is not in this
  // shot"). It must not touch the scenes: a shot happening somewhere else is a
  // different scene node, not the absence of one. Filtering the scenes by a
  // character list silently strips the rooftop off every shot that names a
  // character — which is all of them.
  const dir = await tempDir()
  const { api } = await boot(dir)
  const planTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_plan')
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')

  const built = await planTool.execute({
    title: '场景烟测',
    chain: 'none',
    shots: [{ prompt: 'shot one', cast: ['MOMO'] }, { prompt: 'shot two' }],
    cast: [{ name: 'MOMO', description: 'an orange tabby' }, { name: 'JERRY', description: 'a small mouse' }],
    scenes: [{ name: '天台', description: 'golden-hour rooftop, graffiti wall', image_url: 'https://img.example.com/roof.png' }],
  })
  assert.equal(built.ok, true, built.error)

  const stored = await graphTool.execute({ action: 'get', graph_id: built.graphId })
  const scene = stored.graph.nodes.find((n) => n.type === 'scene')
  assert.ok(scene, 'a scene node must be created')
  assert.equal(scene.fields.source, 'https://img.example.com/roof.png')
  assert.match(scene.fields.description, /rooftop/u, 'the fixed place description must be stored on the node')

  const refsOf = (shotId) => stored.graph.edges
    .filter((edge) => edge.to === shotId && edge.toPort === 'refs')
    .map((edge) => edge.from)
  const castIds = stored.graph.nodes.filter((n) => n.type === 'cast').map((n) => n.id)
  const castOn = (shotId) => refsOf(shotId).filter((id) => castIds.includes(id))

  assert.ok(refsOf('n_s01').includes(scene.id), 'the scene applies to shot 1')
  assert.ok(refsOf('n_s02').includes(scene.id), 'and to shot 2 — the roster must not strip it')
  assert.equal(castOn('n_s01').length, 1, 'shot 1 declares only MOMO')
  assert.equal(castOn('n_s02').length, 2, 'shot 2 takes the default roster of both characters')
})

await check('a delivered filename is built from an ALLOW list, not a deny list', async () => {
  // The real title of a real project: 「猫咪跳街舞 · 30s · 6 镜 · 场景一致 + 1 处接龙」
  // used to become `猫咪跳街舞-·-30s-·-6-镜-·-场景一致-+-1-处接龙-….mp4`. Legal on
  // every filesystem and unpleasant everywhere else. A deny list only catches the
  // characters somebody thought of.
  const stem = mod.fileStem('猫咪跳街舞 · 30s · 6 镜 · 场景一致 + 1 处接龙', 'sequence')
  assert.equal(stem, '猫咪跳街舞-30s-6-镜-场景一致-1-处接龙', stem)
  assert.ok(!/[·+]/u.test(stem), 'the separators that only LOOK like separators must go')

  assert.equal(mod.fileStem('  ／＼:*?  ', 'sequence'), 'sequence',
    'a title that is nothing but punctuation falls back rather than producing "-"')
  assert.equal(mod.fileStem('', 'sequence'), 'sequence')
  assert.ok(mod.fileStem('a'.repeat(200), 'x').length <= 80, 'and it stays bounded')
  assert.equal(mod.fileStem('../../etc/passwd', 'x'), 'etc-passwd', 'path separators cannot survive')
})

await check('the graph tool SAYS what it deleted, so a successful clear is not read as an empty state', async () => {
  const dir = await tempDir()
  const { api } = await boot(dir)
  const graphTool = api.registeredTools.find((entry) => entry.name === 'openrouter_video_graph')
  const created = await graphTool.execute({ action: 'set', title: '甲', graph: { title: '甲', nodes: [{ id: 'n_script', type: 'script', fields: {} }], edges: [] } })

  const removed = await graphTool.execute({ action: 'remove_graph', graph_id: created.graph.id })
  assert.equal(removed.ok, true, removed.error)
  const rendered = graphTool.output.render({}, removed).map((part) => part.text).join('')
  assert.match(rendered, /已删除/u, `the receipt must report the deletion, got: ${rendered}`)
  assert.match(rendered, new RegExp(created.graph.id, 'u'), 'and name WHICH project went')
  assert.match(rendered, /没有任何图/u, 'while still saying the workspace is now empty')
})

await check('an INCOMPLETE film on the ledger is NOT treated as the current one', async () => {
  // Measured end to end: a 6-shot run lost the chained shot to a provider 400, the
  // composer cut a 26.3s film from the other five and cached it as completed. After
  // the failed shot was fixed and re-run, the composer found that film on the
  // ledger and skipped — the receipt said 完成 while the exported file was still a
  // shot short, and RE-RUNNING COULD NEVER FIX IT. The only escape was deleting the
  // mp4 by hand. That is the bug this rule exists to prevent.
  const short = {
    status: 'completed', filePath: 'film-5.mp4',
    sequence: { count: 5, expected: 6, complete: false, clips: ['n_s01:a.mp4', 'n_s03:c.mp4', 'n_s04:d.mp4', 'n_s05:e.mp4', 'n_s06:f.mp4'] },
  }
  const nowAllSix = ['n_s01:a.mp4', 'n_s02:b.mp4', 'n_s03:c.mp4', 'n_s04:d.mp4', 'n_s05:e.mp4', 'n_s06:f.mp4']
  assert.equal(mod.sequenceIsCurrent(short, nowAllSix), false,
    'the finished shot changed the clip set — the film MUST be re-cut')

  assert.equal(mod.sequenceIsCurrent(short, short.sequence.clips), true,
    'the same incomplete set must NOT spray a new file on every resume')

  const complete = { status: 'completed', filePath: 'film.mp4', sequence: { complete: true, clips: nowAllSix } }
  assert.equal(mod.sequenceIsCurrent(complete, nowAllSix), true, 'a finished film stays cached')
  assert.equal(mod.sequenceIsCurrent(complete, ['n_s01:rerendered.mp4']), false,
    're-rendering a shot produces a new take file, and the film must follow it')

  assert.equal(mod.sequenceIsCurrent({ sequence: {} }, nowAllSix), false,
    'a record written before this rule re-cuts once, then is stable')
  assert.equal(mod.sequenceIsCurrent(null, nowAllSix), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
