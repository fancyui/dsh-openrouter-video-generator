/**
 * Graph document — schema, node-type registry, validation.
 *
 * This is the single source of truth the whole plugin reads: the DAG executor,
 * the agent tools, the canvas and the sequence view all go through here. The
 * plan's §3.2 put it plainly — "graph first, canvas second" — because a canvas
 * is a *view* of a document and anyone who builds the view first ends up with a
 * UI that cannot be driven by anything but a mouse.
 *
 * Three invariants this module enforces (plan §3.2):
 *
 *   1. `shotIndex` is the editorial axis and is INDEPENDENT of topology.
 *      Generation order is not film order; collapsing the two into one axis is
 *      the single most common design mistake in tools like this.
 *   2. Execution results never live in the graph document. The graph is intent,
 *      the ledger is fact. Mixing them means every poll rewrites the file the
 *      user is editing.
 *   3. The document is versioned so an old file can be migrated.
 *
 * Node types are DATA, not code. Adding one is a row in NODE_TYPES, and the
 * canvas, executor and inspector all pick it up without being touched. Under
 * the "hand-written React, no bundler" constraint (plan §2) that is what keeps
 * the client half from growing without bound.
 */
import { bibleLibrary, bibleFor, castUsage, BIBLES, BIBLE_TYPES } from './cast.js'

/** Bump when the on-disk shape changes; `migrate` handles the chain. */
export const GRAPH_VERSION = 1

/* ------------------------------------------------------------------ *
 * port type system (plan §3.4)
 * ------------------------------------------------------------------ */

/**
 * What each input port accepts. This table IS the connection rule — the canvas
 * and the agent tools both call `canConnect`, so a wire the mouse is allowed to
 * draw is exactly a wire the tool is allowed to write.
 *
 * `job → video` is allowed because a job's artefact *is* a video; `text →
 * frames` is not, and rejecting it here is what stops the user from composing a
 * request the server would silently reinterpret.
 */
export const PORT_ACCEPTS = {
  brief: ['text', 'shots'],
  frames: ['image[]'],
  refs: ['image[]'],
  video: ['job', 'video'],
  audio: ['audio'],
  job: ['job'],
  jobs: ['job'],
  text: ['text'],
  shots: ['shots'],
}

/**
 * Ports that accept MANY edges. Everything else is one-in, one-out.
 *
 * `frames` is multi-input because the API's `first_last` mode is expressed as
 * TWO frame images on one request. While it took a single edge the canvas could
 * not express it at all: wiring a second source EVICTED the first, so the only
 * reachable chaining mode was "first frame only" and the user had no way to say
 * otherwise. Each edge now carries its own slot (see `frameSlotOf`).
 *
 * `refs` earning a place here is the fix for the SAME bug, one port over — and
 * it is what makes a multi-character shot possible at all. A shot with the cat
 * AND the mouse could only ever carry one of them; `plan` with two
 * `reference_image_urls` built a graph that quietly used one. The API takes an
 * array of `input_references`, so the graph's single-input rule was the only
 * thing standing in the way.
 *
 * A single-input port in a multi-image API is silent data loss, not a
 * simplification. That is worth remembering the next time a port is added.
 */
export const MULTI_INPUT_PORTS = new Set(['jobs', 'frames', 'refs'])

/**
 * Which slot an asset contributes when it feeds a `frames` port.
 *
 * The API takes `{type:'image_url', image_url:{url}, frame_type}` per image, so
 * first-vs-last has to be a property of the SOURCE, not of the consumer. It used
 * to be read off the consumer (`node.fields.frameType`), which is a field no
 * node type declares — so it was always `undefined` and every frame silently
 * became a first frame.
 */
export function frameSlotOf(node) {
  return node?.fields?.slot === 'last_frame' ? 'last_frame' : 'first_frame'
}

/* ------------------------------------------------------------------ *
 * node type registry (plan §3.3)
 * ------------------------------------------------------------------ */

/**
 * 13 node types, of which only four talk to the network. Keeping the network
 * surface that small is deliberate: the executor's hard part is resumability
 * and cost accounting, and neither gets easier with more node kinds.
 *
 * `NETWORK_TYPES` is derived rather than hand-listed so a new network node type
 * cannot be added and then forgotten by the cost ceiling.
 */
export const NODE_TYPES = {
  script: {
    label: '脚本 / 分镜',
    category: 'input',
    color: '#8b8b95',
    inputs: [],
    outputs: [{ port: 'shots', type: 'shots' }, { port: 'brief', type: 'text' }],
    fields: [{ key: 'text', label: '镜头表', kind: 'textarea' }],
  },
  prompt: {
    label: '提示词',
    category: 'input',
    color: '#8b8b95',
    inputs: [],
    outputs: [{ port: 'text', type: 'text' }],
    fields: [{ key: 'text', label: '提示词', kind: 'textarea' }],
  },
  ref: {
    label: '参考素材',
    category: 'asset',
    color: '#39c5cf',
    inputs: [],
    outputs: [{ port: 'asset', type: 'image[]', dynamic: true }],
    fields: [
      { key: 'source', label: '素材', kind: 'text' },
      { key: 'kind', label: '类型', kind: 'select', options: ['image', 'video', 'audio'] },
      {
        key: 'slot',
        label: '接到 frames 时算',
        kind: 'select',
        options: ['first_frame', 'last_frame', 'reference'],
      },
    ],
  },
  cast: {
    label: '角色',
    category: 'asset',
    color: '#f778ba',
    /*
     * WIRED, not global — this comment claimed the opposite for two revisions
     * ("read off the graph by lib/cast.js, not delivered down an edge", so
     * "twelve shots need no twelve edges") and that first draft is exactly what
     * shipped a 角色 node whose inspector said it needed no wires.
     *
     * A `cast` node is one character DEFINITION. Its `asset` output is wired into
     * the `refs` port of each shot the character appears in, which is the only
     * scope that can express "the mouse is not in this shot".
     */
    inputs: [],
    outputs: [{ port: 'asset', type: 'image[]', dynamic: true }],
    fields: [
      { key: 'name', label: '角色名', kind: 'text' },
      { key: 'description', label: '固定外形描述（每条提示词都会原样带上）', kind: 'textarea' },
      { key: 'source', label: '角色参考图 URL', kind: 'text' },
    ],
  },
  scene: {
    label: '场景',
    category: 'asset',
    color: '#c78c3c',
    /*
     * The SAME mechanism as `cast`, pinning the place instead of the character.
     *
     * Why it needs to exist: six independent shots with nothing but per-shot
     * prose keep the character (the pinned description does that work) and lose
     * the ROOFTOP — new graffiti, new wall, new hour of day, three times over.
     * "The character must not drift" and "the location must not drift" are one
     * requirement, and a film has both.
     */
    inputs: [],
    outputs: [{ port: 'asset', type: 'image[]', dynamic: true }],
    fields: [
      { key: 'name', label: '场景名', kind: 'text' },
      { key: 'description', label: '固定场景描述（出场镜头每条提示词都会原样带上）', kind: 'textarea' },
      { key: 'source', label: '场景参考图 URL', kind: 'text' },
    ],
  },
  generate: {
    label: '生成',
    category: 'generate',
    color: '#4c8dff',
    inputs: [
      { port: 'brief', type: 'text' },
      { port: 'frames', type: 'image[]' },
      { port: 'refs', type: 'image[]' },
    ],
    outputs: [{ port: 'job', type: 'job' }],
    fields: [
      { key: 'prompt', label: '提示词', kind: 'textarea' },
      { key: 'model', label: '模型', kind: 'model' },
      { key: 'duration', label: '时长（秒）', kind: 'duration' },
      { key: 'resolution', label: '分辨率', kind: 'enum' },
      { key: 'aspectRatio', label: '画幅', kind: 'enum' },
      { key: 'generateAudio', label: '生成音频', kind: 'boolean' },
    ],
  },
  extend: {
    label: '续接',
    category: 'edit',
    color: '#a371f7',
    inputs: [{ port: 'job', type: 'job', required: true }, { port: 'brief', type: 'text' }],
    outputs: [{ port: 'job', type: 'job' }],
    fields: [
      { key: 'prompt', label: '补充提示词', kind: 'textarea' },
      { key: 'model', label: '模型', kind: 'model' },
      { key: 'duration', label: '时长（秒）', kind: 'duration' },
    ],
  },
  edit: {
    label: '编辑',
    category: 'edit',
    color: '#a371f7',
    inputs: [{ port: 'video', type: 'video', required: true }, { port: 'brief', type: 'text' }],
    outputs: [{ port: 'job', type: 'job' }],
    fields: [
      { key: 'prompt', label: '编辑指令', kind: 'textarea' },
      { key: 'model', label: '模型', kind: 'model' },
    ],
  },
  upscale: {
    label: '超分',
    category: 'edit',
    color: '#a371f7',
    inputs: [{ port: 'job', type: 'job', required: true }],
    outputs: [{ port: 'job', type: 'job' }],
    fields: [
      { key: 'model', label: '模型', kind: 'model' },
      { key: 'upscaleFactor', label: '放大倍数', kind: 'number', min: 1.5, max: 3 },
      { key: 'creativity', label: 'creativity', kind: 'select', options: [0, 1] },
    ],
  },
  take: {
    label: '取帧',
    category: 'process',
    color: '#e3873a',
    inputs: [{ port: 'job', type: 'job', required: true }],
    outputs: [{ port: 'image', type: 'image[]' }],
    fields: [
      { key: 'frame', label: '从上游取哪一帧', kind: 'select', options: ['first_frame', 'last_frame'] },
      { key: 'slot', label: '交给下游当', kind: 'select', options: ['first_frame', 'last_frame'] },
    ],
  },
  seq: {
    label: '成片序列',
    category: 'output',
    color: '#3fb950',
    inputs: [{ port: 'jobs', type: 'job', multi: true }],
    outputs: [{ port: 'manifest', type: 'manifest' }],
    fields: [{ key: 'naming', label: '命名规范', kind: 'text' }],
  },
  note: { label: '注释', category: 'structure', color: '#5a5a63', inputs: [], outputs: [], fields: [{ key: 'text', label: '备注', kind: 'textarea' }] },
  group: { label: '分组', category: 'structure', color: '#5a5a63', inputs: [], outputs: [], fields: [] },
  template: { label: '模板', category: 'structure', color: '#5a5a63', inputs: [], outputs: [], fields: [] },
}

/** Node types that submit an API call. Everything else is local and free. */
export const NETWORK_TYPES = new Set(
  Object.entries(NODE_TYPES).filter(([, def]) => def.category === 'generate' || def.category === 'edit').map(([key]) => key),
)

/** Node types that may carry an editorial position in the finished film. */
export const SHOT_TYPES = new Set(['generate', 'extend', 'edit', 'upscale'])

/**
 * What price bucket a node's request falls in.
 *
 * `extend` is the obvious continuation, but `link: 'continue'` means the same
 * thing on a `generate` node — it sends `previous_job_id` too, and the
 * continuation SKU is the real cost of that leg (on flux-3-video, $0.41/s
 * against a $0.17/s base). Pricing it as `plain` would understate the most
 * expensive part of a long film by 2.4x while the ceiling still claimed to be an
 * upper bound.
 */
export const pricingKind = (node) =>
  (node?.type === 'extend' || node?.link === 'continue' || node?.link === 'edit'
    ? 'continuation'
    : 'plain')

export const isNetworkNode = (node) => NETWORK_TYPES.has(node?.type) && node?.disabled !== true

/* ------------------------------------------------------------------ *
 * defaults & ids
 * ------------------------------------------------------------------ */

export function defaultProject() {
  return {
    model: 'google/veo-3.1-fast',
    resolution: '720p',
    aspectRatio: '16:9',
    duration: 8,
    generateAudio: true,
    seed: null,
  }
}

export function emptyGraph(title = '未命名项目') {
  return {
    version: GRAPH_VERSION,
    id: graphId(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    project: defaultProject(),
    budget: { usd: 30, onExceed: 'refuse' },
    concurrency: 2,
    nodes: [],
    edges: [],
    run: { state: 'idle', startedAt: null, lastRunAt: null },
  }
}

export function graphId(now = Date.now(), salt = Math.random()) {
  return `graph_${now.toString(36)}_${Math.floor(salt * 0xffffff).toString(36)}`
}

export function nodeId(type, now = Date.now(), salt = Math.random()) {
  return `n_${type}_${now.toString(36)}${Math.floor(salt * 0xffff).toString(36)}`
}

/* ------------------------------------------------------------------ *
 * migration
 * ------------------------------------------------------------------ */

/**
 * Bring any stored document up to GRAPH_VERSION. Unknown/missing versions are
 * treated as 1 because there has only ever been one shape; the chain exists so
 * the *next* change has somewhere to live rather than being a breaking rename.
 */
export function migrate(raw) {
  if (raw === null || typeof raw !== 'object') return emptyGraph()
  const graph = { ...raw }
  const from = Number.isInteger(graph.version) ? graph.version : 1
  if (from > GRAPH_VERSION) {
    throw new Error(`图文档版本 ${from} 高于本插件支持的 ${GRAPH_VERSION}；请升级插件后再打开`)
  }
  // (future) if (from < 2) { ...transform... }
  graph.version = GRAPH_VERSION
  return graph
}

/* ------------------------------------------------------------------ *
 * normalisation
 * ------------------------------------------------------------------ */

const asArray = (value) => (Array.isArray(value) ? value : [])

/** Coerce a stored/hand-written document into the shape the rest of the code may assume. */
export function normalizeGraph(raw) {
  const graph = migrate(raw)
  const project = { ...defaultProject(), ...(graph.project ?? {}) }

  const nodes = asArray(graph.nodes)
    .filter((node) => node !== null && typeof node === 'object' && typeof node.id === 'string')
    .map((node) => ({
      id: node.id,
      /*
       * PRESERVE an unknown type. Never silently rewrite it.
       *
       * This line used to map anything unrecognised to `note`. The intent was to
       * tolerate a hand-written document; the effect was DESTRUCTIVE. A client
       * that knows a node type its Host does not — a new client against a Host
       * that has not been restarted, which is the normal state of affairs here
       * because the Host half does not hot-reload — POSTs a `cast` node, has it
       * downgraded on the way in, and gets it back as an empty 注释 with one text
       * field and no image. The type is gone, the ports are gone, and nothing
       * anywhere says why.
       *
       * Refusing is correct; corrupting is not. An unknown type now survives the
       * round trip (so a restart REVIVES the node instead of losing it), renders
       * with the fallback label, and `validate` reports `bad-type` as a hard
       * ERROR — so a run refuses with 「未知节点类型：cast」 rather than quietly
       * doing nothing.
       */
      type: typeof node.type === 'string' && node.type.length > 0 ? node.type : 'note',
      title: typeof node.title === 'string' ? node.title : '',
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
      w: Number.isFinite(Number(node.w)) ? Number(node.w) : 190,
      shotIndex: Number.isInteger(node.shotIndex) && node.shotIndex > 0 ? node.shotIndex : null,
      disabled: node.disabled === true,
      maxRetries: Number.isInteger(node.maxRetries) ? Math.max(0, node.maxRetries) : 1,
      fields: node.fields !== null && typeof node.fields === 'object' ? { ...node.fields } : {},
      link: typeof node.link === 'string' ? node.link : null,
      urlMode: typeof node.urlMode === 'string' ? node.urlMode : null,
    }))

  const ids = new Set(nodes.map((node) => node.id))
  const seenEdge = new Set()
  const edges = asArray(graph.edges)
    .filter((edge) => edge !== null && typeof edge === 'object')
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge, index) => ({
      id: typeof edge.id === 'string' && edge.id.length > 0 ? edge.id : `e_${index}`,
      from: edge.from,
      fromPort: typeof edge.fromPort === 'string' ? edge.fromPort : '',
      to: edge.to,
      toPort: typeof edge.toPort === 'string' ? edge.toPort : '',
      label: typeof edge.label === 'string' ? edge.label : '',
    }))
    // Drop duplicate edges into the same single-input port: the last one wins,
    // matching what the canvas does when a user re-wires a taken port.
    .filter((edge) => {
      const key = `${edge.to}\u0000${edge.toPort}`
      if (MULTI_INPUT_PORTS.has(edge.toPort)) return true
      if (seenEdge.has(key)) return false
      seenEdge.add(key)
      return true
    })

  return {
    version: GRAPH_VERSION,
    id: typeof graph.id === 'string' && graph.id.length > 0 ? graph.id : graphId(),
    title: typeof graph.title === 'string' && graph.title.length > 0 ? graph.title : '未命名项目',
    createdAt: Number.isFinite(Number(graph.createdAt)) ? Number(graph.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(graph.updatedAt)) ? Number(graph.updatedAt) : Date.now(),
    project,
    budget: {
      usd: Number.isFinite(Number(graph.budget?.usd)) ? Math.max(0, Number(graph.budget.usd)) : 30,
      onExceed: graph.budget?.onExceed === 'warn' ? 'warn' : 'refuse',
    },
    concurrency: Number.isInteger(graph.concurrency) ? Math.min(4, Math.max(1, graph.concurrency)) : 2,
    nodes,
    edges,
    run: {
      state: typeof graph.run?.state === 'string' ? graph.run.state : 'idle',
      startedAt: graph.run?.startedAt ?? null,
      lastRunAt: graph.run?.lastRunAt ?? null,
    },
  }
}

/* ------------------------------------------------------------------ *
 * lookup helpers
 * ------------------------------------------------------------------ */

export const findNode = (graph, id) => graph.nodes.find((node) => node.id === id) ?? null
export const outPorts = (node) => NODE_TYPES[node.type]?.outputs ?? []
export const inPorts = (node) => NODE_TYPES[node.type]?.inputs ?? []
export const portType = (node, port, dir) =>
  (dir === 'out' ? outPorts(node) : inPorts(node)).find((spec) => spec.port === port)?.type ?? null

/**
 * Every node that must complete before `id` may run.
 *
 * Two kinds. Wired dependencies are explicit edges. An editorial `link` is
 * IMPLICIT: `link: 'continue'` sends `previous_job_id`, which must be the id of
 * the previous shot's *completed* job — so the shot cannot start until that job
 * exists, and it cannot start at all if the predecessor failed.
 *
 * Leaving `link` out of the scheduling graph meant "continued" shots were
 * dispatched CONCURRENTLY with the shot they were supposed to continue from, so
 * `previous_job_id` was always null and the flag changed nothing but the badge
 * on the sequence view. Deriving it here fixes readiness and failure
 * propagation together, because `readyNodes` uses this one function for both.
 *
 * The implicit edge always points at a strictly lower shotIndex, so it cannot
 * introduce a cycle.
 */
export function dependencies(graph, id) {
  const deps = graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
  const node = findNode(graph, id)
  if (node !== null && (node.link === 'continue' || node.link === 'edit') && node.shotIndex !== null) {
    const ordered = shots(graph)
    const position = ordered.findIndex((shot) => shot.id === id)
    if (position > 0) {
      const previous = ordered[position - 1].id
      if (!deps.includes(previous)) deps.push(previous)
    }
  }
  return deps
}

/** Every node that consumes `id`'s output, transitively. Used by "run downstream". */
export function downstreamOf(graph, ids) {
  const result = new Set()
  const stack = [...ids]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const edge of graph.edges) {
      if (edge.from !== current) continue
      if (result.has(edge.to)) continue
      result.add(edge.to)
      stack.push(edge.to)
    }
  }
  return result
}

/**
 * Every node `id` transitively depends on. The mirror of `downstreamOf`.
 *
 * The `seq` composer needs this and nothing weaker: "can I cut the film yet"
 * means *every* shot feeding this sequence is finished, and a one-level
 * `graph.edges` filter would call the film ready as soon as the direct parents
 * were done — which, for a `seq` hung off a `take` or off another `seq`, is not
 * the same question.
 */
export function upstreamOf(graph, ids) {
  const result = new Set()
  const stack = [...ids]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const edge of graph.edges) {
      if (edge.to !== current) continue
      if (result.has(edge.from)) continue
      result.add(edge.from)
      stack.push(edge.from)
    }
  }
  return result
}

/** Nodes carrying an editorial position, in film order. */
export function shots(graph) {
  return graph.nodes
    .filter((node) => node.shotIndex !== null && SHOT_TYPES.has(node.type))
    .sort((a, b) => a.shotIndex - b.shotIndex)
}

/* ------------------------------------------------------------------ *
 * connection rules (plan §3.4)
 * ------------------------------------------------------------------ */

/**
 * Can `from`'s output feed `to`'s input?
 *
 * Returns `{ ok, reason }` rather than a boolean so the canvas can show WHY a
 * wire was refused and the agent tool can put the same sentence in its receipt.
 * Five rules, in the order the plan lists them:
 *
 *   1. the ports must exist and their types must be compatible
 *   2. a single-input port takes one edge (re-wiring is a replace, not a stack);
 *      `jobs`, `frames` and `refs` are multi-input (see MULTI_INPUT_PORTS)
 *   3. no cycles — the executor only runs a DAG
 *   4. `frames` and `refs` both wired is legal but warns: the provider REJECTS the
 *      combination outright (measured 400 against heygen-video-1), so the request
 *      builder sends the frames and drops the references
 *   5. a required input left empty blocks execution (checked by `validate`)
 */
export function canConnect(graph, from, fromPort, to, toPort) {
  const source = findNode(graph, from)
  const target = findNode(graph, to)
  if (source === null || target === null) return { ok: false, reason: '节点不存在' }
  if (from === to) return { ok: false, reason: '不能连到自己' }

  const sourceType = portType(source, fromPort, 'out')
  if (sourceType === null) return { ok: false, reason: `${source.type} 没有输出端口 ${fromPort}` }

  const targetSpec = inPorts(target).find((spec) => spec.port === toPort)
  if (targetSpec === undefined) return { ok: false, reason: `${target.type} 没有输入端口 ${toPort}` }

  const accepts = PORT_ACCEPTS[toPort]
  if (accepts === undefined) return { ok: false, reason: `未知输入端口 ${toPort}` }
  if (!accepts.includes(sourceType)) {
    return { ok: false, reason: `类型不兼容：${sourceType} → ${toPort}（${toPort} 只接受 ${accepts.join(' / ')}）` }
  }

  if (wouldCycle(graph, from, to)) return { ok: false, reason: '会形成环；执行器只跑 DAG' }

  return { ok: true, reason: null, warn: frameRefsWarning(graph, to, toPort) }
}

/** Would adding from→to close a loop? i.e. is `from` already downstream of `to`. */
export function wouldCycle(graph, from, to) {
  if (from === to) return true
  const seen = new Set()
  const stack = [to]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === from) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to)
  }
  return false
}

/**
 * Rule 4: `frame_images` and `input_references` CANNOT be sent together — the
 * provider refuses the whole request (measured 400 against heygen-video-1), it
 * does not pick a winner. We allow the wiring — a `frames` wire is an explicit
 * continuity instruction while the references may still be wanted if the chain
 * is later removed — but say what will happen, rather than letting the shot fail
 * for a reason nobody stated.
 */
function frameRefsWarning(graph, to, toPort) {
  if (toPort !== 'refs' && toPort !== 'frames') return null
  const other = toPort === 'refs' ? 'frames' : 'refs'
  const hasOther = graph.edges.some((edge) => edge.to === to && edge.toPort === other)
  if (!hasOther && toPort === 'refs') return null
  const hasBoth = toPort === 'refs'
    ? hasOther
    : graph.edges.some((edge) => edge.to === to && edge.toPort === 'refs')
  if (!hasBoth) return null
  return 'frames 与 refs 都已接入：provider 会拒绝这个组合（实测 heygen），所以只发首帧，refs 上的参考图会被丢掉'
}

/* ------------------------------------------------------------------ *
 * validation (plan §3.4 rule 5 + §2 ③)
 * ------------------------------------------------------------------ */

/**
 * Validate a graph without touching the network.
 *
 * Errors block execution; warnings do not. Everything the paid path cares about
 * is checked HERE, before a single request is sent — the plan's most expensive
 * inherited lesson is that imagen-v2 validated after the paid call
 * (`NOTES.md`「校验跑在付费调用之后」).
 */
export function validate(graph, options = {}) {
  const catalog = options.catalog ?? null
  const errors = []
  const warnings = []

  if (graph.nodes.length === 0) errors.push({ code: 'empty', message: '图里没有任何节点' })

  const seenIds = new Set()
  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) errors.push({ code: 'dup-id', nodeId: node.id, message: `节点 id 重复：${node.id}` })
    seenIds.add(node.id)
    if (NODE_TYPES[node.type] === undefined) {
      errors.push({ code: 'bad-type', nodeId: node.id, message: `未知节点类型：${node.type}` })
    }
  }

  // required inputs unwired
  for (const node of graph.nodes) {
    for (const spec of inPorts(node)) {
      if (spec.required !== true) continue
      const wired = graph.edges.some((edge) => edge.to === node.id && edge.toPort === spec.port)
      if (!wired) {
        errors.push({
          code: 'missing-required',
          nodeId: node.id,
          message: `${NODE_TYPES[node.type].label} 的必填输入「${spec.port}」没有接入`,
        })
      }
    }
    if (node.type === 'note' || node.type === 'group' || node.type === 'template') continue
  }

  // cycles (a whole-graph sweep, so a hand-written document is caught too)
  const cycle = findCycle(graph)
  if (cycle !== null) errors.push({ code: 'cycle', message: `检测到环：${cycle.join(' → ')}` })

  // per-network-node parameter validation against the live catalog
  for (const node of graph.nodes) {
    if (!isNetworkNode(node)) continue
    const model = resolveModel(graph, node)
    if (typeof model !== 'string' || model.length === 0) {
      errors.push({ code: 'no-model', nodeId: node.id, message: '没有指定模型（节点和项目规格里都是空的）' })
      continue
    }
    const entry = catalog?.byId?.[model] ?? null

    if (catalog !== null && entry === null && catalog.loaded === true) {
      errors.push({ code: 'unknown-model', nodeId: node.id, message: `模型不在线上目录里：${model}` })
      continue
    }
    if (entry === null) continue

    const duration = resolveDuration(graph, node)
    if (Array.isArray(entry.supported_durations) && entry.supported_durations.length > 0) {
      if (!entry.supported_durations.includes(duration)) {
        errors.push({
          code: 'bad-duration',
          nodeId: node.id,
          message: `${model} 不支持 ${duration}s；支持：${entry.supported_durations.join(', ')}`,
        })
      }
    }
    const resolution = node.fields.resolution ?? graph.project.resolution
    if (Array.isArray(entry.supported_resolutions) && entry.supported_resolutions.length > 0) {
      if (!entry.supported_resolutions.includes(resolution)) {
        errors.push({
          code: 'bad-resolution',
          nodeId: node.id,
          message: `${model} 不支持 ${resolution}；支持：${entry.supported_resolutions.join(', ')}`,
        })
      }
    }
    // The concrete trap from the plan: sora-2-pro's supported_frame_images is
    // null, so it cannot do image-to-video at all. Catch it locally.
    if (node.type === 'generate' && graph.edges.some((e) => e.to === node.id && e.toPort === 'frames')) {
      const frames = entry.supported_frame_images
      if (frames === null || (Array.isArray(frames) && !frames.includes('first_frame'))) {
        errors.push({
          code: 'mode-unsupported',
          nodeId: node.id,
          message: `${model} 不支持首帧图生视频（supported_frame_images 为空）`,
        })
      }
    }
    if (node.type === 'upscale' && (entry.upscale_factor === null || entry.upscale_factor === undefined)) {
      errors.push({ code: 'not-upscaler', nodeId: node.id, message: `${model} 不是超分模型` })
    }
  }

  // rule 4 warnings
  for (const node of graph.nodes) {
    if (node.type !== 'generate') continue
    const hasFrames = graph.edges.some((edge) => edge.to === node.id && edge.toPort === 'frames')
    const hasRefs = graph.edges.some((edge) => edge.to === node.id && edge.toPort === 'refs')
    if (hasFrames && hasRefs) {
      warnings.push({
        code: 'frames-over-refs',
        nodeId: node.id,
        message: 'frames 与 refs 都已接入：provider 会拒绝这个组合，插件只发首帧、丢掉参考图',
      })
    }
    // `take` 取帧 now actually runs (see lib/imagebed.js): the executor is
    // handed a `materializeFrames` hook that cuts the frame with ffmpeg and
    // publishes it. The remaining way for this wire to do nothing is a missing
    // image bed — there is no other way to give a provider a fetchable URL — so
    // that, and only that, is what is worth saying out loud.
    if (hasFrames && options.imageBed === false) {
      const fedByTake = graph.edges.some((edge) =>
        edge.to === node.id && edge.toPort === 'frames' && findNode(graph, edge.from)?.type === 'take')
      if (fedByTake) {
        warnings.push({
          code: 'frame-chaining-needs-imagebed',
          nodeId: node.id,
          message: `${node.id} 的取帧链不会生效：没有配置图床（imageBedUrl），抽出来的帧没有公开 URL，`
            + 'provider 取不到，这一镜会退化成独立生成。',
        })
      }
    }
  }

  // editorial-axis hygiene: duplicate shot indexes
  const byShot = new Map()
  for (const node of shots(graph)) {
    const list = byShot.get(node.shotIndex) ?? []
    list.push(node.id)
    byShot.set(node.shotIndex, list)
  }
  for (const [index, list] of byShot) {
    if (list.length > 1) {
      warnings.push({ code: 'dup-shot', message: `镜头序号 #${index} 被 ${list.join('、')} 同时占用` })
    }
  }

  // cross-model adjacency: a real look/encoding discontinuity, and the only
  // case where a model change deserves a flag (plan §3.11 — flagging every
  // change marks 5 of 6 rows and therefore signals nothing).
  const ordered = shots(graph)
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]
    const current = ordered[i]
    const joined = current.link === 'continue' || current.link === 'edit'
    if (resolveModel(graph, prev) === resolveModel(graph, current)) continue
    if (joined) continue
    warnings.push({
      code: 'model-switch',
      nodeId: current.id,
      message: `#${prev.shotIndex} 与 #${current.shotIndex} 之间换了模型且没有续接关系，会有观感与编码断层`,
    })
  }

  // Bibles — characters AND scenes. Both are reusable DEFINITIONS that do
  // nothing until wired into a shot's `refs` port, and that scope is the whole
  // point: different shots have different characters in them, so a graph-wide
  // fan-out would hand the provider a reference to someone who is not in the
  // scene and spend a bounded reference budget on them.
  //
  // The warning codes are derived from the kind (`cast-*`, `scene-*`) rather
  // than hardcoded twice, so adding a third kind cannot silently lose its
  // warnings.
  const bibles = bibleLibrary(graph)
  if (bibles.length > 0) {
    const usage = castUsage(graph)

    for (const kind of BIBLE_TYPES) {
      const label = BIBLES[kind].label
      const rows = bibles.filter((row) => row.kind === kind)
      if (rows.length === 0) continue

      const undescribed = rows.filter((row) => row.description.length === 0)
      if (undescribed.length > 0) {
        warnings.push({
          code: `${kind}-without-description`,
          message: `${undescribed.map((row) => row.name).join('、')} 没填「${BIBLES[kind].descriptionLabel}」：`
            + `只靠参考图，提示词仍会各自描述一遍${label}，每镜都会漂。`
            + (kind === 'cast'
              ? '写固定外形（毛色、体型、眼睛、穿戴），不写动作和情绪。'
              : '写固定的地点 / 时间 / 光线 / 材质，不写镜头里发生的事。'),
        })
      }

      const unused = rows.filter((row) => (usage.get(row.nodeId) ?? []).length === 0)
      if (unused.length > 0) {
        warnings.push({
          code: `${kind}-unused`,
          message: `${unused.map((row) => row.name).join('、')} 没有连到任何镜头的 refs 端口，对这条片子暂时不起作用。`
            + `一个${label}可以连很多镜头；不连就没有出场。`,
        })
      }
    }

    // Measured against heygen-video-1: the combination is not a soft precedence
    // the provider resolves — it is a 400 that loses the whole render. The request
    // builder drops the references; saying so is the difference between a user
    // understanding their film and hunting a bug that is a documented rule.
    const overridden = graph.nodes.filter((node) => node.type === 'generate'
      && graph.edges.some((edge) => edge.to === node.id && edge.toPort === 'frames')
      && bibleFor(graph, node.id).length > 0)
    if (overridden.length > 0) {
      warnings.push({
        code: 'cast-overridden-by-frames',
        nodeId: overridden[0].id,
        message: `${overridden.length} 个镜头同时接了首帧和参考图（角色或场景）。`
          + '**provider 会直接拒绝这个组合**（实测 heygen-video-1：'
          + '「does not accept input_references alongside a first_frame image」），'
          + '所以插件把参考图丢掉、只发首帧 —— 那里靠接龙传递 + 提示词里原样重复的固定描述保持一致。'
          + '想让参考图真正生效，把那一镜改成硬切（chain: "none"）。',
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Whole-graph cycle detection (DFS three-colour). Returns the cycle path or null. */
export function findCycle(graph) {
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map(graph.nodes.map((node) => [node.id, WHITE]))
  const stack = []

  const visit = (id) => {
    colour.set(id, GREY)
    stack.push(id)
    for (const edge of graph.edges) {
      if (edge.from !== id) continue
      const next = colour.get(edge.to)
      if (next === GREY) return [...stack.slice(stack.indexOf(edge.to)), edge.to]
      if (next === WHITE) {
        const found = visit(edge.to)
        if (found !== null) return found
      }
    }
    stack.pop()
    colour.set(id, BLACK)
    return null
  }

  for (const node of graph.nodes) {
    if (colour.get(node.id) !== WHITE) continue
    const found = visit(node.id)
    if (found !== null) return found
  }
  return null
}

/** Topological order. Returns null when the graph has a cycle. */
export function topoOrder(graph, subset = null) {
  const include = subset === null ? null : new Set(subset)
  const nodes = graph.nodes.filter((node) => include === null || include.has(node.id))
  const ids = new Set(nodes.map((node) => node.id))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    indegree.set(edge.to, indegree.get(edge.to) + 1)
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const order = []
  while (ready.length > 0) {
    const id = ready.shift()
    order.push(id)
    for (const edge of graph.edges) {
      if (edge.from !== id || !ids.has(edge.to)) continue
      const left = indegree.get(edge.to) - 1
      indegree.set(edge.to, left)
      if (left === 0) ready.push(edge.to)
    }
  }
  return order.length === nodes.length ? order : null
}

/* ------------------------------------------------------------------ *
 * resolution: node field → project spec (plan §3.2)
 * ------------------------------------------------------------------ */

export function resolveModel(graph, node) {
  const own = node.fields?.model
  if (typeof own === 'string' && own.length > 0) return own
  return graph.project.model
}

export function resolveDuration(graph, node) {
  const own = Number(node.fields?.duration)
  if (Number.isFinite(own) && own > 0) return own
  return graph.project.duration
}

export function resolveResolution(graph, node) {
  const own = node.fields?.resolution
  if (typeof own === 'string' && own.length > 0) return own
  return graph.project.resolution
}

export function resolveAspect(graph, node) {
  const own = node.fields?.aspectRatio
  if (typeof own === 'string' && own.length > 0) return own
  return graph.project.aspectRatio
}

/**
 * Locked project seed → per-shot seed = base + shotIndex.
 *
 * That keeps the LOOK fixed while still letting each shot differ, which is what
 * "one film looks like one film" actually requires (plan §3.8).
 */
export function resolveSeed(graph, node) {
  const base = graph.project.seed
  if (!Number.isInteger(base)) return null
  return base + (node.shotIndex ?? 0)
}

export const graphInternals = {
  PORT_ACCEPTS, MULTI_INPUT_PORTS, NODE_TYPES, NETWORK_TYPES, SHOT_TYPES, GRAPH_VERSION,
}
