/**
 * Task ledger + graph storage (Host side).
 *
 * Two stores, deliberately separate (plan §3.2 invariant 2):
 *
 *   - **Graphs** are *intent*: what the user wants made. Edited by hand, by the
 *     canvas, and by agent tools.
 *   - **Jobs** are *fact*: what was actually submitted and what it cost.
 *
 * Keeping them apart matters because a poll updates the ledger every 30 seconds;
 * if results lived in the graph document, every poll would rewrite the file the
 * user is currently editing.
 *
 * The single most important property here is inherited from the plan §2 ①:
 *
 *   > records must be persisted **at the moment of submission**, not on
 *   > completion — a user who closes DSH during a 30-second wait must still see
 *   > the job running when they come back.
 *
 * That is what `recordSubmit` is for and why it writes immediately. A ledger
 * that only writes on completion cannot support resume, and resume is the thing
 * that stops a long video from re-spending money it already spent.
 *
 * The data directory is a CONSTRUCTOR ARGUMENT, never derived internally. This
 * is the fix for imagen-v2's most serious outstanding defect (`NOTES.md`):
 * a hardcoded `join(homedir(), '.dsh', ...)` meant `npm run smoke` instantiated
 * plugin instances pointed at the user's real history file and `store.clear()`
 * deleted it. Injectable means tests physically cannot touch user data.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How many jobs are kept. A long film is ~25 shots plus retries and edits. */
export const JOB_LIMIT = 400
/** How many graph documents are kept. */
export const GRAPH_LIMIT = 40

function errorMessage(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Atomic-ish write: temp file + rename, so a crash mid-write cannot corrupt. */
async function writeJson(file, payload) {
  const temp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temp, JSON.stringify(payload, null, 0), 'utf8')
  await rename(temp, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[openrouter-video] ${file} unreadable (${errorMessage(error)}); starting empty`)
    }
    return null
  }
}

/* ================================================================== *
 * job ledger
 * ================================================================== */

/**
 * A job as the client consumes it. Plain JSON only — this crosses the
 * same-origin route.
 *
 * `id` is stored EXACTLY as returned by the API. The plan §0 trap #5 is blunt
 * about this: the documented `gen-vid-` prefix appears on none of the ids
 * actually observed, so validating against that regex would reject every real
 * job. Never parse, never reformat.
 */
export class JobStore {
  /** @param {string} file absolute path of the JSON file backing this store */
  constructor(file) {
    this.file = file
    /** @type {object[]} newest first */
    this.jobs = []
    this.loaded = false
    /**
     * The in-flight read, shared by every concurrent caller.
     *
     * A plain `loaded` boolean is not enough: `load()` used to set it BEFORE
     * awaiting the file, so a second call arriving during the first read saw
     * `loaded === true` and returned an EMPTY store. `apply` kicks the load off
     * with `void store.load()`, which makes that window real — and its symptom is
     * "没有这个图" for a graph that plainly exists on disk.
     */
    this.loading = null
  }

  load() {
    if (this.loading !== null) return this.loading
    this.loading = (async () => {
      const parsed = await readJson(this.file)
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      this.jobs = list.filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
      this.loaded = true
    })()
    return this.loading
  }

  list(limit) {
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : this.jobs.length
    return this.jobs.slice(0, max)
  }

  find(id) {
    return this.jobs.find((row) => row.id === id) ?? null
  }

  /** Every job belonging to one graph, newest first. */
  forGraph(graphId) {
    return this.jobs.filter((row) => row.graphId === graphId)
  }

  /** The node→job mapping for one graph, used to rebuild execution state. */
  byNode(graphId) {
    const map = new Map()
    for (const job of this.jobs) {
      if (job.graphId !== graphId || typeof job.nodeId !== 'string') continue
      if (!map.has(job.nodeId)) map.set(job.nodeId, job)
    }
    return map
  }

  /** Jobs that were submitted but have not reached a terminal state. */
  inFlight() {
    return this.jobs.filter((row) =>
      row.status === 'submitted' || row.status === 'pending' || row.status === 'in_progress')
  }

  async upsert(record) {
    await this.load()
    const index = this.jobs.findIndex((row) => row.id === record.id)
    if (index === -1) this.jobs.unshift(record)
    else this.jobs[index] = { ...this.jobs[index], ...record }
    if (this.jobs.length > JOB_LIMIT) this.jobs.length = JOB_LIMIT
    await this.persist()
    return record
  }

  async remove(id) {
    await this.load()
    const before = this.jobs.length
    this.jobs = this.jobs.filter((row) => row.id !== id)
    if (this.jobs.length !== before) await this.persist()
    return before !== this.jobs.length
  }

  async clear() {
    await this.load()
    this.jobs = []
    await this.persist()
  }

  async persist() {
    try {
      await writeJson(this.file, { version: 1, jobs: this.jobs })
    } catch (error) {
      console.warn(`[openrouter-video] cannot persist jobs: ${errorMessage(error)}`)
    }
  }
}

/* ================================================================== *
 * graph storage
 * ================================================================== */

export class GraphStore {
  constructor(file) {
    this.file = file
    /** @type {Map<string, object>} */
    this.graphs = new Map()
    this.loaded = false
    /** Shared in-flight read — see the note on JobStore.loading. */
    this.loading = null
  }

  load() {
    if (this.loading !== null) return this.loading
    this.loading = (async () => {
      const parsed = await readJson(this.file)
      const list = Array.isArray(parsed?.graphs) ? parsed.graphs : []
      for (const row of list) {
        if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
        this.graphs.set(row.id, row)
      }
      this.loaded = true
    })()
    return this.loading
  }

  /** Newest first. */
  list(limit) {
    const all = [...this.graphs.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : all.length
    return all.slice(0, max)
  }

  get(id) {
    return this.graphs.get(id) ?? null
  }

  async put(graph) {
    await this.load()
    this.graphs.set(graph.id, graph)
    // Trim the oldest beyond the cap.
    if (this.graphs.size > GRAPH_LIMIT) {
      const sorted = [...this.graphs.values()].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
      for (const stale of sorted.slice(0, this.graphs.size - GRAPH_LIMIT)) this.graphs.delete(stale.id)
    }
    await this.persist()
    return graph
  }

  async remove(id) {
    await this.load()
    const existed = this.graphs.delete(id)
    if (existed) await this.persist()
    return existed
  }

  async persist() {
    try {
      await writeJson(this.file, { version: 1, graphs: [...this.graphs.values()] })
    } catch (error) {
      console.warn(`[openrouter-video] cannot persist graphs: ${errorMessage(error)}`)
    }
  }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

/** Ids only have to be unique within one ledger. */
export function jobId(now = Date.now(), salt = Math.random()) {
  return `job_${now.toString(36)}_${Math.floor(salt * 0xffffff).toString(36)}`
}

/**
 * Where this plugin keeps its data.
 *
 * Exported so a caller can see the default, but the stores never call it
 * themselves — they take a path. That separation is what makes the smoke test
 * safe (see the header note).
 */
export function defaultDataDir(home) {
  return join(home, '.dsh', 'openrouter-video')
}

/** The three terminal states, plus the two the docs never mentioned (plan §0 trap #4). */
export const TERMINAL_OK = 'completed'
export const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'expired'])
export const ALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired']

export const isTerminal = (status) => status === TERMINAL_OK || TERMINAL_FAIL.has(status)

export { errorMessage, join }
