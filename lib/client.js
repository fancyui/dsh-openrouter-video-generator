/**
 * dsh-openrouter-video — Client half.
 *
 * A workspace of its own, NOT a conversation surface. Two registrations:
 *
 *   1. `sidebar.panellist` — the entry, sitting with the sidebar's global panel
 *      icons. A list slot, additive, replaceRisk none.
 *   2. `main` — a keyed slot ("the central panel selected by sidebar entry
 *      id"), registered under the same key. Clicking the entry selects it and
 *      the whole central area becomes this workspace.
 *
 * `PANEL_KEY` must be ONE string used twice: the `sidebar.panellist` id and the
 * `main` key. The shell hands the row's id to `layout.selectPanel`, which
 * refuses an id no `main` entry answers to — the reference implementation had
 * two different strings here and a click on the sidebar *label* silently did
 * nothing, while the icon appeared to work only because the button selected
 * itself.
 *
 * Self-contained by hand, no bundler: the client module system wraps this in a
 * CJS factory and the kernel adopts `{ apply, inject }`.
 *
 * NOTE ON CSS: the stylesheet below is a template literal, so a backtick
 * anywhere inside it — including inside a comment — ends the string early and
 * reports as `SyntaxError: Unexpected identifier`. The reference implementation
 * hit exactly that. Do not put backticks in CSS comments.
 */
window.__ModuleLoader__.load({
  id: 'dsh-openrouter-video',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.for('Module.toStringTag'), { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/openrouter-video/api'
    const PANEL_KEY = 'dsh-openrouter-video'

    /* ================================================================ *
     * node type registry — MIRRORS lib/graph.js
     *
     * The client cannot import the Host module, so this table is duplicated.
     * That is a real second source of truth, and it is the one place the
     * plan's own warning applies: keep it to purely PRESENTATIONAL facts
     * (label, colour, port names) and let every RULE — validation, pricing,
     * scheduling — stay on the Host, which is asked over the API. A version
     * skew then costs a wrong colour, never a wrong charge.
     * ================================================================ */
    const NODE_META = {
      script: { label: '脚本/分镜', color: '#8b8b95', inputs: [], outputs: [['shots', 'shots'], ['brief', 'text']] },
      prompt: { label: '提示词', color: '#8b8b95', inputs: [], outputs: [['text', 'text']] },
      ref: { label: '参考素材', color: '#39c5cf', inputs: [], outputs: [['asset', 'image[]']] },
      /* WIRED. This comment claimed the opposite ("Global, not wired: the Host
         reads every `cast` node off the graph and pins it onto every shot") for
         two revisions after the code stopped doing that — the third copy of the
         first draft hiding in a comment, and the source of the 角色 inspector that
         told the reader its nodes were live while they were inert. A `cast` node
         is one character DEFINITION; its asset output goes into the refs port of
         each shot the character is in. */
      cast: { label: '角色', color: '#f778ba', inputs: [], outputs: [['asset', 'image[]']] },
      /* The same mechanism, pinning the PLACE. Six independent hard cuts with
         nothing but per-shot prose kept the character and lost the rooftop. */
      scene: { label: '场景', color: '#c78c3c', inputs: [], outputs: [['asset', 'image[]']] },
      generate: {
        label: '生成', color: '#4c8dff',
        inputs: [['brief', 'text'], ['frames', 'image[]'], ['refs', 'image[]']],
        outputs: [['job', 'job']],
      },
      extend: {
        label: '续接', color: '#a371f7',
        inputs: [['job', 'job', true], ['brief', 'text']],
        outputs: [['job', 'job']],
      },
      edit: {
        label: '编辑', color: '#a371f7',
        inputs: [['video', 'video', true], ['brief', 'text']],
        outputs: [['job', 'job']],
      },
      upscale: {
        label: '超分', color: '#a371f7',
        inputs: [['job', 'job', true]],
        outputs: [['job', 'job']],
      },
      take: {
        label: '取帧', color: '#e3873a',
        inputs: [['job', 'job', true]],
        outputs: [['image', 'image[]']],
      },
      seq: { label: '成片序列', color: '#3fb950', inputs: [['jobs', 'job', true]], outputs: [['manifest', 'manifest']] },
      note: { label: '注释', color: '#5a5a63', inputs: [], outputs: [] },
      group: { label: '分组', color: '#5a5a63', inputs: [], outputs: [] },
      template: { label: '模板', color: '#5a5a63', inputs: [], outputs: [] },
    }

    const NETWORK_TYPES = new Set(['generate', 'extend', 'edit', 'upscale'])
    const SHOT_TYPES = new Set(['generate', 'extend', 'edit', 'upscale'])

    /** Port colour by data type. Same table the Host validates against. */
    const PORT_COLOR = {
      text: '#8b8b95', shots: '#8b8b95', brief: '#8b8b95',
      'image[]': '#39c5cf', audio: '#39c5cf',
      video: '#a371f7', job: '#4c8dff', manifest: '#3fb950',
    }

    /** Mirrors MULTI_INPUT_PORTS in lib/graph.js — used only to REFUSE a drag early. */
    const PORT_ACCEPTS = {
      brief: ['text', 'shots'], frames: ['image[]'], refs: ['image[]'],
      video: ['job', 'video'], audio: ['audio'], job: ['job'], jobs: ['job'],
      text: ['text'], shots: ['shots'],
    }

    /**
     * Ports that accumulate instead of replacing. Mirrors `MULTI_INPUT_PORTS`.
     *
     * The port click below used to evict unconditionally, so the canvas enforced
     * "one reference image per shot" even after the Host stopped enforcing it —
     * and a second wire silently deleted the first, which is the worst way for a
     * limit to behave: the user sees the old connection disappear and assumes
     * they mis-clicked. A shot needs the cat AND the mouse.
     */
    const MULTI_PORTS = new Set(['jobs', 'frames', 'refs'])

    const metaOf = (type) => NODE_META[type] ?? NODE_META.note
    const isNetwork = (node) => NETWORK_TYPES.has(node?.type) && node?.disabled !== true

    /**
     * What each node type is FOR, in one line.
     *
     * Only 角色 and 场景 had a description; every other type opened to a stack of
     * fields with nothing saying what the node does or which port feeds it — the
     * reader had to infer the dataflow from the port names. These are the same
     * sentences the skill and the manual use, kept in the vocabulary of ports:
     * `long` is the fuller explanation, one hover away, so the panel can stay one
     * line. Purely presentational, like NODE_META — no rule lives here.
     */
    const NODE_BLURB = {
      script: {
        text: '一段分镜文字。从 shots 口连到镜头的 brief 口，成为那一镜提示词的开头。',
        long: '一个 script 节点是一份可以复用的分镜稿。连到多个镜头的 brief 口时，'
          + '每个镜头都会拿到它作为提示词的开头 —— 想逐镜不同就每镜一个 script。',
      },
      prompt: {
        text: '一段共享提示词。从 text 口连到镜头的 brief 口。',
        long: '和 script 是同一个机制，只是名字更贴合"一段风格/画质描述"。'
          + '多个镜头共用一段风格时用它，不必逐镜重复粘贴。',
      },
      ref: {
        text: '一张参考图或一段素材。连到镜头 refs 口，作为 input_references 发送。',
        long: 'kind 决定它是什么；接到 frames 口的那一张按 slot 当作首帧或尾帧。'
          + '注意 frames 与 refs 不能同发 —— provider 会拒绝整个请求。',
      },
      cast: {
        text: '可复用的角色定义：名称 + 参考图 + 固定描述。把 asset 口拉到它出场的镜头的 refs 口；'
          + '没连线的角色不起作用。',
        long: '一个「角色」节点 = 一个角色的可复用定义：名称 + 参考图 + 固定外形描述。'
          + '从 asset 口拉线到每个它出场的镜头的 refs 口；没连线的角色对这条片子完全不起作用。'
          + '描述会被原样插进它出场镜头的提示词开头；参考图作为 input_references 发给那些镜头。'
          + '注意 frame_images 与 input_references 不能同发 —— provider 会拒绝整个请求，插件只发首帧、丢掉参考图；'
          + '接了首帧的镜头拿不到参考图，那些镜头靠接龙 + 提示词里原样重复的固定描述保持一致。',
      },
      scene: {
        text: '可复用的场景定义：地点 + 环境空镜 + 固定描述。把 asset 口拉到它出场的镜头的 refs 口；'
          + '没连线的场景不起作用。',
        long: '一个「场景」节点 = 一个地点的可复用定义：名称 + 环境空镜 + 固定的地点/时间/光线/材质描述。'
          + '从 asset 口拉线到每个发生在它里面的镜头的 refs 口；没连线的场景不起作用。'
          + '描述会被原样插进它出场镜头的提示词开头；空镜作为 input_references 发给那些镜头。'
          + '空镜里不要带角色，否则模型可能照着它复制一个人出来。'
          + '注意 frame_images 与 input_references 不能同发 —— provider 会拒绝整个请求，插件只发首帧、丢掉参考图。',
      },
      generate: {
        text: '一次视频生成。brief 给提示词、frames 给首/尾帧、refs 给参考图，输出一个 job。',
        long: '这是唯一会给这一镜生成新画面的节点。prompt 字段写这一镜里发生的事（景别、运镜、动作），'
          + '模型/时长/分辨率/画幅都可以逐镜覆盖。frames 与 refs 不能同发。',
      },
      extend: {
        text: '在上游 job 的末尾继续生成，把一条镜头接长。输出新的 job。',
        long: 'extend 模式的输入是上一段的 job id，它从那一镜的末帧往下续。'
          + '想接长一条镜头用它，而不是把两条独立镜头拼在一起。',
      },
      edit: {
        text: '拿一段已有的视频做修改（edit 模式）。输入 video + brief。',
        long: 'edit 改的是内容而不是长度：输入必须是视频资源，brief 描述要改成什么样。',
      },
      upscale: {
        text: '把上游 job 的成片放大。只吃 job，不需要提示词。',
        long: '超分不产生新内容，只提高分辨率；creativity 决定它允许补多少细节。',
      },
      take: {
        text: '从上游成片里取一帧，交给下一镜当首帧 —— 接龙就是靠它实现的。',
        long: 'frame 选首帧还是尾帧，slot 决定交给下游当首帧还是尾帧。'
          + '取出的帧会先上传到图床换成公开 URL，因为 API 只接受 https 地址；'
          + '没配图床或上传失败时，这一镜会退化成独立生成。',
      },
      seq: {
        text: '把上游每一镜按 shotIndex 拼成一条 mp4，并写出该镜用了哪个文件的 manifest。',
        long: '拼接默认走 -c copy（不重编码）；各镜的编码/分辨率/有没有音轨不一致时才统一转码。',
      },
      note: { text: '画布上的便签。不参与执行，不花任何钱。' },
      group: { text: '把若干节点框在一起，纯视觉分组。不参与执行。' },
      template: { text: '一段可复制的参数模板。不参与执行。' },
    }

    /**
     * Allowed values for each `select` field, per node type.
     *
     * A single hardcoded `['first_frame','last_frame']` used to serve every
     * select in the inspector, so a NEW select field silently rendered with
     * somebody else's options — and a value the Host never accepted looked
     * perfectly selectable. Keyed the same way as the Host's own field table.
     */
    const SELECT_OPTIONS = {
      'take.frame': ['first_frame', 'last_frame'],
      'take.slot': ['first_frame', 'last_frame'],
      'ref.kind': ['image', 'video', 'audio'],
      'ref.slot': ['first_frame', 'last_frame', 'reference'],
      'upscale.creativity': [0, 1],
    }
    const selectOptionsFor = (type, key) => SELECT_OPTIONS[`${type}.${key}`] ?? []

    /* ================================================================ *
     * styles
     * ================================================================ */
    const CSS = `
.dsh-ov-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-base)}
.dsh-ov-top{flex:0 0 auto;display:flex;align-items:center;gap:10px;row-gap:6px;flex-wrap:wrap;padding:8px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-ov-title{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
.dsh-ov-graphpick{display:flex;align-items:center;gap:6px;max-width:320px;background:none;
  border:1px solid transparent;border-radius:8px;padding:2px 6px;cursor:pointer;font:inherit;
  color:var(--dsw-alias-label-primary);text-align:left}
.dsh-ov-graphpick:hover{border-color:var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-ov-caret{font-size:9px;color:var(--dsw-alias-label-tertiary)}
.dsh-ov-count{font-size:10px;font-weight:700;border-radius:8px;padding:0 6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dsh-ov-graphrow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;margin-bottom:7px;
  background:var(--dsw-alias-interactive-bg-hover,transparent)}
.dsh-ov-graphrow[data-current="1"]{border-color:var(--dsw-alias-brand-primary)}
.dsh-ov-graphrow[data-doomed="1"]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-ov-graphmeta{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-ov-gnote{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ov-gwarn{font-size:10.5px;color:var(--dsw-alias-state-error-primary)}
.dsh-ov-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-left:6px}
.dsh-ov-seg{display:flex;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  border-radius:8px;padding:2px;gap:2px;border:1px solid var(--dsw-alias-border-l2)}
.dsh-ov-seg button{padding:3px 11px;border-radius:6px;font-size:12px;border:none;cursor:pointer;
  background:none;color:var(--dsw-alias-label-secondary)}
.dsh-ov-seg button:hover{color:var(--dsw-alias-label-primary)}
/* Painting white text on a brand-primary fill looked right on paper and was
   invisible on screen: in the dark theme brand-primary is the near-WHITE accent
   (static-neutral-bluish-50), so the active tab and every primary button shipped
   a white label on a white fill. The token that pairs with that fill is
   label-primary-foreground — a near-black — and button-primary-hover is the
   designed hover. Pairing a fill with a hardcoded #fff is what made an entire
   control disappear. */
.dsh-ov-seg button[data-on="1"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground,#151517);font-weight:500}
.dsh-ov-seg button[data-on="1"]:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dsh-ov-spacer{flex:1}
/* Pills and the view switch sit on interactive-bg-hover, NOT on bg-layer-2.
   In the light theme bg-base and bg-layer-1/2/3 are ALL the same near-white, so a
   surface built from them has no fill at all — every chip and tab was invisible
   until you looked for its 4% border. interactive-bg-hover is the DSH token for
   "a subtle translucent surface over whatever is behind": 6% dark navy in light,
   8% white in dark. It adapts by construction. */
.dsh-ov-pill{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  border:1px solid var(--dsw-alias-border-l2);border-radius:7px;
  padding:3px 9px;white-space:nowrap}
.dsh-ov-pill b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-ov-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.dsh-ov-dot[data-ok="1"]{background:var(--dsw-alias-state-success-primary)}
.dsh-ov-dot[data-run="1"]{background:var(--dsw-alias-state-warn-primary)}
.dsh-ov-dot[data-err="1"]{background:var(--dsw-alias-state-error-primary)}
/* A configured secret is shown as a green lamp and the WORD, never as a slice
   of the value. The chip used to print the prefix and suffix, which put four real
   characters of an API key on screen at all times — on a projection, in a
   screenshot, in a bug report. "Is there a key" is the fact that explains a
   failure; which key it is, is not. */
/* Buttons. bg-layer-2 plus a 6% border is a visible button in the dark theme and
   an invisible one in the light theme, where both resolve to the same near-white
   the panel and the border is 4% black. The floating-fill token is the surface
   DSH itself uses for a button, and it is correct in both: #2c2c2e in dark, pure
   white in light — where the 10% border and the hover fill carry the affordance. */
.dsh-ov-btn{background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-2));
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-primary);
  transition:background .12s ease,border-color .12s ease}
.dsh-ov-btn:hover{background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-layer-3));
  border-color:var(--dsw-alias-border-l3)}
.dsh-ov-btn:active{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3))}
.dsh-ov-btn[disabled]{opacity:.45;cursor:default}
.dsh-ov-btn[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-ov-btn[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground,#151517)}
.dsh-ov-btn[data-kind="primary"]:hover{
  background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));
  border-color:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dsh-ov-body{flex:1;display:flex;min-height:0}
.dsh-ov-left{flex:0 1 186px;min-width:128px;border-right:1px solid var(--dsw-alias-border-l1);display:flex;
  flex-direction:column;min-height:0;overflow:hidden}
.dsh-ov-right{flex:0 1 282px;min-width:168px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;
  flex-direction:column;min-height:0;overflow:hidden}
.dsh-ov-center{flex:1;position:relative;min-width:0;display:flex;flex-direction:column}
.dsh-ov-head{padding:9px 12px 5px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);
  letter-spacing:.5px;text-transform:uppercase}
.dsh-ov-scroll{overflow-y:auto;flex:1;min-height:0}
.dsh-ov-ntype{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:12.5px;cursor:grab}
.dsh-ov-ntype:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-ov-swatch{width:3px;height:14px;border-radius:2px;flex:0 0 auto}
.dsh-ov-net{margin-left:auto;font-size:10px;color:var(--dsw-alias-state-warn-primary);font-weight:600}
.dsh-ov-asset{padding:5px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);
  display:flex;gap:8px;align-items:center;overflow:hidden}
.dsh-ov-asset span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.dsh-ov-centerstage{position:relative;flex:1 1 auto;min-height:0;display:flex}
.dsh-ov-canvas{flex:1;position:relative;overflow:hidden;min-height:0;cursor:grab;
  background-image:linear-gradient(rgba(127,127,140,.10) 1px,transparent 1px),
    linear-gradient(90deg,rgba(127,127,140,.10) 1px,transparent 1px);
  background-size:26px 26px}
.dsh-ov-canvas[data-grab="1"]{cursor:grabbing}
.dsh-ov-world{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.dsh-ov-edges{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
.dsh-ov-node{position:absolute;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:9px;cursor:pointer;user-select:none;
  box-shadow:0 2px 10px rgba(0,0,0,.18)}
.dsh-ov-node[data-sel="1"]{border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 1px var(--dsw-alias-brand-primary),0 3px 14px rgba(0,0,0,.24)}
.dsh-ov-node[data-state="in_progress"]{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-ov-node[data-state="failed"]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-ov-node[data-disabled="1"]{opacity:.45}
.dsh-ov-nhead{display:flex;align-items:center;gap:6px;padding:5px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  border-radius:8px 8px 0 0}
.dsh-ov-ntitle{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;flex:1}
.dsh-ov-ntitle-edit{font:inherit;font-size:12px;font-weight:600;padding:0 4px;height:18px;
  min-width:0;border:1px solid var(--dsw-alias-brand-primary);border-radius:4px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-ov-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
.dsh-ov-row .dsh-ov-btn{padding:1px 7px;font-size:11px}
.dsh-ov-shot{font-size:9.5px;font-weight:700;color:#fff;background:var(--dsw-alias-label-tertiary);
  border-radius:4px;padding:1px 5px;flex:0 0 auto}
.dsh-ov-portrows{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:5px 0 2px}
.dsh-ov-ports{display:flex;flex-direction:column;gap:3px}
.dsh-ov-ports[data-dir="in"]{margin-left:-6px}
.dsh-ov-ports[data-dir="out"]{margin-right:-6px;align-items:flex-end}
.dsh-ov-prow{display:flex;align-items:center;gap:5px;height:14px;white-space:nowrap}
.dsh-ov-ports[data-dir="out"] .dsh-ov-prow{flex-direction:row;justify-content:flex-end}
.dsh-ov-ptxt{font-size:8.5px;color:var(--dsw-alias-label-tertiary);letter-spacing:.2px}
.dsh-ov-ptxt i{font-style:normal;color:var(--dsw-alias-state-warn-primary)}
.dsh-ov-pdot{width:9px;height:9px;border-radius:50%;border:2px solid var(--dsw-alias-bg-layer-1);
  flex:0 0 auto;cursor:crosshair;position:relative;z-index:4}
.dsh-ov-pdot:hover{transform:scale(1.5)}
.dsh-ov-pdot[data-armed="1"]{box-shadow:0 0 0 3px var(--dsw-alias-brand-primary)}
.dsh-ov-nbody{padding:4px 8px 5px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.4}
/* Label left, value right — but with room to breathe and a value that may be a
   set of chips rather than one string. Aligning to the TOP keeps a wrapping value
   on the label's line instead of drifting to the middle of the row. */
.dsh-ov-kv{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:1px 0}
/* The FIRST-CHILD variant, not a bare child selector. The bare one also matched
   the chips container (a span), and flex:0 0 auto then made it unshrinkable — so
   six chips ran out through the card's right edge instead of wrapping. */
.dsh-ov-kv>span:first-child{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:0 0 auto;font-size:11.5px}
.dsh-ov-kv b{color:var(--dsw-alias-label-primary);font-weight:500;text-align:right;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px}
.dsh-ov-nstat{display:flex;justify-content:space-between;gap:6px;padding:0 8px 6px;font-size:11px}
/* object-fit:cover cropped the frame this preview exists to show: a 16:9 or 1.75:1
   shot inside a 190px-wide strip lost its top and bottom. Letterboxed on black,
   and tall enough that the letterbox is not most of the box. */
.dsh-ov-thumb{height:58px;border-radius:0 0 8px 8px;border-top:1px solid var(--dsw-alias-border-l1);
  display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-thumb[data-media="1"]{background:#000}
/* A 角色/场景/素材 node carries a public image URL and nothing else, so it had no
   picture at all — you had to open the URL to see which cat this node was. */
.dsh-ov-thumb[data-asset="1"]{background:var(--dsw-alias-bg-layer-3);height:64px}
.dsh-ov-thumb img,.dsh-ov-thumb video{width:100%;height:100%;object-fit:contain;display:block}
.dsh-ov-thumb[data-broken="1"]::after{content:'参考图无法加载';font-size:9.5px;padding:0 6px;
  text-align:center;color:var(--dsw-alias-state-error-primary)}
.dsh-ov-bar{height:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;border-radius:0 0 8px 8px}
.dsh-ov-bar i{display:block;height:100%;background:var(--dsw-alias-state-warn-primary)}
.dsh-ov-flag{position:absolute;top:-8px;right:-7px;width:17px;height:17px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#141416;z-index:3}
.dsh-ov-flag[data-side="l"]{right:auto;left:-7px}

.dsh-ov-tools{position:absolute;left:10px;top:10px;display:flex;gap:6px;z-index:7;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;padding:4px}
/* The canvas legend was removed: it listed the same node types and colours as
   the library in the left column (a second source of truth for one fact), and
   floating at the canvas's top-right it sat on top of any node placed there.
   Its one unique line — how to wire two ports — lives in .dsh-ov-hint below. */
.dsh-ov-hint{position:absolute;left:10px;bottom:10px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px;padding:4px 8px;pointer-events:none;max-width:62%;z-index:5}
.dsh-ov-zoom{position:absolute;right:10px;bottom:10px;display:flex;gap:5px;z-index:6}
.dsh-ov-toast{position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:7px 13px;
  border-radius:8px;font-size:12px;z-index:20;max-width:74%;border:1px solid;pointer-events:none}
.dsh-ov-toast[data-kind="bad"]{background:var(--dsw-alias-bg-layer-1);
  border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-ov-toast[data-kind="good"]{background:var(--dsw-alias-bg-layer-1);
  border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-ov-mini{position:absolute;right:10px;bottom:44px;width:150px;height:94px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  border-radius:7px;padding:4px;z-index:5}
.dsh-ov-mini svg{display:block}

.dsh-ov-table{width:100%;border-collapse:collapse;font-size:12px}
.dsh-ov-table th{position:sticky;top:0;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  text-align:left;
  padding:7px 9px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:600;
  border-bottom:1px solid var(--dsw-alias-border-l2);z-index:1;white-space:nowrap}
.dsh-ov-table td{padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.dsh-ov-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-ov-table tr[data-sel="1"] td{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3))}
.dsh-ov-idx{font-weight:700;color:var(--dsw-alias-label-tertiary);width:24px}
.dsh-ov-badge{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;padding:1px 7px;
  border-radius:20px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-ov-link{color:var(--dsw-alias-brand-primary)}
.dsh-ov-th{width:62px}
.dsh-ov-th div{width:54px;height:31px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center;
  font-size:9px;color:var(--dsw-alias-label-tertiary);overflow:hidden}
.dsh-ov-th img,.dsh-ov-th video{width:100%;height:100%;object-fit:contain;display:block}

.dsh-ov-sec{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ov-sec h4{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;margin:0}
.dsh-ov-sec .dsh-ov-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:6px;line-height:1.5}

/* ---- the inspector proper: a column of CARDS ---------------------- *
   The right column was one continuous strip of identical 1px rules — every
   section the same, every field full width, and a label/value row whose value
   was squeezed against the right edge. It read like an INI file. Sections are
   cards now, the shot list is chips, and the spacing is the thing that does the
   separating instead of a line under every block. Scoped to .dsh-ov-insp so the
   preflight panel, which shares .dsh-ov-sec, keeps its denser table-like look. */
.dsh-ov-insp{padding:9px;display:flex;flex-direction:column;gap:8px}
.dsh-ov-insp .dsh-ov-sec{padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-insp .dsh-ov-sec h4{font-size:13px}
.dsh-ov-insp .dsh-ov-alert{margin:0;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.dsh-ov-insp .dsh-ov-sec .dsh-ov-alert{margin-top:8px}
.dsh-ov-insp .dsh-ov-note{margin-top:5px}
.dsh-ov-insp .dsh-ov-empty{padding:22px 14px}
/* The reference picture, on the panel. object-fit:contain keeps the whole sheet
   visible; the tinted backdrop marks the letterbox instead of hiding it. */
.dsh-ov-assetimg{width:100%;max-height:260px;object-fit:contain;display:block;margin-top:7px;
  border-radius:9px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}
.dsh-ov-sec[data-broken="1"] .dsh-ov-assetimg{display:none}
.dsh-ov-sec[data-broken="1"]::after{content:'这张图加载不出来 —— 检查地址是不是公开可访问的 https 图片';
  display:block;margin-top:7px;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-state-error-primary)}
/* A <video> with no width rule renders at its INTRINSIC size — 1344px inside a
   282px column. The sequence node's own film was the only place that happened,
   because the film PANEL had a rule and the inspector did not. */
.dsh-ov-insp video{width:100%;border-radius:8px;background:#000;display:block}
.dsh-ov-insp .dsh-ov-fld{margin-top:10px}
.dsh-ov-insp .dsh-ov-fld:first-child{margin-top:0}

/* The shot list used to be a run-on string crushed against the right edge
   ("5 镜（#1 #3 #4 #5 #6）"). Chips say the same thing and read as a SET. */
/* min-width:0 or the chips refuse to shrink: a flex item's default min-width:auto
   is its content size, so six chips ran past the card edge instead of wrapping. */
.dsh-ov-chips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;align-items:center;min-width:0}
.dsh-ov-chip{font-style:normal;font-size:10px;font-weight:700;border-radius:6px;padding:1px 6px;
  background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3));
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-ov-chip[data-kind="count"]{background:none;border-color:transparent;font-weight:600;
  color:var(--dsw-alias-label-tertiary);padding:1px 2px}
/* Wiring, as wiring: "port → node:port", one row per edge. */
.dsh-ov-lins{display:flex;flex-direction:column;gap:3px;margin-top:6px}
.dsh-ov-lin{display:flex;align-items:center;gap:6px;font-size:10.5px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dsh-ov-lin span{color:var(--dsw-alias-label-tertiary)}
.dsh-ov-lin i{font-style:normal;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}
.dsh-ov-lin b{color:var(--dsw-alias-label-secondary);font-weight:600;
  overflow:hidden;text-overflow:ellipsis}
.dsh-ov-lin em{font-style:normal;color:var(--dsw-alias-label-tertiary);flex:0 0 auto;
  border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}
.dsh-ov-fld{margin-top:8px}
.dsh-ov-fld label{display:block;font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  margin-bottom:3px;letter-spacing:.3px;text-transform:uppercase}
/* Fields. Reported in order: "the border is invisible" (it was 6% white on a panel
   of the same tone), then "the dark theme is fine, the light one is not" — because
   the fix was a 16% white border and a hardcoded rgba(0,0,0,.32) inset shadow: a
   smudge inside a white box. Both were one mistake: a hardcoded value pretending
   to be theme-agnostic. The field is now a translucent TINT (6% navy in light, 8%
   white in dark) plus a 12%/16% border, with an inner top edge drawn from a token
   so it darkens in light and lightens in dark instead of only ever going black. */
.dsh-ov-fld input,.dsh-ov-fld textarea,.dsh-ov-fld select{width:100%;
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  padding:5px 9px;font:inherit;font-size:12px;box-sizing:border-box;
  box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1);
  transition:border-color .12s ease,box-shadow .12s ease,background .12s ease}
.dsh-ov-fld input:hover,.dsh-ov-fld textarea:hover,.dsh-ov-fld select:hover{
  border-color:var(--dsw-alias-border-l3)}
.dsh-ov-fld input:focus,.dsh-ov-fld textarea:focus,.dsh-ov-fld select:focus{outline:none;
  background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3));
  border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px var(--dsw-alias-border-l3)}
.dsh-ov-fld textarea{resize:vertical;min-height:64px;line-height:1.55;display:block}
.dsh-ov-fld select{cursor:pointer}
.dsh-ov-fld input::placeholder,.dsh-ov-fld textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
/* A checkbox is not a well: the shared width:100% and inset shadow made the
   boolean fields render as a full-width empty box with a tick lost at its left. */
.dsh-ov-fld input[type="checkbox"]{width:auto;box-shadow:none;padding:0;border-radius:4px;
  accent-color:var(--dsw-alias-brand-primary)}
.dsh-ov-note{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:3px}
.dsh-ov-alert{margin:8px 12px;padding:7px 9px;border-radius:7px;font-size:11.5px;
  line-height:1.5;border:1px solid}
.dsh-ov-alert b{display:block;margin-bottom:2px}
.dsh-ov-alert[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary);
  color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-alert[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-alert[data-kind="info"]{border-color:var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-log{font-size:11px;padding:4px 12px;display:flex;gap:8px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ov-log time{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-size:10px}
.dsh-ov-log span{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis}
.dsh-ov-bottom{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);
  display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--dsw-alias-bg-base)}
.dsh-ov-strips{display:flex;gap:5px;overflow-x:auto;flex:1;min-width:0}
.dsh-ov-strip{flex:0 0 auto;width:60px;cursor:pointer;position:relative}
.dsh-ov-strip div.dsh-ov-sbox{height:33px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center;
  font-size:9px;color:var(--dsw-alias-label-tertiary);overflow:hidden}
.dsh-ov-strip img,.dsh-ov-strip video{width:100%;height:100%;object-fit:contain;display:block}
.dsh-ov-strip[data-sel="1"] div.dsh-ov-sbox{border-color:var(--dsw-alias-brand-primary)}
/* A clip that exists is a thing you can OPEN, so it says so on hover; an empty
   slot still selects the node, and must not pretend it plays. */
.dsh-ov-strip[data-ready="1"]:hover div.dsh-ov-sbox{border-color:var(--dsw-alias-border-l4)}
.dsh-ov-strip[data-ready="1"] div.dsh-ov-sbox::after{content:'▶';position:absolute;right:3px;bottom:1px;
  font-size:8px;color:#fff;text-shadow:0 1px 2px #000;pointer-events:none}
.dsh-ov-strip div.dsh-ov-sbox{position:relative}
.dsh-ov-strip .dsh-ov-slabel{font-size:9.5px;color:var(--dsw-alias-label-tertiary);text-align:center;
  margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ov-strip .dsh-ov-snum{position:absolute;top:2px;left:3px;font-size:8.5px;font-weight:700;
  color:#fff;background:var(--dsw-alias-label-tertiary);border-radius:3px;padding:0 3px}
.dsh-ov-summary{flex:0 0 auto;display:flex;gap:12px;align-items:center;font-size:11.5px;
  border-left:1px solid var(--dsw-alias-border-l1);padding-left:12px}
.dsh-ov-summary div{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-ov-summary b{color:var(--dsw-alias-label-primary);font-weight:600;font-size:12.5px}

.dsh-ov-modal{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;
  align-items:center;justify-content:center;z-index:40}
.dsh-ov-card{width:430px;max-width:88%;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:11px;padding:16px 17px}
.dsh-ov-card h3{font-size:14px;margin:0 0 9px}
.dsh-ov-card p{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:0 0 7px}
.dsh-ov-card p b{color:var(--dsw-alias-state-warn-primary)}
.dsh-ov-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}
.dsh-ov-empty{padding:26px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}

/* The dialog's own status readouts (key, image-bed token): a lamp plus a word,
   in amber until the thing is actually configured. The top-bar chips no longer
   use this — they are pills with their own dot. */
.dsh-ov-keystate{white-space:nowrap;color:var(--dsw-alias-state-warn-primary)}
.dsh-ov-keystate[data-on="1"]{color:var(--dsw-alias-label-primary)}
.dsh-ov-ntype[data-add]{cursor:pointer}
.dsh-ov-ntype[data-add]:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-ov-node[data-drag="1"]{cursor:grabbing;z-index:12;opacity:.9}

/* ---- settings dialog ---------------------------------------------- *
   The key and the image bed used to live in two full-width strips under the
   top bar. They are configured once and then never touched again, so they were
   permanent chrome paying rent for a dialog. The dialog is also where a second
   OpenRouter concern — the model shortlist — finally has a home, and where the
   image bed can be PROBED rather than merely described. */
.dsh-ov-settings{width:600px;max-width:94%;max-height:86%;overflow-y:auto;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:2px}
.dsh-ov-settings h3{font-size:14px;margin:0 0 4px}
.dsh-ov-shead{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);
  padding-top:11px;margin-top:11px}
.dsh-ov-srow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0}
.dsh-ov-srow>label{flex:0 0 92px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-ov-sin{flex:1 1 190px;min-width:110px;padding:4px 9px;font-size:12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font-family:inherit;transition:border-color .12s ease,box-shadow .12s ease}
.dsh-ov-sin:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-ov-sin:focus{outline:none;border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px var(--dsw-alias-border-l3)}
.dsh-ov-snote{flex:1 1 100%;margin-left:100px;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.55}
.dsh-ov-mlist{display:flex;flex-direction:column;gap:4px;margin:2px 0 0 100px}
.dsh-ov-mrow{display:flex;align-items:center;gap:8px;font-size:12px;
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:7px;padding:3px 8px}
.dsh-ov-mrow span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ov-mrow b{font-size:10px;font-weight:600;color:var(--dsw-alias-brand-primary);
  border:1px solid var(--dsw-alias-brand-primary);border-radius:4px;padding:0 4px}
.dsh-ov-castrow{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  padding:3px 12px;overflow:hidden}
.dsh-ov-castrow i{color:#f778ba;flex:0 0 auto;font-style:normal}
.dsh-ov-castrow span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.dsh-ov-castn{font-style:normal;flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px}
.dsh-ov-castcard{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));padding:8px 9px;margin:6px 0}
.dsh-ov-castcard textarea.dsh-ov-sin{font-family:inherit;resize:vertical;line-height:1.5}
.dsh-ov-castcount{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}
.dsh-ov-wirelist{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0 0 100px}
.dsh-ov-wirelist .dsh-ov-btn{padding:1px 6px;font-size:10.5px}
.dsh-ov-film{margin:10px 12px;padding:10px 12px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ov-film video{width:100%;border-radius:7px;background:#000;display:block;margin-bottom:7px}

/* ---- clip preview ------------------------------------------------- *
   A finished clip in the bottom strip used to be clickable only in the sense
   that it moved the inspector; the two questions a 33px box cannot answer are
   "which take is this" and "is the seam right". The modal plays it at full
   width and repeats the shot's numbers beside it. */
.dsh-ov-preview{width:min(880px,94%);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;
  display:flex;flex-direction:column;gap:10px}
.dsh-ov-preview h3{font-size:13.5px;margin:0;display:flex;align-items:center;gap:8px}
.dsh-ov-preview video{width:100%;max-height:62vh;border-radius:9px;background:#000;display:block}
.dsh-ov-preview .dsh-ov-pmeta{display:flex;gap:8px;flex-wrap:wrap;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary)}
.dsh-ov-preview .dsh-ov-pmeta span{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  padding:2px 7px;background:var(--dsw-alias-bg-layer-2)}
.dsh-ov-preview .dsh-ov-pmeta b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-ov-preview .dsh-ov-pfile{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  word-break:break-all}
`

    function installStyles() {
      const id = 'dsh-openrouter-video-css'
      if (document.getElementById(id) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ================================================================ *
     * helpers
     * ================================================================ */
    const usd = (value) => (typeof value === 'number' && isFinite(value) ? '$' + value.toFixed(2) : '—')
    const shortModel = (id) => (typeof id === 'string' && id.length > 0 ? id.split('/').pop() : '')
    const clockOf = (ms) => {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    /**
     * The API's six statuses mapped to a colour and a label. `cancelled` and
     * `expired` are real and terminal even though the prose docs list only four.
     */
    const STATE_LABEL = {
      idle: ['未开始', 'idle'],
      blocked: ['已阻塞', 'idle'],
      queued: ['排队中', 'run'],
      submitted: ['已提交', 'run'],
      in_progress: ['生成中', 'run'],
      completed: ['已完成', 'ok'],
      failed: ['失败', 'err'],
      skipped: ['已跳过', 'idle'],
    }
    const stateLabel = (state) => STATE_LABEL[state] ?? ['未开始', 'idle']

    /* ================================================================ *
     * the workspace
     * ================================================================ */
    function Workspace() {
      const [view, setView] = React.useState('canvas')
      const [config, setConfig] = React.useState(null)
      const [keyInfo, setKeyInfo] = React.useState(null)
      const [catalog, setCatalog] = React.useState({ models: [], loaded: false, error: null })
      const [graphList, setGraphList] = React.useState([])
      const [graphId, setGraphId] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      /**
       * The in-progress edit of ONE inspector field: `{nodeId, key, value}`.
       *
       * The inspector used to render every text field with `defaultValue`, keyed
       * by FIELD name. `defaultValue` is applied at mount only, and the key did
       * not depend on the node, so switching selected nodes reused the same DOM
       * element: the heading changed and the prompt text stayed on the previous
       * node. The fields are controlled now, so what is displayed is derived from
       * the selected node and an external reload cannot leave stale text behind
       * either. The draft exists so typing does not POST on every keystroke — it
       * is committed on blur, as before.
       */
      const [fieldDraft, setFieldDraft] = React.useState(null)
      /* The world origin starts BELOW the floating run toolbar (absolute at
         left:10 top:10, ~34px tall). Starting at y=12 put a node authored at
         (20,20) — the default the tools use — underneath the toolbar, so the
         first node of every graph was hidden by the buttons. */
      const [zoom, setZoom] = React.useState({ x: 16, y: 58, k: 0.9 })
      const [toast, setToast] = React.useState(null)
      const [preflight, setPreflight] = React.useState(null)
      const [showPreflight, setShowPreflight] = React.useState(false)
      const [abortOpen, setAbortOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [armed, setArmed] = React.useState(null)
      const [logs, setLogs] = React.useState([])
      const [error, setError] = React.useState(null)
      /* Live position of the node under the cursor. Kept OUT of `graph` so a
         drag does not rewrite the document on every mousemove — the document
         is written once, on mouseup. */
      const [dragNode, setDragNode] = React.useState(null)
      /* In-progress rename of ONE node: `{id, value}` or null.
         A node could not be renamed at all before this — `title` was only ever
         set by whoever created the node, so every node kept the name a tool call
         or a script gave it. For a `seq` node that name is the film's name, and
         for a shot it is what the sequence table shows. */
      const [renaming, setRenaming] = React.useState(null)
      /* A delete waiting on confirmation: `{id, wires, upstream, downstream}`.
         Deleting is NOT a one-keypress operation here. A node in this graph can
         be a paid generation, and the wires carry the film's structure — so the
         confirm bar states exactly how many wires go and which nodes are left
         without an input, before anything is removed. */
      const [pendingDelete, setPendingDelete] = React.useState(null)
      const [keyDraft, setKeyDraft] = React.useState('')
      const [keyBusy, setKeyBusy] = React.useState(false)
      /* The image bed. Without a public URL for a sampled frame, first/last-frame
         chaining degrades into an independent take — so this is not an optional
         nicety, it is the switch, and it belongs in the workspace rather than
         only in the plugin settings panel. */
      const [bedDraft, setBedDraft] = React.useState({ url: '', folder: '', userAgent: '', token: '' })
      const [bedBusy, setBedBusy] = React.useState(false)
      const [bedTest, setBedTest] = React.useState(null)
      const [bedTesting, setBedTesting] = React.useState(false)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [castOpen, setCastOpen] = React.useState(false)
      /* The project list. `graphList` was fetched on mount and never rendered, so
         the workspace had no project list at all — it always opened whichever
         graph was newest, with no way to see, switch to or remove anything. */
      const [projectsOpen, setProjectsOpen] = React.useState(false)
      const [pendingGraphDelete, setPendingGraphDelete] = React.useState(null)
      /* Which finished clip is open in the playback modal. Before this, clicking a
         clip in the bottom strip only moved the inspector, so the two questions a
         33px box cannot answer — "which take is this" and "does the seam hold" —
         still required hunting for the node and playing it in a 58px thumb. */
      const [clipPreview, setClipPreview] = React.useState(null)
      /** The model shortlist being edited. Committed on save, not per keystroke. */
      const [modelsDraft, setModelsDraft] = React.useState([])
      const [modelInput, setModelInput] = React.useState('')
      const [keyTest, setKeyTest] = React.useState(null)
      const [keyTesting, setKeyTesting] = React.useState(false)

      const canvasRef = React.useRef(null)
      const worldRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const nodeDragRef = React.useRef(null)
      const pollRef = React.useRef(null)

      const say = React.useCallback((message, kind) => {
        setToast({ message, kind: kind ?? 'good', at: Date.now() })
        window.setTimeout(() => {
          setToast((current) => (current !== null && Date.now() - current.at >= 2400 ? null : current))
        }, 2500)
      }, [])

      const log = React.useCallback((message) => {
        setLogs((current) => [{ at: Date.now(), message }, ...current].slice(0, 40))
      }, [])

      const api = React.useCallback(async (path, options) => {
        const response = await fetch(API + path, {
          method: options?.method ?? 'GET',
          headers: options?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        })
        if (!response.ok) throw new Error(`接口 ${path} 返回 ${response.status}`)
        return response.json()
      }, [])

      /* ---- bootstrap ---- */
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const cfg = await api('/config')
            if (!alive) return
            setConfig(cfg.config ?? {})
            setKeyInfo(cfg.key ?? null)
            /* Seed the bed form from what the Host actually holds. Values, not
               `defaultValue`: the earlier revision keyed uncontrolled inputs by
               field name, so switching nodes kept showing the first node's
               text — the form now mirrors state in both directions. */
            setBedDraft({
              url: cfg.config?.imageBedUrl ?? '',
              folder: cfg.config?.imageBedFolder ?? 'test',
              userAgent: cfg.config?.imageBedUserAgent ?? 'gobelagent',
              token: '',
            })
            setModelsDraft(Array.isArray(cfg.config?.models) ? cfg.config.models : [])
            const list = await api('/graphs')
            if (!alive) return
            setGraphList(list.graphs ?? [])
            if ((list.graphs ?? []).length > 0) setGraphId(list.graphs[0].id)
            else {
              const created = await api('/graph/new', { method: 'POST', body: { title: '未命名项目' } })
              if (!alive) return
              setGraphId(created.graph.id)
            }
          } catch (err) {
            if (alive) setError(err.message)
          }
          try {
            const models = await api('/models')
            if (alive) setCatalog({ models: models.models ?? [], loaded: models.loaded === true, error: models.error ?? null })
          } catch { /* the picker degrades to the saved default */ }
        })()
        return () => { alive = false }
      }, [api])

      /* ---- load the selected graph ---- */
      const reload = React.useCallback(async (id) => {
        const target = id ?? graphId
        if (target === null || target === undefined) return null
        try {
          const data = await api('/graph?id=' + encodeURIComponent(target))
          setSnapshot(data)
          return data
        } catch (err) {
          setError(err.message)
          return null
        }
      }, [api, graphId])

      React.useEffect(() => { void reload(graphId) }, [graphId, reload])

      /**
       * Poll the Host for state. The Host owns the actual job polling (the docs
       * say to poll from a server route), so this only refreshes the VIEW, and
       * unmounting stops only this refresh — never the Host's polling.
       *
       * This used to install the interval ONLY when the client's own snapshot said
       * `running` — a self-fulfilling condition. The panel is not the only writer:
       * an agent calling openrouter_video_run, or another window, starts a run the
       * client cannot see, so its snapshot keeps saying idle, so it never polls,
       * so it never learns otherwise. The reported symptom was exactly that: the
       * videos were generated but no node showed 生成中, no shot showed progress,
       * and the entire finished film appeared at once the moment something else
       * finally refreshed.
       *
       * So: always watch, on two speeds. Slow while idle (nothing is supposed to
       * be happening, but something might be), fast as soon as a run is known to be
       * live. Re-reading the graph is cheap — it is a local GET and it cannot cost
       * money, which is the only reason a 4s beat was ever a concern.
       */
      React.useEffect(() => {
        const period = snapshot?.running === true ? 4000 : 10000
        if (pollRef.current !== null) window.clearInterval(pollRef.current)
        pollRef.current = window.setInterval(() => { void reload() }, period)
        return () => {
          if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null }
        }
      }, [snapshot?.running, reload])

      const graph = snapshot?.graph ?? null
      const states = snapshot?.states ?? {}
      const jobs = snapshot?.jobs ?? []
      const ceilings = snapshot?.ceilings ?? {}

      /* ---- DERIVED VALUES, COMPUTED ONCE -----------------------------
       * The design prototype shipped three views that each hardcoded their own
       * totals and disagreed. Everything below is derived from one snapshot,
       * so the top bar, the table, the strip and the summary cannot drift.
       * ---------------------------------------------------------------- */
      const derived = React.useMemo(() => {
        const nodes = graph?.nodes ?? []
        const network = nodes.filter(isNetwork)
        const jobsByNode = new Map()
        for (const job of jobs) if (job.nodeId && !jobsByNode.has(job.nodeId)) jobsByNode.set(job.nodeId, job)

        const shotRows = nodes
          .filter((node) => node.shotIndex !== null && node.shotIndex !== undefined && SHOT_TYPES.has(node.type))
          .sort((a, b) => a.shotIndex - b.shotIndex)
          .map((node) => {
            const job = jobsByNode.get(node.id) ?? null
            const state = states[node.id] ?? 'idle'
            const ceiling = ceilings[node.id]
            return {
              node,
              job,
              state,
              ceiling: ceiling === null || ceiling === undefined ? null : ceiling,
              model: node.fields?.model ?? graph?.project?.model ?? '',
              seconds: Number(node.fields?.duration ?? graph?.project?.duration ?? 0),
              resolution: node.fields?.resolution ?? graph?.project?.resolution ?? '',
              /* `.get()` returns undefined when absent, NOT null — checking
                 `!== null` let undefined through and crashed on `.cost`. */
              actual: typeof job?.cost === 'number' ? job.cost : null,
              /* Which characters are IN this shot. Derived from the wires, the
                 same way the Host derives it — one source of truth, and a wire
                 that shows here is a wire the request will honour. */
              cast: nodes
                .filter((candidate) => candidate.type === 'cast'
                  && graph.edges.some((edge) => edge.from === candidate.id && edge.to === node.id && edge.toPort === 'refs'))
                .map((candidate) => candidate.fields?.name || candidate.title || '未命名'),
            }
          })

        /*
         * The REAL continuity mechanism, derived from topology.
         *
         * The column used to answer from `node.link`, which only ever meant
         * `previous_job_id` — a mechanism that is dead in this workspace. So a
         * fully frame-chained film displayed 独立起幅 on every row, and a reader
         * had no way to tell which transitions were actually cuts.
         */
        const continuityOf = (node) => {
          const feed = graph.edges.find((edge) => edge.to === node.id && edge.toPort === 'frames')
          if (feed !== undefined) {
            const source = nodes.find((candidate) => candidate.id === feed.from) ?? null
            if (source !== null && source.type === 'take') {
              const upstream = graph.edges.find((edge) => edge.to === source.id && edge.toPort === 'job')
              const from = upstream === undefined ? null : nodes.find((candidate) => candidate.id === upstream.from) ?? null
              return { kind: 'frames', from: from?.shotIndex ?? null }
            }
            return { kind: 'frames', from: null }
          }
          if (node.link === 'continue' || node.link === 'edit') return { kind: 'link', from: null }
          return { kind: 'cut', from: null }
        }
        for (const row of shotRows) row.continuity = continuityOf(row.node)

        const actualTotal = network.reduce((sum, node) => {
          const job = jobsByNode.get(node.id)
          return sum + (typeof job?.cost === 'number' ? job.cost : 0)
        }, 0)

        let pendingCeiling = 0
        let unknownCount = 0
        for (const node of network) {
          const state = states[node.id] ?? 'idle'
          if (state === 'completed') continue
          const ceiling = ceilings[node.id]
          if (ceiling === null || ceiling === undefined) unknownCount += 1
          else pendingCeiling += ceiling
        }

        const counts = { completed: 0, running: 0, failed: 0, skipped: 0, idle: 0 }
        for (const node of network) {
          const state = states[node.id] ?? 'idle'
          if (state === 'completed') counts.completed += 1
          else if (state === 'failed') counts.failed += 1
          else if (state === 'skipped' || state === 'blocked') counts.skipped += 1
          else if (state === 'in_progress' || state === 'submitted' || state === 'queued') counts.running += 1
          else counts.idle += 1
        }

        let totalSeconds = 0
        for (const node of network) totalSeconds += Number(node.fields?.duration ?? graph?.project?.duration ?? 0)

        // Cross-model adjacency is only a real discontinuity when the two shots
        // are NOT joined by anything. Flagging every change marks most rows and
        // therefore signals nothing (design-prototype finding).
        const seams = []
        for (let i = 1; i < shotRows.length; i += 1) {
          const prev = shotRows[i - 1]
          const current = shotRows[i]
          if (prev.model === current.model) continue
          if (current.continuity.kind !== 'cut') continue
          seams.push(current.node.shotIndex)
        }

        const hardSeams = shotRows.filter((row) => row.continuity.kind === 'cut').length

        return {
          network, jobsByNode, shotRows, actualTotal, pendingCeiling, unknownCount,
          counts, totalSeconds, seams, hardSeams,
          ceilingTotal: actualTotal + pendingCeiling,
        }
      }, [graph, states, jobs, ceilings])

      const budgetUsd = graph?.budget?.usd ?? 30

      /* ---- canvas geometry: MEASURED, never arithmetic ----------------
       * Port positions are read from the rendered DOM. Computing them as
       * "node.y + 30 + i*22" is a second source of truth that goes wrong the
       * moment a node's height changes (design-prototype bug #5).
       * ---------------------------------------------------------------- */
      const portPosition = React.useCallback((nodeId, port, dir) => {
        const world = worldRef.current
        if (world === null) return null
        const el = world.querySelector(`#ov-port-${dir}-${CSS_escape(nodeId)}-${CSS_escape(port)}`)
        if (el === null) return null
        const rect = el.getBoundingClientRect()
        const base = world.getBoundingClientRect()
        if (zoom.k <= 0) return null
        return {
          x: (rect.left - base.left + rect.width / 2) / zoom.k,
          y: (rect.top - base.top + rect.height / 2) / zoom.k,
        }
      }, [zoom.k])

      /* Wires are MEASURED from the rendered DOM, and the DOM of the commit
       * being rendered is not queryable DURING that render. Computing this in a
       * `useMemo` therefore measures the previous commit: on the render that
       * first produces the nodes every port lookup returns null, an empty wire
       * layer is cached, and because none of the memo's dependencies change
       * afterwards it is never recomputed. The canvas then shows nodes and no
       * wires at all — the wires appear only if something else (a zoom, a drag)
       * happens to invalidate the memo.
       *
       * So the measurement runs AFTER the commit, in an effect, and lands in
       * state. The functional update returns the previous array when nothing
       * moved, which is what keeps this from looping when `graph` or `dragNode`
       * change identity on every render.
       */
      const [wires, setWires] = React.useState([])
      React.useEffect(() => {
        if (graph === null) {
          setWires((prev) => (prev.length === 0 ? prev : []))
          return
        }
        const next = []
        for (const edge of graph.edges) {
          const a = portPosition(edge.from, edge.fromPort, 'out')
          const b = portPosition(edge.to, edge.toPort, 'in')
          if (a === null || b === null) continue
          const dx = Math.max(34, Math.abs(b.x - a.x) * 0.42)
          next.push({
            id: edge.id,
            d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`,
            label: edge.label,
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 },
          })
        }
        setWires((prev) => {
          if (prev.length !== next.length) return next
          for (let i = 0; i < next.length; i += 1) {
            if (prev[i].id !== next[i].id || prev[i].d !== next[i].d) return next
          }
          return prev
        })
      }, [graph, portPosition, zoom.k, graphId, dragNode])

      /* ---- actions ---- */
      const saveGraph = React.useCallback(async (next, options) => {
        try {
          /* `allowInvalid` is for AUTHORING, not for running. Dropping a bare
             node onto the canvas is legal — its required inputs are unwired by
             definition, and refusing the save would make the library unusable.
             Preflight and the run path still validate on the Host. */
          const result = await api('/graph', {
            method: 'POST',
            body: { graph: next, allowInvalid: options?.allowInvalid === true },
          })
          if (result.ok !== true) {
            say(result.error ?? '图不合法', 'bad')
            return false
          }
          await reload(next.id)
          const warnings = result.errors?.length ?? 0
          if (options?.allowInvalid === true && warnings > 0 && typeof options.announce === 'string') {
            say(`${options.announce}（待补：${result.errors[0].message}）`)
          }
          return true
        } catch (err) {
          say(err.message, 'bad')
          return false
        }
      }, [api, reload, say])

      const runPreflight = React.useCallback(async () => {
        if (graph === null) return
        try {
          const result = await api('/graph/validate', { method: 'POST', body: { graph } })
          setPreflight(result)
          setShowPreflight(true)
          log(`预检：上界 ${usd(result.ceilingTotal)} · ${result.unknownCount} 个量级未知`)
        } catch (err) { say(err.message, 'bad') }
      }, [api, graph, log, say])

      /**
       * The ONE place a run is dispatched from the panel.
       *
       * `only` is a SEED set, not a scope: the Host expands it downstream
       * (`expandSubset`), so `[selected]` means the selected node AND everything
       * derived from it. That is worth stating here because the button that called
       * it was labelled 运行选中, which reads as "just this one" — see the toolbar.
       *
       * `retryFailed` is the Host's `retry_failed`. It is the ONLY way a failed
       * shot becomes runnable again: with it false a failed node short-circuits,
       * the run ends, and clicking run again skips it for ever. It existed on the
       * agent tool and in the executor and was unreachable from the panel.
       */
      const startRun = React.useCallback(async (only, options) => {
        if (graph === null) return
        setBusy(true)
        try {
          const result = await api('/graph/run', {
            method: 'POST',
            body: {
              id: graph.id,
              only: only ?? null,
              ...(options?.retryFailed === true ? { retry_failed: true } : {}),
            },
          })
          setSnapshot(result)
          if (result.ok !== true) say(result.error ?? '执行失败', 'bad')
          else {
            log((options?.retryFailed === true ? '重跑失败镜头：' : '执行结束：')
              + `完成 ${result.report?.completed?.length ?? 0}，失败 ${result.report?.failed?.length ?? 0}`)
          }
          await reload()
        } catch (err) { say(err.message, 'bad') } finally { setBusy(false) }
      }, [api, graph, log, reload, say])

      const abortRun = React.useCallback(async () => {
        if (graph === null) return
        setAbortOpen(false)
        try {
          const result = await api('/graph/abort', { method: 'POST', body: { id: graph.id } })
          say(result.message ?? result.error ?? '已中止派发', result.ok === true ? 'good' : 'bad')
          await reload()
        } catch (err) { say(err.message, 'bad') }
      }, [api, graph, reload, say])

      /* ---- 项目：列出 / 打开 / 新建 / 删除 -------------------------------
       * Clearing the workspace was impossible from every direction: no route, no
       * tool action, no button, and the Host caches graphs in memory after one
       * load — so emptying the JSON on disk is reverted by the next write. The
       * only honest path is through the Host, which is what `/graph/delete` is.
       * ---------------------------------------------------------------- */
      const refreshGraphList = React.useCallback(async () => {
        try {
          const list = await api('/graphs')
          setGraphList(list.graphs ?? [])
          return list.graphs ?? []
        } catch (err) { say(err.message, 'bad'); return [] }
      }, [api, say])

      const newProject = React.useCallback(async () => {
        try {
          const created = await api('/graph/new', { method: 'POST', body: { title: '未命名项目' } })
          await refreshGraphList()
          setSelected(null)
          setGraphId(created.graph.id)
          setProjectsOpen(false)
          say('已新建项目')
          return created.graph.id
        } catch (err) { say(err.message, 'bad'); return null }
      }, [api, refreshGraphList, say])

      const removeGraph = React.useCallback(async (id) => {
        try {
          const result = await api('/graph/delete', { method: 'POST', body: { id } })
          if (result.ok !== true) { say(result.error ?? '删除失败', 'bad'); return }
          const rest = Array.isArray(result.graphs) ? result.graphs : await refreshGraphList()
          setGraphList(rest)
          setPendingGraphDelete(null)
          say('已删除项目')
          /* The open project just vanished. Leaving `graphId` pointed at a graph
             the Host no longer has makes every later save fail with 没有这个图,
             so switch to whatever is newest — or mint an empty one. */
          if (id === graphId) {
            setSelected(null)
            if (rest.length > 0) setGraphId(rest[0].id)
            else await newProject()
          }
        } catch (err) { say(err.message, 'bad') }
      }, [api, graphId, newProject, refreshGraphList, say])

      /**
       * The seed set a run on `id` would cover: that node plus its downstream,
       * transitively — the same shape as the Host's `expandSubset`.
       *
       * Computed here ONLY to label a button ("N of these are failed"), never to
       * decide what runs: the Host re-derives it authoritatively. The function this
       * replaces (`runDownstream`) computed this set and then printed a toast,
       * which is how the panel ended up with a button that appeared to plan a run
       * and never performed one.
       */
      const subsetOf = React.useCallback((id) => {
        if (graph === null) return []
        const seen = new Set()
        const stack = [id]
        while (stack.length > 0) {
          const current = stack.pop()
          if (seen.has(current)) continue
          seen.add(current)
          for (const edge of graph.edges) if (edge.from === current && !seen.has(edge.to)) stack.push(edge.to)
        }
        return [...seen]
      }, [graph])

      /* ---- pan / zoom ---- */
      const onCanvasDown = React.useCallback((event) => {
        if (event.target.closest('.dsh-ov-node') !== null) return
        if (event.target.closest('.dsh-ov-tools') !== null) return
        if (event.target.closest('.dsh-ov-zoom') !== null) return
        dragRef.current = { x: event.clientX - zoom.x, y: event.clientY - zoom.y }
      }, [zoom.x, zoom.y])

      React.useEffect(() => {
        const move = (event) => {
          const drag = dragRef.current
          if (drag === null) return
          setZoom((current) => ({ ...current, x: event.clientX - drag.x, y: event.clientY - drag.y }))
        }
        const up = () => { dragRef.current = null }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
      }, [])

      const onWheel = React.useCallback((event) => {
        event.preventDefault()
        const canvas = canvasRef.current
        if (canvas === null) return
        const rect = canvas.getBoundingClientRect()
        const mx = event.clientX - rect.left
        const my = event.clientY - rect.top
        setZoom((current) => {
          const next = Math.min(2.2, Math.max(0.32, current.k * (event.deltaY < 0 ? 1.1 : 0.9)))
          return {
            k: next,
            x: mx - (mx - current.x) * (next / current.k),
            y: my - (my - current.y) * (next / current.k),
          }
        })
      }, [])

      /* ---- port click-to-connect ---- */
      const onPortClick = React.useCallback((nodeId, port, dir, type) => {
        if (armed === null) {
          if (dir !== 'out') { say('请先点一个输出口（右侧的圆点）', 'bad'); return }
          setArmed({ nodeId, port, type })
          say(`已拿起 ${type} 类型的线，点一个输入口放下`)
          return
        }
        setArmed(null)
        if (dir !== 'in') { say('已取消连线', 'bad'); return }
        const accepts = PORT_ACCEPTS[port] ?? []
        if (!accepts.includes(armed.type)) {
          say(`类型不兼容被拒：${armed.type} → ${port}（只接受 ${accepts.join(' / ')}）`, 'bad')
          return
        }
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        // A single-input port is a REPLACE; a multi-input port accumulates. Doing
        // the first on every port is how a second reference image silently
        // deleted the first.
        if (!MULTI_PORTS.has(port)) {
          next.edges = next.edges.filter((edge) => !(edge.to === nodeId && edge.toPort === port))
        }
        const already = next.edges.some((edge) =>
          edge.from === armed.nodeId && edge.fromPort === armed.port && edge.to === nodeId && edge.toPort === port)
        if (already) { say('这条线已经接好了', 'bad'); return }
        next.edges.push({
          id: 'e_' + Date.now().toString(36),
          from: armed.nodeId, fromPort: armed.port, to: nodeId, toPort: port, label: '',
        })
        void saveGraph(next).then((ok) => { if (ok) say('已连接') })
      }, [armed, graph, saveGraph, say])

      /* ---- selection ---- */
      const selectNode = React.useCallback((id) => setSelected(id), [])

      /**
       * Write ONE field on ONE node.
       *
       * Generalized from a version bound to `selected`, because the 角色 roster
       * edits a dozen nodes without changing the selection — and a roster that
       * steals the inspector's selection every time you type in it is unusable.
       */
      const writeNodeField = React.useCallback((nodeId, key, value) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const node = next.nodes.find((n) => n.id === nodeId)
        if (node === undefined) return
        node.fields = { ...(node.fields ?? {}) }
        if (value === '' || value === null) delete node.fields[key]
        else node.fields[key] = value
        void saveGraph(next)
      }, [graph, saveGraph])

      const updateField = React.useCallback((key, value) => {
        if (graph === null || selected === null) return
        writeNodeField(selected, key, value)
      }, [graph, selected, writeNodeField])

      /* ---- 改名 / 删除: two things a graph editor owes you --------------
       * Neither existed. `title` was only ever written by whichever tool call or
       * library click created the node, and there was no way to remove a node at
       * all — an orphaned node could only be dealt with by editing graphs.json
       * by hand. A canvas you can only add to is not an editor.
       * ---------------------------------------------------------------- */
      const writeNodeTitle = React.useCallback((nodeId, title) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const node = next.nodes.find((candidate) => candidate.id === nodeId)
        if (node === undefined) return
        /* Empty means "fall back to the type label", not an unnamed node. A
           `cast` node created before `nodeDefaults` knew the type has an empty
           title, so this has to survive a round trip. */
        if (title.length === 0) delete node.title
        else node.title = title
        void saveGraph(next, { allowInvalid: true, announce: title.length === 0 ? '已清除名称' : `已改名为「${title}」` })
      }, [graph, saveGraph])

      /* The draft lives in a ref as well as in state, and the ref is what commit
         reads. Enter commits and then unmounts the input, which can fire blur as
         well — without a write-once guard the same rename went out twice. */
      const renameRef = React.useRef(null)
      const beginRename = React.useCallback((node) => {
        const draft = { id: node.id, value: typeof node.title === 'string' ? node.title : '' }
        renameRef.current = draft
        setSelected(node.id)
        setRenaming(draft)
      }, [])
      const editRename = (nodeId, value) => {
        const draft = { id: nodeId, value }
        renameRef.current = draft
        setRenaming(draft)
      }
      const cancelRename = () => { renameRef.current = null; setRenaming(null) }
      const commitRename = React.useCallback(() => {
        const draft = renameRef.current
        if (draft === null || draft === undefined) return
        renameRef.current = null
        setRenaming(null)
        const node = graph?.nodes.find((candidate) => candidate.id === draft.id)
        if (node === undefined) return
        const title = String(draft.value ?? '').trim()
        if (title === (node.title ?? '')) return
        writeNodeTitle(draft.id, title)
      }, [graph, writeNodeTitle])

      /**
       * What deleting this node would cost, computed BEFORE anything is removed.
       *
       * `upstream` is direct (nodes feeding it), `downstream` is the transitive
       * closure — the shipped definition of "run downstream", so the confirm bar
       * and the run toolbar agree on what downstream means.
       */
      const deleteImpact = React.useCallback((nodeId) => {
        if (graph === null) return { wires: 0, upstream: [], downstream: [] }
        const byId = new Map(graph.nodes.map((node) => [node.id, node]))
        const touching = graph.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId)
        const upstream = touching
          .filter((edge) => edge.to === nodeId)
          .map((edge) => byId.get(edge.from))
          .filter(Boolean)
        const seen = new Set()
        const stack = [nodeId]
        while (stack.length > 0) {
          const id = stack.pop()
          for (const edge of graph.edges) {
            if (edge.from !== id || seen.has(edge.to)) continue
            seen.add(edge.to)
            stack.push(edge.to)
          }
        }
        const downstream = [...seen].map((id) => byId.get(id)).filter(Boolean)
        return { wires: touching.length, upstream, downstream }
      }, [graph])

      const requestDelete = React.useCallback((nodeId) => {
        if (graph === null) return
        setSelected(nodeId)
        setPendingDelete({ id: nodeId, ...deleteImpact(nodeId) })
      }, [graph, deleteImpact])

      /**
       * Remove ONE node and every wire on it.
       *
       * The wires go WITH the node. `normalizeGraph` would strip dangling edges
       * on the way back anyway — but only after a round trip, which makes the
       * deletion look like it did not take and leaves the canvas drawing a wire
       * to nothing in the meantime.
       *
       * Downstream nodes are deliberately LEFT ALONE: they lose an input, and the
       * next preflight says so. Cascading the delete would let one click take out
       * a chain of paid generations.
       */
      const deleteNode = React.useCallback((nodeId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const node = next.nodes.find((candidate) => candidate.id === nodeId)
        next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId)
        next.edges = next.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
        setPendingDelete(null)
        if (selected === nodeId) setSelected(null)
        void saveGraph(next, { allowInvalid: true, announce: `已删除「${node?.title || node?.type || nodeId}」` })
      }, [graph, selected, saveGraph])

      /* Delete removes the selected node — but only when focus is NOT in a text
         field. Otherwise backspacing a character out of a prompt would delete the
         node you are typing into. */
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') { setPendingDelete(null); return }
          if (event.key !== 'Delete' && event.key !== 'Backspace') return
          const target = event.target
          const tag = String(target?.tagName ?? '').toLowerCase()
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true) return
          if (selected === null) return
          event.preventDefault()
          requestDelete(selected)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selected, requestDelete])

      /* ---- 角色库: define once, wire per shot ------------------------
       * A character is a DEFINITION; wiring it into a shot is what makes it
       * appear there. The first draft was global (every character on every
       * shot), which put the mouse into shots the mouse is not in — and spent
       * the API's bounded reference-image budget on them.
       * ---------------------------------------------------------------- */
      /* One factory for both kinds. A character and a place are the same node
         shape, so a second near-identical function would be the place the two
         drift apart. */
      const addBible = React.useCallback((kind) => {
        if (graph === null) return
        const label = kind === 'scene' ? '场景' : '角色'
        const next = JSON.parse(JSON.stringify(graph))
        const peers = next.nodes.filter((node) => node.type === kind)
        const id = `n_${kind}` + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
        next.nodes.push({
          id, type: kind, title: `${label} ${peers.length + 1}`,
          x: 20, y: 120 + (next.nodes.length % 8) * 110,
          fields: { name: `${label} ${peers.length + 1}`, description: '', source: '' },
        })
        void saveGraph(next, { allowInvalid: true, announce: `已添加${label} ${peers.length + 1}` })
      }, [graph, saveGraph])

      const removeCharacter = React.useCallback((nodeId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        next.nodes = next.nodes.filter((node) => node.id !== nodeId)
        // Drop the wires WITH the node. A dangling edge would be stripped by
        // `normalizeGraph` on the way back anyway — but only after a round trip
        // that makes the deletion look like it did not take.
        next.edges = next.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
        void saveGraph(next, { allowInvalid: true, announce: '已删除角色' })
      }, [graph, saveGraph])

      /** Wire one character into every shot that does not already have it. */
      const wireCastToAll = React.useCallback((nodeId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const shots = next.nodes.filter((node) => SHOT_TYPES.has(node.type) && node.shotIndex !== null)
        let added = 0
        for (const shot of shots) {
          const wired = next.edges.some((edge) =>
            edge.from === nodeId && edge.to === shot.id && edge.toPort === 'refs')
          if (wired) continue
          next.edges.push({
            id: 'e_' + nodeId + '_' + shot.id, from: nodeId, fromPort: 'asset', to: shot.id, toPort: 'refs', label: '',
          })
          added += 1
        }
        if (added === 0) { say('这个角色已经接到所有镜头了', 'bad'); return }
        void saveGraph(next, { allowInvalid: true, announce: `已接到 ${added} 个镜头` })
      }, [graph, saveGraph, say])

      /** Unwire one character from one shot — the per-shot call sheet. */
      const unwireCastFromShot = React.useCallback((castId, shotId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        next.edges = next.edges.filter((edge) =>
          !(edge.from === castId && edge.to === shotId && edge.toPort === 'refs'))
        void saveGraph(next, { allowInvalid: true, announce: '已从这个镜头撤下' })
      }, [graph, saveGraph])

      /* ---- 衔接: 断开 / 接上取帧 -------------------------------------
       * The graph's frame chain is TOPOLOGY, so the control is too: adding the
       * take node and its two wires, or removing them. A boolean field would be
       * a second source of truth that lies the moment someone deletes a wire by
       * hand — and deleting a wire by hand is a normal thing to do here.
       * ---------------------------------------------------------------- */
      const unlinkFrames = React.useCallback((shotId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const feeds = next.edges.filter((edge) => edge.to === shotId && edge.toPort === 'frames')
        const takeIds = new Set(feeds.map((edge) => edge.from))
        next.edges = next.edges.filter((edge) =>
          !(edge.to === shotId && edge.toPort === 'frames') && !takeIds.has(edge.to))
        next.nodes = next.nodes.filter((node) => !takeIds.has(node.id))
        void saveGraph(next, { allowInvalid: true, announce: '这一镜改成硬切（转场）' })
      }, [graph, saveGraph])

      const relinkFrames = React.useCallback((shotId) => {
        if (graph === null) return
        const next = JSON.parse(JSON.stringify(graph))
        const shot = next.nodes.find((node) => node.id === shotId)
        if (shot === undefined) return
        const earlier = next.nodes
          .filter((node) => SHOT_TYPES.has(node.type) && node.shotIndex !== null && node.shotIndex < shot.shotIndex)
          .sort((a, b) => b.shotIndex - a.shotIndex)
        const previous = earlier[0]
        if (previous === undefined) { say('这是第一个镜头，没有上一镜可接', 'bad'); return }
        const takeId = 'n_take' + Date.now().toString(36)
        next.nodes.push({
          id: takeId, type: 'take', title: `取帧 ${previous.shotIndex}→${shot.shotIndex}`,
          x: (shot.x ?? 0) + 20, y: (shot.y ?? 0) + 105,
          fields: { frame: 'last_frame', slot: 'first_frame' },
        })
        next.edges.push({ id: 'e_' + takeId + '_in', from: previous.id, fromPort: 'job', to: takeId, toPort: 'job' })
        next.edges.push({ id: 'e_' + takeId + '_out', from: takeId, fromPort: 'image', to: shotId, toPort: 'frames' })
        void saveGraph(next, { allowInvalid: true, announce: `已接上 #${previous.shotIndex}` })
      }, [graph, saveGraph, say])

      /* Controlled-field helpers. `shownField` prefers the in-progress draft for
         THIS node+field and otherwise reads the node, so the displayed value can
         never belong to a different node than the heading above it. */
      const shownField = (nodeId, key, fallback) =>
        (fieldDraft !== null && fieldDraft.nodeId === nodeId && fieldDraft.key === key
          ? fieldDraft.value
          : fallback)
      const editField = (nodeId, key, value) => setFieldDraft({ nodeId, key, value })
      const commitField = (nodeId, key, kind) => {
        if (fieldDraft === null || fieldDraft.nodeId !== nodeId || fieldDraft.key !== key) return
        const raw = String(fieldDraft.value ?? '')
        // Write to the node the draft BELONGS to, not to whatever is selected.
        // `updateField` is bound to `selected`, so the roster — which edits a
        // dozen nodes without ever changing the selection — wrote every character
        // field onto the currently selected node instead.
        writeNodeField(nodeId, key, kind === 'number' ? Number(raw.trim()) : raw)
        setFieldDraft(null)
      }
      // A draft belongs to one node; dropping it on re-selection stops a
      // half-typed value from resurfacing when the user comes back.
      React.useEffect(() => { setFieldDraft(null) }, [selected])

      /* ---- authoring: add a node from the library --------------------
       * The library rows were plain divs with no handler, so the whole left
       * column was decorative and the canvas could only ever show the nodes a
       * tool call had created. Clicking a row now appends a node and selects
       * it, so the inspector is immediately usable.
       * ---------------------------------------------------------------- */
      const nodeDefaults = React.useCallback((type) => {
        const project = graph?.project ?? {}
        if (NETWORK_TYPES.has(type)) {
          return {
            model: project.model,
            duration: project.duration,
            resolution: project.resolution,
            aspectRatio: project.aspectRatio,
            prompt: '',
          }
        }
        if (type === 'script' || type === 'prompt' || type === 'note' || type === 'template') return { text: '' }
        if (type === 'ref') return { source: '', kind: 'image', slot: 'first_frame' }
        /*
         * A character is born with all THREE fields.
         *
         * It used to fall through to `{}`, so a freshly added 角色 node carried no
         * `name`, `description` or `source` at all — and the first save wrote an
         * empty node. Combined with a Host that did not know the type yet, that is
         * exactly the reported symptom: a node titled 角色 that came back as an
         * empty 注释 with one text field and no image.
         */
        if (type === 'cast' || type === 'scene') return { name: '', description: '', source: '' }
        if (type === 'take') return { frame: 'last_frame', slot: 'first_frame' }
        if (type === 'seq') return { naming: 's{idx}_take{n}' }
        return {}
      }, [graph])

      const addNode = React.useCallback((type) => {
        if (graph === null) return
        const meta = metaOf(type)
        const next = JSON.parse(JSON.stringify(graph))
        const count = next.nodes.length
        const id = 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
        next.nodes.push({
          id,
          type,
          title: meta.label,
          x: 40 + (count % 4) * 230,
          /* y starts past the floating toolbar (which occupies the canvas's
             top-left) so a freshly added node is never hidden behind it. */
          y: 70 + Math.floor(count / 4) * 175,
          w: 190,
          shotIndex: null,
          disabled: false,
          fields: nodeDefaults(type),
        })
        setSelected(id)
        void saveGraph(next, { allowInvalid: true, announce: '已加入「' + meta.label + '」' })
      }, [graph, nodeDefaults, saveGraph])

      /* ---- drag a node: preview locally, write the document once -----
       * The live position lives in `dragNode`, NOT in `graph`, so a drag is one
       * write on mouseup instead of one per mousemove. The mutable `drag`
       * record is the authoritative end position — reading it back beats
       * depending on a React state update that may not have flushed yet.
       * ---------------------------------------------------------------- */
      const onNodeDown = React.useCallback((event, node) => {
        event.stopPropagation()
        selectNode(node.id)
        if (event.button !== 0) return
        const startX = event.clientX
        const startY = event.clientY
        const originX = Number(node.x) || 0
        const originY = Number(node.y) || 0
        const k = zoom.k
        const drag = { id: node.id, x: originX, y: originY, moved: false }
        nodeDragRef.current = drag
        const move = (moveEvent) => {
          if (!drag.moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 3) return
          drag.moved = true
          drag.x = Math.round(originX + (moveEvent.clientX - startX) / k)
          drag.y = Math.round(originY + (moveEvent.clientY - startY) / k)
          setDragNode({ id: node.id, x: drag.x, y: drag.y })
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          nodeDragRef.current = null
          setDragNode(null)
          if (!drag.moved) return
          const movedGraph = JSON.parse(JSON.stringify(graph))
          const target = movedGraph.nodes.find((n) => n.id === drag.id)
          if (target === undefined) return
          target.x = drag.x
          target.y = drag.y
          void saveGraph(movedGraph)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }, [graph, saveGraph, selectNode, zoom.k])

      /* ---- the API key, settable from the workspace ------------------
       * The Host has always exposed POST /config and DELETE /config/key; the
       * client read the key status and then never rendered it, so the only way
       * in was the plugin settings panel. A field that refuses to submit a key
       * the Host would reject locally (it must start with sk-or-) is better
       * than a silent round trip.
       * ---------------------------------------------------------------- */
      const saveKey = React.useCallback(async () => {
        const value = keyDraft.trim()
        if (value.length === 0) return
        if (!value.startsWith('sk-or-')) { say('密钥应以 sk-or- 开头，请核对', 'bad'); return }
        setKeyBusy(true)
        try {
          const result = await api('/config', { method: 'POST', body: { config: { apiKey: value } } })
          /* The route reports failures as HTTP 200 + {ok:false}, so `api()` does
             NOT throw on them. Without this check a failed save still said
             "已保存" — which is exactly how a key that never persisted looked
             fine while the strip kept reading 未配置. */
          if (result.ok !== true) { say(result.error ?? '密钥保存失败', 'bad'); return }
          setKeyInfo(result.key ?? null)
          setKeyDraft('')
          if (result.key?.hasKey === true) {
            say('密钥已保存')
            log('已更新 OpenRouter 密钥')
          } else {
            say('保存已提交，但状态仍未生效 —— 刷新页面确认', 'bad')
          }
        } catch (err) { say(err.message, 'bad') } finally { setKeyBusy(false) }
      }, [api, keyDraft, log, say])

      const clearKey = React.useCallback(async () => {
        setKeyBusy(true)
        try {
          const result = await api('/config/key', { method: 'DELETE' })
          if (result.ok !== true) { say(result.error ?? '清除失败', 'bad'); return }
          setKeyInfo(result.key ?? null)
          setKeyTest(null)
          say('已清除密钥')
        } catch (err) { say(err.message, 'bad') } finally { setKeyBusy(false) }
      }, [api, say])

      /* `/config/test` has always existed on the Host but nothing in the UI ever
         called it, so "is this key actually good" was only answerable by running
         a paid render. It costs one authenticated GET of the (free) model list. */
      const testKey = React.useCallback(async () => {
        setKeyTesting(true)
        setKeyTest(null)
        try {
          const result = await api('/test')
          setKeyTest({ ok: result.ok === true, message: result.ok === true ? result.message : (result.error ?? '未知错误') })
        } catch (err) {
          setKeyTest({ ok: false, message: err.message })
        } finally { setKeyTesting(false) }
      }, [api])

      /* ---- the model shortlist --------------------------------------
       * `model` has always been a single value, and the inspector's dropdown
       * offered the ENTIRE OpenRouter video catalog — hundreds of entries, of
       * which four are ever used. A shortlist with one marked default is the
       * missing half: it is also what the per-node model picker now offers.
       * ---------------------------------------------------------------- */
      const commitModels = React.useCallback(async (nextList, alsoSetDefault) => {
        const body = { models: nextList }
        if (typeof alsoSetDefault === 'string' && alsoSetDefault.length > 0) body.model = alsoSetDefault
        try {
          const result = await api('/config', { method: 'POST', body: { config: body } })
          if (result.ok !== true) { say(result.error ?? '模型列表保存失败', 'bad'); return false }
          setConfig(result.config ?? {})
          setModelsDraft(Array.isArray(result.config?.models) ? result.config.models : [])
          return true
        } catch (err) { say(err.message, 'bad'); return false }
      }, [api, say])

      const addModel = React.useCallback(async () => {
        const id = modelInput.trim()
        if (id.length === 0) return
        if (modelsDraft.includes(id)) { say('这个模型已经在列表里了', 'bad'); return }
        // The FIRST model added becomes the default — otherwise "add a model"
        // leaves the project still pointed at a model the user just removed from
        // the list, which looks like the save silently failed.
        const alsoDefault = (config?.model ?? '').length === 0 || modelsDraft.length === 0 ? id : null
        if (await commitModels([...modelsDraft, id], alsoDefault)) {
          setModelInput('')
          say(alsoDefault !== null ? `已添加 ${id}，并设为默认` : `已添加 ${id}`)
        }
      }, [commitModels, config, modelInput, modelsDraft, say])

      const removeModel = React.useCallback(async (id) => {
        if (await commitModels(modelsDraft.filter((row) => row !== id), null)) say(`已移除 ${id}`)
      }, [commitModels, modelsDraft, say])

      const setDefaultModel = React.useCallback(async (id) => {
        if (await commitModels(modelsDraft, id)) { say(`默认模型改为 ${id}`); log('默认模型 ' + id) }
      }, [commitModels, modelsDraft, log, say])

      const applyConfig = React.useCallback((cfg) => {
        setConfig(cfg.config ?? {})
        setKeyInfo(cfg.key ?? null)
        setBedDraft({
          url: cfg.config?.imageBedUrl ?? '',
          folder: cfg.config?.imageBedFolder ?? 'test',
          userAgent: cfg.config?.imageBedUserAgent ?? 'gobelagent',
          token: '',
        })
        setModelsDraft(Array.isArray(cfg.config?.models) ? cfg.config.models : [])
      }, [])

      /* The image bed is the mechanism, not a convenience: `take` cuts a frame
         with ffmpeg and the bed gives it a URL a provider will actually fetch.
         With no bed the chained shot silently becomes an independent take, so
         the Host warns about it — and this is where the user fixes it. */
      const saveBed = React.useCallback(async () => {
        setBedBusy(true)
        try {
          const patch = {
            imageBedUrl: bedDraft.url.trim().replace(/\/+$/u, ''),
            imageBedFolder: bedDraft.folder.trim() || 'test',
            imageBedUserAgent: bedDraft.userAgent.trim() || 'gobelagent',
          }
          // A blank token means "leave it alone" — the same rule the key uses.
          if (bedDraft.token.trim().length > 0) patch.imageBedToken = bedDraft.token.trim()
          const result = await api('/config', { method: 'POST', body: { config: patch } })
          if (result.ok !== true) { say(result.error ?? '图床设置保存失败', 'bad'); return }
          applyConfig(await api('/config'))
          const saved = result.config?.imageBedUrl ?? ''
          if (saved.length === 0) say('图床已清空 —— 首尾帧续接会退化成独立生成', 'bad')
          else { say('图床已保存'); log('图床 ' + saved) }
        } catch (err) { say(err.message, 'bad') } finally { setBedBusy(false) }
      }, [api, applyConfig, bedDraft, log, say])

      /* Probing beats describing. A Cloudflare-fronted bed answers 403 with an
         HTML interstitial to the wrong User-Agent, and the only other place that
         surfaces is three shots into a film, as a chained shot that quietly
         became an independent take. It sends the UNSAVED draft, so the button
         tests what is on screen. */
      const testBed = React.useCallback(async () => {
        setBedTesting(true)
        setBedTest(null)
        try {
          const result = await api('/bed/test', {
            method: 'POST',
            body: {
              url: bedDraft.url.trim(),
              folder: bedDraft.folder.trim(),
              userAgent: bedDraft.userAgent.trim(),
            },
          })
          setBedTest({ ok: result.ok === true, message: result.ok === true ? result.message : (result.error ?? '未知错误') })
        } catch (err) {
          setBedTest({ ok: false, message: err.message })
        } finally { setBedTesting(false) }
      }, [api, bedDraft])

      /* ================================================================ *
       * render
       * ================================================================ */
      if (error !== null && config === null) {
        return h('div', { className: 'dsh-ov-root' },
          h('div', { className: 'dsh-ov-empty' }, '工作台加载失败：' + error))
      }

      const selectedNode = graph !== null && selected !== null
        ? graph.nodes.find((node) => node.id === selected) ?? null
        : null

      /* How many nodes a retry of the current selection would actually re-submit.
         The LABEL only — the Host re-derives the subset when the run happens. The
         count is why the retry control can be absent rather than dead: with nothing
         failed there is nothing to retry, so there is no button promising it. */
      const retryCount = selected === null
        ? 0
        : subsetOf(selected).filter((id) => states[id] === 'failed').length

      /* Both pinned-setting kinds. The roster and the top-bar count treat them
         alike because they ARE alike: a definition you wire into the shots it
         applies to. */
      const isBible = (node) => node.type === 'cast' || node.type === 'scene'
      const castNodes = (graph?.nodes ?? []).filter(isBible)

      /*
       * Node-type SKEW detection.
       *
       * The client mirrors the Host's node registry, and the Host half does not
       * hot-reload — so a client newer than the running Host is a normal state.
       * It used to present itself as a node that came back as an empty 注释 with
       * a single text field and no image, with nothing saying why. The Host now
       * publishes its registry; this refuses to offer a type the Host cannot
       * honour, and names the ones it is holding back.
       */
      const hostTypes = Array.isArray(config?.nodeTypes) ? config.nodeTypes : null
      const unknownToHost = hostTypes === null
        ? []
        : Object.keys(NODE_META).filter((type) => !hostTypes.includes(type))
      const hostKnows = (type) => hostTypes === null || hostTypes.includes(type)

      const nodeEls = []
      if (graph !== null) {
        for (const node of graph.nodes) {
          const meta = metaOf(node.type)
          const state = states[node.id] ?? 'idle'
          const [label, tone] = stateLabel(state)
          const job = derived.jobsByNode.get(node.id) ?? null
          const ceiling = ceilings[node.id]
          const isNet = isNetwork(node)

          /* Cost cell: only for network nodes, and computed INSIDE the guard.
             Computing it first and guarding the render is how the prototype
             produced `Cannot read properties of undefined` — a guard that
             wraps the USE instead of the EVALUATION. */
          let costText = null
          if (isNet) {
            if (state === 'completed' && typeof job?.cost === 'number') costText = usd(job.cost) + ' 实账'
            else if (ceiling === null || ceiling === undefined) costText = '量级未知'
            else costText = '≤' + usd(ceiling)
          }

          const inputs = (meta.inputs ?? []).map(([port, type, required]) =>
            h('div', { className: 'dsh-ov-prow', key: 'in-' + port },
              h('span', {
                className: 'dsh-ov-pdot',
                id: 'ov-port-in-' + node.id + '-' + port,
                style: { background: PORT_COLOR[type] ?? 'var(--dsw-alias-label-tertiary)' },
                'data-armed': armed !== null && armed.nodeId === node.id && armed.port === port ? '1' : '0',
                title: port + ': ' + type + (required === true ? ' · 必填' : ''),
                onClick: (event) => { event.stopPropagation(); onPortClick(node.id, port, 'in', type) },
              }),
              h('span', { className: 'dsh-ov-ptxt' }, port, required === true ? h('i', null, ' *') : null)))

          const outputs = (meta.outputs ?? []).map(([port, type]) =>
            h('div', { className: 'dsh-ov-prow', key: 'out-' + port },
              h('span', { className: 'dsh-ov-ptxt' }, port),
              h('span', {
                className: 'dsh-ov-pdot',
                id: 'ov-port-out-' + node.id + '-' + port,
                style: { background: PORT_COLOR[type] ?? 'var(--dsw-alias-label-tertiary)' },
                'data-armed': armed !== null && armed.nodeId === node.id && armed.port === port ? '1' : '0',
                title: port + ': ' + type,
                onClick: (event) => { event.stopPropagation(); onPortClick(node.id, port, 'out', type) },
              })))

          const kvs = []
          if (node.fields?.model !== undefined || graph.project?.model !== undefined) {
            kvs.push(h('div', { className: 'dsh-ov-kv', key: 'model' },
              h('span', null, '模型'),
              h('b', { title: node.fields?.model ?? graph.project?.model ?? '' },
                shortModel(node.fields?.model ?? graph.project?.model ?? ''))))
          }
          if (node.fields?.duration !== undefined || graph.project?.duration !== undefined) {
            kvs.push(h('div', { className: 'dsh-ov-kv', key: 'dur' },
              h('span', null, '时长'),
              h('b', null, String(node.fields?.duration ?? graph.project?.duration ?? '') + 's')))
          }
          if (node.type === 'ref' && typeof node.fields?.source === 'string') {
            kvs.push(h('div', { className: 'dsh-ov-kv', key: 'src' },
              h('span', null, '素材'),
              h('b', { title: node.fields.source },
                node.fields.source.length > 18 ? node.fields.source.slice(-16) : node.fields.source)))
          }

          const holding = dragNode !== null && dragNode.id === node.id
          const isRenaming = renaming !== null && renaming.id === node.id
          /* A 角色 / 场景 / 参考素材 node is a public image URL and nothing else, so
             it rendered no picture at all: you could not tell which cat a node was
             without opening the URL in another tab. Only http(s) is accepted —
             the provider itself can only fetch a public URL, so a local path
             would preview into a broken-image glyph and promise something the
             request will never send. */
          const rawAsset = typeof node.fields?.source === 'string' ? node.fields.source.trim() : ''
          const assetImage = /^https?:\/\//u.test(rawAsset)
            && (node.type === 'cast' || node.type === 'scene'
              || (node.type === 'ref' && (node.fields?.kind ?? 'image') === 'image'))
            ? rawAsset : null
          const hasFilm = job?.status === 'completed' && typeof job?.filePathRelative === 'string'
          nodeEls.push(h('div', {
            className: 'dsh-ov-node',
            key: node.id,
            id: 'ov-node-' + node.id,
            'data-sel': selected === node.id ? '1' : '0',
            'data-state': state,
            'data-disabled': node.disabled === true ? '1' : '0',
            'data-drag': holding ? '1' : '0',
            style: {
              left: (holding ? dragNode.x : node.x) + 'px',
              top: (holding ? dragNode.y : node.y) + 'px',
              width: (node.w ?? 190) + 'px',
            },
            onMouseDown: (event) => onNodeDown(event, node),
          },
          h('div', { className: 'dsh-ov-nhead' },
            h('i', { className: 'dsh-ov-swatch', style: { background: meta.color } }),
            isRenaming
              ? h('input', {
                  className: 'dsh-ov-ntitle dsh-ov-ntitle-edit',
                  key: 'rename',
                  id: 'ov-rename-' + node.id,
                  'data-act': 'rename-input',
                  'data-node': node.id,
                  value: renaming.value,
                  autoFocus: true,
                  spellCheck: false,
                  title: '回车确认 · Esc 取消',
                  onClick: (event) => event.stopPropagation(),
                  /* Without this the node's own mousedown handler starts a drag
                     and the caret never lands in the field. */
                  onMouseDown: (event) => event.stopPropagation(),
                  onChange: (event) => editRename(node.id, event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); commitRename() }
                    else if (event.key === 'Escape') { event.preventDefault(); cancelRename() }
                  },
                  onBlur: () => commitRename(),
                })
              : h('span', {
                  className: 'dsh-ov-ntitle',
                  'data-act': 'node-title',
                  'data-node': node.id,
                  title: (node.title || meta.label) + ' —— 双击改名',
                  onDoubleClick: (event) => { event.stopPropagation(); beginRename(node) },
                }, node.title || meta.label),
            node.shotIndex !== null && node.shotIndex !== undefined
              ? h('span', { className: 'dsh-ov-shot' }, '#' + node.shotIndex)
              : null),
          (inputs.length > 0 || outputs.length > 0)
            ? h('div', { className: 'dsh-ov-portrows' },
                h('div', { className: 'dsh-ov-ports', 'data-dir': 'in' }, inputs),
                h('div', { className: 'dsh-ov-ports', 'data-dir': 'out' }, outputs))
            : null,
          kvs.length > 0 ? h('div', { className: 'dsh-ov-nbody' }, kvs) : null,
          isNet
            ? h('div', { className: 'dsh-ov-nstat' },
                h('span', {
                  style: {
                    color: state === 'completed' ? 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))'
                      : state === 'failed' ? 'var(--dsw-alias-state-error-primary)'
                      : state === 'in_progress' ? 'var(--dsw-alias-state-warn-primary)'
                      : 'var(--dsw-alias-label-tertiary)',
                  },
                }, label),
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, costText))
            : h('div', { className: 'dsh-ov-nstat' },
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '本地 · 不发请求')),
          h('div', { className: 'dsh-ov-thumb',
            'data-media': hasFilm || assetImage !== null ? '1' : '0',
            'data-asset': assetImage !== null ? '1' : '0' },
            hasFilm
              ? h('video', { src: API + '/content?id=' + encodeURIComponent(job.id), muted: true, preload: 'metadata' })
              : assetImage !== null
                ? h('img', {
                    src: assetImage,
                    alt: node.fields?.name ?? '',
                    loading: 'lazy',
                    referrerPolicy: 'no-referrer',
                    title: assetImage,
                    /* A dead link must say so rather than leave a black box that
                       looks like a slow load. */
                    onError: (event) => {
                      const box = event.target?.parentNode
                      if (box !== null && box !== undefined && typeof box.setAttribute === 'function') {
                        box.setAttribute('data-broken', '1')
                      }
                      if (event.target?.style !== undefined) event.target.style.display = 'none'
                    },
                  })
                : h('span', null, state === 'in_progress' ? '生成中…' : (state === 'failed' ? '失败' : '—'))),
          state === 'in_progress' || state === 'submitted' || state === 'queued'
            ? h('div', { className: 'dsh-ov-bar' }, h('i', { style: { width: '55%' } }))
            : null,
          state === 'failed' ? h('div', { className: 'dsh-ov-flag', 'data-side': 'l', style: { background: 'var(--dsw-alias-state-error-primary)' } }, '!') : null))
        }
      }

      /* ---- clip preview -------------------------------------------------
       * ONE entry point for "open this clip", shared by the bottom strip and the
       * sequence table's thumbnail. A clip with no file yet still has a useful
       * meaning — "take me to this shot" — so it falls back to selection instead
       * of opening a modal that would play nothing. */
      const CONTINUITY_TEXT = { frames: '取帧接龙', link: '续接', cut: '硬切（转场）' }
      const openClip = (row) => {
        const job = row.job
        if (row.state !== 'completed' || job === null || typeof job.filePathRelative !== 'string') {
          selectNode(row.node.id)
          return
        }
        setClipPreview({
          nodeId: row.node.id,
          jobId: job.id,
          title: row.node.title || ('镜头 ' + row.node.shotIndex),
          shotIndex: row.node.shotIndex,
          seconds: row.seconds,
          model: row.model,
          cost: row.actual,
          cast: Array.isArray(row.cast) ? row.cast : [],
          continuity: CONTINUITY_TEXT[row.continuity.kind] ?? row.continuity.kind,
          file: job.filePathRelative,
        })
      }

      /* ---- sequence view rows ---- */
      const shotRowEls = derived.shotRows.map((row, index) => {
        const [label] = stateLabel(row.state)
        const previous = index > 0 ? derived.shotRows[index - 1] : null
        const seam = previous !== null && previous.model !== row.model && row.continuity.kind === 'cut'
        const job = row.job
        const costText = row.state === 'completed' && row.actual !== null
          ? usd(row.actual)
          : (row.ceiling === null ? '未知' : '≤' + usd(row.ceiling))
        return h('tr', {
          key: row.node.id,
          'data-sel': selected === row.node.id ? '1' : '0',
          onClick: () => selectNode(row.node.id),
          style: { cursor: 'pointer' },
        },
        h('td', { className: 'dsh-ov-idx' }, String(row.node.shotIndex)),
        h('td', { className: 'dsh-ov-th' },
          h('div', {
            'data-media': job?.status === 'completed' && typeof job?.filePathRelative === 'string' ? '1' : '0',
            title: job?.status === 'completed' && typeof job?.filePathRelative === 'string' ? '点开预览这一镜' : '',
            /* The row's own click selects the node; the thumbnail means "play
               this", so it must not be swallowed by that. */
            onClick: (event) => { event.stopPropagation(); openClip(row) },
          },
            job?.status === 'completed' && typeof job?.filePathRelative === 'string'
              ? h('video', { src: API + '/content?id=' + encodeURIComponent(job.id), muted: true, preload: 'metadata' })
              : (row.state === 'in_progress' ? '◌' : '—'))),
        h('td', null, h('b', null, row.node.title || '镜头 ' + row.node.shotIndex)),
        h('td', null, row.seconds + 's'),
        h('td', { title: row.model }, shortModel(row.model)),
        // Who is IN this shot. Derived from the wires, so this column cannot
        // disagree with what the request will send.
        h('td', { 'data-cast': row.cast.join(',') },
          row.cast.length === 0
            ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '—')
            : row.cast.join('、')),
        h('td', null, row.resolution),
        h('td', null, h('span', { className: 'dsh-ov-badge' }, label)),
        h('td', { style: { color: row.ceiling === null && row.actual === null ? 'var(--dsw-alias-label-secondary)' : undefined } }, costText),
        // The REAL mechanism, from topology — not from `link`, which only ever
        // meant `previous_job_id` and so labelled every chained shot 独立起幅.
        h('td', { className: seam ? undefined : 'dsh-ov-link', 'data-continuity': row.continuity.kind,
          style: seam ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined },
          row.continuity.kind === 'frames'
            ? '取帧接龙' + (row.continuity.from !== null ? ' #' + row.continuity.from : '')
            : row.continuity.kind === 'link'
              ? '续接 ' + (previous !== null ? '#' + previous.node.shotIndex : '')
              : '硬切（转场）',
          seam ? ' ⚠ 换模型' : ''))
      })

      /* ---- bottom strip ---- */
      const stripEls = derived.shotRows.map((row) => {
        const job = row.job
        const state = row.state
        const playable = state === 'completed' && typeof job?.filePathRelative === 'string'
        return h('div', {
          className: 'dsh-ov-strip',
          key: 'strip-' + row.node.id,
          'data-sel': selected === row.node.id ? '1' : '0',
          'data-ready': playable ? '1' : '0',
          'data-node': row.node.id,
          onClick: () => openClip(row),
          title: playable
            ? (row.node.title || '') + ' · 点击预览'
            : (row.node.title || '') + ' · 还没有成片',
        },
        h('div', { className: 'dsh-ov-snum' }, String(row.node.shotIndex)),
        h('div', { className: 'dsh-ov-sbox' },
          state === 'completed' && typeof job?.filePathRelative === 'string'
            ? h('video', { src: API + '/content?id=' + encodeURIComponent(job.id), muted: true, preload: 'metadata' })
            : (state === 'in_progress' ? '◌' : (state === 'failed' ? '!' : '—'))),
        h('div', { className: 'dsh-ov-slabel' }, (row.node.title || '').split(' ')[0].slice(0, 6)))
      })

      /* ---- inspector ---- */
      const inspectorEls = []
      if (selectedNode === null) {
        inspectorEls.push(h('div', { className: 'dsh-ov-empty' }, '点一个节点查看参数'))
      } else {
        const meta = metaOf(selectedNode.type)
        const state = states[selectedNode.id] ?? 'idle'
        const job = derived.jobsByNode.get(selectedNode.id) ?? null
        /* What this node IS, on every type — not only on 角色/场景. See NODE_BLURB. */
        const blurb = NODE_BLURB[selectedNode.type] ?? null
        /* The node's own picture, when it has one. Only http(s): the provider can
           only fetch a public URL, so previewing a local path would draw a broken
           glyph and promise a request that can never be sent. */
        const inspectorSource = typeof selectedNode.fields?.source === 'string'
          ? selectedNode.fields.source.trim() : ''
        const inspectorImage = /^https?:\/\//u.test(inspectorSource)
          && (selectedNode.type === 'cast' || selectedNode.type === 'scene'
            || (selectedNode.type === 'ref' && (selectedNode.fields?.kind ?? 'image') === 'image'))
          ? inspectorSource : null
        inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'head' },
          h('h4', null,
            h('i', { className: 'dsh-ov-swatch', style: { background: meta.color } }),
            selectedNode.title || meta.label),
          h('div', { className: 'dsh-ov-note' },
            selectedNode.id + ' · ' + selectedNode.type
            + (selectedNode.shotIndex !== null && selectedNode.shotIndex !== undefined ? ' · 镜头 #' + selectedNode.shotIndex : '')),
          blurb === null
            ? null
            : h('div', { className: 'dsh-ov-note', key: 'blurb', 'data-act': 'node-blurb',
                title: blurb.long ?? blurb.text }, blurb.text),
          h('div', { className: 'dsh-ov-row', key: 'head-acts' },
            h('button', {
              className: 'dsh-ov-btn', 'data-act': 'rename-node',
              title: '也可以直接双击画布上这个节点的标题',
              onClick: () => beginRename(selectedNode),
            }, '重命名'),
            h('button', {
              className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'delete-node',
              title: '也可以选中节点后按 Delete',
              onClick: () => requestDelete(selectedNode.id),
            }, '删除节点'))))

        /* The reference picture itself. A 角色/场景/素材 node is defined by its image,
           and the panel showed the URL as a string — so you had to leave the
           workspace to check which cat this node was. */
        if (inspectorImage !== null) {
          const assetLabel = selectedNode.type === 'scene' ? '环境空镜'
            : selectedNode.type === 'cast' ? '角色参考图' : '参考素材'
          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'assetimg', 'data-act': 'node-asset-image' },
            h('h4', null, assetLabel),
            h('img', {
              className: 'dsh-ov-assetimg',
              src: inspectorImage,
              alt: selectedNode.fields?.name ?? assetLabel,
              title: inspectorImage,
              referrerPolicy: 'no-referrer',
              /* A dead link must say so rather than sit there as an empty frame. */
              onError: (event) => {
                const card = event.target?.parentNode
                if (card !== null && card !== undefined && typeof card.setAttribute === 'function') {
                  card.setAttribute('data-broken', '1')
                }
                if (event.target?.style !== undefined) event.target.style.display = 'none'
              },
            }),
            h('div', { className: 'dsh-ov-note', title: inspectorImage },
              '公开 https 地址 —— provider 只能抓公网 URL。')))
        }

        /* The confirm bar. It states the cost of the delete BEFORE anything is
           removed, because one click here can drop a paid generation and the
           wires that carry the film's structure. */
        if (pendingDelete !== null && pendingDelete.id === selectedNode.id) {
          const bits = [`会同时删掉 ${pendingDelete.wires} 条连线`]
          if (pendingDelete.upstream.length > 0) bits.push(`上游 ${pendingDelete.upstream.length} 个节点失去下游`)
          if (pendingDelete.downstream.length > 0) {
            const names = pendingDelete.downstream.slice(0, 4).map((node) => node.title || node.type)
            bits.push(`下游 ${pendingDelete.downstream.length} 个节点失去输入（${names.join('、')}`
              + (pendingDelete.downstream.length > 4 ? ' 等' : '') + '）')
          }
          inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'error', key: 'del', 'data-act': 'delete-confirm' },
            h('b', null, `删除「${selectedNode.title || meta.label}」？`),
            bits.join('；') + '。下游节点不会被连带删除 —— 它们会缺输入，下次预检会点出来。',
            h('div', { className: 'dsh-ov-row' },
              h('button', {
                className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'delete-confirm-yes',
                onClick: () => deleteNode(selectedNode.id),
              }, '确认删除'),
              h('button', {
                className: 'dsh-ov-btn', 'data-act': 'delete-confirm-no',
                onClick: () => setPendingDelete(null),
              }, '取消'))))
        }

        if (state === 'failed' && job?.error) {
          inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'error', key: 'err' },
            h('b', null, '失败'), job.error))
        }
        /* Two warnings, one per case, so they never stack saying the same rule.
           A NON-character reference wired next to a first frame gets the generic
           one; a character gets the specific one below, which says what to do
           about it (turn the shot into a hard cut). */
        const nonCastRefHere = (graph.edges ?? []).some((edge) =>
          edge.to === selectedNode.id && edge.toPort === 'refs'
          && graph.nodes.some((node) => node.id === edge.from && node.type !== 'cast'))
        if (selectedNode.type === 'generate' && nonCastRefHere
            && graph.edges.some((e) => e.to === selectedNode.id && e.toPort === 'frames')) {
          inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn', key: 'w1',
            title: '实测 heygen 返回 400：does not accept input_references alongside a first_frame image。'
              + '管线本身不改 graph：把 refs 拆掉，改成硬切（转场）就能让参考图生效。' },
            h('b', null, 'frames 与 refs 都接了'),
            'provider 会拒绝这个组合（实测 400），插件只发首帧、把这些参考图丢掉。'))
        }

        if (selectedNode.type === 'cast' || selectedNode.type === 'scene') {
          /* The one-line description of what a 角色/场景 node IS now lives in the
             head card, with every other node type (see NODE_BLURB) — the full
             five-line explanation is its hover title. What stays here is the part
             that is NOT a description: the wiring this node actually has, the
             warning when it has none, and the warning when it has an image but no
             pinned description. */
          const isScene = selectedNode.type === 'scene'
          const noun = isScene ? '场景' : '角色'
          const wired = graph.nodes.filter((candidate) => SHOT_TYPES.has(candidate.type)
            && graph.edges.some((edge) => edge.from === selectedNode.id && edge.to === candidate.id && edge.toPort === 'refs'))
          const hasDescription = (selectedNode.fields?.description ?? '').length > 0
          const hasImage = (selectedNode.fields?.source ?? '').length > 0
          /* The wired-shot count used to be one long string crushed against the
             right edge — "5 镜（#1 #3 #4 #5 #6）". Chips say the same thing, keep
             the count, and make a wrong scope visible at a glance. */
          inspectorEls.push(h('div', { className: 'dsh-ov-kv', key: 'cast-wired' },
            h('span', null, '当前出场'),
            wired.length === 0
              ? h('b', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '没有镜头')
              : h('span', { className: 'dsh-ov-chips' },
                  h('i', { className: 'dsh-ov-chip', 'data-kind': 'count', key: 'count' }, wired.length + ' 镜'),
                  wired.map((node) => h('i', { className: 'dsh-ov-chip', key: 'w-' + node.id },
                    '#' + node.shotIndex)))))
          if (wired.length === 0) {
            inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn', key: 'cast-idle' },
              h('b', null, `这个${noun}现在不起作用`),
              `没有连到任何镜头。用顶栏「设定」→「接到全部镜头」，或从这里拉线到镜头的 refs 口。`))
          }
          if (hasImage && !hasDescription) {
            inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn', key: 'cast-desc' },
              h('b', null, `只有参考图、没有固定${noun}描述`),
              `参考图只在没接首帧的镜头里生效；其余镜头靠这段描述保持一致 —— `
              + (isScene ? '否则每一镜的墙面、光线、时间各不一样。' : '否则长相随镜头漂移。')
              + '描述是性价比最高的一层，别省。'))
          }
        }
        /* Only fires when something is actually WIRED to THIS shot. It used to
           fire on `castNodes.length > 0` — any reference anywhere in the graph —
           so a landscape shot in a film that happens to have a cat was told its
           reference was being overridden by its first frame. */
        const refWiredHere = (graph.edges ?? []).some((edge) =>
          edge.to === selectedNode.id && edge.toPort === 'refs'
          && graph.nodes.some((node) => node.id === edge.from && (node.type === 'cast' || node.type === 'scene')))
        if (selectedNode.type === 'generate' && refWiredHere
            && graph.edges.some((edge) => edge.to === selectedNode.id && edge.toPort === 'frames')) {
          inspectorEls.push(h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn', key: 'w2', 'data-act': 'frames-over-refs',
            title: 'frame_images 与 input_references 不能同发 —— 实测 heygen 返回 400，provider 会拒绝整个请求。' },
            h('b', null, '这一镜接了首帧'),
            '角色/场景参考图在这一镜会被丢掉；想用参考图定住，就把它改成硬切（转场）。'))
        }

        if (selectedNode.type === 'seq') {
          const hasFilm = job !== null && typeof job.filePath === 'string' && job.filePath.length > 0
          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'film' },
            h('h4', null, '成片'),
            hasFilm
              ? h('div', null,
                  h('video', { src: API + '/content?id=' + encodeURIComponent(job.id), controls: true, preload: 'metadata' }),
                  h('div', { className: 'dsh-ov-note' },
                    String(job.sequence?.count ?? '?') + ' 镜'
                    + (typeof job.sequence?.durationSec === 'number' ? ' · ' + Number(job.sequence.durationSec).toFixed(1) + 's' : '')
                    + (job.sequence?.mode === 'normalize' ? ' · 统一转码后拼接' : ' · 直接拼接')),
                  job.sequence?.complete === false
                    ? h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn' },
                        h('b', null, '这版成片不完整'), '缺 ' + (job.sequence?.missing ?? []).join('、'))
                    : null,
                  typeof job.filePathRelative === 'string'
                    ? h('div', { className: 'dsh-ov-note' }, job.filePathRelative)
                    : null)
              : h('div', { className: 'dsh-ov-note', key: 'seqempty',
                  title: '拼接默认走 -c copy（不重编码）；各镜的编码/分辨率/有没有音轨不一致时才统一转码。'
                    + '同时写出同名 -manifest.json，记录每一镜用的是哪个文件。' },
                  '还没有成片。跑完图后，这里会用 ffmpeg 按 shotIndex 把上游每一镜拼成一条 mp4。')))
        }

        if (isNetwork(selectedNode)) {
          const ceiling = ceilings[selectedNode.id]
          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'cost' },
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '实账 usage.cost'),
              h('b', null, typeof job?.cost === 'number' ? usd(job.cost) : '—')),
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '上界（运行前）'),
              h('b', null, ceiling === null || ceiling === undefined ? '量级未知' : '≤' + usd(ceiling))),
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '计价口径'),
              h('b', null, ceiling === null || ceiling === undefined ? 'USD / token' : 'USD / 秒')),
            ceiling === null || ceiling === undefined
              ? h('div', { className: 'dsh-ov-note' }, 'token→秒换算未公开，预算里计为「未知」，绝不当 0')
              : null))
        }

        /* Fields. The Host is the authority on what a node may contain; this
           renders whatever the node already has, plus the common ones. */
        /* Resolved BEFORE the field list, because `duration` must have exactly ONE
           control. It had two: a plain number input from fieldDefs AND the
           supported_durations control appended below, both writing the same field
           — the same "two controls for one decision" this file refuses elsewhere,
           and in the one direction that is invisible: they agreed until you used
           one of them. */
        const effectiveModel = selectedNode.fields?.model ?? graph.project?.model
        const modelInfo = catalog.models.find((m) => m.id === effectiveModel) ?? null
        const supportedDurations = Array.isArray(modelInfo?.supported_durations)
          && modelInfo.supported_durations.length > 0 ? modelInfo.supported_durations : null
        const takesDuration = selectedNode.type === 'generate' || selectedNode.type === 'extend'

        const fieldDefs = []
        if (selectedNode.type === 'generate' || selectedNode.type === 'extend' || selectedNode.type === 'edit') {
          fieldDefs.push(['prompt', '提示词', 'textarea',
            '写这一镜里发生的事：景别、运镜、动作、时长内讲多少。'])
        }
        if (isNetwork(selectedNode)) {
          fieldDefs.push(['model', '模型', 'model'])
        }
        /* One duration control, never two. When the model advertises its own
           supported_durations the block below owns the field; the plain number
           input only appears when there is nothing better to constrain it with
           (an un-catalogued or hand-typed model). */
        if (takesDuration && supportedDurations === null) {
          fieldDefs.push(['duration', '时长（秒）', 'number', '必须是所选模型 supported_durations 里的值。'])
        }
        if (selectedNode.type === 'generate') {
          fieldDefs.push(['resolution', '分辨率', 'enum'], ['aspectRatio', '画幅', 'enum'])
        }
        if (selectedNode.type === 'ref') {
          fieldDefs.push(['source', '素材 URL', 'text', '公开 https 地址 —— provider 只能抓公网 URL。'],
            ['kind', '类型', 'select'], ['slot', '接到 frames 时算作', 'select'])
        }
        if (selectedNode.type === 'cast' || selectedNode.type === 'scene') {
          const isScene = selectedNode.type === 'scene'
          fieldDefs.push(['name', isScene ? '场景名' : '角色名', 'text',
            '只用于界面和连线，不会进提示词。'])
          fieldDefs.push(['source', '参考图 URL', 'text',
            '公开的 https 图片地址。环境空镜不要带角色，否则模型可能照着它复制一个人出来。'])
          fieldDefs.push(['description', isScene ? '固定场景描述' : '固定外形描述', 'textarea',
            isScene
              ? '写固定的地点 / 时间 / 光线 / 材质；不要写这一镜里发生的事（那属于镜头的提示词）。'
              : '写固定外形：毛色、体型、眼睛、穿戴。不写动作和情绪。'])
        }
        if (selectedNode.type === 'take') {
          fieldDefs.push(['frame', '从上游取哪一帧', 'select'], ['slot', '交给下游当', 'select'])
        }
        /* `generateAudio` was a declared config field with no UI at all — it could
           only be reached by editing YAML and restarting.
           `useCast` used to sit next to it. It is gone: it was a per-node boolean
           that switched the character bible off, and once a character is a node
           you WIRE to the shots it appears in, "this shot has no cast" is
           expressed by not wiring it. Two controls for one decision is how the
           inspector ends up disagreeing with the request. */
        if (selectedNode.type === 'generate') {
          fieldDefs.push(['generateAudio', '生成音频', 'boolean'])
        }
        if (selectedNode.type === 'script' || selectedNode.type === 'note') fieldDefs.push(['text', '内容', 'textarea'])

        const fieldsEls = []
        for (const [key, label, kind, hint] of fieldDefs) {
          const value = selectedNode.fields?.[key]
          let control = null
          if (kind === 'textarea') {
            control = h('textarea', {
              key: 'f-' + key,
              value: shownField(selectedNode.id, key, typeof value === 'string' ? value : ''),
              onChange: (event) => editField(selectedNode.id, key, event.target.value),
              onBlur: () => commitField(selectedNode.id, key, 'textarea'),
            })
          } else if (kind === 'model') {
            /* The shortlist from 设置 wins; the full catalog is the fallback when
               nobody has curated one yet. Offering 300 models to pick from is not
               a feature, it is a haystack. */
            const configured = Array.isArray(config?.models) ? config.models : []
            const options = configured.length > 0 ? configured.slice() : catalog.models.map((model) => model.id)
            if (typeof value === 'string' && value.length > 0 && !options.includes(value)) options.unshift(value)
            control = h('select', {
              key: 'f-' + key, value: typeof value === 'string' ? value : (graph.project?.model ?? ''),
              onChange: (event) => updateField(key, event.target.value),
            }, options.map((id) => h('option', { key: id, value: id }, id)))
          } else if (kind === 'boolean') {
            /* Absent means "inherit the project default", which for both of these
               is TRUE. Showing an unchecked box for an unset field would claim
               the opposite of what actually gets sent. */
            const current = value === undefined || value === null ? true : value === true
            control = h('input', {
              key: 'f-' + key,
              type: 'checkbox',
              checked: current,
              style: { flex: '0 0 auto', width: 'auto' },
              onChange: (event) => updateField(key, event.target.checked),
            })
          } else if (kind === 'enum') {
            const list = key === 'resolution'
              ? (modelInfo?.supported_resolutions ?? [graph.project?.resolution ?? '720p'])
              : (modelInfo?.supported_aspect_ratios ?? [graph.project?.aspectRatio ?? '16:9'])
            const current = typeof value === 'string' ? value : (graph.project?.[key] ?? list[0])
            control = h('select', {
              key: 'f-' + key, value: current,
              onChange: (event) => updateField(key, event.target.value),
            }, list.map((option) => h('option', { key: option, value: option }, option)))
          } else if (kind === 'select') {
            const options = selectOptionsFor(selectedNode.type, key)
            const fallback = options.length > 0 ? String(options[0]) : ''
            control = h('select', {
              key: 'f-' + key,
              value: typeof value === 'string' || typeof value === 'number' ? String(value) : fallback,
              onChange: (event) => updateField(key, event.target.value),
            }, options.map((option) => h('option', { key: String(option), value: String(option) }, String(option))))
          } else {
            control = h('input', {
              key: 'f-' + key,
              value: shownField(selectedNode.id, key, value === undefined || value === null ? '' : String(value)),
              onChange: (event) => editField(selectedNode.id, key, event.target.value),
              onBlur: () => commitField(selectedNode.id, key, kind),
            })
          }
          fieldsEls.push(h('div', { className: 'dsh-ov-fld', key: 'wrap-' + key, 'data-field': key },
            h('label', { title: hint ?? undefined }, label), control))
        }

        /* Duration from supported_durations, not a fixed dropdown: seedance-2.5
           advertises 27 values, which a select cannot reasonably express. This is
           the ONLY duration control when it renders — see `supportedDurations`. */
        if (takesDuration && supportedDurations !== null) {
          const current = Number(selectedNode.fields?.duration ?? graph.project?.duration ?? supportedDurations[0])
          fieldsEls.push(h('div', { className: 'dsh-ov-fld', key: 'durs', 'data-field': 'duration' },
            h('label', { title: '各模型支持的秒数是动态的：seedance-2.5 会给出 27 个值，所以多了就换成数字输入。' },
              '时长'),
            supportedDurations.length > 12
              ? h('input', {
                  key: 'd-' + selectedNode.id,
                  value: shownField(selectedNode.id, 'duration', String(current)),
                  onChange: (event) => editField(selectedNode.id, 'duration', event.target.value),
                  onBlur: () => commitField(selectedNode.id, 'duration', 'number'),
                })
              : h('select', {
                  key: 'd-' + selectedNode.id,
                  value: String(current),
                  onChange: (event) => updateField('duration', Number(event.target.value)),
                }, supportedDurations.map((value) => h('option', { key: value, value: String(value) }, value + 's'))),
            h('div', { className: 'dsh-ov-note' },
              supportedDurations.length > 12
                ? supportedDurations.length + ' 个可选值（' + supportedDurations[0] + '–'
                  + supportedDurations[supportedDurations.length - 1] + 's）→ 数字输入'
                : '支持：' + supportedDurations.join(', ') + 's')))
        }

        if (fieldsEls.length > 0) {
          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'fields' }, fieldsEls))
        }

        /* ---- inspector: 衔接 (the frame chain is TOPOLOGY, so is the control) */
        if (SHOT_TYPES.has(selectedNode.type) && selectedNode.shotIndex !== null) {
          const feed = graph.edges.find((edge) => edge.to === selectedNode.id && edge.toPort === 'frames')
          const source = feed === undefined ? null : graph.nodes.find((node) => node.id === feed.from) ?? null
          const wired = graph.edges
            .filter((edge) => edge.to === selectedNode.id && edge.toPort === 'refs')
            .map((edge) => graph.nodes.find((node) => node.id === edge.from) ?? null)
            .filter((node) => node !== null)
          const named = wired.map((node) => node.fields?.name || node.title || node.id)

          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'cont' },
            h('h4', null, '衔接'),
            h('div', { className: 'dsh-ov-kv' },
              h('span', null, '上一镜'),
              h('b', null, source === null ? '硬切 / 转场' : (source.type === 'take' ? '取帧接龙' : source.type))),
            source === null
              ? h('div', { className: 'dsh-ov-note', key: 'cont-cut',
                  title: '接了首帧的镜头反而拿不到参考图：frame_images 与 input_references 不能同发，'
                    + 'provider 会拒绝整个请求，插件只发首帧。' },
                  '独立起幅 —— 角色/场景参考图在这一镜真正生效。')
              : null,
            h('div', { className: 'dsh-ov-kv' },
              h('span', null, '出场角色'),
              h('b', null, named.length === 0 ? '（无）' : named.join('、'))),
            named.length === 0
              ? h('div', { className: 'dsh-ov-note' }, '把「角色」节点的 asset 连到这一镜的 refs 口，角色就会出现在这一镜。')
              : null,
            h('div', { className: 'dsh-ov-acts', style: { marginTop: '7px', justifyContent: 'flex-start' } },
              source === null
                ? h('button', { className: 'dsh-ov-btn', 'data-act': 'link-frames', onClick: () => relinkFrames(selectedNode.id) }, '接上一镜（取帧）')
                : h('button', { className: 'dsh-ov-btn', 'data-act': 'unlink-frames', onClick: () => unlinkFrames(selectedNode.id) }, '改成硬切（转场）'))))
        }

        /* Lineage: which edges feed this node and which consume it. Rendered as
           arrow rows rather than as prose — it is a list of ports, and it was the
           densest five lines in the panel. */
        const upstream = graph.edges.filter((edge) => edge.to === selectedNode.id)
        const downstream = graph.edges.filter((edge) => edge.from === selectedNode.id)
        if (upstream.length > 0 || downstream.length > 0) {
          /* One shape for both directions — "port → node:port" — so the list reads
             as wiring rather than as two different sentences. */
          const linRow = (edge, key) => h('div', { className: 'dsh-ov-lin', key,
            title: edge.from + ':' + edge.fromPort + ' → ' + edge.to + ':' + edge.toPort },
            h('span', null, edge.fromPort),
            h('i', null, '→'),
            h('b', null, edge.to),
            h('em', null, edge.toPort))
          inspectorEls.push(h('div', { className: 'dsh-ov-sec', key: 'lin' },
            h('h4', null, '血统'),
            h('div', { className: 'dsh-ov-lins' },
              ...upstream.map((edge) => linRow(edge, 'u-' + edge.id)),
              ...downstream.map((edge) => linRow(edge, 'd-' + edge.id)))))
        }
      }

      /* ---- settings: two chips in the top bar, and one dialog ----------
       * The key and the image bed each used to own a full-width row of the
       * workspace. Both are configured once and then never touched, so they were
       * permanent chrome paying rent for a dialog — and the dialog is also where
       * the model shortlist (a second OpenRouter concern with nowhere to live)
       * and a way to PROBE the image bed finally fit.
       *
       * The chips stay, because "is there a key" and "is there a bed" are the
       * two facts that explain most failures, and they must be readable without
       * opening anything. They are built BEFORE the top bar because they are
       * children of it.
       * ------------------------------------------------------------------ */
      const bedConfigured = (config?.imageBedUrl ?? '').length > 0
      /* Both chips report a STATE and nothing else: a lamp plus one word. They
         used to print `sk-or-v1-…4f2a` and the bed's hostname, which put a slice
         of a real secret and of a private endpoint into every screenshot, and
         neither fact is one you act on — the lamp is. `已配置` and `未配置` are
         the two answers; the dialog is where the value lives. */
      const statusDot = (ok) => h('i', { className: 'dsh-ov-dot', 'data-ok': ok ? '1' : '0',
        'data-err': ok ? '0' : '1' })

      const keyPill = h('div', {
        className: 'dsh-ov-pill',
        'data-state': keyInfo?.hasKey === true ? 'on' : 'off',
        /* Its OWN act name, not the 设置 button's: two ways into one dialog must be
           two addressable controls, or "the 设置 button was deleted" stops being a
           detectable failure (the mutation suite caught exactly that). */
        'data-act': 'open-settings-key',
        style: { cursor: 'pointer' },
        title: keyInfo?.hasKey === true
          ? '密钥已配置，保存在本机插件设置里。点开设设置。'
          : '还没有密钥：生成与模型目录都会失败。点开设设置。',
        onClick: () => setSettingsOpen(true),
      },
        statusDot(keyInfo?.hasKey === true),
        '密钥 ',
        h('b', null, keyInfo?.hasKey === true ? '已配置' : '未配置'))

      const bedPill = h('div', {
        className: 'dsh-ov-pill',
        'data-state': bedConfigured ? 'on' : 'off',
        'data-act': 'open-settings-bed',
        style: { cursor: 'pointer' },
        title: bedConfigured
          ? '抽出的帧会传到这个图床，再把公开 URL 交给下一镜当首帧。点开设设置。'
          : '未配置图床：取帧接龙不会生效，续接镜头会退化成独立生成。点开设设置。',
        onClick: () => setSettingsOpen(true),
      },
        statusDot(bedConfigured),
        '图床 ',
        h('b', null, bedConfigured ? '已配置' : '未配置'))

      /* A client newer than the Host is a normal state here (no hot reload) — and
         it must announce itself, because the symptom is otherwise a node that
         silently becomes an empty 注释. */
      const skewChip = unknownToHost.length > 0
        ? h('div', {
            className: 'dsh-ov-pill', style: { cursor: 'pointer', borderColor: 'var(--dsw-alias-state-warn-primary)' },
            title: '当前运行的 Host 还不认识这些节点类型：' + unknownToHost.join('、') + '。重启 DSH 后即可使用。',
            'data-act': 'skew-warning',
          }, h('i', { className: 'dsh-ov-dot', 'data-err': '1' }), 'Host 不认识 ', h('b', null, unknownToHost.join('/')))
        : (hostTypes === null && config !== null
          ? h('div', {
              className: 'dsh-ov-pill', style: { cursor: 'pointer' },
              title: '这个 Host 没有报告节点类型表 —— 它可能是旧版。如果加的节点变成了「注释」，重启 DSH。',
              'data-act': 'skew-warning',
            }, h('i', { className: 'dsh-ov-dot', 'data-run': '1' }), 'Host 版本未知')
          : null)

      /* ---- top bar ---- */
      const running = derived.counts.running
      const topBar = h('div', { className: 'dsh-ov-top' },
        h('button', {
          className: 'dsh-ov-graphpick',
          'data-act': 'open-projects',
          title: '项目：切换 / 新建 / 删除',
          onClick: () => setProjectsOpen(true),
        },
          h('span', { className: 'dsh-ov-title' }, graph?.title ?? '未命名项目'),
          h('span', { className: 'dsh-ov-sub' }, graph !== null ? graph.id : ''),
          h('i', { className: 'dsh-ov-caret' }, '▾'),
          h('span', { className: 'dsh-ov-count' }, String(graphList.length))),
        h('div', { className: 'dsh-ov-seg' },
          h('button', { 'data-on': view === 'canvas' ? '1' : '0', onClick: () => setView('canvas') }, '画布'),
          h('button', { 'data-on': view === 'sequence' ? '1' : '0', onClick: () => setView('sequence') }, '顺序')),
        h('div', { className: 'dsh-ov-spacer' }),
        h('div', { className: 'dsh-ov-pill' },
          h('i', { className: 'dsh-ov-dot', 'data-run': running > 0 ? '1' : '0',
            'data-err': derived.counts.failed > 0 ? '1' : '0' }),
          '运行中 ', h('b', null, String(running)),
          ' · 待跑 ', h('b', null, String(derived.counts.idle))),
        h('div', { className: 'dsh-ov-pill', title: '上界是保守估算，不是报价；实账以 usage.cost 为准' },
          '上界 ', h('b', null, usd(derived.ceilingTotal)), ' / 预算 $', h('b', null, String(budgetUsd)),
          derived.unknownCount > 0 ? h('b', null, ' · +' + derived.unknownCount + ' 未知') : null),
        h('div', { className: 'dsh-ov-pill' }, '并发 ', h('b', null, String(config?.concurrency ?? 2))),
        keyPill,
        bedPill,
        h('button', { className: 'dsh-ov-btn', 'data-act': 'open-cast', onClick: () => setCastOpen(true) },
          `设定 ${castNodes.filter((n) => n.type === 'cast').length}·${castNodes.filter((n) => n.type === 'scene').length}`),
        skewChip,
        running > 0
          ? h('button', { className: 'dsh-ov-btn', 'data-kind': 'warn', onClick: () => setAbortOpen(true) }, '中止派发')
          : null,
        h('button', { className: 'dsh-ov-btn', 'data-act': 'open-settings', onClick: () => setSettingsOpen(true) }, '设置'),
        h('button', { className: 'dsh-ov-btn', onClick: () => { void reload(); say('已刷新') } }, '刷新'))

      /* ---- 角色库 roster ------------------------------------------------
       * Characters are defined ONCE and reused by wiring. The first draft put
       * them on the canvas as loose nodes and applied them graph-wide; the
       * second lets a shot name its own cast. This dialog is the missing third
       * piece: a place to write 角色1, 角色2, 角色3 down without hunting for
       * nodes on a canvas, and to see at a glance who is in how many shots.
       *
       * Editing writes the graph directly (one POST per commit), exactly like
       * the inspector, so the canvas and the roster can never disagree.
       * ------------------------------------------------------------------ */
      const castRows = graph === null ? [] : castNodes.map((node, index) => {
        const isScene = node.type === 'scene'
        const noun = isScene ? '场景' : '角色'
        const name = node.fields?.name || node.title || `${noun} ${index + 1}`
        const inShots = graph.nodes
          .filter((candidate) => SHOT_TYPES.has(candidate.type) && candidate.shotIndex !== null
            && graph.edges.some((edge) => edge.from === node.id && edge.to === candidate.id && edge.toPort === 'refs'))
          .sort((a, b) => a.shotIndex - b.shotIndex)
        const described = typeof node.fields?.description === 'string' && node.fields.description.trim().length > 0
        const imaged = typeof node.fields?.source === 'string' && node.fields.source.trim().length > 0

        return h('div', {
          className: 'dsh-ov-castcard', key: node.id, 'data-cast': node.id,
          'data-kind': node.type,
          'data-bible': node.id,
          style: { borderLeft: '2px solid ' + metaOf(node.type).color },
        },
          h('div', { className: 'dsh-ov-srow' },
            h('label', null, noun + ' ' + (index + 1)),
            h('input', {
              className: 'dsh-ov-sin', 'data-field': 'cast-name', type: 'text', autoComplete: 'off',
              placeholder: isScene ? '天台' : 'TOM',
              value: shownField(node.id, 'name', name),
              onChange: (event) => editField(node.id, 'name', event.target.value),
              onBlur: () => commitField(node.id, 'name', 'text'),
            }),
            h('span', { className: 'dsh-ov-castcount', 'data-in-shots': String(inShots.length) },
              inShots.length === 0 ? '未接到任何镜头' : `出场 ${inShots.length} 镜：${inShots.map((s) => '#' + s.shotIndex).join(' ')}`),
            h('button', { className: 'dsh-ov-btn', 'data-act': 'wire-all', onClick: () => wireCastToAll(node.id) }, '接到全部镜头'),
            h('button', { className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'remove-cast', onClick: () => removeCharacter(node.id) }, '删除')),

          h('div', { className: 'dsh-ov-srow' },
            h('label', null, '参考图'),
            h('input', {
              className: 'dsh-ov-sin', 'data-field': 'cast-source', type: 'text', autoComplete: 'off',
              placeholder: isScene ? 'https://…/rooftop-plate.png（环境空镜，别带角色）' : 'https://…/tom-sheet.png（角色定妆图最好）',
              value: shownField(node.id, 'source', typeof node.fields?.source === 'string' ? node.fields.source : ''),
              onChange: (event) => editField(node.id, 'source', event.target.value),
              onBlur: () => commitField(node.id, 'source', 'text'),
            })),

          h('div', { className: 'dsh-ov-srow' },
            h('label', null, '描述'),
            h('textarea', {
              className: 'dsh-ov-sin', 'data-field': 'cast-description', rows: 2,
              placeholder: isScene
                ? '黄昏的城市屋顶，右侧一面满涂鸦的混凝土墙，地面裂缝水泥，低角度硬光，24fps 3D 动画'
                : '蓝灰色家猫，圆脸，黄眼睛，白肚皮，脖子上一条红领结',
              value: shownField(node.id, 'description', typeof node.fields?.description === 'string' ? node.fields.description : ''),
              onChange: (event) => editField(node.id, 'description', event.target.value),
              onBlur: () => commitField(node.id, 'description', 'textarea'),
            })),

          !imaged && !described
            ? h('div', { className: 'dsh-ov-snote', style: { marginLeft: '100px' } },
                `这个${noun}还是空的：至少写「固定${noun}描述」。`)
            : (!described
              ? h('div', { className: 'dsh-ov-snote', style: { marginLeft: '100px' } },
                  `只给了参考图：它只在没接首帧的镜头里生效。写「固定${noun}描述」才能让每一镜不漂。`)
              : null),

          inShots.length > 0
            ? h('div', { className: 'dsh-ov-wirelist' },
                inShots.map((shot) => h('button', {
                  className: 'dsh-ov-btn', key: shot.id, 'data-act': 'unwire-shot',
                  title: '从这个镜头撤下',
                  onClick: () => unwireCastFromShot(node.id, shot.id),
                }, '#' + shot.shotIndex + ' ✕')))
            : null)
      })

      const castDialog = castOpen && graph !== null
        ? h('div', {
            className: 'dsh-ov-modal',
            onClick: (event) => { if (event.target === event.currentTarget) setCastOpen(false) },
          },
            h('div', { className: 'dsh-ov-settings' },
              h('h3', null, '设定库'),
              h('div', { className: 'dsh-ov-snote', style: { marginLeft: 0 } },
                '每个「角色」或「场景」只定义一次（名称 / 参考图 / 固定描述），然后连到它**适用**的镜头。'
                + '一个定义可以连很多镜头；不同镜头可以接不同的定义。\n'
                + '描述会被原样插进它出场镜头的提示词开头 —— 「每一镜的角色都不一样」和'
                + '「每一镜的屋顶都不一样」是同一个毛病，这里是同一副解药。'),
              h('div', { className: 'dsh-ov-shead' },
                `已定义 ${castRows.length} 个设定（角色 ${castNodes.filter((n) => n.type === 'cast').length} · 场景 ${castNodes.filter((n) => n.type === 'scene').length}）`),
              castRows.length === 0
                ? h('div', { className: 'dsh-ov-note' }, '还没有设定。点下面的「+ 角色」或「+ 场景」。')
                : castRows,
              h('div', { className: 'dsh-ov-acts' },
                h('button', { className: 'dsh-ov-btn', 'data-act': 'add-cast', onClick: () => addBible('cast') }, '+ 角色'),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'add-scene', onClick: () => addBible('scene') }, '+ 场景'),
                h('button', { className: 'dsh-ov-btn', 'data-kind': 'primary', 'data-act': 'close-cast', onClick: () => setCastOpen(false) }, '关闭'))))
        : null

      /* ---- the projects dialog ----
       * The list is the whole point: a workbench you cannot clear is a workbench
       * you stop using. Deleting is confirmed inline and states what is lost,
       * because one click here removes a graph document for good — a paid run's
       * node graph included. The ledger is NOT touched (it is fact, not intent),
       * so history and completed files survive.
       */
      const projectsDialog = projectsOpen
        ? h('div', {
            className: 'dsh-ov-modal',
            onClick: (event) => { if (event.target === event.currentTarget) setProjectsOpen(false) },
          },
            h('div', { className: 'dsh-ov-settings' },
              h('h3', null, '项目'),
              h('div', { className: 'dsh-ov-snote', style: { marginLeft: 0 } },
                '每个项目是一张独立的图。删除只删**图文档**（意图），不动台账与库里已生成的视频（事实）——'
                + '所以已经花过钱、已经下下来的成片不会因为清工作台而消失。'),
              h('div', { className: 'dsh-ov-shead' }, `${graphList.length} 个项目`),
              graphList.length === 0
                ? h('div', { className: 'dsh-ov-note' }, '还没有项目。')
                : graphList.map((row) => {
                    const doomed = pendingGraphDelete === row.id
                    return h('div', {
                      className: 'dsh-ov-graphrow',
                      key: row.id,
                      'data-graph': row.id,
                      'data-current': row.id === graphId ? '1' : '0',
                      'data-doomed': doomed ? '1' : '0',
                    },
                      h('div', { className: 'dsh-ov-graphmeta' },
                        h('b', null, row.title || '未命名项目'),
                        h('span', { className: 'dsh-ov-gnote' },
                          row.id + ' · ' + row.nodes + ' 节点 / ' + row.edges + ' 边'),
                        doomed
                          ? h('span', { className: 'dsh-ov-gwarn', 'data-act': 'graph-delete-warn' },
                              `删除「${row.title || row.id}」？连同它的 ${row.nodes} 个节点 / ${row.edges} 条边，不可撤销。`)
                          : null),
                      h('div', { className: 'dsh-ov-row' },
                        row.id === graphId
                          ? h('span', { className: 'dsh-ov-gnote' }, '当前打开')
                          : h('button', {
                              className: 'dsh-ov-btn', 'data-act': 'open-graph', 'data-graph': row.id,
                              onClick: () => { setSelected(null); setGraphId(row.id); setProjectsOpen(false) },
                            }, '打开'),
                        doomed
                          ? h('span', null,
                              h('button', {
                                className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'graph-delete-yes',
                                'data-graph': row.id,
                                onClick: () => { void removeGraph(row.id) },
                              }, '确认删除'),
                              h('button', {
                                className: 'dsh-ov-btn', 'data-act': 'graph-delete-no',
                                onClick: () => setPendingGraphDelete(null),
                              }, '取消'))
                          : h('button', {
                              className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'graph-delete',
                              'data-graph': row.id,
                              onClick: () => setPendingGraphDelete(row.id),
                            }, '删除')))
                  }),
              h('div', { className: 'dsh-ov-acts' },
                h('button', { className: 'dsh-ov-btn', 'data-act': 'new-graph', onClick: () => { void newProject() } }, '+ 新建项目'),
                h('button', { className: 'dsh-ov-btn', 'data-kind': 'primary', 'data-act': 'close-projects', onClick: () => setProjectsOpen(false) }, '关闭'))))
        : null

      /* ---- the settings dialog ----
       * Built after the top bar; it is a sibling in the overlay layer, not a
       * child of the chrome, so the order here does not matter.
       */
      const catalogIds = catalog.models.map((model) => model.id)
      const suggestions = catalogIds.filter((id) => !modelsDraft.includes(id)).slice(0, 400)
      const defaultModel = config?.model ?? ''

      const settingsDialog = settingsOpen
        ? h('div', {
            className: 'dsh-ov-modal',
            onClick: (event) => { if (event.target === event.currentTarget) setSettingsOpen(false) },
          },
            h('div', { className: 'dsh-ov-settings' },
              h('h3', null, '设置'),

              /* ---- OpenRouter ---- */
              h('div', { className: 'dsh-ov-shead' }, 'OpenRouter'),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, 'API 密钥'),
                h('span', { className: 'dsh-ov-keystate', style: { display: 'flex', alignItems: 'center', gap: '6px' },
                  'data-on': keyInfo?.hasKey === true ? '1' : '0' },
                  statusDot(keyInfo?.hasKey === true),
                  keyInfo?.hasKey === true ? '已配置' : '未配置'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'apiKey',
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: keyInfo?.hasKey === true ? '留空 = 保留，填入 = 替换' : 'sk-or-v1-…',
                  value: keyDraft,
                  onChange: (event) => setKeyDraft(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') void saveKey() },
                }),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'save-key', disabled: keyBusy || keyDraft.trim().length === 0, onClick: () => void saveKey() }, '保存'),
                keyInfo?.hasKey === true
                  ? h('button', { className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'clear-key', disabled: keyBusy, onClick: () => void clearKey() }, '清除')
                  : null),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, ' '),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'test-key', disabled: keyTesting, onClick: () => void testKey() },
                  keyTesting ? '测试中…' : '测试密钥'),
                keyTest !== null
                  ? h('span', { className: 'dsh-ov-snote', style: { marginLeft: 0, flex: '1 1 240px', color: keyTest.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)' } }, keyTest.message)
                  : h('span', { className: 'dsh-ov-snote', style: { marginLeft: 0, flex: '1 1 240px' } }, '在 openrouter.ai/keys 生成，以 sk-or- 开头')),

              h('div', { className: 'dsh-ov-shead' }, '模型'),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, '添加模型'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'modelInput',
                  type: 'text',
                  list: 'dsh-ov-model-ids',
                  autoComplete: 'off',
                  placeholder: 'heygen/heygen-video-1',
                  value: modelInput,
                  onChange: (event) => setModelInput(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') void addModel() },
                }),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'add-model', disabled: modelInput.trim().length === 0, onClick: () => void addModel() }, '添加'),
                h('datalist', { id: 'dsh-ov-model-ids' }, suggestions.map((id) => h('option', { key: id, value: id })))),
              h('div', { className: 'dsh-ov-mlist' },
                modelsDraft.length === 0
                  ? h('div', { className: 'dsh-ov-snote', style: { marginLeft: 0 } },
                      '列表为空 —— 节点上的模型下拉会退回显示线上全部视频模型（几百个）。')
                  : modelsDraft.map((id) => h('div', { className: 'dsh-ov-mrow', key: id },
                      id === defaultModel ? h('b', null, '默认') : null,
                      h('span', { title: id }, id),
                      id === defaultModel
                        ? null
                        : h('button', { className: 'dsh-ov-btn', 'data-act': 'set-default', onClick: () => void setDefaultModel(id) }, '设为默认'),
                      h('button', { className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'remove-model', onClick: () => void removeModel(id) }, '移除')))),
              h('div', { className: 'dsh-ov-snote' },
                '默认模型 ' + (defaultModel.length > 0 ? defaultModel : '（未设置）')
                + '：新建图、以及节点没有单独指定时都用它。'),

              /* ---- image bed ---- */
              h('div', { className: 'dsh-ov-shead' }, '图床（首尾帧续接要用）'),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, '地址'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'bedUrl',
                  type: 'text',
                  autoComplete: 'off',
                  placeholder: 'https://img.example.com',
                  value: bedDraft.url,
                  onChange: (event) => setBedDraft({ ...bedDraft, url: event.target.value }),
                })),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, '文件夹'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'bedFolder',
                  type: 'text',
                  autoComplete: 'off',
                  placeholder: 'test',
                  value: bedDraft.folder,
                  onChange: (event) => setBedDraft({ ...bedDraft, folder: event.target.value }),
                })),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, 'User-Agent'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'bedUserAgent',
                  type: 'text',
                  autoComplete: 'off',
                  placeholder: 'gobelagent',
                  value: bedDraft.userAgent,
                  onChange: (event) => setBedDraft({ ...bedDraft, userAgent: event.target.value }),
                })),
              h('div', { className: 'dsh-ov-snote' },
                '有的图床（尤其套了 Cloudflare 的）只放行某一个 agent 字符串，别的会拿到 403 + HTML 校验页。'
                + '改了先点「测试连通」，别等到三镜之后才发现帧传不上去。'),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, 'Token'),
                h('span', { className: 'dsh-ov-keystate', style: { display: 'flex', alignItems: 'center', gap: '6px' },
                  'data-on': config?.hasImageBedToken === true ? '1' : '0' },
                  statusDot(config?.hasImageBedToken === true),
                  config?.hasImageBedToken === true ? '已配置' : '未配置'),
                h('input', {
                  className: 'dsh-ov-sin',
                  'data-field': 'bedToken',
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: config?.hasImageBedToken === true ? '留空 = 保留' : '（可留空）',
                  value: bedDraft.token,
                  onChange: (event) => setBedDraft({ ...bedDraft, token: event.target.value }),
                })),
              h('div', { className: 'dsh-ov-srow' },
                h('label', null, ' '),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'save-bed', disabled: bedBusy, onClick: () => void saveBed() }, '保存'),
                h('button', { className: 'dsh-ov-btn', 'data-act': 'test-bed', disabled: bedTesting || bedDraft.url.trim().length === 0, onClick: () => void testBed() },
                  bedTesting ? '上传中…' : '测试连通')),
              bedTest !== null
                ? h('div', {
                    className: 'dsh-ov-snote',
                    style: { color: bedTest.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)' },
                  }, (bedTest.ok ? '✓ ' : '✗ ') + bedTest.message)
                : null,

              h('div', { className: 'dsh-ov-acts' },
                h('button', { className: 'dsh-ov-btn', 'data-kind': 'primary', 'data-act': 'close', onClick: () => setSettingsOpen(false) }, '关闭'))))
        : null

      /* ---- canvas view ----
       * Structure: an outer positioned box holds the scrollable canvas PLUS the
       * overlays as SIBLINGS. The overlays must not be children of the canvas
       * (they would be clipped and scaled by the world transform), and they must
       * not sit in a comma sequence expression (they would not render at all,
       * which is what happened in the first draft of this file).
       */
      const canvasView = h('div', { className: 'dsh-ov-centerstage' },
        h('div', {
          className: 'dsh-ov-canvas',
          ref: canvasRef,
          'data-grab': dragRef.current !== null ? '1' : '0',
          onMouseDown: onCanvasDown,
          onWheel,
        },
        h('div', {
          className: 'dsh-ov-world',
          ref: worldRef,
          style: { transform: 'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.k + ')' },
        },
        h('svg', { className: 'dsh-ov-edges', width: 2400, height: 1400 },
          wires.map((edge) => h('path', {
            key: edge.id, d: edge.d, fill: 'none',
            stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1.5,
          })),
          wires.filter((edge) => typeof edge.label === 'string' && edge.label.length > 0).map((edge) =>
            h('text', {
              key: 'lbl-' + edge.id, x: edge.mid.x, y: edge.mid.y,
              fill: 'var(--dsw-alias-label-secondary)', fontSize: '9.5', textAnchor: 'middle',
            }, edge.label))),
        nodeEls)),

        /* The toolbar. `▶ 运行选中` used to say 选中 while running the selection PLUS
           its whole downstream chain (the Host expands the seed), so a mid-film
           shot could quietly dispatch ten nodes; and `▶▶ 运行下游` sat next to it
           doing the SAME thing — except it did nothing at all, only a toast. Two
           controls for one decision, one of them a lie, and no control at all for
           the one thing that was genuinely missing: retrying a failed shot. */
        h('div', { className: 'dsh-ov-tools' },
          h('button', {
            className: 'dsh-ov-btn', 'data-act': 'run-selected', disabled: selected === null || busy,
            title: '运行选中的节点，以及从它出发的全部下游节点（传递展开）。'
              + '已完成的会跳过，不会重复提交、不会重复计费。',
            onClick: () => { if (selected !== null) void startRun([selected]) },
          }, '▶ 运行这一镜及下游'),
          retryCount > 0
            ? h('button', {
                className: 'dsh-ov-btn', 'data-kind': 'warn', 'data-act': 'retry-failed',
                disabled: selected === null || busy,
                title: `重新提交「${selectedNode?.title || selected}」及其下游里失败的 ${retryCount} 个执行节点；`
                  + '同一批里还没跑过的也会一起跑。已完成的保持不变。**会再次产生费用。**',
                onClick: () => { if (selected !== null) void startRun([selected], { retryFailed: true }) },
              }, '↻ 重跑失败的 ' + retryCount + ' 镜')
            : null,
          h('button', { className: 'dsh-ov-btn', 'data-act': 'preflight', onClick: runPreflight }, '预检'),
          h('button', {
            className: 'dsh-ov-btn', 'data-act': 'run-all', disabled: busy || graph === null,
            title: '运行整张图。已完成的会跳过。',
            onClick: () => void startRun(null),
          }, '执行全图')),

        h('div', { className: 'dsh-ov-hint' },
          '左栏点节点类型加入画布 · 拖节点移动 · 空白拖拽平移 · 滚轮缩放 · 点节点看参数 · 点输出口再点输入口连线'),
        h('div', { className: 'dsh-ov-zoom' },
          h('button', { className: 'dsh-ov-btn', onClick: () => setZoom((z) => ({ ...z, k: Math.min(2.2, z.k * 1.15) })) }, '+'),
          h('button', { className: 'dsh-ov-btn', onClick: () => setZoom((z) => ({ ...z, k: Math.max(0.32, z.k / 1.15) })) }, '−'),
          h('button', { className: 'dsh-ov-btn', onClick: () => setZoom({ x: 16, y: 58, k: 0.9 }) }, '适应')),
        toast !== null
          ? h('div', { className: 'dsh-ov-toast', 'data-kind': toast.kind }, toast.message)
          : null)

      /* ---- preflight panel: DOCKED, not an overlay -------------------
       * An overlay that covers the canvas defeats the panel's whole purpose:
       * reading the numbers WHILE seeing which nodes they refer to.
       * ---------------------------------------------------------------- */
      const preflightPanel = showPreflight && preflight !== null
        ? h('div', {
            style: {
              position: 'absolute', left: 0, top: 0, bottom: 0, width: '330px', overflowY: 'auto',
              background: 'var(--dsw-alias-bg-layer-1)',
              borderRight: '1px solid var(--dsw-alias-border-l1)', zIndex: 8,
            },
          },
          h('div', { className: 'dsh-ov-sec' },
            h('h4', null, '预检 · 成本上界'),
            h('div', { className: 'dsh-ov-note' },
              '这是上界不是报价：取该模型最贵分辨率档，宁可高估不可低估。实账以 usage.cost 回填。'),
            h('div', { style: { marginTop: '8px' } },
              h('button', { className: 'dsh-ov-btn', onClick: () => setShowPreflight(false) }, '关闭'))),
          (preflight.ceilings ?? []).map((row) =>
            h('div', { key: row.nodeId, className: 'dsh-ov-sec', style: { padding: '6px 12px' } },
              h('div', { className: 'dsh-ov-kv' },
                h('span', null, row.nodeId + ' · ' + shortModel(row.model)),
                h('b', null, row.usd === null ? '量级未知' : '≤' + usd(row.usd))),
              h('div', { className: 'dsh-ov-note' },
                row.usd === null ? (row.reason ?? '无法计算') : row.seconds + 's · ' + row.source))),
          h('div', { className: 'dsh-ov-sec' },
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '未完成上界'), h('b', null, usd(preflight.ceilingTotal))),
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '量级未知节点'),
              h('b', null, String(preflight.unknownCount ?? 0) + ' 个（不计入）')),
            h('div', { className: 'dsh-ov-kv' }, h('span', null, '合计 / 预算'),
              h('b', null, usd(preflight.ceilingTotal) + ' / $' + String(preflight.budgetUsd ?? budgetUsd)
                + (preflight.overBudget === true ? ' → 会拒绝' : ' → 通过'))),
            h('div', { className: 'dsh-ov-note' }, '超预算时拒绝派发，且不发一个网络请求。'),
            (preflight.errors ?? []).length > 0
              ? h('div', { className: 'dsh-ov-alert', 'data-kind': 'error' },
                  h('b', null, '校验错误'), (preflight.errors ?? []).map((e) => e.message).join('；'))
              : null,
            (preflight.warnings ?? []).length > 0
              ? h('div', { className: 'dsh-ov-alert', 'data-kind': 'warn' },
                  h('b', null, '注意'), (preflight.warnings ?? []).map((w) => w.message).join('；'))
              : null))
        : null

      /* ---- sequence view ---- */
      const seqNode = (graph?.nodes ?? []).find((node) => node.type === 'seq') ?? null
      const seqJob = seqNode !== null ? (derived.jobsByNode.get(seqNode.id) ?? null) : null
      const hasFilm = seqJob !== null && typeof seqJob.filePath === 'string' && seqJob.filePath.length > 0
      const filmPanel = seqNode === null
        ? null
        : h('div', { className: 'dsh-ov-film' },
            h('div', { className: 'dsh-ov-kv' },
              h('span', null, '成片'),
              h('b', null, hasFilm ? '已导出' : '未导出')),
            hasFilm
              ? h('div', null,
                  h('video', { src: API + '/content?id=' + encodeURIComponent(seqJob.id), controls: true, preload: 'metadata' }),
                  h('div', { className: 'dsh-ov-note' },
                    String(seqJob.sequence?.count ?? '?') + ' 镜 · '
                    + (typeof seqJob.sequence?.durationSec === 'number' ? Number(seqJob.sequence.durationSec).toFixed(1) + 's · ' : '')
                    + (seqJob.sequence?.mode === 'normalize' ? '统一转码后拼接' : '直接拼接')
                    + (seqJob.sequence?.complete === false
                      ? ' · 缺 ' + (seqJob.sequence?.missing ?? []).join('、')
                      : '')),
                  typeof seqJob.filePathRelative === 'string'
                    ? h('div', { className: 'dsh-ov-note' }, seqJob.filePathRelative)
                    : null)
              : h('div', { className: 'dsh-ov-note' },
                  '跑完图后这里会出现成片：所有镜头按 shotIndex 顺序用 ffmpeg 拼成一条 mp4。'
                  + '拼接默认 `-c copy`，不重编码，也不会二次损失画质。'))

      const sequenceView = h('div', { className: 'dsh-ov-scroll' },
        filmPanel,
        derived.shotRows.length === 0
          ? h('div', { className: 'dsh-ov-empty' },
              '还没有镜头。用 openrouter_video_plan 建图，或在画布上添加 generate 节点并设置 shotIndex。')
          : h('table', { className: 'dsh-ov-table' },
              h('thead', null, h('tr', null,
                ['#', '', '标题', '时长', '模型', '角色', '分辨率', '状态', '成本', '与前一条的衔接']
                  .map((label, index) => h('th', { key: 'th' + index }, label)))),
              h('tbody', null, shotRowEls),
              h('tfoot', null, h('tr', null,
                h('td', { colSpan: 3, style: { textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' } }, '合计'),
                h('td', null, h('b', null, derived.totalSeconds + 's')),
                h('td', { colSpan: 3 }),
                h('td', null, derived.counts.completed + ' 完成 / ' + derived.counts.running + ' 生成中 / ' + derived.counts.idle + ' 未开始'),
                h('td', null, h('b', null, usd(derived.actualTotal)),
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, ' + ≤' + usd(derived.pendingCeiling))),
                h('td', null, derived.seams.length + ' 处观感断层 · ' + derived.unknownCount + ' 个量级未知')))))

      /* Playback modal. It repeats the shot's own numbers next to the frame,
         because "is this the take I meant" is a question about the shot, not
         just about the pixels — and the numbers already exist in the row. */
      const clipDialog = clipPreview === null ? null : h('div', {
        className: 'dsh-ov-modal',
        'data-act': 'clip-modal',
        onClick: (event) => { if (event.target === event.currentTarget) setClipPreview(null) },
      },
        h('div', { className: 'dsh-ov-preview' },
          h('h3', null,
            clipPreview.shotIndex !== null && clipPreview.shotIndex !== undefined
              ? h('span', { className: 'dsh-ov-shot' }, '#' + clipPreview.shotIndex)
              : null,
            clipPreview.title),
          h('video', {
            key: clipPreview.jobId,
            src: API + '/content?id=' + encodeURIComponent(clipPreview.jobId),
            controls: true,
            autoPlay: true,
            preload: 'auto',
          }),
          h('div', { className: 'dsh-ov-pmeta' },
            h('span', null, '时长 ', h('b', null, clipPreview.seconds + 's')),
            h('span', null, '模型 ', h('b', null, shortModel(clipPreview.model))),
            h('span', null, '实账 ', h('b', null,
              typeof clipPreview.cost === 'number' ? usd(clipPreview.cost) : '未回执')),
            h('span', null, '衔接 ', h('b', null, clipPreview.continuity)),
            clipPreview.cast.length > 0
              ? h('span', null, '出场 ', h('b', null, clipPreview.cast.join('、')))
              : null),
          h('div', { className: 'dsh-ov-pfile' }, clipPreview.file),
          h('div', { className: 'dsh-ov-acts' },
            h('button', {
              className: 'dsh-ov-btn', 'data-act': 'clip-goto-node',
              title: '关掉预览，在画布/检查器里选中这一镜',
              onClick: () => { selectNode(clipPreview.nodeId); setClipPreview(null) },
            }, '打开所在节点'),
            h('button', {
              className: 'dsh-ov-btn', 'data-kind': 'primary', 'data-act': 'clip-close',
              onClick: () => setClipPreview(null),
            }, '关闭'))))

      return h('div', { className: 'dsh-ov-root' },
        topBar,
        h('div', { className: 'dsh-ov-body' },
          /* left: node library + assets */
          h('div', { className: 'dsh-ov-left' },
            h('div', { className: 'dsh-ov-head' }, '节点库'),
            h('div', { className: 'dsh-ov-scroll', style: { flex: '0 1 auto' } },
              Object.entries(NODE_META)
                // Offering a type the running Host cannot honour is how a node
                // gets POSTed, downgraded and handed back as an empty 注释.
                .filter(([type]) => hostKnows(type))
                .map(([type, meta]) =>
                h('div', {
                  className: 'dsh-ov-ntype',
                  key: type,
                  'data-add': '1',
                  'data-type': type,
                  title: '点击加入画布',
                  onClick: () => addNode(type),
                },
                  h('i', { className: 'dsh-ov-swatch', style: { background: meta.color } }),
                  meta.label,
                  NETWORK_TYPES.has(type) ? h('span', { className: 'dsh-ov-net' }, '网络') : null))),
            h('div', { className: 'dsh-ov-head', style: { borderTop: '1px solid var(--dsw-alias-border-l1)' } }, '素材池'),
            h('div', { className: 'dsh-ov-scroll', style: { flex: '0 1 auto' } },
              (graph?.nodes ?? []).filter((node) => node.type === 'ref').length === 0
                ? h('div', { className: 'dsh-ov-asset' }, h('span', null, '（还没有参考素材节点）'))
                : (graph?.nodes ?? []).filter((node) => node.type === 'ref').map((node) =>
                    h('div', { className: 'dsh-ov-asset', key: node.id, onClick: () => selectNode(node.id) },
                      h('span', { title: node.fields?.source ?? '' },
                        (node.fields?.source ?? '').split('/').pop() || '未命名')))),

            /* The 角色 list is the visible answer to "is this global?". A cast
               node has no wires, so nothing on the canvas shows that it applies
               to ALL twelve shots — this section does. */
            h('div', { className: 'dsh-ov-head', style: { borderTop: '1px solid var(--dsw-alias-border-l1)' } }, '角色（可复用）'),
            h('div', { className: 'dsh-ov-scroll' },
              castNodes.length === 0
                ? h('div', { className: 'dsh-ov-asset' },
                    h('span', null, '（顶栏「角色」→ 添加角色，再连到它出场的镜头）'))
                : castNodes.map((node) => {
                    const inShots = (graph?.nodes ?? []).filter((candidate) =>
                      SHOT_TYPES.has(candidate.type) && candidate.shotIndex !== null
                      && (graph?.edges ?? []).some((edge) => edge.from === node.id && edge.to === candidate.id && edge.toPort === 'refs'))
                    const described = typeof node.fields?.description === 'string' && node.fields.description.trim().length > 0
                    return h('div', {
                      className: 'dsh-ov-castrow',
                      key: node.id,
                      style: { cursor: 'pointer' },
                      title: described ? node.fields.description : '没有填固定外形描述',
                      onClick: () => selectNode(node.id),
                    },
                      h('i', null, '●'),
                      h('span', null, (node.fields?.name || node.title || '未命名')
                        + (described ? '' : '（缺描述）')),
                      h('em', { className: 'dsh-ov-castn' }, inShots.length === 0 ? '未连线' : inShots.length + ' 镜'))
                  }))),

          /* centre */
          h('div', { className: 'dsh-ov-center' },
            preflightPanel,
            view === 'canvas' ? canvasView : sequenceView),

          /* right: inspector + log */
          h('div', { className: 'dsh-ov-right' },
            h('div', { className: 'dsh-ov-scroll dsh-ov-insp', style: showPreflight ? { marginLeft: 0 } : undefined }, inspectorEls),
            h('div', { className: 'dsh-ov-head', style: { borderTop: '1px solid var(--dsw-alias-border-l1)' } }, '运行日志'),
            h('div', { className: 'dsh-ov-scroll', style: { flex: '0 1 140px' } },
              logs.length === 0
                ? h('div', { className: 'dsh-ov-log' }, h('span', null, '尚无事件'))
                : logs.map((entry, index) =>
                    h('div', { className: 'dsh-ov-log', key: 'log' + index },
                      h('time', null, clockOf(entry.at)), h('span', null, entry.message)))))),

        /* bottom strip + derived summary */
        h('div', { className: 'dsh-ov-bottom' },
          h('div', { className: 'dsh-ov-strips' }, stripEls),
          h('div', { className: 'dsh-ov-summary' },
            h('div', null, '总时长 ', h('b', null, derived.totalSeconds + 's')),
            h('div', null, '实账 ', h('b', null, usd(derived.actualTotal))),
            h('div', null, '上界 ', h('b', null, usd(derived.ceilingTotal))),
            derived.unknownCount > 0
              ? h('div', null, '未知 ', h('b', null, String(derived.unknownCount)))
              : null)),

        /* abort confirmation — the copy has to be exactly this honest */
        settingsDialog,
        castDialog,
        projectsDialog,
        clipDialog,
        abortOpen
          ? h('div', { className: 'dsh-ov-modal', onClick: (event) => { if (event.target === event.currentTarget) setAbortOpen(false) } },
              h('div', { className: 'dsh-ov-card' },
                h('h3', null, '⏸ 中止派发'),
                h('p', null, '已停止派发 ', h('b', null, String(derived.counts.idle)), ' 个未开始节点。'),
                h('p', null, h('b', null, String(derived.counts.running)),
                  ' 个正在生成的任务在 OpenRouter 侧继续运行，', h('b', null, '会继续计费'),
                  '，且', h('b', null, '无法取消'), ' —— Video API 没有取消端点。'),
                h('p', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                  '图仍是可续跑状态：再点运行会从断点继续，已完成的节点不会被重复提交，因此不会重复花钱。'),
                h('div', { className: 'dsh-ov-acts' },
                  h('button', { className: 'dsh-ov-btn', onClick: () => setAbortOpen(false) }, '返回'),
                  h('button', { className: 'dsh-ov-btn', 'data-kind': 'primary', onClick: () => void abortRun() }, '确认中止'))))
          : null)
    }

    /** CSS.escape may be absent in the preview renderer; keep a local shim. */
    function CSS_escape(value) {
      const text = String(value)
      if (typeof window !== 'undefined' && window.CSS !== undefined && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(text)
      }
      return text.replace(/[^a-zA-Z0-9_-]/gu, (ch) => '\\' + ch)
    }

    /** The sidebar glyph. Purely additive to a list slot. */
    function SidebarEntry() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none' },
        h('rect', { x: 2.2, y: 4.6, width: 15.6, height: 10.8, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M8.2 7.6 12.6 10l-4.4 2.4z', fill: 'currentColor' }))
    }

    exports.SidebarEntry = SidebarEntry
    exports.Workspace = Workspace

    function apply(ctx) {
      ctx.effect(installStyles, 'openrouter-video: styles')

      // The entry. `sidebar.panellist` is a list slot with replaceRisk none, so
      // this is additive and cannot shadow shipped UI.
      ctx.effect(
        () => ctx.slots.inject('sidebar.panellist', function* () {
          // `id` is PANEL_KEY, not a second string: the shell hands this id to
          // `layout.selectPanel`, which throws unless a `main` entry carries the
          // same key. Two different strings here is why the reference
          // implementation's label click did nothing.
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 61, label: '视频生成' },
            () => h(SidebarEntry),
          )
        }),
        'openrouter-video: sidebar entry',
      )

      // The workspace itself. `main` is the keyed "central panel selected by
      // sidebar entry id" slot; registering under our own key leaves the chat
      // untouched.
      ctx.effect(
        () => ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_KEY }, () => h(Workspace))
        }),
        'openrouter-video: main view',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports
  },
})
