/**
 * Client-half static checks.
 *
 * The client cannot be exercised without the DSH shell, so this covers the
 * things that ARE checkable offline and that have actually gone wrong:
 *
 *   - the CSS lives in a template literal, so a backtick inside it (including
 *     inside a comment) terminates the string early and reports as a confusing
 *     SyntaxError — the reference implementation hit exactly this
 *   - every `dsh-ov-*` class the code uses has a rule, so a typo shows up here
 *     rather than as an unstyled element
 *   - `PANEL_KEY` is ONE string used for both registrations; using two is why
 *     the reference implementation's sidebar label click did nothing
 *   - the module registers through `window.__ModuleLoader__` with the expected
 *     exports
 *
 * Run: node test-client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { NODE_TYPES } from './lib/graph.js'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${error.message}`) }
}

const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')

/** Pull the CSS template literal out by scanning, not by regex — the delimiter is a backtick. */
function extractCss(text) {
  const marker = 'const CSS ='
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, 'CSS declaration not found')
  const open = text.indexOf('`', start)
  assert.notEqual(open, -1, 'CSS template literal not found')
  let index = open + 1
  while (index < text.length) {
    if (text[index] === '\\') { index += 2; continue }
    if (text[index] === '`') return text.slice(open + 1, index)
    index += 1
  }
  throw new Error('CSS template literal is not terminated — a stray backtick ends it early')
}

console.log('client: static contract\n')

await check('the CSS template literal is well-formed (no stray backticks)', () => {
  const css = extractCss(source)
  assert.ok(css.length > 1000, 'CSS should not be nearly empty')
  assert.equal((css.match(/`/g) ?? []).length, 0, 'a backtick inside the CSS ends the string early')
})

await check('every dsh-ov-* class used in code has a CSS rule', () => {
  const css = extractCss(source)
  const styled = new Set([...css.matchAll(/\.([a-z0-9-]+)/g)].map((m) => m[1]))
  const used = new Set()
  for (const match of source.matchAll(/className: '([^']+)'/g)) {
    for (const cls of match[1].split(/\s+/)) if (cls.startsWith('dsh-ov-')) used.add(cls)
  }
  const missing = [...used].filter((cls) => !styled.has(cls))
  assert.deepEqual(missing, [], `used but unstyled: ${missing.join(', ')}`)
})

await check('PANEL_KEY is one string used for BOTH registrations', () => {
  const declaration = /const PANEL_KEY = '([^']+)'/.exec(source)
  assert.ok(declaration, 'PANEL_KEY must be declared')
  const key = declaration[1]

  // Both slots must reference the constant rather than a literal, which is what
  // guarantees they cannot diverge.
  assert.match(source, /name: 'sidebar\.panellist', id: PANEL_KEY/, 'sidebar entry must use PANEL_KEY as its id')
  assert.match(source, /name: 'main', key: PANEL_KEY/, 'main slot must use PANEL_KEY as its key')
  // And no second literal that looks like a panel id.
  const literals = [...source.matchAll(/(?:id|key): '([a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(!literals.includes('openrouter-video'), 'the panel id must not be written as a second literal')
  assert.ok(key.length > 0)
})

await check('module registers through the CJS factory with the expected exports', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/, 'must register with the client module loader')
  assert.match(source, /id: 'dsh-openrouter-video'/, 'module id must match the package')
  assert.match(source, /factory: \(require\) =>/, 'a CJS-style factory taking require is the contract')
  assert.match(source, /exports\.apply = apply/)
  assert.match(source, /exports\.inject = \['slots'\]/)
  assert.match(source, /exports\.SidebarEntry = SidebarEntry/)
})

await check('only react is required (no bundler, no other runtime dep)', () => {
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(requires, ['react'])
})

await check('the abort copy states that in-flight jobs keep billing and cannot be cancelled', () => {
  // This sentence is a product decision, not decoration: the API has no cancel
  // endpoint, so claiming a cancel happened would be a lie.
  assert.match(source, /会继续计费/, 'abort must say billing continues')
  assert.match(source, /无法取消/, 'abort must say the job cannot be cancelled')
})

await check('ports are addressed by id, so their position can be MEASURED', () => {
  // Computing port coordinates arithmetically is the second-source-of-truth bug
  // the design prototype shipped; the fix was to read them from the DOM.
  assert.match(source, /id: 'ov-port-in-'/, 'input ports need stable ids for measurement')
  assert.match(source, /id: 'ov-port-out-'/, 'output ports need stable ids for measurement')
  assert.match(source, /getBoundingClientRect/, 'position must be measured, not computed')
})

await check('derived totals are computed once and shared, not hand-maintained per view', () => {
  assert.match(source, /const derived = React\.useMemo/, 'there must be a single derived-values memo')
  for (const key of ['ceilingTotal', 'totalSeconds', 'actualTotal', 'unknownCount']) {
    assert.ok(source.includes(key), `derived must expose ${key}`)
  }
  // The top bar, table and summary must all read from `derived`.
  const derivedUses = (source.match(/derived\./g) ?? []).length
  assert.ok(derivedUses >= 12, `expected the views to share derived values, saw ${derivedUses} uses`)
})

await check('cost is computed INSIDE the network-node guard, not after it', () => {
  // The prototype's white screen came from computing a value for every node and
  // only guarding its USE.
  assert.match(source, /if \(isNet\) \{[\s\S]{0,400}costText/, 'cost must be computed after the isNet check')
})

await check('the client node registry mirrors the Host node registry', () => {
  // NODE_META is a genuine second source of truth — the client cannot import the
  // Host module — and the plan's own rule is that it may carry PRESENTATIONAL
  // facts only. The failure mode when it drifts is silent: an unknown type falls
  // back to `NODE_META.note`, so a new node renders as an unlabelled grey blob
  // rather than as an error. Adding `cast` to lib/graph.js and forgetting it here
  // is exactly that bug.
  const block = /const NODE_META = \{([\s\S]*?)\n    \}/.exec(source)
  assert.ok(block, 'NODE_META must be findable')
  const clientTypes = [...block[1].matchAll(/^\s+([a-z]+): \{/gm)].map((m) => m[1]).sort()
  assert.deepEqual(clientTypes, Object.keys(NODE_TYPES).sort(),
    'a node type on the Host must exist on the client, or it renders as 注释')
})

await check('the key and the image bed live in the settings dialog, not in permanent chrome', () => {
  // They are configured once and then never touched, so two full-width rows were
  // permanent chrome paying rent for a dialog.
  assert.match(source, /className: 'dsh-ov-settings'/, 'the dialog must exist')
  assert.match(source, /'data-field': 'apiKey'/, 'the key input must be addressable')
  assert.match(source, /'data-field': 'bedUrl'/, 'the bed address must be addressable')
  assert.match(source, /'data-field': 'bedFolder'/)
  assert.match(source, /'data-field': 'bedUserAgent'/)
  assert.match(source, /'data-field': 'bedToken'/)
  assert.match(source, /'data-act': 'open-settings'/, 'the dialog must be reachable from the workspace')
  assert.match(source, /'data-act': 'test-bed'/, 'the bed must be probeable, not merely described')
  assert.ok(!/dsh-ov-keybar/.test(source), 'the removed strips must not leave dead markup behind')
})

await check('the 成片序列 node shows its film, so the export is not invisible', () => {
  assert.match(source, /className: 'dsh-ov-film'/, 'the sequence view must have a film panel')
  assert.match(source, /selectedNode\.type === 'seq'/, 'the inspector must render the seq node specially')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
