/**
 * 角色库: reusable characters, wired per shot.
 *
 * WHY THIS EXISTS
 * ---------------
 * A 12-shot film rendered with the same model, the same style prompt and working
 * first/last-frame chaining still came out with a **different cat in every shot**.
 * Chaining fixes the seam — measured SSIM 0.90 across it, against 0.39 for
 * independent shots — but it fixes the *transition*, not the *identity*. Two
 * things were missing:
 *
 *   1. **A pinned description.** Every shot's prompt was written in its own
 *      breath, so "a grey cat" in shot 1 became "a bluish cat" in shot 3 and "a
 *      cartoon kitten" in shot 9. A model cannot hold an identity the prompt
 *      itself keeps redefining.
 *   2. **A canonical image.** Text pins a *kind* of cat, not *this* cat.
 *
 * WIRED, NOT GLOBAL — and the first draft of this module got that wrong.
 *
 * It shipped as a GLOBAL node: every `cast` in the graph was applied to every
 * shot. That is wrong for the same reason a per-shot call sheet is right:
 * different shots have different characters in them. Shot 3 is the cat alone;
 * shot 7 is the cat, the mouse and the dog. A global fan-out hands the provider a
 * reference to a mouse that is not in the scene — and, because the API accepts
 * only a bounded number of references, it spends that budget on characters the
 * shot does not contain.
 *
 * So a `cast` node is a **character definition** (name, description, image) and
 * its `asset` output is wired into the `refs` port of each shot that character
 * appears in. One definition, many shots: the same node fans out to all twelve
 * if the cat is in all twelve, and to three of them if it is in three. Editing
 * the description once changes every shot it is wired to.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * This is a text-and-reference anchor, not identity preservation. It is the
 * cheap end of the ladder (see skills/openrouter-video/SKILL.md). It cannot beat
 * the frames/references exclusion: the provider REFUSES a request that carries
 * both, so on a chained shot the plugin drops the character sheet before sending
 * — which is exactly why a hard cut (an unchained shot) is where a character
 * reference does its real work.
 */

/**
 * The first line of the injected block, per KIND of bible.
 *
 * `cast` pins the character; `scene` pins the PLACE. They are the same mechanism
 * — a fixed text block plus an optional reference image, wired to the shots it
 * applies to — because that is what identity actually needs, and a film has more
 * than one thing that must not drift. Six independent hard cuts with nothing but
 * per-shot prose gave a character that stayed and a ROOFTOP that did not: new
 * graffiti, new wall, new hour of the day, three times over.
 *
 * The marker doubles as the idempotency key, so it must be a string no author
 * would type by accident and no other code path would prepend.
 */
export const CAST_MARKER = '【角色设定·所有镜头必须一致】'
export const SCENE_MARKER = '【场景设定·所有镜头必须一致】'

/**
 * Every kind of pinned setting, and how it announces itself.
 *
 * Keyed by NODE TYPE, so a row's kind is read off the node rather than stored a
 * second time. `order` fixes the order blocks are written in, because a block
 * order that depends on a Map's insertion order is a prompt that changes for no
 * reason between two identical runs.
 */
export const BIBLES = {
  cast: { marker: CAST_MARKER, label: '角色', fallbackName: '未命名角色', descriptionLabel: '固定外形描述' },
  scene: { marker: SCENE_MARKER, label: '场景', fallbackName: '未命名场景', descriptionLabel: '固定场景描述' },
}
export const BIBLE_TYPES = Object.keys(BIBLES)
export const BIBLE_ORDER = ['scene', 'cast']

/**
 * Every bible DEFINED in a graph, in canvas order.
 *
 * Order is `(y, x, id)` rather than node-array order so that moving a node
 * changes the order the block is written in, and so the result is stable across
 * a save/load round trip.
 */
export function bibleLibrary(graph, options = {}) {
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : BIBLE_TYPES
  const rows = (graph?.nodes ?? [])
    .filter((node) => node !== null && typeof node === 'object')
    .filter((node) => node.disabled !== true && kinds.includes(node.type))
    .map((node) => ({
      nodeId: node.id,
      kind: node.type,
      name: typeof node.fields?.name === 'string' && node.fields.name.trim().length > 0
        ? node.fields.name.trim()
        : (typeof node.title === 'string' && node.title.trim().length > 0
            ? node.title.trim()
            : BIBLES[node.type].fallbackName),
      description: typeof node.fields?.description === 'string' ? node.fields.description.trim() : '',
      source: typeof node.fields?.source === 'string' && node.fields.source.trim().length > 0
        ? node.fields.source.trim()
        : null,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
    }))
  rows.sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.nodeId).localeCompare(String(b.nodeId)))
  return rows.map(({ y, x, ...rest }) => rest)
}

/** Only the characters. Kept as its own export because callers ask for exactly that. */
export function castLibrary(graph) {
  return bibleLibrary(graph, { kinds: ['cast'] })
}

/** Only the places. */
export function sceneLibrary(graph) {
  return bibleLibrary(graph, { kinds: ['scene'] })
}

/**
 * Which settings are wired into a given shot — characters AND scenes.
 *
 * This is the ONLY correct scope: the things actually true of this shot. Derived
 * from the graph's edges rather than stored, so undoing a wire immediately
 * un-pins it — a stored copy would be a second source of truth and would drift
 * on the first rewire.
 */
export function bibleFor(graph, nodeId) {
  const wired = new Set(
    (graph?.edges ?? [])
      .filter((edge) => edge?.to === nodeId && edge?.toPort === 'refs')
      .map((edge) => edge.from),
  )
  if (wired.size === 0) return []
  return bibleLibrary(graph).filter((row) => wired.has(row.nodeId))
}

/** Characters only, for the callers that mean characters. */
export function castFor(graph, nodeId) {
  return bibleFor(graph, nodeId).filter((row) => row.kind === 'cast')
}

/**
 * castNodeId → [shotNodeId, …]. The roster's "出场 N 镜" column, and how
 * `validate` can tell a character that is defined but never used from one that
 * is doing work.
 */
export function castUsage(graph) {
  const usage = new Map()
  for (const row of bibleLibrary(graph)) usage.set(row.nodeId, [])
  for (const edge of graph?.edges ?? []) {
    if (edge?.toPort !== 'refs' || !usage.has(edge.from)) continue
    const list = usage.get(edge.from)
    if (!list.includes(edge.to)) list.push(edge.to)
  }
  return usage
}

/**
 * The blocks that get prepended to a shot's prompt, one per kind.
 *
 * Only settings with a description contribute: a name on its own pins nothing,
 * and an empty header in every prompt is pure noise. When nothing is described
 * this returns `[]`, and `applyCast` becomes the identity function — so a graph
 * with no bibles behaves exactly as it did before this module existed.
 */
export function bibleBlocks(rows) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  for (const kind of BIBLE_ORDER) {
    const described = list.filter((row) => row?.kind === kind && (row?.description ?? '').length > 0)
    if (described.length === 0) continue
    out.push({
      kind,
      marker: BIBLES[kind].marker,
      body: described.map((row) => `${row.name}: ${row.description}`).join('\n'),
    })
  }
  return out
}

/** All blocks as one string. Empty when nothing is described. */
export function castPromptBlock(rows) {
  return bibleBlocks(rows).map((block) => `${block.marker}\n${block.body}`).join('\n')
}

/**
 * Pin the bibles onto a shot prompt.
 *
 * There is no `enabled` option: what is handed in is already the set of settings
 * WIRED to this shot, so "this shot has no cast" arrives as an empty list, not
 * as a boolean that has to be kept in sync with the wires.
 *
 * Idempotent PER BLOCK, not per prompt. The old guard was
 * `startsWith(CAST_MARKER)` — so once a prompt carried the character block, a
 * scene block added later was silently never applied, and the scene drifted
 * exactly as before while the code reported it pinned. Each block is now skipped
 * only if ITS OWN marker is already present.
 *
 * Idempotence matters because this runs on every request and a resumed run
 * rebuilds the request from the stored node fields: without a guard, re-running a
 * shot would stack a second copy of the bible onto the first, and a third on the
 * next retry, inflating the prompt (and, on a token-priced model, the bill) with
 * every attempt.
 */
export function applyCast(prompt, rows) {
  const text = typeof prompt === 'string' ? prompt : ''
  const missing = bibleBlocks(rows).filter((block) => !text.includes(block.marker))
  if (missing.length === 0) return text
  const head = missing.map((block) => `${block.marker}\n${block.body}`).join('\n')
  return text.trim().length === 0 ? head : `${head}\n\n${text}`
}

/**
 * Cast images as `input_references` entries.
 *
 * The request path does NOT call this: a wired `cast` node reaches
 * `input_references` through the ordinary edge loop, exactly like a `ref` node —
 * one mechanism, not two. It stays here because the roster and the run receipt
 * both need to say "these images will be sent", and because deduping by URL is a
 * rule worth keeping in one place.
 */
export function castReferences(cast) {
  const seen = new Set()
  const out = []
  for (const row of Array.isArray(cast) ? cast : []) {
    const url = row?.source ?? null
    if (url === null || seen.has(url)) continue
    seen.add(url)
    out.push({ type: 'image_url', image_url: { url } })
  }
  return out
}

/**
 * One-line summary for a run receipt. Never says "consistent" — only what was
 * pinned, and which definitions are doing nothing.
 *
 * Scenes are reported alongside characters because a film that drifts is not
 * only a film where the cat changes: the rooftop changing between shot 1 and
 * shot 4 is the same defect, arrived at by a different door.
 */
export function describeCast(graph) {
  const library = bibleLibrary(graph)
  if (library.length === 0) return null
  const usage = castUsage(graph)
  const described = library.filter((row) => row.description.length > 0)
  const namesOf = (kind) => library.filter((row) => row.kind === kind).map((row) => row.name)
  return {
    characters: namesOf('cast'),
    scenes: namesOf('scene'),
    descriptions: described.length,
    images: library.filter((row) => row.source !== null).length,
    /**
     * Defined but wired to nothing. This is the "I made a character and nothing
     * happened" state, and it is worth saying out loud: the definition is
     * silently inert until it is on a shot.
     */
    unused: library.filter((row) => (usage.get(row.nodeId) ?? []).length === 0)
      .map((row) => `${BIBLES[row.kind].label}「${row.name}」`),
  }
}

export const castInternals = { CAST_MARKER, SCENE_MARKER }
