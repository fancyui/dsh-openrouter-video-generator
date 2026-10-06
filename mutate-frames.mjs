/**
 * Mutation-test the frame hand-off.
 *
 * The claim being defended is narrow and specific: a `take` node wired into a
 * shot's `frames` port makes that shot start FROM THE PREVIOUS CLIP'S FRAME,
 * and it does so before the shot can be dispatched. Every mutation below
 * reintroduces one real way that claim was false:
 *
 *   - the last frame sampled several frames early, so the seam is almost right
 *   - the tail's FIRST file taken instead of its last
 *   - a Cloudflare interstitial reported as a JSON parse error
 *   - no User-Agent, so the bed challenges the upload
 *   - a relative `src` accepted as if a provider could fetch it
 *   - `frames` back to single-input, so first_last cannot be expressed
 *   - the slot read off the wrong node, so every frame becomes a first frame
 *   - the missing-image-bed warning made unreachable, so the wire degrades silently
 *   - completion announced from the poll loop, reopening the dispatch race
 *   - publication moved after the COMPLETED announcement
 *   - a frame failure folded into the shot's failure
 *   - the resume pre-pass removed
 *
 * A suite that stays green when any of these is reintroduced is not evidence.
 *
 * Run: node mutate-frames.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const NODE = process.env.NODE_BIN ?? process.execPath
const SUITE = process.env.SUITE ?? 'test-frames.mjs'

const mutations = [
  {
    file: 'lib/imagebed.js',
    name: 'last frame via `-sseof -0.15 -frames:v 1` (the frame-past-a-seek idiom)',
    from: `    return {
      mode: 'sequence',
      parts,
      args: ['-y', '-v', 'error', '-sseof', \`-\${back}\`, '-i', videoPath, join(parts, 'f_%05d.png')],
    }`,
    to: `    return {
      mode: 'single',
      parts: null,
      args: ['-y', '-v', 'error', '-sseof', '-0.15', '-i', videoPath, '-frames:v', '1', '-update', '1', outPath],
    }`,
  },
  {
    file: 'lib/imagebed.js',
    name: 'take the FIRST file of the dumped tail instead of the last',
    from: `    await fs.rename(join(plan.parts, names[names.length - 1]), outPath)`,
    to: `    await fs.rename(join(plan.parts, names[0]), outPath)`,
  },
  {
    file: 'lib/imagebed.js',
    name: 'treat a Cloudflare challenge page as an ordinary JSON response',
    from: `  if (contentType.includes('text/html')) {`,
    to: `  if (false) {`,
  },
  {
    file: 'lib/imagebed.js',
    name: 'stop sending the User-Agent the bed requires',
    from: `  if (typeof userAgent === 'string' && userAgent.length > 0) headers['User-Agent'] = userAgent`,
    to: `  void userAgent`,
  },
  {
    file: 'lib/imagebed.js',
    name: 'accept a relative src, which no provider can fetch',
    from: `  if (typeof payload === 'string') return /^https?:\\/\\//iu.test(payload) ? payload : null`,
    to: `  if (typeof payload === 'string') return payload`,
  },
  {
    file: 'lib/graph.js',
    suite: 'test-core.mjs',
    name: 'make `frames` single-input again, so first_last is unexpressible',
    from: `export const MULTI_INPUT_PORTS = new Set(['jobs', 'frames', 'refs'])`,
    to: `export const MULTI_INPUT_PORTS = new Set(['jobs', 'refs'])`,
  },
  {
    file: 'lib/graph.js',
    suite: 'test-core.mjs',
    name: 'hard-code every frame slot to first_frame',
    from: `  return node?.fields?.slot === 'last_frame' ? 'last_frame' : 'first_frame'`,
    to: `  return 'first_frame'`,
  },
  {
    file: 'lib/graph.js',
    suite: 'test-core.mjs',
    name: 'make the missing-image-bed warning unreachable (silent degradation)',
    from: `    if (hasFrames && options.imageBed === false) {`,
    to: `    if (false) {`,
  },
  {
    file: 'lib/exec.js',
    name: 're-read the status AFTER the onState callback has had a chance to rewrite it',
    from: `          { jobId: current.id, attempts })
        if (outcome === 'completed') break
        if (isTerminal(outcome)) break`,
    to: `          { jobId: current.id, attempts })
        outcome = current.status
        if (outcome === 'completed') break
        if (isTerminal(outcome)) break`,
  },
  // NOTE: there is deliberately no mutation for the Host-side `onState` write.
  // `lib/index.js` now builds a copy instead of mutating `existingJob` in place,
  // but that is defence in depth rather than a separately observable behaviour:
  // once the executor keeps its own `outcome` local it does not care what the
  // callback does to the record, so reverting the Host side alone changes
  // nothing any test can see. The mutation above covers the half that matters.
  {
    file: 'lib/exec.js',
    name: 'announce COMPLETED from the poll loop, reopening the dispatch race',
    from: `        const announced = nodeStateFor(outcome)
        setState(id, announced === NODE_STATE.COMPLETED ? NODE_STATE.IN_PROGRESS : announced,
          { jobId: current.id, attempts })`,
    to: `        setState(id, nodeStateFor(current.status), { jobId: current.id, attempts })`,
  },
  {
    file: 'lib/exec.js',
    name: 'publish frames AFTER announcing COMPLETED',
    from: `    await publishFrames(id, node, current, jobs, report)
    setState(id, NODE_STATE.COMPLETED, { jobId: current.id, cost: current.cost ?? null })`,
    to: `    setState(id, NODE_STATE.COMPLETED, { jobId: current.id, cost: current.cost ?? null })
    await publishFrames(id, node, current, jobs, report)`,
  },
  {
    file: 'lib/exec.js',
    name: 'fold a frame failure into the shot failure (invites paying twice)',
    from: `    if (failed.length > 0) report.frameErrors = [...(report.frameErrors ?? []), ...failed]`,
    to: `    if (failed.length > 0) report.failed.push(...failed.map((row) => row.nodeId ?? 'take'))`,
  },
  {
    file: 'lib/exec.js',
    name: 'drop the resume pre-pass, so a resumed node never publishes',
    from: `  for (const id of (topoOrder(graph) ?? [])) {
    if (subset !== null && !subset.has(id)) continue
    const node = findNode(graph, id)
    if (node === null || !isNetworkNode(node)) continue
    if ((states.get(id) ?? '') !== NODE_STATE.COMPLETED) continue
    const record = jobs.get(id)
    if (record === undefined || record === null) continue
    await publishFrames(id, node, record, jobs, report)
  }`,
    to: `  void topoOrder`,
  },
  {
    file: 'lib/exec.js',
    suite: 'test-api-url.mjs',
    name: 'treat a local dependency (a `take`) as satisfied, so chained shots dispatch in parallel',
    from: `    } else {
      // A local node: its own verdict is its inputs' verdict.
      verdict = 'done'
      for (const up of dependencies(graph, id)) {
        const inherited = verdictOf(up, seen)
        if (inherited === 'blocked') { verdict = 'blocked'; break }
        if (inherited === 'pending') verdict = 'pending'
      }
    }`,
    to: `    } else {
      verdict = 'done'
    }`,
  },
  {
    file: 'lib/index.js',
    suite: 'test-api-url.mjs',
    name: 'let `materializeFrames` close over an out-of-scope `jobMap` again',
    from: `  async function materializeFrames(graph, upstream, upstreamJob, settings, cwd, jobMap) {`,
    to: `  async function materializeFrames(graph, upstream, upstreamJob, settings, cwd) {`,
  },
  {
    file: 'lib/index.js',
    suite: 'test-api-url.mjs',
    name: 'drop the frame outcome from the run receipt again, so a dead hand-off reads as success',
    from: `          frameErrors: report.frameErrors ?? [],
          framesPublished: report.framesPublished ?? [],`,
    to: `          framesPublished: report.framesPublished ?? [],`,
  },
  {
    file: 'lib/exec.js',
    name: 'treat a transient poll error as a dead shot again (pays twice to recover)',
    from: `        transientFailures += 1
        if (transientFailures <= pollRetries) {
          setState(id, NODE_STATE.IN_PROGRESS,
            { jobId: current.id, note: 'poll-retry', attempt: transientFailures })
          await sleep(Math.min(2000, pollIntervalMs))
          continue
        }`,
    to: `        void pollRetries`,
  },
  {
    file: 'lib/index.js',
    suite: 'test-api-url.mjs',
    name: 'ignore the per-plan audio flag, so a content-filtered model cannot be rescued',
    from: `          generateAudio: typeof args?.generate_audio === 'boolean' ? args.generate_audio : settings.generateAudio,`,
    to: `          generateAudio: settings.generateAudio,`,
  },
]

const FILES = [...new Set(mutations.map((m) => m.file))]
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]))
const backups = new Map(FILES.map((f) => [f, `${f}.mutbak`]))
for (const f of FILES) copyFileSync(f, backups.get(f))

function restore() {
  for (const f of FILES) {
    writeFileSync(f, originals.get(f))
    try { unlinkSync(backups.get(f)) } catch { /* already gone */ }
  }
}

let caught = 0
try {
  // A mutation run against an already-red suite proves nothing: every mutation
  // would be "caught" by the pre-existing failure. Refuse to start.
  const baseline = spawnSync(NODE, [SUITE], { encoding: 'utf8' })
  if (baseline.status !== 0) {
    console.log('BASELINE IS RED — fix the suite before mutating:')
    console.log(baseline.stdout.split('\n').filter((l) => l.trim().startsWith('FAIL'))
      .map((l) => '   ' + l.trim()).join('\n'))
    process.exit(2)
  }
  console.log('baseline green\n')

  for (const m of mutations) {
    const source = originals.get(m.file)
    if (!source.includes(m.from)) {
      console.log(`SKIP    ${m.name} — anchor not found in ${m.file}`)
      continue
    }
    writeFileSync(m.file, source.replace(m.from, m.to))
    // A graph rule is asserted in the graph suite, an executor rule in the
    // frame suite. Running the wrong one would report a live assertion as
    // vacuous, which is worse than not mutating at all.
    const suite = m.suite ?? SUITE
    // A timeout is a CAUGHT mutation, not a harness failure: the aliasing bug's
    // signature is an infinite re-dispatch loop, so a hang IS the regression.
    const run = spawnSync(NODE, [suite], { encoding: 'utf8', timeout: 120_000 })
    const red = run.status !== 0
    console.log(`${red ? 'CAUGHT' : 'MISSED'}  ${m.name}`)
    const fail = run.stdout.split('\n').find((l) => l.trim().startsWith('FAIL'))
    if (red) console.log('        ' + (fail ?? '').trim())
    else console.log('        suite stayed GREEN — the assertion is vacuous')
    if (red) caught += 1
    writeFileSync(m.file, source)
  }
} finally {
  restore()
  const identical = FILES.every((f) => readFileSync(f, 'utf8') === originals.get(f))
  console.log(`\nrestored byte-identical: ${identical}`)
}

console.log(`\n${caught} of ${mutations.length} mutations caught`)
process.exit(caught === mutations.length ? 0 : 1)
