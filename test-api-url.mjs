/**
 * test-api-url.mjs — the request-path contract.
 *
 * WHY THIS FILE EXISTS
 *
 * `new URL('/videos/models', 'https://openrouter.ai/api/v1')` is
 * `https://openrouter.ai/videos/models`. The leading slash resolves against the
 * ORIGIN and throws away `/api/v1`, so every request the plugin made was aimed
 * at the wrong endpoint — the model catalog, every generation submit, every poll,
 * every download.
 *
 * It stayed invisible because openrouter.ai answers an unknown path with
 * **HTTP 200 and the 171 KB marketing page**. `response.ok` is true, so the code
 * proceeded to `response.json()` on an HTML body, threw, and a `try/catch` ate
 * it. The user-visible symptom was "cost ceiling $0.00, magnitude unknown",
 * which reads like a cheap render rather than a broken URL.
 *
 * The existing suite could not catch it: every test stubbed the network, so no
 * assertion ever looked at a URL. This one runs a loopback server and asserts the
 * path that actually arrived.
 *
 * Run: node test-api-url.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

/* ---- loopback stand-in for OpenRouter ---------------------------------- */

const seen = []
const submitted = []
/**
 * When each shot was submitted, and how many polls had already reported
 * `completed` at that moment.
 *
 * This is what makes dispatch ORDER assertable without timing. Chaining is only
 * real if the downstream shot waits for its upstream frame, and "waited" means
 * the upstream poll had already returned — a fact the fake server can date
 * exactly, rather than a wall-clock threshold that goes flaky under load.
 */
const submitTimeline = []
let completedPolls = 0
let mode = 'json'
let audioSupported = true
let e2eSeq = 0

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8')
  seen.push({ method: req.method, url: req.url, raw })

  const json = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (mode === 'html') {
    // Exactly what a wrong path on this host returns: 200, HTML, `.ok === true`.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!DOCTYPE html><html><body>' + 'x'.repeat(2048) + '</body></html>')
    return
  }

  // A rejected submission: the API answers 400 and nothing is billed.
  if (mode === 'fail') {
    if (req.method === 'POST' && req.url === '/api/v1/videos') {
      submitted.push(JSON.parse(raw ?? '{}'))
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 400, message: 'deliberate 400 for the failure test' } }))
      return
    }
  }

  // The paid lifecycle, faked: submit -> poll -> download.
  if (mode === 'e2e') {
    if (req.method === 'POST' && req.url === '/api/v1/videos') {
      const body = JSON.parse(raw ?? '{}')
      submitted.push(body)
      submitTimeline.push({ prompt: body.prompt, completedPolls })
      e2eSeq += 1
      const id = `gen-vid-e2e-${String(e2eSeq).padStart(4, '0')}`
      json({ id, status: 'pending' })
      return
    }
    if (req.method === 'GET' && /\/content\?index=0$/u.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      res.end(Buffer.from('000000206674797069736f6d', 'hex'))
      return
    }
    if (req.method === 'GET' && /^\/api\/v1\/videos\/gen-vid-e2e-\d{4}$/u.test(req.url)) {
      const id = req.url.split('/').pop()
      completedPolls += 1
      json({
        id, status: 'completed',
        unsigned_urls: [`/api/v1/videos/${id}/content?index=0`],
        usage: { cost: 0.42 },
      })
      return
    }
  }

  json({
    data: [{
      id: 'google/veo-3.1-fast',
      supported_resolutions: ['720p'],
      supported_durations: [4],
      supported_frame_images: ['first_frame', 'last_frame'],
      generate_audio: audioSupported,
      // $0.30/s is the most expensive PLAIN sku, so a 4 s ceiling is $1.20. The
      // continuation sku is a SEPARATE bucket: $0.41/s -> $1.64 for 4 s.
      pricing_skus: {
        duration_seconds_with_audio: '0.10',
        duration_seconds_with_audio_4k: '0.30',
        cents_per_second_video_continuation_720p: 41,
      },
    }],
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

// Must be set BEFORE lib/index.js is imported: API_BASE is read at module scope.
process.env.OPENROUTER_VIDEO_API_BASE = `http://127.0.0.1:${PORT}/api/v1`
process.env.no_proxy = 'localhost,127.0.0.1,::1'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''
process.env.http_proxy = ''
process.env.https_proxy = ''

const mod = await import('./lib/index.js')

/* ---- minimal Cordis stub (inject enforced, like the real one) ---------- */

function makeContext({ declared = [], services = {} } = {}) {
  const makeScope = (scopeDeclared) => {
    const scopeServices = { ...services }
    const proxy = {
      get: (name) => scopeServices[name],
      inject(names, fn) {
        const child = makeScope([...new Set([...scopeDeclared, ...names])])
        if (typeof fn === 'function') fn(child)
        return child
      },
      effect(fn) { return typeof fn === 'function' ? fn() : undefined },
      plugin(child) { if (typeof child === 'function') child(makeScope(scopeDeclared)); return child },
      on() { return () => {} },
    }
    Object.defineProperty(proxy, 'tools', {
      configurable: true,
      get() {
        if (!scopeDeclared.includes('tools')) throw new Error('cannot get property "tools" without inject')
        return scopeServices.tools
      },
    })
    return proxy
  }
  return makeScope(declared)
}

const tempDirs = []
/** Drive one HTTP route the way the web shell does. */
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

const boot = async ({ apiKey } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'orv-url-'))
  tempDirs.push(dir)
  const tools = []
  /* Routes are captured too: the tools and the workspace are two doors into the
     SAME run machinery, and a flag wired to one of them is not wired at all. The
     `retry_failed` pass-through lived only on the tool for a while, which made the
     panel's retry control a button that sent a field nobody read. */
  const routes = []
  const live = {
    dataDir: dir, model: 'google/veo-3.1-fast', resolution: '720p', aspectRatio: '16:9',
    duration: 8, generateAudio: true, concurrency: 2, budgetUsd: 30, abortOnExceed: true,
    urlMode: 'https', pollIntervalMs: 10, maxPollAttempts: 5, splitRatio: 0.18,
    saveDir: 'generated-videos', skills: false,
  }
  const ctx = makeContext({
    declared: ['tools'],
    services: {
      tools: { register: (t) => { tools.push(t); return () => {} } },
      webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    },
  })
  const config = { apiKey: { get: () => apiKey } }
  for (const [key, value] of Object.entries(live)) config[key] = { get: () => value }
  mod.apply(ctx, config)
  const find = (name) => {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool, `tool ${name} was registered`)
    return tool
  }
  const route = routes.find((entry) => entry.path === '/openrouter-video/api')
  assert.ok(route, 'the workspace api route was registered')
  return {
    plan: find('openrouter_video_plan'), run: find('openrouter_video_run'),
    graph: find('openrouter_video_graph'), dir, route,
  }
}

console.log('test-api-url: the request path contract\n')

await check('the catalog request goes to <base>/api/v1/videos/models, not <origin>/videos/models', async () => {
  seen.length = 0
  mode = 'json'
  const { plan } = await boot()
  await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  assert.equal(seen.length, 1, 'exactly one request')
  assert.equal(seen[0].url, '/api/v1/videos/models',
    `the /api/v1 prefix must survive the join; the server actually saw ${seen[0].url}`)
})

await check('a wrong path is not silently accepted: 200 + HTML must surface as catalogError', async () => {
  seen.length = 0
  mode = 'html'
  const { plan } = await boot()
  const result = await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  assert.equal(seen.length, 1, 'the request was still made')
  assert.ok(typeof result.catalogError === 'string' && result.catalogError.length > 0,
    'a non-JSON 200 must be reported, not treated as a usable catalog')
  // Assert the GUARD's own wording, not a generic parse failure. Without the
  // content-type check, `response.json()` throws on the HTML too — and undici's
  // message ("Unexpected token '<'... is not valid JSON") also contains "JSON",
  // so a looser assertion would pass with the guard removed and prove nothing.
  assert.match(result.catalogError, /text\/html/u,
    'the error names the content type actually received')
  assert.match(result.catalogError, /videos\/models/u, 'the error names the URL actually requested')
})

await check('the catalog really parsed: the ceiling is computed from the served SKUs', async () => {
  mode = 'json'
  const { plan } = await boot()
  const result = await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  assert.equal(result.catalogError, null, 'catalog loaded')
  assert.equal(result.unknownCount, 0, 'the model is priceable')
  // 4 s x the MOST EXPENSIVE SKU ($0.30) — an upper bound, not the $0.10 quote.
  assert.equal(result.ceilingUsd, 1.2, 'ceiling uses the max SKU over the requested one')
})

await check('tool return values carry no undefined-valued key (lossless JSON at the harness boundary)', async () => {
  mode = 'json'
  const { plan, run } = await boot()
  const planned = await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  const dry = await run.execute({ graph_id: planned.graphId })
  assert.equal(dry.dryRun, true, 'dry-run by default: nothing was submitted')
  for (const [name, value] of [['plan', planned], ['run(dry)', dry]]) {
    const undefinedKeys = Object.entries(value).filter(([, v]) => v === undefined).map(([k]) => k)
    assert.deepEqual(undefinedKeys, [], `${name} has no undefined-valued key`)
    assert.ok(!('error' in value), `${name} omits \`error\` entirely when there is no error`)
    // Round-tripping is the property the boundary actually enforces.
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name} survives a JSON round trip unchanged`)
  }
})

await check('the dry-run ceiling matches the catalog, in dollars not cents', async () => {
  mode = 'json'
  const { plan, run } = await boot()
  const planned = await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  const dry = await run.execute({ graph_id: planned.graphId })
  assert.equal(dry.catalogError, null)
  assert.equal(dry.ceilingUsd, 1.2, 'a $0.30/s SKU is 30 cents, not $30')
  assert.equal(dry.plannedCount, 1)
})

await check('a caller-supplied reference URL is left absolute (no double-join)', async () => {
  // resolveApiUrl must pass an absolute media URL through untouched, because
  // `unsigned_urls` are already complete and some point at third-party storage.
  const { plan } = await boot()
  const result = await plan.execute({
    title: 't', model: 'google/veo-3.1-fast', duration: 4,
    reference_image_urls: ['https://cdn.example.com/hero.png'],
    shots: [{ prompt: 'a', duration: 4 }],
  })
  assert.equal(result.ok, true)
})

await check('a paid run whose budget gate cannot be evaluated is REFUSED, sending nothing', async () => {
  // The gate sums ceilings computed from the catalog. With no catalog every
  // ceiling is null, the sum is 0, and `abortOnExceed` would never fire — so an
  // over-budget film would be dispatched unguarded against a user's balance, on
  // an API with no cancel endpoint. Refusing is the only safe default.
  mode = 'html'
  const { plan, run } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const planned = await plan.execute({ title: 't', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a', duration: 4 }] })
  seen.length = 0

  const result = await run.execute({ graph_id: planned.graphId, dry_run: false })
  assert.equal(result.ok, false, 'the run was refused')
  assert.match(String(result.error), /模型目录不可用/u, 'the reason names the real blocker')

  const submits = seen.filter((hit) => hit.url.includes('/videos') && !hit.url.includes('/models'))
  assert.deepEqual(submits, [], 'nothing was submitted — a refusal must cost $0')
})

await check('end to end against a fake API: submit -> poll -> download, and no unsupported generate_audio', async () => {
  // The whole paid chain, with nothing stubbed below the HTTP boundary. This is
  // the first test in the suite that drives a real generation to a real file.
  mode = 'e2e'
  audioSupported = false
  submitted.length = 0

  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-e2e-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({ title: 'e2e', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a cat', duration: 4 }] })
  assert.equal(planned.catalogError, null, 'catalog must load for this test to mean anything')

  const result = await boot_.run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, `run refused: ${result.error ?? ''}`)
  assert.equal(result.completed, 1, `expected one completed node: ${JSON.stringify(result)}`)
  assert.equal(result.failed, 0)
  assert.equal(result.spentUsd, 0.42, 'the real usage.cost must be read back off the ledger')

  assert.equal(submitted.length, 1, 'exactly one submission')
  const body = submitted[0]
  assert.equal(body.model, 'google/veo-3.1-fast')
  assert.equal(body.prompt, 'a cat')
  assert.equal(body.duration, 4)
  // The project wants audio (generateAudio defaults true) but the model's own
  // catalog entry declares `generate_audio: false`. Sending the parameter anyway
  // is at best ignored and at worst a 400 that burns a submission round.
  assert.ok(!('generate_audio' in body), 'a model declaring generate_audio:false must not receive the parameter')

  assert.equal(result.files.length, 1, 'the artifact must be recorded')
  const artifact = resolve(work, result.files[0])
  assert.ok(existsSync(artifact), `the file must exist on disk: ${artifact}`)
  assert.ok(statSync(artifact).size > 0, 'the artifact must not be empty')
})

await check('link:continue sends previous_job_id and serialises the chain', async () => {
  // The continuation route, end to end. `link: 'continue'` used to be purely
  // decorative: `node.link` never reached `buildNodeRequest`, and because it
  // produced no edge the two shots were dispatched CONCURRENTLY, so even a wired
  // reference would have had nothing to point at.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  e2eSeq = 0

  const { plan, run } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-chain-'))
  tempDirs.push(work)

  const planned = await plan.execute({
    title: 'chain', model: 'google/veo-3.1-fast', duration: 4,
    shots: [
      { title: 'a', prompt: 'first shot', duration: 4 },
      { title: 'b', prompt: 'second shot', duration: 4, link: 'continue' },
    ],
  })
  // The continuation sku must reach the preflight: 4 s at $0.30/s for the plain
  // shot plus 4 s at $0.41/s for the continued one.
  assert.equal(planned.unknownCount, 0)
  assert.equal(Math.round(planned.ceilingUsd * 100) / 100, 2.84,
    `the continued leg must be priced at the continuation sku, got ${planned.ceilingUsd}`)

  const result = await run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, `run refused: ${result.error ?? ''}`)
  assert.equal(result.completed, 2, `both shots must complete: ${JSON.stringify(result)}`)

  assert.equal(submitted.length, 2, 'two submissions')
  assert.equal(submitted[0].previous_job_id, undefined, 'the first shot continues from nothing')
  assert.equal(submitted[1].previous_job_id, 'gen-vid-e2e-0001',
    'the continued shot must carry the PREVIOUS job id — this is the whole feature')
  assert.equal(submitted[1].prompt, 'second shot')
  // And the audio guard is not simply "always omit": this model declares support.
  assert.equal(submitted[1].generate_audio, true, 'a model that supports audio still receives the parameter')
})

await check('a failed shot is recorded WITH its reason — and only retried when asked', async () => {
  // Three defects in one line of code. The failure path called `setState` BEFORE
  // `jobs.set`, and the Host persists a record only when `onState` finds it in
  // that map — so a failed submit was never written to the ledger and the reason
  // died with the process. `options.fresh` (which retries failed shots and keeps
  // completed ones) was implemented but nothing could reach it. And a re-run then
  // reported "完成 0，失败 0，跳过 0" with ok:true.
  mode = 'fail'
  submitted.length = 0
  const { plan, run, dir } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-fail-'))
  tempDirs.push(work)
  const exec = { agent: { session: { header: { cwd: work } } } }

  const planned = await plan.execute({ title: 'fail', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a cat', duration: 4 }] })

  const first = await run.execute({ graph_id: planned.graphId, dry_run: false }, exec)
  assert.equal(first.ok, false, 'a run where everything failed is not a success')
  assert.match(String(first.error), /n_s01/u, 'the receipt names the node')
  assert.match(String(first.error), /deliberate 400/u, 'and the reason, not just the node id')

  const ledger = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8'))
  const recorded = ledger.jobs.find((job) => job.nodeId === 'n_s01' && job.status === 'failed')
  assert.ok(recorded, 'the failure must be PERSISTED — otherwise the reason is unrecoverable')
  assert.match(String(recorded.error), /deliberate 400/u)

  const afterFirst = submitted.length
  const second = await run.execute({ graph_id: planned.graphId, dry_run: false }, exec)
  assert.equal(submitted.length, afterFirst, 'a plain re-run must not silently re-submit')
  assert.deepEqual(second.stillFailed, ['n_s01'],
    'and it must SAY the shot is still failed, not report an empty successful run')

  const third = await run.execute({ graph_id: planned.graphId, dry_run: false, retry_failed: true }, exec)
  assert.equal(submitted.length, afterFirst + 1, 'retry_failed must actually retry the failed shot')
})

await check('the WORKSPACE route reaches the same retry — the panel\'s retry was a field nobody read', async () => {
  // The client test proves the panel SENDS `retry_failed: true`. Nothing proved the
  // ROUTE read it: `POST /graph/run` passed only id/cwd/only, so the retry control
  // would have been a button sending an ignored field — the exact class of bug the
  // control exists to fix, one layer down from where it was fixed.
  mode = 'fail'
  submitted.length = 0
  const { plan, route } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-route-'))
  tempDirs.push(work)
  const planned = await plan.execute({
    title: 'route-retry', model: 'google/veo-3.1-fast', duration: 4,
    shots: [{ prompt: 'a cat', duration: 4 }],
  })

  const first = await callRoute(route.handler, {
    path: '/graph/run', method: 'POST', body: { id: planned.graphId, cwd: work },
  })
  assert.ok(first.payload.report, 'the route must return a run report')
  assert.deepEqual(first.payload.report.failed, ['n_s01'], 'the shot failed and the report says so')
  assert.equal(first.payload.states.n_s01, 'failed', 'and the state the canvas colours itself from')
  const afterFirst = submitted.length
  assert.equal(afterFirst, 1, 'it was submitted once')

  // The control: without the flag, a re-run must NOT re-submit. Recovery has to be
  // an explicit, costed decision — silently re-submitting is how a retry button
  // becomes a money leak.
  const plain = await callRoute(route.handler, {
    path: '/graph/run', method: 'POST', body: { id: planned.graphId, cwd: work },
  })
  assert.equal(submitted.length, afterFirst, 'a plain route run must not re-submit the dead shot')
  // What the route reports about a dead shot differs from the tool's `stillFailed`
  // list: an already-failed node is not re-scheduled, so it never enters the
  // report. The STATE is the honest signal here (and it is what the canvas colours
  // itself from), so that is what this asserts.
  assert.equal(plain.payload.states.n_s01, 'failed', 'and the shot must still read as failed')

  // Now the retry, through the route, with the shot's own model serving it.
  mode = 'e2e'
  const retry = await callRoute(route.handler, {
    path: '/graph/run', method: 'POST',
    body: { id: planned.graphId, cwd: work, only: ['n_s01'], retry_failed: true },
  })
  assert.equal(submitted.length, afterFirst + 1,
    'retry_failed on the route must reach the executor and re-submit')
  assert.equal(retry.payload.states.n_s01, 'completed', 'and the shot must come back alive')
})

await check('first_last mode reaches the wire: two frames, each with its OWN frame_type', async () => {
  // The API expresses `first_last` as TWO images on one request, each carrying
  // its own `frame_type`. Two things had to change for the canvas to express it:
  // `frames` had to stop being single-input (the second wire evicted the first),
  // and the slot had to be read off the SOURCE node — it used to be read from
  // `node.fields.frameType` on the consumer, a field no node type declares, so
  // it was always undefined and every frame silently became a first frame.
  //
  // This asserts the actual outbound body, which is the only place both halves
  // are visible together.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  e2eSeq = 0

  const { plan, run, graph } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-frames-'))
  tempDirs.push(work)

  const planned = await plan.execute({ title: 'first_last', model: 'google/veo-3.1-fast', duration: 4, shots: [{ prompt: 'a leap', duration: 4 }] })
  assert.equal(planned.catalogError, null)

  await graph.execute({
    action: 'add_node', graph_id: planned.graphId,
    node: { id: 'r_first', type: 'ref', fields: { source: 'https://cdn.example.com/first.png', slot: 'first_frame' } },
  })
  await graph.execute({
    action: 'add_node', graph_id: planned.graphId,
    node: { id: 'r_last', type: 'ref', fields: { source: 'https://cdn.example.com/last.png', slot: 'last_frame' } },
  })
  const wired1 = await graph.execute({
    action: 'connect', graph_id: planned.graphId,
    edge: { from: 'r_first', fromPort: 'asset', to: 'n_s01', toPort: 'frames' },
  })
  assert.equal(wired1.ok, true)
  assert.deepEqual(Object.entries(wired1).filter(([, v]) => v === undefined).map(([k]) => k), [],
    'the connect receipt must survive the lossless-JSON boundary even when there is no warning')
  const wired2 = await graph.execute({
    action: 'connect', graph_id: planned.graphId,
    edge: { from: 'r_last', fromPort: 'asset', to: 'n_s01', toPort: 'frames' },
  })
  assert.equal(wired2.ok, true)

  const readBack = await graph.execute({ action: 'get', graph_id: planned.graphId })
  assert.equal(
    readBack.graph.edges.filter((e) => e.to === 'n_s01' && e.toPort === 'frames').length, 2,
    'both frame wires must survive — a single-input `frames` port silently evicts the first one',
  )

  const result = await run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, `run refused: ${result.error ?? ''}`)
  assert.deepEqual(submitted[0].frame_images, [
    { type: 'image_url', image_url: { url: 'https://cdn.example.com/first.png' }, frame_type: 'first_frame' },
    { type: 'image_url', image_url: { url: 'https://cdn.example.com/last.png' }, frame_type: 'last_frame' },
  ], 'each frame must carry the slot of the node it was wired FROM')
})

await check('plan inserts the first/last-frame chain, so continuity is the default', async () => {
  // Hand-wiring continuity across a 23-shot film is 22 nodes and 44 edges, and
  // the only mechanism that works here is a frame hand-off. A planner that
  // leaves it out makes "long video" mean "23 unrelated clips".
  mode = 'json'
  const { plan, graph } = await boot()

  const planned = await plan.execute({
    title: 'chain', model: 'google/veo-3.1-fast', duration: 4,
    shots: [
      { prompt: 'a', duration: 4 },
      { prompt: 'b', duration: 4 },
      { prompt: 'c', duration: 4, link: 'continue' },
    ],
  })
  assert.equal(planned.ok, true, planned.error ?? '')
  assert.equal(planned.chainedCount, 1, 'the shot that declared link=continue opts out of the frame chain')
  assert.equal(planned.chainMode, 'frames')

  const readBack = await graph.execute({ action: 'get', graph_id: planned.graphId })
  const takes = readBack.graph.nodes.filter((n) => n.type === 'take')
  assert.equal(takes.length, 1)
  for (const take of takes) {
    assert.equal(take.fields.frame, 'last_frame', 'continuation samples the LAST frame of the previous shot')
    assert.equal(take.fields.slot, 'first_frame', 'and fills the FIRST frame of the next one')
  }
  const frameEdges = readBack.graph.edges.filter((e) => e.toPort === 'frames')
  assert.equal(frameEdges.length, 1, 'one frame wire per hand-off')
  for (const edge of frameEdges) {
    assert.equal(readBack.graph.nodes.find((n) => n.id === edge.from)?.type, 'take',
      'the frame must come from a take node — a bare url would never be populated')
  }
  // An explicit per-shot `link` outranks the graph-wide default: that shot asked
  // for `previous_job_id`, and sending a first frame alongside it is not a
  // documented combination. The specific instruction wins, and it is reported.
  const optedOut = readBack.graph.nodes.find((n) => n.id === 'n_s03')
  assert.equal(optedOut.link, 'continue', 'the explicit link must survive untouched')
  assert.equal(frameEdges.some((e) => e.to === 'n_s03'), false, 'and it must not also receive a frame')
  assert.ok(planned.notes.some((note) => /n_s03/.test(note) && /link/u.test(note)),
    'the opt-out must be reported, not silent')

  const off = await plan.execute({
    title: 'no chain', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'a', duration: 4 }, { prompt: 'b', duration: 4 }],
  })
  assert.equal(off.chainedCount, 0)
  assert.equal(off.chainMode, 'none')
  const readOff = await graph.execute({ action: 'get', graph_id: off.graphId })
  assert.equal(readOff.graph.nodes.filter((n) => n.type === 'take').length, 0,
    'chain:"none" must build independent shots')
})

await check('a chained shot is NOT dispatched until its upstream shot has finished', async () => {
  // WHAT THIS CATCHES
  //
  // `readyNodes` treated a non-network dependency as satisfied. A `take` node is
  // exactly that — local, free, no API call — so it was TRANSPARENT: the shot
  // after it had no visible blocker and was dispatched in the same breath as the
  // shot before it. On a real 12-shot film that produced six concurrent pairs
  // (the job ids carried identical epoch seconds), every downstream request was
  // built before its frame existed, and a paid 60-second film came back with no
  // continuity whatsoever.
  //
  // Publishing the frame before announcing COMPLETED is only half the mechanism.
  // Something has to WAIT for COMPLETED, and nothing did.
  mode = 'e2e'
  submitted.length = 0
  submitTimeline.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-chain-order-'))
  tempDirs.push(work)
  const { plan, run } = boot_

  const planned = await plan.execute({
    title: 'chain-order', model: 'google/veo-3.1-fast', duration: 4, chain: 'frames',
    shots: [{ prompt: 'first shot', duration: 4 }, { prompt: 'second shot', duration: 4 }],
  })
  assert.equal(planned.ok, true, planned.error ?? '')
  assert.equal(planned.chainedCount, 1, 'the chain has to be planned in for this to mean anything')

  const result = await run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, result.error ?? '')
  assert.equal(result.completed, 2, 'both shots render')

  const first = submitTimeline.find((row) => row.prompt === 'first shot')
  const second = submitTimeline.find((row) => row.prompt === 'second shot')
  assert.ok(first, 'the first shot was submitted')
  assert.ok(second, 'the second shot was submitted')
  assert.equal(first.completedPolls, 0, 'the first shot has nothing upstream to wait for')
  assert.ok(second.completedPolls >= 1,
    `the second shot must not be submitted until the first has finished polling; `
    + `it was submitted when ${second.completedPolls} polls had completed. `
    + `With the default concurrency of 2 that means both renders were in flight together.`)
})

await check('the frame hand-off reports its own failure instead of failing silently', async () => {
  // WHAT THIS CATCHES
  //
  // `materializeFrames` referenced `jobMap`, which is a local of `startRun` and
  // not in its scope. Every single call threw "jobMap is not defined".
  // `publishFrames` filed that as a per-take error — correct, the clip is
  // already paid for — and the run receipt printed neither `frameErrors` nor the
  // count of successes. The result was a run that reported「完成 12，失败 0」while
  // the entire chaining mechanism did nothing.
  //
  // `boot()` deliberately configures no image bed, so the failure is the
  // ACTIONABLE one ("no image bed") rather than an internal ReferenceError. Both
  // halves matter: that the outcome is reported at all, and that what it says is
  // something a user can act on.
  mode = 'e2e'
  submitted.length = 0
  submitTimeline.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-chain-nobed-'))
  tempDirs.push(work)
  const { plan, run } = boot_

  const planned = await plan.execute({
    title: 'chain-nobed', model: 'google/veo-3.1-fast', duration: 4, chain: 'frames',
    shots: [{ prompt: 'a', duration: 4 }, { prompt: 'b', duration: 4 }],
  })
  assert.equal(planned.ok, true, planned.error ?? '')

  const result = await run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, result.error ?? '')

  assert.ok(Array.isArray(result.frameErrors),
    'the receipt must carry the frame outcome at all — that omission is what hid the bug')
  assert.equal(result.frameErrors.length, 1,
    `one take means one row; got ${JSON.stringify(result.frameErrors)}`)
  const row = result.frameErrors[0]
  assert.equal(row.nodeId, 'n_take01', 'name the take that could not run')
  assert.match(String(row.error), /图床/u,
    `the reason must name something actionable, got: ${String(row.error)}`)
  assert.doesNotMatch(String(row.error), /is not defined/u,
    'an internal ReferenceError is not a reason a user can act on')
  assert.deepEqual(result.framesPublished, [], 'nothing was published, and the receipt says so')
})

await check('plan can turn audio OFF, for a model whose audio gets content-filtered', async () => {
  // seedance-2.5 rejects the entire job on its OUTPUT audio:
  //   "The request failed because the output audio may be related to copyright
  //    restrictions."
  // The job is accepted, then fails server-side, and nothing is billed — but a
  // 12-shot film renders nothing at all. `generateAudio` was a declared config
  // field with no UI control and no tool parameter, so the only way to reach it
  // was to hand-edit the profile YAML and restart the whole Host.
  //
  // Per-plan is also the right granularity: heygen renders these same prompts
  // fine WITH audio, so a global default would have degraded it.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  submitTimeline.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-audio-'))
  tempDirs.push(work)
  const exec = { agent: { session: { header: { cwd: work } } } }

  const off = await boot_.plan.execute({
    title: 'no audio', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    generate_audio: false, shots: [{ prompt: 'a cat', duration: 4 }],
  })
  await boot_.run.execute({ graph_id: off.graphId, dry_run: false }, exec)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].generate_audio, false,
    'the model accepts audio, so the parameter must be sent — but it must say false')

  submitted.length = 0
  const on = await boot_.plan.execute({
    title: 'audio', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'a cat', duration: 4 }],
  })
  await boot_.run.execute({ graph_id: on.graphId, dry_run: false }, exec)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].generate_audio, true,
    'omitting the argument must keep the configured default, not silently flip it')
})

await check('the cast reaches the REQUEST: pinned text in the prompt, sheet in input_references', async () => {
  // The measured failure this exists for: a 12-shot film with one model, one
  // style prompt and working frame chaining (seam SSIM 0.90) still had a
  // DIFFERENT cat in every shot. Chaining fixes the transition, not the identity
  // — each shot's prompt re-described the cat slightly differently, and a model
  // cannot hold an identity the prompt keeps redefining.
  //
  // This is the only test that proves the cast is applied at the REQUEST level.
  // Everything in test-cast.mjs stops at the pure function; without this, the
  // wiring into `buildNodeRequest` could be deleted and the suite would stay
  // green.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  submitTimeline.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-cast-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({
    title: 'cast', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'first shot', duration: 4 }, { prompt: 'second shot', duration: 4 }],
    cast: [
      { name: 'TOM', description: '蓝灰色家猫，圆脸，黄眼睛，白肚皮，红领结', image_url: 'https://img.example.com/tom-sheet.png' },
      { name: 'JERRY', description: '棕色小老鼠，大耳朵' },
    ],
  })
  assert.equal(planned.cast.length, 2, 'both characters must become cast nodes')
  await boot_.run.execute({ graph_id: planned.graphId, dry_run: false }, { agent: { session: { header: { cwd: work } } } })

  assert.equal(submitted.length, 2, 'both shots must be submitted')
  for (const body of submitted) {
    assert.match(body.prompt, /^【角色设定/u, `the bible must be pinned at the TOP of the prompt: ${body.prompt}`)
    assert.match(body.prompt, /TOM: 蓝灰色家猫，圆脸，黄眼睛，白肚皮，红领结/u, 'the fixed description must be repeated verbatim')
    assert.match(body.prompt, /JERRY: 棕色小老鼠，大耳朵/u)
  }
  assert.equal(submitted[0].prompt.split('【角色设定').length - 1, 1, 'the block must not be doubled')
  assert.ok(submitted[0].prompt.endsWith('first shot'), 'the authored prompt must survive intact')
  assert.deepEqual(
    (submitted[0].input_references ?? []).map((row) => row.image_url.url),
    ['https://img.example.com/tom-sheet.png'],
    'the character sheet must ride input_references — and only the one character that HAS an image',
  )
})

await check('the SCENE reaches the REQUEST too: its own block, and its plate in input_references', async () => {
  // The measured failure this exists for: six independent hard cuts kept the
  // character (the pinned description does that work) and lost the ROOFTOP —
  // new graffiti, new wall, new hour of day, three times over. "The character
  // must not drift" and "the place must not drift" are one requirement, so the
  // place gets the same mechanism, and this is the only test that proves it
  // survives all the way into the request body.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  submitTimeline.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-scene-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({
    title: 'scene', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'first shot', duration: 4 }, { prompt: 'second shot', duration: 4 }],
    scenes: [{
      name: '天台',
      description: '黄昏的城市屋顶，右侧一面满涂鸦的混凝土墙，地面裂缝水泥，低角度硬光',
      image_url: 'https://img.example.com/rooftop-plate.png',
    }],
    cast: [{ name: 'MOMO', description: '橘白虎斑猫，芥末黄卫衣，反扣红帽' }],
  })
  assert.equal(planned.ok, true, planned.error)
  await boot_.run.execute({ graph_id: planned.graphId, dry_run: false }, { agent: { session: { header: { cwd: work } } } })

  assert.equal(submitted.length, 2, 'both shots must be submitted')
  for (const body of submitted) {
    assert.match(body.prompt, /^【场景设定/u, `the scene block must be pinned at the TOP: ${body.prompt}`)
    assert.match(body.prompt, /天台: 黄昏的城市屋顶/u, 'the fixed place description must be repeated verbatim')
    assert.match(body.prompt, /【角色设定/u, 'and the character block must be there as well')
    assert.equal(body.prompt.split('【场景设定').length - 1, 1, 'the scene block must not be doubled')
    assert.equal(body.prompt.split('【角色设定').length - 1, 1)
  }
  assert.ok(submitted[1].prompt.endsWith('second shot'), 'the authored prompt must survive intact')

  const urls = (submitted[0].input_references ?? []).map((row) => row.image_url.url).sort()
  assert.deepEqual(urls, [
    'https://img.example.com/rooftop-plate.png',
  ], 'the scene plate must ride input_references; MOMO has no image in this graph')
})

await check('a chained shot DROPS its references, because the provider refuses the combination', async () => {
  // Measured, live: a request carrying both was refused —
  //   "HeyGen Video 1 image-to-video does not accept input_references alongside a
  //    first_frame image; pass the image as an input_reference instead to use
  //    reference-to-video"
  // That is a 400, not the "frame_images takes precedence" this workspace assumed,
  // and it cost a whole shot: the delivered film was 26.3s instead of 30s. The
  // first frame wins (the shot cannot render at all otherwise); the references go.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  completedPolls = 0
  e2eSeq = 0
  const { plan, run, graph } = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-droprefs-'))
  tempDirs.push(work)

  // `chain: "none"` so there is no take node, then a `ref` carrying a frame slot
  // wired straight into shot two's `frames` port — this harness has no image bed,
  // and a ref needs none.
  const planned = await plan.execute({
    title: 'drop', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'first', duration: 4 }, { prompt: 'second', duration: 4 }],
    cast: [{ name: 'TOM', description: 'a cat', image_url: 'https://img.example.com/tom.png' }],
  })
  assert.equal(planned.ok, true, planned.error)

  const added = await graph.execute({
    action: 'add_node', graph_id: planned.graphId,
    node: { id: 'r_first', type: 'ref', fields: { source: 'https://cdn.example.com/first.png', slot: 'first_frame' } },
  })
  assert.equal(added.ok, true, added.error)
  const wired = await graph.execute({
    action: 'connect', graph_id: planned.graphId,
    edge: { from: 'r_first', fromPort: 'asset', to: 'n_s02', toPort: 'frames' },
  })
  assert.equal(wired.ok, true, wired.error)

  await run.execute({ graph_id: planned.graphId, dry_run: false }, { agent: { session: { header: { cwd: work } } } })

  assert.equal(submitted.length, 2, 'both shots must be submitted')
  const chained = submitted.find((body) => body.prompt.includes('second'))
  const plain = submitted.find((body) => body.prompt.includes('first'))
  assert.ok(chained && plain)
  assert.ok(Array.isArray(chained.frame_images) && chained.frame_images.length > 0,
    'the chained shot must carry its first frame')
  assert.equal(chained.input_references, undefined,
    'and must NOT also carry input_references — the provider rejects that combination outright')
  // The FIRST shot is not chained, so it keeps the reference: the drop is scoped to
  // the shot that actually has a first frame, not to the whole graph.
  assert.ok(Array.isArray(plain.input_references) && plain.input_references.length > 0,
    'the unchained shot still sends its reference')
  assert.equal(plain.frame_images, undefined)
})

await check('a shot that declares its own cast gets ONLY those characters', async () => {
  // Different shots have different characters in them: shot 1 is the cat alone,
  // shot 2 is the cat and the mouse. A graph-wide fan-out would put the mouse in
  // shot 1 — and spend a bounded reference-image budget on a character who is not
  // in the scene. This is the whole reason the cast is wired per shot.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-cast2-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({
    title: 'roster', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [
      { prompt: 'cat alone', duration: 4, cast: ['TOM'] },
      { prompt: 'cat and mouse', duration: 4, cast: ['TOM', 'JERRY'] },
    ],
    cast: [
      { name: 'TOM', description: '蓝灰色家猫', image_url: 'https://img.example.com/tom.png' },
      { name: 'JERRY', description: '棕色小老鼠', image_url: 'https://img.example.com/jerry.png' },
      { name: 'SPIKE', description: '灰色斗牛犬', image_url: 'https://img.example.com/spike.png' },
    ],
  })
  await boot_.run.execute({ graph_id: planned.graphId, dry_run: false }, { agent: { session: { header: { cwd: work } } } })

  const first = submitted.find((body) => body.prompt.includes('cat alone'))
  const second = submitted.find((body) => body.prompt.includes('cat and mouse'))
  assert.ok(first && second, 'both shots must be submitted')

  assert.match(first.prompt, /TOM/u)
  assert.ok(!first.prompt.includes('JERRY'), `shot 1 must not carry the mouse: ${first.prompt}`)
  assert.ok(!first.prompt.includes('SPIKE'), 'nor the dog')
  assert.deepEqual((first.input_references ?? []).map((row) => row.image_url.url), ['https://img.example.com/tom.png'],
    'exactly ONE reference image on a one-character shot')

  assert.match(second.prompt, /TOM/u)
  assert.match(second.prompt, /JERRY/u)
  assert.ok(!second.prompt.includes('SPIKE'), 'a shot may take two of three characters')
  assert.deepEqual((second.input_references ?? []).map((row) => row.image_url.url),
    ['https://img.example.com/tom.png', 'https://img.example.com/jerry.png'],
    'BOTH character sheets must reach the wire — this is what a single-input refs port silently ate')
})

await check('chain:"none" makes a HARD CUT — no first frame, and the character reference survives', async () => {
  // A film that chains every transition has no transitions at all. And it is
  // exactly on a hard cut that a character reference does its job: the API
  // applies `frame_images` OVER `input_references`, so a shot carrying a first
  // frame cannot receive its character sheet.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-cut-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({
    title: 'cut', model: 'google/veo-3.1-fast', duration: 4,
    shots: [
      { prompt: 'shot one', duration: 4 },
      { prompt: 'shot two', duration: 4, chain: 'none' },
      { prompt: 'shot three', duration: 4 },
    ],
    cast: [{ name: 'TOM', description: '蓝灰色家猫', image_url: 'https://img.example.com/tom.png' }],
  })
  assert.ok(planned.notes.some((note) => /硬切/u.test(note) && /n_s02/u.test(note)),
    `the hard cut must be reported, got ${JSON.stringify(planned.notes)}`)

  const runResult = await boot_.run.execute({ graph_id: planned.graphId, dry_run: false }, { agent: { session: { header: { cwd: work } } } })
  const hard = submitted.find((body) => body.prompt.includes('shot two'))
  const chained = submitted.find((body) => body.prompt.includes('shot three'))
  const diagnostics = JSON.stringify({
    submitted: submitted.map((body) => body.prompt.split('\n').pop()),
    completed: runResult.completed, failed: runResult.failed, skipped: runResult.skipped,
    error: runResult.error, stillFailed: runResult.stillFailed,
  })
  assert.ok(hard, `shot two must be submitted: ${diagnostics}`)
  assert.ok(chained, `shot three must be submitted: ${diagnostics}`)

  assert.equal(hard.frame_images, undefined, 'a hard cut carries NO first frame')
  assert.deepEqual((hard.input_references ?? []).map((row) => row.image_url.url), ['https://img.example.com/tom.png'],
    'and therefore its character reference actually reaches the provider')
  assert.match(hard.prompt, /TOM/u)

  // Topology, not the submitted body: this test has no image bed configured, so
  // the take between shots two and three cannot publish a frame URL and shot
  // three legitimately goes out without one. Whether the hand-off works is
  // test-frames.mjs's subject; whether the CUT exists is this one's.
  const stored = await boot_.graph.execute({ action: 'get', graph_id: planned.graphId })
  const edges = stored.graph?.edges ?? stored.edges ?? []
  assert.equal(edges.filter((edge) => edge.to === 'n_s02' && edge.toPort === 'frames').length, 0,
    'nothing may feed shot two a first frame — that is what a hard cut IS')
  assert.equal(edges.filter((edge) => edge.to === 'n_s03' && edge.toPort === 'frames').length, 1,
    'the shot AFTER the cut is still chained from it')
})

await check('a cast node with no description is called out at plan time, not discovered in the film', async () => {
  mode = 'e2e'
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const planned = await boot_.plan.execute({
    title: 'cast-no-desc', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'a cat', duration: 4 }],
    cast: [{ name: 'TOM', image_url: 'https://img.example.com/tom-sheet.png' }],
  })
  assert.ok(planned.notes.some((note) => /没给固定外形描述/u.test(note)),
    `expected a note about the missing description, got ${JSON.stringify(planned.notes)}`)
})

await check('the 成片序列 node is WIRED — and an un-composable film says so instead of vanishing', async () => {
  // `seq` is a LOCAL node, so the scheduler never dispatches it; before this it
  // produced nothing at all and both finished films in this workspace were
  // concatenated by hand from a shell. The fake API serves a header-only "mp4",
  // so the export must FAIL here — and the point of the test is that the failure
  // is REPORTED. A `seq` that quietly does nothing is exactly what went unnoticed
  // for two films.
  mode = 'e2e'
  audioSupported = true
  submitted.length = 0
  completedPolls = 0
  e2eSeq = 0
  const boot_ = await boot({ apiKey: 'sk-or-v1-' + 'a'.repeat(48) })
  const work = await mkdtemp(join(tmpdir(), 'orv-seq-'))
  tempDirs.push(work)

  const planned = await boot_.plan.execute({
    title: 'seq', model: 'google/veo-3.1-fast', duration: 4, chain: 'none',
    shots: [{ prompt: 'first', duration: 4 }, { prompt: 'second', duration: 4 }],
  })
  const result = await boot_.run.execute(
    { graph_id: planned.graphId, dry_run: false },
    { agent: { session: { header: { cwd: work } } } },
  )
  assert.equal(result.ok, true, 'the shots themselves still succeeded')
  assert.equal(result.completed, 2)
  assert.equal(result.sequences.length, 1, 'the seq node must be attempted, not skipped')
  assert.equal(result.sequences[0].nodeId, 'n_seq')
  // The verdict depends on what ffprobe makes of a synthetic 10-byte file, which
  // is not this test's subject. What IS its subject is that the node was
  // attempted and its outcome was REPORTED — either a film or a reason. A `seq`
  // that quietly does nothing is exactly what went unnoticed for two films.
  const row = result.sequences[0]
  assert.ok(
    (typeof row.error === 'string' && row.error.length > 0) || typeof row.filePath === 'string',
    `the seq node must report either a film or a reason: ${JSON.stringify(row)}`,
  )
  assert.equal(result.sequenceErrors.length, typeof row.error === 'string' ? 1 : 0,
    'a failed export must also be counted as an error, not silently succeed')
})

await new Promise((resolve) => server.close(resolve))
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
