/**
 * 落点交接 — the STORY axis, which nothing covered.
 *
 * WHAT WAS MISSING
 * ----------------
 * A six-shot film with the character pinned and the place pinned still did not
 * hold together AS A STORY. Two axes were already covered:
 *
 *   identity — a fixed description repeated verbatim (lib/cast.js) plus a
 *              canonical reference image
 *   the seam — shot N-1's last frame becomes shot N's first frame (a `take`
 *              node; measured SSIM 0.949 across the seam, against 0.420 for two
 *              independent shots and 0.970 for two adjacent frames inside one
 *              clip)
 *
 * and one was covered by nothing at all: **what the previous shot ended on**.
 * A frame can show where he is; it cannot say "he is mid-spin, keep going" or
 * "he has just landed". Every shot's prompt was written in its own breath, so
 * five hard cuts restarted the action five times.
 *
 * The channel that looked like it existed did not. `brief` is a declared input
 * of `generate`/`extend`/`edit`, documented in README.md / MANUAL.md / SKILL.md
 * as 「成为那一镜提示词的开头」, and wired by `plan` into every shot — and it is
 * read by NOTHING. Measured with a loopback API: the script node's text reaches
 * no request body, a wired text node is dropped, and a shot with a wired brief
 * and no prompt of its own goes out with no prompt field at all and no warning.
 * (That dead port is its own defect and is not fixed here; this module does not
 * route through it.)
 *
 * WHY A MARKED HANDOFF, NOT A COPY OF THE PREVIOUS PROMPT
 * -------------------------------------------------------
 * The obvious version — paste the previous shot's prompt in front of this one —
 * is the wrong shape, for three reasons:
 *
 *   1. a video model renders what the prompt says, so the previous prompt makes
 *      it perform the previous shot again at the start of the new one;
 *   2. the previous prompt describes a whole shot (its own camera move, its own
 *      beat), not the state that shot ended in;
 *   3. on a chained shot the first frame already IS the previous last frame, so
 *      re-describing position and light is text that can fight the image.
 *
 * What crosses the seam is therefore a HANDOFF: what this shot leaves behind,
 * under a marker that says it has already been generated and is background
 * rather than an instruction. The shot's own prompt then describes only its
 * delta.
 *
 * FACTS, NOT POSE — AND NEVER AN ARGUMENT AGAINST THE CUT
 * -------------------------------------------------------
 * The handoff must not become a second chaining mechanism. Not every seam
 * continues the previous last frame: a hard cut to a new angle, a new size, a new
 * position is a normal edit, and the whole reason `chain: "none"` exists. So the
 * field carries **facts that survive the cut** — what he has done, what has
 * changed, who is in the room, how far the scene has moved — and explicitly NOT
 * pose, facing or camera angle. Those belong to the picture, which is the `take`
 * chain's job; and on an unchained shot the note says out loud that the shot may
 * change angle and does not have to match the previous frame.
 *
 * A note that read 「本镜从这里继续」 on every seam would make every seam a chain
 * while claiming not to.
 *
 * The marker is not decoration. It is the 「注明」 that keeps the model from
 * re-performing the previous beat, AND it is the idempotency key: `applyHandoff`
 * skips a prompt that already carries it, so an author who wrote the handoff by
 * hand does not get a second copy, and a resumed run does not stack one more
 * copy onto every retry. The guard is per block, for the same reason
 * `applyCast`'s is: a whole-prompt guard silently disables every later block.
 *
 * ORTHOGONAL TO CHAINING, ON PURPOSE
 * ----------------------------------
 * This is derived from EDITORIAL ORDER (`shotIndex`), not from the `take`
 * topology — because a hard cut is where it is needed most. A chained shot gets
 * the previous frame as its first frame; an unchained shot gets nothing at all
 * from the previous shot, and is exactly where a reference image is also allowed
 * to work (`frame_images` and `input_references` cannot be sent together). So
 * 「硬切 + 参考图 + 交接」 is a complete configuration, not a compromise: the
 * bibles and the plates pin how it looks, and this pins what just happened.
 *
 * A `take` chain adds pixel continuity on top; it is not a prerequisite, and its
 * absence does not make a seam wrong.
 *
 * HONEST LIMIT
 * ------------
 * This makes the handoff deterministic, checkable and idempotent. It does NOT
 * measure whether the model obeys it — that is a semantic claim, and this
 * workspace's precedent for continuity claims is to measure (SSIM 0.949 was
 * measured, not assumed). What is provable for free: the text reaches the
 * request, in film order, once, marked, and never from the wrong neighbour.
 */

/**
 * The first line of the injected block. Doubles as the idempotency key, so it
 * must be a string no author would type by accident and no other code path
 * would prepend.
 *
 * Note what it does NOT say: "本镜从这里继续". An earlier draft said exactly that,
 * and it is wrong — it makes the text do the job `chain` already does, and it
 * quietly argues against the cut. A hard cut to a new angle is a normal edit,
 * not a defect: the story continues while the picture deliberately does not. So
 * the marker claims only what is true of every seam: this already happened.
 */
export const HANDOFF_MARKER = '【上一段已生成·以下是已经发生的事实】'

/** The clause that says the text is context, not an instruction to render. */
const NOT_AGAIN = '以上已经发生，不要重演'

/**
 * The two closers, chosen by TOPOLOGY rather than by a new switch.
 *
 * Whether this shot's picture connects to the previous one is already expressed
 * by the graph: a `frames` wire means the first frame is supplied. So the block
 * reads the wiring instead of asking the author to state the same thing twice —
 * and, more importantly, the wording gets to be TRUE in both cases. The
 * unchained wording has to free the shot to cut, because that is the whole point
 * of an unchained shot; a note that said "画面是接上的" on every seam would make
 * every seam a chain.
 */
export const HANDOFF_NOTE_FRAMED = `（${NOT_AGAIN}；本镜的首帧来自上一段的末帧，不必再次描述画面）`
export const HANDOFF_NOTE_CUT = `（${NOT_AGAIN}；本镜是硬切，可以换机位、换景别，不必接上上一段的画面）`

/** The node field the end state lives in. Named once, read everywhere. */
export const HANDOFF_FIELD = 'endsOn'

/**
 * Which node types can carry a handoff.
 *
 * Exactly the ones that already declare a `prompt` field. `upscale` is a shot in
 * the editorial sense (it has a `shotIndex`) but takes no prompt — injecting one
 * would add a `prompt` to a request that has never carried one.
 */
export const HANDOFF_TYPES = ['generate', 'extend', 'edit']

/**
 * The story order, from the editorial order.
 *
 * `shots(graph)` is `generate`/`extend`/`edit`/`upscale`; the last one carries no
 * prompt, so it is a render leg rather than a story beat and must not become the
 * "previous shot" of the beat that follows it. Filtering here rather than in
 * each caller is what keeps `handoffFor` and `handoffUsage` counting the same
 * film.
 */
export const handoffOrder = (order) =>
  (Array.isArray(order) ? order : []).filter((node) => HANDOFF_TYPES.includes(node?.type))

/** The declared end state of a shot, trimmed. `''` when there is none. */
export function endsOnOf(node) {
  const text = node?.fields?.[HANDOFF_FIELD]
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * The handoff a shot should receive, or `null`.
 *
 * Takes the ALREADY-ORDERED shot list (`shots(graph)` — film order is
 * `shotIndex`, never topology) rather than importing it, so this module stays a
 * leaf: `lib/graph.js` can import it without a cycle, and both the request path
 * and `validate` derive the handoff from the same function instead of two
 * copies that drift.
 *
 * `framed` is whether the receiving shot's first frame is supplied (a `frames`
 * wire). It changes only the NOTE, never whether a handoff is sent.
 *
 * `null` covers all three "nothing crosses" cases with one value: the first
 * shot, a previous shot that declared no end state, and a node that is not in
 * the film at all.
 */
export function handoffFor(order, nodeId, framed = false) {
  const list = Array.isArray(order) ? order : []
  const index = list.findIndex((node) => node?.id === nodeId)
  if (index <= 0) return null
  const text = endsOnOf(list[index - 1])
  if (text.length === 0) return null
  return { fromId: list[index - 1].id, toId: nodeId, index, text, framed: framed === true }
}

/** The block as it is written into a prompt. `''` when there is no handoff. */
export function handoffBlock(handoff) {
  if (handoff === null || handoff === undefined) return ''
  const note = handoff.framed === true ? HANDOFF_NOTE_FRAMED : HANDOFF_NOTE_CUT
  return `${HANDOFF_MARKER}\n上一段结束时的情况：${handoff.text}\n${note}`
}

/**
 * Pin the handoff onto a shot prompt.
 *
 * Order is deliberate: the handoff goes ABOVE the bible blocks, so a prompt
 * reads as 「你从哪来」→「你是谁 / 这是哪」→「这一镜发生什么」.
 *
 * Idempotent by marker, and a prompt that already contains the marker is left
 * exactly as written — an author's own handoff outranks a generated one, which
 * is also what keeps a hand-written block from being doubled.
 */
export function applyHandoff(prompt, handoff) {
  const text = typeof prompt === 'string' ? prompt : ''
  const block = handoffBlock(handoff)
  if (block.length === 0) return text
  if (text.includes(HANDOFF_MARKER)) return text
  return text.trim().length === 0 ? block : `${block}\n\n${text}`
}

/**
 * How the seams of a film are covered. One shape for the plan receipt, the run
 * receipt and `validate`, so "5 处接缝里有 3 处没有落点" is never computed twice.
 *
 * `bare` is the list of seams whose PREVIOUS shot declared nothing — the seams
 * where the next shot starts from zero.
 */
export function handoffUsage(order) {
  const list = Array.isArray(order) ? order : []
  const seams = list.slice(1).map((node, position) => ({
    from: list[position],
    to: node,
    text: endsOnOf(list[position]),
  }))
  const bare = seams.filter((seam) => seam.text.length === 0)
  return {
    shots: list.length,
    declared: list.filter((node) => endsOnOf(node).length > 0).length,
    seams: seams.length,
    covered: seams.length - bare.length,
    bare,
  }
}
