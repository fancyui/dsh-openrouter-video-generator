/**
 * Mutation-test the interaction suite: break each behaviour and require that
 * test-interact.mjs goes RED. A green suite that stays green when the feature
 * is deleted is not evidence.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'lib/client.js'
const BAK = 'lib/client.js.mutbak'
const NODE = process.env.NODE_BIN ?? process.execPath

const mutations = [
  {
    name: 'library rows lose their onClick',
    from: 'onClick: () => addNode(type),',
    to: 'onClick: undefined,',
  },
  {
    name: 'a drag no longer persists the position',
    from: 'void saveGraph(movedGraph)',
    to: 'void 0',
  },
  {
    name: 'the key input is removed from the settings dialog',
    from: "'data-field': 'apiKey',",
    to: "'data-field': 'apiKey-gone',",
  },
  {
    name: 'a drag writes on every mousemove (state instead of ref)',
    from: 'if (!drag.moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 3) return',
    to: 'if (false) return',
  },
  {
    name: 'the 设置 button is dropped, so the dialog is unreachable',
    from: "'data-act': 'open-settings',",
    to: "'data-act': 'open-settings-gone',",
  },
  {
    name: 'the image bed is dropped from the dialog, so chaining has no on-switch',
    from: "'data-field': 'bedUrl',",
    to: "'data-field': 'bedUrl-gone',",
  },
  {
    name: 'the bed URL is saved with its trailing slash (breaks the upload URL)',
    from: "imageBedUrl: bedDraft.url.trim().replace(/\\/+$/u, ''),",
    to: 'imageBedUrl: bedDraft.url,',
  },
  {
    name: 'the bed probe never contacts the bed',
    from: "const result = await api('/bed/test', {",
    to: "const result = await api('/bed/notest', {",
  },
  {
    name: 'the model shortlist is never persisted',
    from: 'const body = { models: nextList }',
    to: 'const body = { }',
  },
  {
    name: "the ref node's slot list loses `reference`, so 参考 becomes a frame",
    from: `      'ref.slot': ['first_frame', 'last_frame', 'reference'],`,
    to: `      'ref.slot': ['first_frame', 'last_frame'],`,
  },
  {
    name: 'every select falls back to the hardcoded first/last pair again',
    from: `            const options = selectOptionsFor(selectedNode.type, key)`,
    to: `            const options = ['first_frame', 'last_frame']`,
  },

  /* ---- 改名 / 删除, and the two stale-cast defects behind the report ---- */
  {
    name: 'a rename is accepted and then not written to the document',
    from: '        else node.title = title',
    to: '        else node.title = node.title',
  },
  {
    name: 'the rename write-once guard is dropped, so Enter + blur send it twice',
    from: '        renameRef.current = null\n        setRenaming(null)',
    to: '        setRenaming(null)',
  },
  {
    name: 'deleting a node leaves its wires behind, still pointing at nothing',
    from: '        next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId)\n'
      + '        next.edges = next.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)',
    to: '        next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId)',
  },
  {
    name: 'deleting one node cascades into the downstream chain',
    from: '        next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId)',
    to: '        next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId'
      + ' && !deleteImpact(nodeId).downstream.some((row) => row.id === candidate.id))',
  },
  {
    name: 'delete happens on the keypress, without asking and without stating the cost',
    from: '        setPendingDelete({ id: nodeId, ...deleteImpact(nodeId) })',
    to: '        void deleteNode(nodeId)',
  },
  {
    name: 'the Delete key fires inside text fields, so editing a prompt deletes the node',
    from: '          if (tag === \'input\' || tag === \'textarea\' || tag === \'select\' || target?.isContentEditable === true) return',
    to: '          if (false) return',
  },
  {
    name: 'the first-frame warning fires on ANY reference in the graph, not the ones wired to this shot',
    from: '        const refWiredHere = (graph.edges ?? []).some((edge) =>\n'
      + '          edge.to === selectedNode.id && edge.toPort === \'refs\'\n'
      + '          && graph.nodes.some((node) => node.id === edge.from && (node.type === \'cast\' || node.type === \'scene\')))',
    to: '        const refWiredHere = castNodes.length > 0',
  },
  {
    name: 'a character wired to nothing stops saying that it is doing nothing',
    from: '          if (wired.length === 0) {',
    to: '          if (false) {',
  },
  {
    name: 'the two reference warnings stack again, both saying the same rule',
    from: '          && graph.nodes.some((node) => node.id === edge.from && node.type !== \'cast\'))',
    to: '          && graph.nodes.some((node) => node.id === edge.from))',
  },

  /* ---- 清空工作台: the project list and its delete ---- */
  {
    name: 'the project list is never rendered, so nothing can be seen or cleared',
    from: '      const projectsDialog = projectsOpen',
    to: '      const projectsDialog = false',
  },
  {
    name: 'a project is deleted on the first click, without asking',
    from: '                              onClick: () => setPendingGraphDelete(row.id),',
    to: '                              onClick: () => { void removeGraph(row.id) },',
  },
  {
    name: 'the list is not refreshed from the Host response, so a deleted project lingers',
    from: '          setGraphList(rest)',
    to: '          void rest',
  },
  {
    name: 'deleting the OPEN project leaves the canvas pointed at a graph the Host no longer has',
    from: '          if (id === graphId) {',
    to: '          if (false) {',
  },

  /* ---- the inspector: one line per type, one control per field, and the
     reference picture ---- */
  {
    name: 'a generate node gets BOTH duration controls back',
    from: '        if (takesDuration && supportedDurations === null) {',
    to: '        if (takesDuration) {',
  },
  {
    name: 'the model-driven duration control is dropped entirely',
    from: '        if (takesDuration && supportedDurations !== null) {',
    to: '        if (false) {',
  },
  {
    name: 'node types stop saying what they are for',
    from: '        const blurb = NODE_BLURB[selectedNode.type] ?? null',
    to: '        const blurb = null',
  },
  {
    name: 'the 角色/场景 panel shows the URL instead of the picture',
    from: '        const inspectorImage = /^https?:\\/\\//u.test(inspectorSource)',
    to: '        const inspectorImage = false && /^https?:\\/\\//u.test(inspectorSource)',
  },
  {
    name: 'clicking a finished clip in the bottom strip only selects the node again',
    from: '          onClick: () => openClip(row),',
    to: '          onClick: () => selectNode(row.node.id),',
  },
  {
    name: 'the key chip prints the key prefix and suffix again',
    from: "        h('b', null, keyInfo?.hasKey === true ? '已配置' : '未配置'))",
    to: "        h('b', null, keyInfo?.hasKey === true ? keyInfo.prefix + '…' + (keyInfo.suffix || '••••') : '未配置'))",
  },

  /* ---- the run controls: one subset control, a retry that works, and a poll
     that notices a run somebody else started ---- */
  {
    name: 'the poll interval is installed only while the CLIENT thinks a run is live',
    from: '        const period = snapshot?.running === true ? 4000 : 10000',
    to: '        if (snapshot?.running !== true) return undefined\n        const period = 4000',
  },
  {
    name: 'the retry control sends a plain run, so a failed shot stays dead',
    from: 'void startRun([selected], { retryFailed: true })',
    to: 'void startRun([selected])',
  },
  {
    name: 'the subset-run control claims to run the selection alone again',
    from: "          }, '▶ 运行这一镜及下游'),",
    to: "          }, '▶ 运行选中'),",
  },
]

copyFileSync(SRC, BAK)
const original = readFileSync(SRC, 'utf8')
let caught = 0

try {
  // A mutation run against an already-red suite proves nothing: every mutation
  // would be "caught" by the pre-existing failure. Refuse to start.
  const baseline = spawnSync(NODE, ['test-interact.mjs'], { encoding: 'utf8' })
  if (baseline.status !== 0) {
    console.log('BASELINE IS RED — fix the suite before mutating:')
    console.log(baseline.stdout.split('\n').filter((l) => l.trim().startsWith('FAIL')).map((l) => '   ' + l.trim()).join('\n'))
    process.exit(2)
  }
  console.log('baseline green\n')

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      console.log(`SKIP  ${m.name} — anchor not found`)
      continue
    }
    writeFileSync(SRC, original.replace(m.from, m.to))
    const run = spawnSync(NODE, ['test-interact.mjs'], { encoding: 'utf8' })
    const red = run.status !== 0
    console.log(`${red ? 'CAUGHT' : 'MISSED'}  ${m.name}`)
    if (!red) {
      console.log('   --- output tail ---')
      console.log(run.stdout.split('\n').slice(-12).join('\n'))
    } else {
      const failedLines = run.stdout.split('\n').filter((l) => l.trim().startsWith('FAIL') || l.trim().startsWith('ok'))
      const firstFail = failedLines.find((l) => l.trim().startsWith('FAIL'))
      if (firstFail) console.log('   ' + firstFail.trim())
    }
    if (red) caught += 1
    writeFileSync(SRC, original)
  }
} finally {
  writeFileSync(SRC, readFileSync(BAK, 'utf8'))
  copyFileSync(BAK, SRC)
  const restored = readFileSync(SRC, 'utf8') === original
  console.log(`\nrestored byte-identical: ${restored}`)
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'del', BAK.replace(/\//g, '\\')])
}

console.log(`\n${caught} of ${mutations.length} mutations caught`)
process.exit(caught === mutations.length ? 0 : 1)
