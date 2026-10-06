/**
 * DAG executor (Host side).
 *
 * Owns the parts of a long video that are easy to get wrong:
 *
 *   - **topological dispatch** with a concurrency semaphore;
 *   - **six-state polling** (`cancelled` and `expired` exist; the prose docs
 *     list only four — plan §0 trap #4);
 *   - **download immediately on completion**, because the job TTL is unpublished
 *     and a 23-shot film can be generated across days (plan §2 ①);
 *   - **resume without re-submitting**, which is the only thing standing between
 *     a restart and paying twice for the same shot (plan §3.5.3);
 *   - **abort means stop dispatching** — there is no cancel endpoint, so
 *     in-flight jobs keep running and keep billing, and the UI has to say so
 *     (plan §3.5.5);
 *   - **a hard budget gate** that refuses before any request is sent.
 *
 * Everything that touches the network arrives as an injected function. That is
 * not decoration: it is what lets the smoke test prove "over budget → zero HTTP
 * calls" and "restart → no second submit" without a key, a network, or money.
 */

import {
  NETWORK_TYPES, isNetworkNode, topoOrder, dependencies, resolveModel, resolveDuration, resolveSeed,
  findNode, graphInternals,
} from './graph.js'
import { isTerminal, TERMINAL_FAIL, errorMessage } from './store.js'

/** Node execution states. `blocked`/`skipped`/`queued` have no API counterpart. */
export const NODE_STATE = {
  IDLE: 'idle',
  BLOCKED: 'blocked',
  QUEUED: 'queued',
  SUBMITTED: 'submitted',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Map an API status onto a node state. Exhaustive over all six. */
export function nodeStateFor(status) {
  switch (status) {
    case 'completed': return NODE_STATE.COMPLETED
    case 'failed':
    case 'cancelled':
    case 'expired': return NODE_STATE.FAILED
    case 'pending':
    case 'in_progress': return NODE_STATE.IN_PROGRESS
    default: return NODE_STATE.IN_PROGRESS
  }
}

/**
 * Which nodes can be dispatched right now.
 *
 * A node is ready when every dependency is COMPLETED and it has at least one
 * artefact. Anything whose dependency failed becomes `skipped` — but only along
 * that dependency chain, so a broken shot does not take the rest of the film
 * down with it (plan §3.5.4).
 *
 * LOCAL NODES ARE WALKED THROUGH, NOT ASSUMED SATISFIED.
 *
 * A local dependency used to count as satisfied the instant it was seen, on the
 * reasoning that local work is free and instant. For a pure source — a `script`
 * node holding the brief, which has no inputs — that is true. For a `take` it is
 * false, and treating it as satisfied made the node TRANSPARENT: the shot
 * downstream of a `take` saw the take as already done and was dispatched in the
 * same breath as the shot UPSTREAM of it. The two rendered concurrently, the
 * downstream request was built before its frame existed, no `frame_images` were
 * ever sent, and the film drifted apart exactly as chaining was meant to
 * prevent. A measured 12-shot run dispatched six concurrent pairs and chained
 * nothing.
 *
 * So a local node WITH inputs is satisfied only when everything feeding it is
 * satisfied — recursively. A local node with no inputs (a brief) still is
 * immediately, which is what keeps the common `script → shots` graph free.
 *
 * RESUME: a node rehydrated as IN_PROGRESS/SUBMITTED is ALSO ready. It must be
 * handed to `runOne`, which sees the existing ledger record, skips submission
 * and re-attaches polling. Excluding it here was a real bug: the job stopped
 * being tracked after a restart and the run reported it as unfinished forever —
 * the exact failure the plan calls「长视频的生死线」.
 */
export function readyNodes(graph, states) {
  const order = topoOrder(graph) ?? []
  const ready = []
  const skipped = []

  const RESUMABLE = new Set([
    NODE_STATE.IDLE,
    NODE_STATE.BLOCKED,
    NODE_STATE.IN_PROGRESS,
    NODE_STATE.SUBMITTED,
    NODE_STATE.QUEUED,
  ])

  /**
   * What a node contributes to everything downstream of it: 'done', 'blocked'
   * or 'pending'.
   *
   * Memoised per call — never across calls. `states` is mutated between rounds,
   * so a cached verdict from a previous round would keep a shot blocked after
   * its upstream finished, which is a hang rather than a wrong number.
   */
  const verdicts = new Map()
  const verdictOf = (id, seen) => {
    const cached = verdicts.get(id)
    if (cached !== undefined) return cached
    // Graphs are DAGs by construction, but this must not be the function that
    // hangs forever if one ever is not.
    if (seen.has(id)) return 'pending'
    seen.add(id)

    const node = findNode(graph, id)
    let verdict
    if (node === null) {
      verdict = 'done'
    } else if (isNetworkNode(node)) {
      const state = states.get(id) ?? NODE_STATE.IDLE
      verdict = state === NODE_STATE.COMPLETED
        ? 'done'
        : (state === NODE_STATE.FAILED || state === NODE_STATE.SKIPPED ? 'blocked' : 'pending')
    } else {
      // A local node: its own verdict is its inputs' verdict.
      verdict = 'done'
      for (const up of dependencies(graph, id)) {
        const inherited = verdictOf(up, seen)
        if (inherited === 'blocked') { verdict = 'blocked'; break }
        if (inherited === 'pending') verdict = 'pending'
      }
    }

    seen.delete(id)
    verdicts.set(id, verdict)
    return verdict
  }

  for (const id of order) {
    const node = findNode(graph, id)
    if (node === null || !isNetworkNode(node)) continue
    const state = states.get(id) ?? NODE_STATE.IDLE
    if (!RESUMABLE.has(state)) continue

    const verdictList = dependencies(graph, id).map((dep) => verdictOf(dep, new Set()))

    if (verdictList.includes('blocked')) { skipped.push(id); continue }
    if (verdictList.every((verdict) => verdict === 'done')) ready.push(id)
  }

  return { ready, skipped, order }
}

/**
 * Run one graph.
 *
 * @param {object} options
 * @param {object} options.graph
 * @param {Map<string,string>} options.states        nodeId → NODE_STATE (mutated)
 * @param {Map<string,object>} options.jobs          nodeId → ledger record (mutated)
 * @param {(node:object, request:object) => Promise<{id:string, status:string}>} options.submit
 * @param {(job:object) => Promise<object>} options.poll
 * @param {(job:object) => Promise<object>} options.download
 * @param {(node:object, request:object) => object} options.buildRequest
 * @param {(node:object, job:object) => Promise<object[]>} [options.materializeFrames]
 *   Called with a node that has just finished (or resumed as finished); returns
 *   a per-`take`-node summary. Injected, so the executor still knows nothing
 *   about ffmpeg, image beds, or the filesystem.
 * @param {(node:object) => Promise<object|null>} [options.materializeSequence]
 *   Called once per `seq` node after the scheduler has drained. Same reasoning:
 *   the executor must not learn what an mp4 is.
 * @param {(nodeId:string, state:string, detail?:object) => void} [options.onState]
 * @param {() => number} [options.ceilingOf]         nodeId → USD ceiling (null = unknown)
 * @param {number} [options.budgetUsd]
 * @param {boolean} [options.abortOnExceed]
 * @param {Set<string>} [options.only]               restrict to these nodes + downstream
 * @param {number} [options.concurrency]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.maxPollAttempts]
 * @param {{aborted:boolean}} [options.control]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 */
export async function runGraph(options) {
  const {
    graph,
    states,
    jobs,
    submit,
    poll,
    download,
    buildRequest,
    materializeFrames = async () => [],
    materializeSequence = async () => null,
    onState = () => {},
    ceilingOf = () => null,
    budgetUsd = Infinity,
    abortOnExceed = true,
    only = null,
    concurrency = 2,
    pollIntervalMs = 30_000,
    maxPollAttempts = 60,
    pollRetries = 3,
    control = { aborted: false },
    retryFailed = false,
    sleep = wait,
  } = options

  const report = {
    dispatched: [],
    completed: [],
    failed: [],
    skipped: [],
    aborted: false,
    paused: false,
    pauseReason: null,
    spentUsd: 0,
    ceilingUsd: 0,
    unknownCeiling: 0,
    /** Per-`take` frame failures. Never fails the shot — the video is already paid for. */
    frameErrors: [],
    /**
     * Per-`take` frames that were actually cut and published.
     *
     * `frameErrors` existed on its own and the run receipt printed neither, so a
     * chaining feature that did nothing at all — every call throwing
     * "jobMap is not defined" — still produced「完成 12，失败 0」. Successes are
     * counted too, because the receipt has to be able to say "12 shots, 11
     * frames, 0 problems" rather than leaving the user to infer it.
     */
    framesPublished: [],
    /**
     * One row per `seq` node the composer ran on.
     *
     * A `seq` node is LOCAL — it spends nothing and calls nobody — so the
     * scheduler above never dispatches it, and for most of this plugin's life it
     * therefore produced nothing at all: both finished films were concatenated
     * by hand from a shell, not by the graph. The shape that promised a film and
     * delivered nothing is the same failure the `take` node had, and the fix is
     * the same: give the executor an injected hook and report what it did.
     */
    sequences: [],
    sequenceErrors: [],
  }

  const subset = only === null ? null : expandSubset(graph, only)

  // Money already spent by an EARLIER run belongs in this run's report too.
  // A resumed graph would otherwise under-report its true cost, and under-
  // reporting a ceiling is exactly the failure mode the plan forbids.
  for (const node of graph.nodes) {
    if (subset !== null && !subset.has(node.id)) continue
    const prior = jobs.get(node.id)
    if (prior !== null && prior !== undefined && prior.status === 'completed' && typeof prior.cost === 'number') {
      report.spentUsd += prior.cost
    }
  }

  const setState = (id, state, detail) => {
    states.set(id, state)
    try { onState(id, state, detail) } catch { /* a UI callback must not kill a run */ }
  }

  /* ---- budget gate: refuse BEFORE anything is sent (plan §3.9 / §6 test 4) ---- */
  const planned = graph.nodes.filter((node) => isNetworkNode(node) && (subset === null || subset.has(node.id)))
  let ceilingTotal = 0
  let unknownCount = 0
  for (const node of planned) {
    const ceiling = ceilingOf(node.id)
    if (ceiling === null || ceiling === undefined) unknownCount += 1
    else ceilingTotal += ceiling
  }
  report.ceilingUsd = ceilingTotal
  report.unknownCeiling = unknownCount

  if (abortOnExceed && Number.isFinite(budgetUsd) && ceilingTotal > budgetUsd) {
    report.paused = true
    report.pauseReason = `成本上界 $${ceilingTotal.toFixed(2)} 超过预算 $${budgetUsd.toFixed(2)}；已拒绝派发，未发出任何请求`
    // Mark everything planned as blocked so the UI can show where it stopped.
    for (const node of planned) {
      if (!isNetworkNode(node)) continue
      if (states.get(node.id) === NODE_STATE.COMPLETED) continue
      setState(node.id, NODE_STATE.BLOCKED, { reason: 'over-budget' })
    }
    return report
  }

  /* ---- publish frames for nodes that are ALREADY completed ----------
   * Rehydrated nodes start as COMPLETED, so `readyNodes` can consider their
   * downstream ready on the very first dispatch — before `runOne` for a
   * resumed node has run at all. Doing the hand-off here, before the scheduler
   * exists, is the only ordering that is safe on resume. It is also the path
   * that covers a process that died between a download and its upload.
   *
   * Idempotent: the Host-side hook short-circuits a `take` that already has a
   * `frameUrl`, so a normal run re-uploads nothing.
   */
  for (const id of (topoOrder(graph) ?? [])) {
    if (subset !== null && !subset.has(id)) continue
    const node = findNode(graph, id)
    if (node === null || !isNetworkNode(node)) continue
    if ((states.get(id) ?? '') !== NODE_STATE.COMPLETED) continue
    const record = jobs.get(id)
    if (record === undefined || record === null) continue
    await publishFrames(id, node, record, jobs, report)
  }

  const inFlight = new Map() // nodeId → promise

  const dispatchable = () => {
    const { ready, skipped } = readyNodes(graph, states)
    for (const id of skipped) {
      if (states.get(id) === NODE_STATE.FAILED || states.get(id) === NODE_STATE.SKIPPED) continue
      setState(id, NODE_STATE.SKIPPED, { reason: 'upstream-failed' })
      report.skipped.push(id)
    }
    return ready.filter((id) => subset === null || subset.has(id))
  }

  const runOne = async (id) => {
    const node = findNode(graph, id)
    const existing = jobs.get(id)

    // RESUME: a node that already has an in-flight ledger record is re-attached,
    // never re-submitted. This is the whole reason the ledger writes at submit
    // time (plan §3.5.3).
    let record = existing ?? null
    if (record !== null && isTerminal(record.status)) {
      if (record.status === 'completed') {
        // Cost was already seeded into report.spentUsd from the ledger above;
        // adding it again here would double-count a resumed run.
        // Its frames were already published by the pre-pass, BEFORE the
        // scheduler had a chance to dispatch anything downstream.
        setState(id, NODE_STATE.COMPLETED, { cost: record.cost ?? null, resumed: true })
        report.completed.push(id)
        return
      }
      if (retryFailed === false) {
        setState(id, NODE_STATE.FAILED, { error: record.error ?? record.status, resumed: true })
        report.failed.push(id)
        return
      }
      // An explicit retry. Resetting the STATE to IDLE is not enough on its own:
      // this short-circuit reads the LEDGER, which still holds the dead record,
      // so `fresh` used to reset the state and then have it immediately
      // overridden here — the shot stayed failed forever with no way to re-run it.
      jobs.delete(id)
      record = null
    }

    if (record === null) {
      const request = buildRequest(node, {
        model: resolveModel(graph, node),
        duration: resolveDuration(graph, node),
        seed: resolveSeed(graph, node),
      })
      setState(id, NODE_STATE.QUEUED)
      let submitted
      try {
        submitted = await submit(node, request)
      } catch (error) {
        // `jobs.set` FIRST. The Host persists a record from `onState` only when
        // it can find it in this map, so announcing the failure before recording
        // it meant a failed submit was NEVER written to the ledger. The run said
        // "全部 2 个节点都失败了" and there was nothing anywhere — not in the
        // ledger, not in the graph, not in the UI — saying why. A failure with no
        // recorded reason is unrecoverable the moment the process exits.
        record = {
          // A unique id per attempt, so retrying a shot APPENDS to the ledger
          // instead of overwriting the previous failure. The earlier reason is
          // exactly what you need to tell a transient failure from a permanent one.
          id: `local:${id}:${Date.now()}`, nodeId: id, graphId: graph.id,
          status: 'failed', error: errorMessage(error), cost: null,
        }
        jobs.set(id, record)
        setState(id, NODE_STATE.FAILED, { error: errorMessage(error) })
        report.failed.push(id)
        return
      }
      // Persist the job id the instant we have it — before any polling.
      record = {
        id: submitted.id,
        nodeId: id,
        graphId: graph.id,
        model: request.model,
        status: submitted.status ?? 'pending',
        submittedAt: Date.now(),
        cost: null,
        filePath: null,
        error: null,
      }
      jobs.set(id, record)
      setState(id, nodeStateFor(record.status), { jobId: record.id })
      report.dispatched.push(id)
    }

    /* ---- poll to a terminal state ---- */
    let attempts = 0
    /**
     * Consecutive poll attempts that failed at the transport level.
     *
     * Reset by every poll that answers, so this counts a RUN of failures rather
     * than a lifetime total: a shot that blips once an hour is never killed by it.
     */
    let transientFailures = 0
    let current = record
    /**
     * The status this node ACTUALLY reached, held in a local.
     *
     * `onState` is a UI callback, and it is handed the ledger record — which can
     * be the very object this function is holding. An `onState` that writes
     * `record.status` in place therefore rewrites the value read a line later,
     * and control flow that depends on a callback not mutating its input is not
     * control flow at all. This aliasing produced an endless re-dispatch loop:
     * 49 dispatches, 244 polls, every poll reporting `completed`, and a run that
     * never finished.
     *
     * `current.status` is also what `poll()` is handed, so it is refreshed from
     * the API each round; `outcome` is the record of what came back.
     */
    let outcome = current.status
    while (!isTerminal(outcome) && attempts < maxPollAttempts) {
      if (control.aborted) {
        setState(id, NODE_STATE.IN_PROGRESS, { jobId: current.id, note: 'aborted-dispatch' })
        return
      }
      await sleep(pollIntervalMs)
      attempts += 1
      try {
        const fresh = await poll(current)
        current = { ...current, ...pickStatus(fresh) }
        outcome = current.status
        jobs.set(id, current)
        transientFailures = 0
        // Do NOT announce COMPLETED from the poll loop.
        //
        // The frame hand-off runs after the download, and readiness is derived
        // from THIS state — so announcing completion here lets a *concurrent*
        // node's completion resolve the race in the main loop and dispatch the
        // downstream shot before its frame exists. The chained shot then finds
        // no `frameUrl`, silently becomes an independent take, and the film
        // drifts exactly the way the chaining was supposed to prevent.
        // With the default concurrency of 2 that window is live, not
        // theoretical. Completion is announced once, after publication.
        const announced = nodeStateFor(outcome)
        setState(id, announced === NODE_STATE.COMPLETED ? NODE_STATE.IN_PROGRESS : announced,
          { jobId: current.id, attempts })
        if (outcome === 'completed') break
        if (isTerminal(outcome)) break
      } catch (error) {
        // A TRANSIENT poll failure is not a dead shot.
        //
        // The submission already succeeded — the API minted a job id and billed
        // for it — so treating one network blip as terminal throws away a clip
        // that is sitting finished on the server, and (on a chained film) blocks
        // every shot downstream of it. That happened for real: one `fetch failed`
        // during polling marked a $0.075 shot as failed, and the only in-app way
        // forward was `retry_failed`, which SUBMITS AGAIN and pays twice.
        //
        // Polling is a GET of an already-paid-for job, so retrying it is both
        // free and idempotent. Only a persistent failure is terminal.
        transientFailures += 1
        if (transientFailures <= pollRetries) {
          setState(id, NODE_STATE.IN_PROGRESS,
            { jobId: current.id, note: 'poll-retry', attempt: transientFailures })
          await sleep(Math.min(2000, pollIntervalMs))
          continue
        }
        current = { ...current, status: 'failed', error: `${errorMessage(error)}（轮询连续失败 ${transientFailures} 次）` }
        outcome = 'failed'
        jobs.set(id, current)
        setState(id, NODE_STATE.FAILED, { jobId: current.id, error: current.error })
        report.failed.push(id)
        return
      }
    }

    if (outcome !== 'completed') {
      const terminal = isTerminal(outcome)
      const message = terminal
        ? (current.error ?? outcome)
        : `轮询超时（${maxPollAttempts} 次）；任务仍在服务端运行并继续计费，job id ${current.id}`
      setState(id, terminal ? NODE_STATE.FAILED : NODE_STATE.IN_PROGRESS, { jobId: current.id, error: message })
      if (terminal) report.failed.push(id)
      return
    }

    /* ---- download IMMEDIATELY: the TTL is unpublished ---- */
    try {
      const saved = await download(current)
      current = {
        ...current,
        filePath: saved?.filePath ?? null,
        filePathRelative: saved?.filePathRelative ?? null,
        mediaType: saved?.mediaType ?? null,
      }
      jobs.set(id, current)
    } catch (error) {
      current = { ...current, error: `已完成但下载失败：${errorMessage(error)}` }
      jobs.set(id, current)
      setState(id, NODE_STATE.FAILED, { jobId: current.id, error: current.error })
      report.failed.push(id)
      return
    }

    if (typeof current.cost === 'number') report.spentUsd += current.cost
    // Publish frames BEFORE announcing COMPLETED. Readiness is derived from
    // that state, so this ordering is what removes the need for a scheduling
    // edge from the `take` node to the shot that consumes it — and a race along
    // with it.
    await publishFrames(id, node, current, jobs, report)
    setState(id, NODE_STATE.COMPLETED, { jobId: current.id, cost: current.cost ?? null })
    report.completed.push(id)
  }

  /**
   * Run the frame hook and record what it did.
   *
   * A frame failure must never fail the shot: the video is already rendered and
   * already paid for, and marking it failed would invite a re-render of a clip
   * that is sitting on disk. It is recorded as a per-take error instead, which
   * is where the user can see it.
   */
  async function publishFrames(id, node, jobRecord, jobs, report) {
    let results
    try {
      results = await materializeFrames(node, jobRecord)
    } catch (error) {
      results = [{ error: errorMessage(error) }]
    }
    if (!Array.isArray(results) || results.length === 0) return
    const merged = { ...jobs.get(id), frames: results }
    jobs.set(id, merged)
    const failed = results.filter((row) => typeof row?.error === 'string')
    if (failed.length > 0) report.frameErrors = [...(report.frameErrors ?? []), ...failed]
    const published = results.filter((row) => typeof row?.frameUrl === 'string' && row.frameUrl.length > 0)
    if (published.length > 0) report.framesPublished = [...(report.framesPublished ?? []), ...published]
  }

  /* ---- main loop ---- */
  for (;;) {
    if (control.aborted) { report.aborted = true; break }

    const canStart = concurrency - inFlight.size
    if (canStart > 0) {
      const ready = dispatchable()
      for (const id of ready.slice(0, canStart)) {
        if (inFlight.has(id)) continue
        const promise = runOne(id).finally(() => inFlight.delete(id))
        inFlight.set(id, promise)
      }
    }

    if (inFlight.size === 0) {
      const remaining = graph.nodes.filter((node) =>
        isNetworkNode(node) && (subset === null || subset.has(node.id))
        && !['completed', 'failed', 'skipped'].includes(states.get(node.id) ?? ''))
      if (remaining.length === 0) break
      // Nothing dispatchable and nothing running: the rest is blocked.
      for (const node of remaining) {
        if (states.get(node.id) === NODE_STATE.FAILED) continue
        setState(node.id, NODE_STATE.SKIPPED, { reason: 'unreachable' })
        report.skipped.push(node.id)
      }
      break
    }

    await Promise.race([...inFlight.values()])
  }

  /* ---- compose `seq` nodes ------------------------------------------
   * After every shot is terminal, and ONLY here. `seq` is local, so the
   * scheduler never sees it; running it after the loop also makes it correct on
   * the two paths that matter most:
   *
   *   - **resume**, where all twelve shots were already paid for and nothing was
   *     dispatched this run — "nothing ran" must not mean "no film";
   *   - **partial run** (`only`), where the composer must not reach for shots
   *     outside the subset.
   *
   * The hook decides which upstream clips it can actually use. Keeping that
   * decision on the Host is what lets a film with one failed shot still be
   * exported, with the missing shot NAMED in the receipt, instead of the whole
   * export failing on a node the user can see is already broken.
   */
  for (const node of graph.nodes) {
    if (node === null || node.type !== 'seq' || node.disabled === true) continue
    if (subset !== null && !subset.has(node.id)) continue

    let row = null
    try {
      row = await materializeSequence(node)
    } catch (error) {
      row = { nodeId: node.id, error: errorMessage(error) }
    }
    if (row === null || row === undefined) continue

    report.sequences = [...(report.sequences ?? []), row]
    if (typeof row.error === 'string' && row.error.length > 0) {
      report.sequenceErrors = [...(report.sequenceErrors ?? []), row]
      setState(node.id, NODE_STATE.FAILED, { error: row.error })
    } else {
      // Free, and the client reads the state off this map, so the node finally
      // turns green when the film lands.
      setState(node.id, NODE_STATE.COMPLETED, { cost: 0 })
    }
  }

  return report
}

/** Keep the fields that come back from a poll, dropping anything unexpected. */
function pickStatus(fresh) {
  const out = {}
  if (fresh === null || typeof fresh !== 'object') return out
  if (typeof fresh.status === 'string') out.status = fresh.status
  if (typeof fresh.error === 'string') out.error = fresh.error
  if (fresh.usage !== null && typeof fresh.usage === 'object' && typeof fresh.usage.cost === 'number') {
    out.cost = fresh.usage.cost
  }
  if (Array.isArray(fresh.unsigned_urls)) out.unsigned_urls = fresh.unsigned_urls
  if (typeof fresh.generation_id === 'string') out.generation_id = fresh.generation_id
  if (typeof fresh.polling_url === 'string') out.polling_url = fresh.polling_url
  return out
}

/**
 * `only` restricts a run to a node set. The plan's §3.5.6 makes "run this node
 * and its downstream" the core advantage over a form UI, and *downstream* is
 * what makes it useful: re-run a shot and everything derived from it, leaving
 * the rest of the film alone.
 */
export function expandSubset(graph, only) {
  const result = new Set()
  const stack = [...only]
  while (stack.length > 0) {
    const id = stack.pop()
    if (result.has(id)) continue
    result.add(id)
    for (const edge of graph.edges) if (edge.from === id && !result.has(edge.to)) stack.push(edge.to)
  }
  return result
}

/** Seed `states` from a ledger so a restart resumes instead of restarting. */
export function rehydrate(graph, jobMap) {
  const states = new Map()
  for (const node of graph.nodes) {
    if (!isNetworkNode(node)) continue
    const job = jobMap.get(node.id)
    if (job === undefined || job === null) { states.set(node.id, NODE_STATE.IDLE); continue }
    if (job.status === 'completed') states.set(node.id, NODE_STATE.COMPLETED)
    else if (TERMINAL_FAIL.has(job.status)) states.set(node.id, NODE_STATE.FAILED)
    else if (isTerminal(job.status)) states.set(node.id, NODE_STATE.FAILED)
    else states.set(node.id, NODE_STATE.IN_PROGRESS)
  }
  return states
}

/** Counts for the top bar. Derived once, never hand-maintained (plan §3.11 #1). */
export function summarize(graph, states) {
  const network = graph.nodes.filter(isNetworkNode)
  const count = (state) => network.filter((node) => states.get(node.id) === state).length
  return {
    total: network.length,
    completed: count(NODE_STATE.COMPLETED),
    running: count(NODE_STATE.IN_PROGRESS) + count(NODE_STATE.SUBMITTED) + count(NODE_STATE.QUEUED),
    failed: count(NODE_STATE.FAILED),
    skipped: count(NODE_STATE.SKIPPED),
    idle: network.length - count(NODE_STATE.COMPLETED) - count(NODE_STATE.IN_PROGRESS)
      - count(NODE_STATE.SUBMITTED) - count(NODE_STATE.QUEUED) - count(NODE_STATE.FAILED) - count(NODE_STATE.SKIPPED),
  }
}

export const execInternals = { readyNodes, expandSubset, rehydrate, nodeStateFor, NETWORK_TYPES, graphInternals }
