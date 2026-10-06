/**
 * Mutation-test 成片序列 + 角色设定: break each behaviour and require that the
 * suites go RED. A green suite that stays green when the feature is deleted is
 * not evidence — and this workspace has twice shipped a node that drew a promise
 * the runtime did not keep, with every test passing.
 *
 * Run: node mutate-sequence.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const NODE = process.env.NODE_BIN ?? process.execPath

/** Each mutation names the file it lives in, so one run covers all three modules. */
const mutations = [
  /* ---- lib/sequence.js ------------------------------------------- */
  {
    file: 'lib/sequence.js',
    name: 'isUniform ignores audio presence, so copy-concat silently drops a track',
    from: '    && clip.hasAudio === first.hasAudio)',
    to: '    && true)',
  },
  {
    file: 'lib/sequence.js',
    name: 'concat entries are left relative (ffmpeg resolves them against the list file)',
    from: '  let list = probed.map((clip) => resolve(clip.filePath))',
    to: '  let list = probed.map((clip) => clip.filePath)',
  },
  {
    file: 'lib/sequence.js',
    name: 'normalize CROPS to fit instead of padding, silently reframing the shot',
    from: '  const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`',
    to: '  const pad = `crop=${width}:${height}`',
  },
  {
    file: 'lib/sequence.js',
    name: 'concat drops -safe 0, so every absolute path is refused',
    from: "    '-f', 'concat', '-safe', '0', '-i', listPath,",
    to: "    '-f', 'concat', '-i', listPath,",
  },
  {
    file: 'lib/sequence.js',
    name: 'normalize omits the silent track, so the copy step is not uniform after all',
    from: "  if (hasAudio !== true) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')",
    to: '  if (false) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo")',
  },
  {
    file: 'lib/sequence.js',
    name: 'orderClips sorts by node id, so the film is cut in dispatch order',
    from: '    .sort((a, b) => ((a.node.shotIndex ?? 1e9) - (b.node.shotIndex ?? 1e9))\n      || String(a.id).localeCompare(String(b.id)))',
    to: '    .sort((a, b) => String(a.id).localeCompare(String(b.id)))',
  },
  {
    file: 'lib/sequence.js',
    name: 'a completed job with no local file is treated as a clip',
    from: "      && typeof job.filePath === 'string' && job.filePath.length > 0) {",
    to: '      ) {',
  },
  {
    file: 'lib/sequence.js',
    name: 'the export claims success without stat-ing the film it never wrote',
    from: '    bytes = (await fsx.stat(outPath)).size',
    to: '    bytes = 1',
  },

  /* ---- lib/exec.js ----------------------------------------------- */
  {
    file: 'lib/exec.js',
    name: 'the seq pass is skipped, so the film is never cut',
    from: "    if (node === null || node.type !== 'seq' || node.disabled === true) continue",
    to: '    if (true) continue',
  },
  {
    file: 'lib/exec.js',
    name: 'a sequence failure is recorded nowhere, so a missing film is silent',
    from: '      report.sequenceErrors = [...(report.sequenceErrors ?? []), row]',
    to: '      report.sequenceErrors = report.sequenceErrors ?? []',
  },

  /* ---- lib/cast.js ----------------------------------------------- */
  {
    file: 'lib/cast.js',
    name: 'castPromptBlock includes settings with no description',
    from: "  const described = list.filter((row) => row?.kind === kind && (row?.description ?? '').length > 0)",
    to: '  const described = list.filter((row) => row?.kind === kind)',
  },
  {
    file: 'lib/cast.js',
    name: 'idempotence regresses to per-PROMPT, so a scene added later never lands',
    from: '  const missing = bibleBlocks(rows).filter((block) => !text.includes(block.marker))',
    to: '  if (text.trimStart().startsWith(CAST_MARKER)) return text\n  const missing = bibleBlocks(rows)',
  },
  {
    file: 'lib/cast.js',
    name: 'the scene announces itself with the CHARACTER marker, collapsing the two blocks',
    from: "  scene: { marker: SCENE_MARKER, label: '场景', fallbackName: '未命名场景', descriptionLabel: '固定场景描述' },",
    to: "  scene: { marker: CAST_MARKER, label: '场景', fallbackName: '未命名场景', descriptionLabel: '固定场景描述' },",
  },
  {
    file: 'lib/graph.js',
    name: 'scene warnings are emitted under the cast code, so a drifting place is never reported',
    from: '          code: `${kind}-without-description`,',
    to: "          code: 'cast-without-description',",
  },

  /* ---- lib/index.js ---------------------------------------------- */
  {
    file: 'lib/index.js',
    name: 'the cast never reaches the request, so the prompt drifts again',
    from: "    const prompt = applyHandoff(applyCast(node.fields?.prompt, cast), handoff)",
    to: '    const prompt = applyHandoff(node.fields?.prompt, handoff)',
  },
  {
    file: 'lib/index.js',
    name: 'cast images are dropped from input_references',
    from: "    if (node.type === 'ref' || node.type === 'cast' || node.type === 'scene') {",
    to: "    if (node.type === 'ref') {",
    suites: ['test-cast.mjs', 'test-api-url.mjs'],
  },
  {
    file: 'lib/index.js',
    name: 'the composer is never handed to the executor, so no film is ever cut',
    from: '        materializeSequence: (node) => materializeSequence(graph, node, jobMap, settings, cwd),',
    to: '        materializeSequence: undefined,',
  },
  /* ---- lib/graph.js: the structural bugs behind the reported symptoms ---- */
  {
    file: 'lib/graph.js',
    name: 'an unknown node type is silently rewritten to `note` again',
    from: "      type: typeof node.type === 'string' && node.type.length > 0 ? node.type : 'note',",
    to: "      type: typeof node.type === 'string' && NODE_TYPES[node.type] !== undefined ? node.type : 'note',",
    suites: ['test-core.mjs'],
  },
  {
    file: 'lib/graph.js',
    name: 'refs stops being multi-input, so a shot can hold only ONE character',
    from: "export const MULTI_INPUT_PORTS = new Set(['jobs', 'frames', 'refs'])",
    to: "export const MULTI_INPUT_PORTS = new Set(['jobs', 'frames'])",
    suites: ['test-core.mjs', 'test-cast.mjs'],
  },

  /* ---- lib/cast.js: wired, not global ----------------------------------- */
  {
    file: 'lib/cast.js',
    name: 'the settings go back to GLOBAL — every character and scene on every shot',
    from: '  return bibleLibrary(graph).filter((row) => wired.has(row.nodeId))',
    to: '  return bibleLibrary(graph)',
    suites: ['test-cast.mjs'],
  },

  /* ---- lib/index.js: per-shot call sheet and per-shot cuts -------------- */
  {
    file: 'lib/index.js',
    name: '`chain:"none"` per shot is ignored, so every transition is a dissolve',
    from: "            if (entry?.chain === 'none') {",
    to: '            if (false) {',
    suites: ['test-api-url.mjs'],
  },
  {
    file: 'lib/index.js',
    name: 'a wired cast never reaches the prompt',
    from: '    const cast = bibleFor(graph, node.id)',
    to: '    const cast = []',
    suites: ['test-api-url.mjs'],
  },

  /* ---- lib/index.js: the request body, measured against the provider ------- */
  {
    file: 'lib/index.js',
    name: 'a chained shot ships frame_images AND input_references, which the provider refuses',
    from: "    if (frames.length > 0) body.frame_images = frames\n    else if (references.length > 0) body.input_references = references",
    to: "    if (frames.length > 0) body.frame_images = frames\n    if (references.length > 0) body.input_references = references",
    suites: ['test-api-url.mjs'],
  },

  /* ---- lib/client.js: the canvas and the roster ------------------------- */
  {
    file: 'lib/client.js',
    name: 'the canvas evicts a previous wire on a multi-input port again',
    from: '        if (!MULTI_PORTS.has(port)) {',
    to: '        if (true) {',
    suites: ['test-interact.mjs'],
  },
  {
    file: 'lib/client.js',
    name: 'a roster edit is written to the SELECTED node, not the one being edited',
    from: "        writeNodeField(nodeId, key, kind === 'number' ? Number(raw.trim()) : raw)",
    to: "        updateField(key, kind === 'number' ? Number(raw.trim()) : raw)",
    suites: ['test-interact.mjs'],
  },
  {
    file: 'lib/client.js',
    name: 'a node type the Host cannot honour is offered anyway',
    from: '                .filter(([type]) => hostKnows(type))',
    to: '                .filter(() => true)',
    suites: ['test-interact.mjs'],
  },
  {
    file: 'lib/client.js',
    name: 'the character roster loses its IMAGE field — the reported symptom',
    from: "'data-field': 'cast-source',",
    to: "'data-field': 'cast-source-gone',",
    suites: ['test-interact.mjs'],
  },
  {
    file: 'lib/client.js',
    name: 'the sequence view answers continuity from the dead `link` flag again',
    from: "          const feed = graph.edges.find((edge) => edge.to === node.id && edge.toPort === 'frames')",
    to: '          const feed = undefined',
    suites: ['test-interact.mjs'],
  },
]

/**
 * Which suites must go red for a mutation to count as caught.
 *
 * A mutation may narrow this to the suite that actually owns the behaviour —
 * running all five for every mutation would make this script a minute longer for
 * no extra signal.
 */
const SUITES = ['test-sequence.mjs', 'test-cast.mjs', 'test-api-url.mjs']

const saved = new Map()
for (const file of new Set(mutations.map((m) => m.file))) saved.set(file, readFileSync(file, 'utf8'))

const restoreAll = () => {
  for (const [file, text] of saved) writeFileSync(file, text)
}

let caught = 0
try {
  // A mutation run against an already-red suite proves nothing: every mutation
  // would be "caught" by the pre-existing failure. Refuse to start.
  for (const suite of SUITES) {
    const baseline = spawnSync(NODE, [suite], { encoding: 'utf8' })
    if (baseline.status !== 0) {
      console.log(`BASELINE IS RED (${suite}) — fix the suite before mutating:`)
      console.log(baseline.stdout.split('\n').filter((l) => l.trim().startsWith('FAIL')).map((l) => '   ' + l.trim()).join('\n'))
      process.exit(2)
    }
  }
  console.log('baseline green\n')

  for (const mutation of mutations) {
    const original = saved.get(mutation.file)
    if (!original.includes(mutation.from)) {
      console.log(`SKIP  ${mutation.name} — anchor not found in ${mutation.file}`)
      continue
    }
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))

    let red = false
    let firstFail = ''
    let output = ''
    for (const suite of (mutation.suites ?? SUITES)) {
      const run = spawnSync(NODE, [suite], { encoding: 'utf8' })
      output += run.stdout + run.stderr
      if (run.status !== 0) {
        red = true
        firstFail = run.stdout.split('\n').find((l) => l.trim().startsWith('FAIL')) ?? ''
        break
      }
    }
    console.log(`${red ? 'CAUGHT' : 'MISSED'}  ${mutation.name}`)
    if (red) console.log(`   ${firstFail.trim()}`)
    else console.log(output.split('\n').slice(-8).join('\n'))
    if (red) caught += 1
    writeFileSync(mutation.file, original)
  }
} finally {
  restoreAll()
  let identical = true
  for (const [file, text] of saved) if (readFileSync(file, 'utf8') !== text) identical = false
  console.log(`\nrestored byte-identical: ${identical}`)
  for (const file of saved.keys()) {
    try { unlinkSync(`${file}.mutbak`) } catch { /* nothing to clean */ }
  }
}

console.log(`\n${caught} of ${mutations.length} mutations caught`)
process.exit(caught === mutations.length ? 0 : 1)
