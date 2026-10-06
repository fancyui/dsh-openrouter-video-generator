/**
 * Mutation-test the settings seam in the Host half.
 *
 * The bug being guarded against is specific: saving a key returned
 * `{ok:true}` while nothing was written, so the UI showed 未配置 forever.
 * A test suite that does not go red when that exact regression is reintroduced
 * is not evidence. Each mutation below restores one form of it.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'lib/index.js'
const BAK = 'lib/index.js.mutbak'
const NODE = process.env.NODE_BIN ?? process.execPath

const mutations = [
  {
    name: 'revert to the silent no-op: mutate config instead of calling the settings service',
    from: `        if (Object.keys(next).length > 0) await settingsEditor().update(NS, next)`,
    to: `        for (const [key, value] of Object.entries(next)) config[key]?.set?.(value)`,
  },
  {
    name: 'make a missing settings service a silent no-op again',
    from: `      throw new Error('设置服务不可用：当前 DSH 运行时没有挂载可写的配置编辑器，因此密钥无法保存。')`,
    to: `      return { update: async () => {} }`,
  },
  {
    name: 'read config only through reactive .get() (plain values collapse to defaults)',
    from: `    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw`,
    to: `    const value = raw?.get?.()`,
  },
  {
    name: 'clear the key by mutating config instead of persisting it',
    from: `        await settingsEditor().update(NS, { apiKey: '' })`,
    to: `        config.apiKey?.set?.('')`,
  },
  {
    name: 'let a malformed key reach the settings service',
    from: `            if (!value.trim().startsWith('sk-or-')) throw new Error('密钥形态不对，应以 sk-or- 开头')`,
    to: `            void 0`,
  },
  {
    name: 'the image-bed probe is dropped, so a Cloudflare challenge surfaces three shots in',
    from: `      if (action === 'bed/test' && method === 'POST') {`,
    to: `      if (action === 'bed/test-disabled' && method === 'POST') {`,
  },
  {
    name: 'the bed probe always claims success without contacting the bed',
    from: `        return sendJson(res, 200, up.ok === true
          ? { ok: true, url: up.url, message: \`图床可用，帧的公开地址会形如 \${up.url}\` }
          : { ok: false, error: up.error })`,
    to: `        void up
        return sendJson(res, 200, { ok: true, url: 'https://example.com/probe.png', message: 'ok' })`,
  },
  {
    name: 'the model shortlist is written through raw, undeduped and unbounded',
    from: `            next.models = [...new Set(value
              .filter((id) => typeof id === 'string' && id.trim().length > 0)
              .map((id) => id.trim()))].slice(0, 60)
            continue`,
    to: `            next.models = value
            continue`,
  },

  /* ---- 清空工作台 + 本机图发布: both were impossible while operating it ---- */
  {
    name: 'remove_graph reports success without removing anything, so the workspace can never be cleared',
    from: `          await graphStore.load()
          await graphStore.remove(id)
          return { ok: true, removed: id, graphs: graphSummaries() }`,
    to: `          return { ok: true, removed: id, graphs: graphSummaries() }`,
  },
  {
    name: 'the /graph/delete route never removes the project',
    from: `        const existed = await graphStore.remove(id)`,
    to: `        const existed = true`,
  },
  {
    name: 'a cast image_file is ignored, so the local path is sent to the provider verbatim',
    from: `            const source = typeof row.image_file === 'string' && row.image_file.trim().length > 0
              ? row.image_file
              : row.image_url`,
    to: `            const source = row.image_url`,
  },
  {
    name: 'the session-directory bound on a published file is dropped',
    from: `          if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error(\`\${label}只能读会话工作目录内的文件：\${raw}\`)
          }`,
    to: `          void rel`,
  },
  {
    name: 'the published URL is not what lands in the graph (the local path is stored instead)',
    from: '            const image = await toPublicUrl(spec.sources[index], `${fallback}「${name}」的参考图`)',
    to: '            const image = typeof spec.sources[index] === \'string\' ? spec.sources[index] : \'\'',
  },

  /* ---- 场景：同一个机制，钉住地点 ---- */
  {
    name: 'a per-shot cast roster also strips the scenes off that shot',
    from: `          const forThisShot = [
            ...scenes,
            ...(declared === null ? characters : characters.filter((row) => declared.includes(row.name))),
          ]`,
    to: `          const forThisShot = declared === null
            ? castCreated
            : castCreated.filter((row) => declared.includes(row.name))`,
  },
  {
    name: 'the scenes parameter is ignored, so a declared place is never built',
    from: `          { kind: 'scene', rows: Array.isArray(args?.scenes) ? args.scenes : [], names: [], descriptions: [], sources: [] },`,
    to: `          { kind: 'scene', rows: [], names: [], descriptions: [], sources: [] },`,
  },

  /* ---- measured live: a 26.3s "30s" film, and a filename full of · and + ---- */
  {
    name: 'the composer caches an INCOMPLETE film as final, so finishing a shot changes nothing',
    from: `  if (recorded === null) return false
  return recorded.join('|') === (Array.isArray(clipKeys) ? clipKeys : []).join('|')`,
    to: `  void recorded
  return true`,
  },
  {
    name: 'the filename deny list is back, so · and + reach the delivered filename',
    from: "    .replace(/[^\\p{L}\\p{N}_-]+/gu, '-')",
    to: '    .replace(/[<>:"/\\\\|?*]/gu, \'-\')',
  },
  {
    name: 'the delete receipt drops the 已删除 line, so a successful clear reads as an empty state',
    from: "          const removed = typeof value.removed === 'string' && value.removed.length > 0",
    to: '          const removed = false',
  },
  {
    name: 'the /graph/run route ignores retry_failed, so the panel cannot recover a dead shot',
    from: '          fresh: body?.retry_failed === true,',
    to: '          fresh: false,',
  },
]

/**
 * Which suite(s) must go red for a mutation to count as caught.
 *
 * The Host half is reached through two doors — the agent tools and the workspace
 * routes — and they live in different suites. A single suite per mutation meant a
 * pass-through that only ONE door used could be deleted with every mutation run
 * still green, which is how `retry_failed` reached the tool and not the route.
 * Caught by ANY listed suite is caught.
 */
const SUITES = (process.env.SUITE ?? 'smoke.mjs,test-api-url.mjs').split(',').map((s) => s.trim())

copyFileSync(SRC, BAK)
const original = readFileSync(SRC, 'utf8')
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
  console.log(`baseline green (${SUITES.join(' + ')})\n`)

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      console.log(`SKIP    ${m.name} — anchor not found`)
      continue
    }
    writeFileSync(SRC, original.replace(m.from, m.to))
    let red = false
    let failLine = null
    for (const suite of SUITES) {
      const run = spawnSync(NODE, [suite], { encoding: 'utf8' })
      if (run.status !== 0) {
        red = true
        failLine = failLine ?? run.stdout.split('\n').find((l) => l.trim().startsWith('FAIL'))
      }
    }
    console.log(`${red ? 'CAUGHT' : 'MISSED'}  ${m.name}`)
    if (red) {
      if (failLine) console.log('        ' + failLine.trim())
    } else {
      console.log('        every suite stayed GREEN — the assertion is vacuous')
    }
    if (red) caught += 1
    writeFileSync(SRC, original)
  }
} finally {
  copyFileSync(BAK, SRC)
  console.log(`\nrestored byte-identical: ${readFileSync(SRC, 'utf8') === original}`)
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'del', BAK.replace(/\//g, '\\')])
}

console.log(`\n${caught} of ${mutations.length} mutations caught`)
process.exit(caught === mutations.length ? 0 : 1)
