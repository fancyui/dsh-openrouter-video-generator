/**
 * preflight-load.mjs — packaging surface.
 *
 * Verifies the things that decide whether the plugin LOADS AT ALL, before any
 * of it is exercised:
 *
 *   - the package resolves by bare name and its entry exists
 *   - `exports["./client"]` is present (the shell fetches the client half by that
 *     subpath, so a missing entry means no UI and no error message)
 *   - `cordis.patch.yml` is declared and mounts exactly one plugin row
 *   - `dsh.manifestVersion` is 1 and `dsh.client.platform` is set
 *   - the compatibility declarations exist, and `peerDependencies` — the one DSH
 *     actually enforces — names `@deepseek-ai/dsh`
 *   - source files named in `files` are all present, because the git-install
 *     channel ships the package contents, not the working tree. A new lib file
 *     that was never committed is simply absent from the installed package.
 *
 * Run: node preflight-load.mjs
 */
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${error.message}`) }
}

const root = dirname(fileURLToPath(import.meta.url))
const read = (relative) => readFile(join(root, relative), 'utf8')
const exists = async (relative) => {
  try { await access(join(root, relative)); return true } catch { return false }
}

console.log('preflight: packaging and load surface\n')

const pkg = JSON.parse(await read('package.json'))

await check('package identity and entry point', () => {
  assert.equal(pkg.name, 'dsh-openrouter-video')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh?.manifestVersion, 1, 'dsh.manifestVersion is fixed at 1')
})

await check('exports["./client"] resolves to the client half', async () => {
  assert.equal(pkg.exports?.['./client'], './lib/client.js',
    'the shell loads the client through this subpath; without it there is no UI')
  assert.ok(await exists('lib/client.js'))
  assert.ok(await exists(pkg.exports['.']), 'the main export must exist on disk')
})

await check('importing the package by bare name yields the plugin contract', async () => {
  // Resolve through the package entry exactly as a loader would.
  const mod = await import('./lib/index.js')
  assert.equal(mod.name, 'openrouter-video')
  assert.deepEqual(mod.inject, ['tools'], 'inject must be exactly [tools]')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config !== undefined, 'a Config schema is required for the bundle patch')
})

await check('the client half is not imported by the Host half', async () => {
  // lib/client.js touches `window` at module scope; importing it on the Host
  // would throw at activation time.
  const host = await read('lib/index.js')
  assert.ok(!/from '\.\/client\.js'/.test(host), 'the Host must never import the browser client')
  const client = await read('lib/client.js')
  assert.match(client, /window\.__ModuleLoader__\.load/, 'the client registers itself with the shell')
})

await check('cordis.patch.yml declares exactly one insert row', async () => {
  const patch = await read('cordis.patch.yml')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'the bundle patch must be declared')
  const inserts = (patch.match(/^\s*-\s*insert:/gm) ?? []).length
  assert.equal(inserts, 1, 'exactly one insert: two mounts register the route prefix twice and throw at boot')
  assert.match(patch, /name: 'dsh-openrouter-video'/, 'the row must name this package')
  assert.match(patch, /id: openrouter-video/, 'the row id is the settings namespace')
})

await check('compatibility is declared in both the declarative and enforced places', () => {
  // `engines.dsh` is declared only; DSH actually checks peerDependencies.
  assert.ok(pkg.engines?.dsh, 'engines.dsh must be declared (declarative)')
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/dsh'], 'peerDependencies is what DSH enforces')
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']) {
    assert.ok(pkg.peerDependencies?.[name], `${name} is imported by the Host half and must be a peer`)
  }
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true,
    'optional peers keep the package loadable where those services are absent')
})

await check('client platform is declared for the web shell', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
})

await check('every file the package ships actually exists', async () => {
  // The git-install channel ships the `files` whitelist, not the working tree:
  // a new lib file that was never committed is absent from the installed package.
  //
  // The docs used to be skipped here because they did not exist yet, which made
  // this check unable to fail for the most likely omission of all. They exist
  // now, so nothing is exempt.
  const missing = []
  for (const entry of pkg.files ?? []) {
    if (!(await exists(entry))) missing.push(entry)
  }
  assert.deepEqual(missing, [], `declared but missing: ${missing.join(', ')}`)
})

await check('every lib module is syntactically loadable and listed in check', async () => {
  const { readdir } = await import('node:fs/promises')
  const libDir = join(root, 'lib')
  const files = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
  assert.ok(files.length >= 6, `expected the full lib set, saw ${files.length}`)
  for (const name of files) {
    if (name === 'client.js') continue // touches `window`; checked statically elsewhere
    // On Windows an absolute path must be a file:// URL for the ESM loader.
    await import(new URL(`./lib/${name}`, import.meta.url).href)
  }
  const checkScript = pkg.scripts?.check ?? ''
  for (const name of files) {
    assert.ok(checkScript.includes(`lib/${name}`), `lib/${name} is missing from the check script`)
  }
})

await check('the bundled skill ships with the package', async () => {
  assert.ok(pkg.files?.includes('skills'), 'skills/ must be in the shipped file list')
  assert.ok(await exists('skills/openrouter-video/SKILL.md'), 'the skill file must exist')
  const skill = await read('skills/openrouter-video/SKILL.md')
  assert.match(skill, /^---\r?\n/, 'the skill needs YAML frontmatter')
  assert.match(skill, /description:/, 'the frontmatter must carry a description for the catalog')
})

await check('no lifecycle scripts (the git channel refuses them)', () => {
  for (const key of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.equal(pkg.scripts?.[key], undefined, `${key} would make pnpm refuse the git install`)
  }
})

await check('undici is a real dependency, not a peer', () => {
  // @deepseek-ai/* are intercepted by the host; undici must be resolvable
  // inside the package or the plugin cannot make any request at all.
  assert.ok(pkg.dependencies?.undici, 'undici must be a regular dependency')
  assert.equal(pkg.peerDependencies?.undici, undefined, 'undici must not be a peer')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
