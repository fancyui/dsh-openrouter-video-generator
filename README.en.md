# dsh-openrouter-video

Turns a video model that produces **one 5–15 second clip per call** into a pipeline that can
**plan, resume, and deliver a film**.

A [DSH](https://github.com/deepseek-ai) (DeepSeek Harness) plugin: a **node-graph video workspace**.
Shots are nodes, continuity is wiring, and the finished film is an ffmpeg concatenation.
The graph is the single source of truth — humans and agents read and write the same document.

[中文](README.md) · **English** · **[Manual (中文)](MANUAL.md)** · [agent skill](skills/openrouter-video/SKILL.md)

---

## Why it exists

The OpenRouter Video API generates **one** clip per request, bills on submission, and
**has no cancel endpoint**. A three-minute film is 23 of those calls. The hard part is not
generation — it is these:

| Problem | This plugin's answer |
|---|---|
| Shot 14 fails — what about the money already spent on 1–13? | **Resumable**: completed shots are never re-submitted; failed shots are skipped by default and only retried when you pass `retry_failed` |
| No idea what it will cost | **Preflight by default**: `run` reports a cost ceiling unless you pass `dry_run:false`; over-budget runs are refused before anything is sent |
| The cat looks different in every shot | **Bibles**: a character/scene is a fixed description (injected verbatim into every shot it appears in) plus an optional reference image, **wired per shot** |
| Shots do not connect | **Frame chaining**: last frame of shot N → first frame of shot N+1 (local ffmpeg + image-bed upload, no API cost) |
| Character and place are stable, the STORY still does not connect | **`endsOn`**: the FACTS shot N leaves behind (not its pose) are injected into shot N+1's prompt as an already-generated previous segment, marked do-not-re-perform — chaining only carries the picture, and on a hard cut the text is the only thing that crosses |
| A pile of loose mp4s to assemble by hand | **Sequence node**: concatenates by `shotIndex` with ffmpeg and writes a `-manifest.json` alongside |

---

## What it is

- **A workspace** (DSH sidebar → "视频生成"): node canvas, port wiring, inspector, thumbnails,
  minimap, shot table, film preview.
- **14 node types**, of which only 4 touch the network: `generate` / `extend` / `edit` / `upscale`.
  Everything else (script, prompt, reference asset, character, scene, frame-take, sequence,
  note, group, template) is local and free.
- **A DAG executor**: topological order, bounded concurrency, per-node cost accounting, resumable.
- **5 agent tools**: `openrouter_video_plan` (build a graph) / `openrouter_video_run` (preflight and
  execute) / `openrouter_video_status` (actual spend) / `openrouter_video_graph` (mutate the graph) /
  `openrouter_generate_video` (a single clip).
- **An agent skill** that tells a creative/director agent which tools exist and how to use them —
  see [SKILL.md](skills/openrouter-video/SKILL.md).

**What it is not**: not one-click video, not a video editor, not local inference.
Creativity does not live here; this only guarantees the machine can honour it.

```
script ──► shot 1 ──► shot 2 ──► shot 3         each shot takes:
               │         ▲        ▲              · endsOn (facts the previous shot left behind)
               │         │        │              · refs   (character / scene / reference)
             take ───────┘        │              · frames (previous shot's last frame)
             take ────────────────┘
                (the prompt is typed in each shot's own inspector)
                                      └──► seq ──► film.mp4 + film-manifest.json
cast/scene ──► refs
```

---

## Install

### Requirements

| Need | Why |
|---|---|
| DSH `0.2.0-rc.2` or newer | enforced through `peerDependencies` (`engines.dsh` is declarative only) |
| Node.js `^22.19.0` or `>=24.0.0` | see `engines.node` |
| `ffmpeg` + `ffprobe` on PATH | frame extraction and concatenation; failures are reported, never silent |
| An OpenRouter API key (`sk-or-…`) | needs access to video models |
| An image bed (optional) | **only for frame chaining** — providers accept public https URLs only |

### Option A — official CLI (git install, untested)

The package is **not published to npm**. Install from git:

```bash
dsh plugin --profile desktop add github:fancyui/dsh-openrouter-video
```

The package declares `dsh.bundle.patch`, so the CLI records it in `dsh.profile.bundles` and the
profile boot merges the bundled `cordis.patch.yml` (a single `insert`) — i.e. it does Option B's
step 2 for you.

> ⚠️ **Use Option A or Option B, never both.** Two mounts register the same web route prefix twice,
> the duplicate `(kind, path)` throws at boot, and the whole plugin tree fails to start.

### Option B — mount the source (what this repo actually runs on)

**1. Create the junction**

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-openrouter-video" `
  -Target "X:\path\to\dsh-openrouter-video-generator"
```

It must be a **Junction** (`mklink /J`, no admin needed), not a symlink — ESM resolves real paths,
and a symlink breaks the package's own bare imports.

**2. Insert one row into the profile patch** — `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: openrouter-video
      name: 'dsh-openrouter-video'
      config:
        model: google/veo-3.1-fast
        resolution: 720p
        aspectRatio: 16:9
        duration: 8
        generateAudio: true
        concurrency: 2
        budgetUsd: 30
        abortOnExceed: true
        saveDir: generated-videos
```

`id` is the settings namespace (`openrouter-video`) and must match. `config` here is the **base
layer**; values saved from the workspace's Settings dialog live in another `- id: openrouter-video`
override entry in the same file. Two entries with the same id (one `insert`, one override) is
normal — it is not a double mount.

**3. Restart DSH.** The Host half does not hot-reload.

### ⚠️ One trap that deletes your source tree

**Never create the junction under `~/.dsh/profiles/desktop/.dsh-module-fallback/`.**

At boot DSH calls `removeLinkProjections()`: it removes links in the profile's `node_modules` that
point into `.dsh-module-fallback/node_modules`, then **recursively deletes `.dsh-module-fallback`
itself**. When a junction points outside that directory, the recursive delete **follows it and
wipes the target**.

Measured on 2026-10-04: a junction at `.dsh-module-fallback\node_modules\dsh-openrouter-video`
wiped the entire source workspace on restart, with nothing in the recycle bin.

There is exactly one correct location:
`~/.dsh/profiles/desktop/node_modules/dsh-openrouter-video`.

### First-time setup (~3 minutes)

Open the sidebar entry **"视频生成"**, then **"设置" (Settings)** in the top bar:

1. **API key** — paste `sk-or-…`, press "测试密钥" (Test key). It really fetches the video model catalog.
2. **Models** — add the model ids you intend to use (e.g. `heygen/heygen-video-1`) and mark one as
   default. With an empty list, the per-node model dropdown falls back to the entire live catalog.
3. **Image bed** (only needed for frame chaining) — base URL, folder, User-Agent, token; save, then
   press "测试连通" (Test connection). **Press it first**: some beds gate on User-Agent behind
   Cloudflare, and the wrong UA gets a 403 + HTML interstitial that only surfaces after your film is cut.

---

## Quick start

```
1. Sidebar → "视频生成" → click the title ▾ → "+ 新建项目" (new project)
2. Left column "节点库": click to add  generate ×3 → seq
3. Click a node and fill the inspector: prompt, duration, model; number the three generates 1/2/3,
   and give shots 1 and 2 an "结尾状况（写给下一镜）" — that is the only channel the story crosses on
4. Wire them: each generate's job ──jobs──► seq
5. Press "预检" (preflight, free) to read the ceiling → "执行全图" to actually run → the film appears below
```

> **Note: the `brief` input port has no consumer** (measured: text wired into it never reaches the
> request). Type each shot's prompt in that shot's own inspector; the script node stays on the canvas
> as a storyboard document for humans to read.

Every button, every field and every error message: **[MANUAL.md](MANUAL.md)** (Chinese only — the
plugin UI itself is Chinese).

---

## Uninstall

```powershell
# 1) remove the junction
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-openrouter-video" -Force

# 2) remove both rows for this plugin from the profile patch
#    one openrouter-video row inside `- insert:`, and one `- id: openrouter-video` override
#    file: ~/.dsh/profiles/desktop/cordis.patch.yml
```

For Option A:

```bash
dsh plugin --profile desktop remove dsh-openrouter-video
```

and confirm it is gone from `dsh.profile.bundles`. **Then restart DSH.**

**Uninstalling does not delete** these, because they are facts, not intentions:

- `~/.dsh/openrouter-video/graphs.json` — projects (graph documents)
- `~/.dsh/openrouter-video/jobs.json` — job ledger and actual spend
- `<session cwd>/generated-videos/*.mp4` — videos already rendered and downloaded

Delete those three by hand if you want them gone.

---

## Data and privacy

| Data | Location |
|---|---|
| Projects (graphs) | `~/.dsh/openrouter-video/graphs.json` |
| Job ledger (incl. actual `usage.cost`) | `~/.dsh/openrouter-video/jobs.json` |
| Films and clips | `<session cwd>/generated-videos/` (change with `saveDir`) |
| API key / image-bed token | the profile patch user layer (`~/.dsh/profiles/desktop/cordis.patch.yml`), never in this repo |

The workspace **never prints any part of your key or your image-bed address**: the top bar gives a
lamp and a word (●已配置 / ●未配置). A masked key is still the first 9 and last 4 characters of a
live credential, and projections, screenshots and pasted issue reports all carry it out of the
room — while the only question you actually act on is "is it configured".

**Prompts and assets leave your machine** — they go to OpenRouter and to the image bed you configure.
Every call spends **your own** credits. An 8-second shot is roughly `$0.16` (heygen 480p) to
`$3.20` (veo-3.1 720p).

---

## Layout

```
lib/
  index.js     Host half: 5 tools, HTTP routes, settings, request building, scheduling
  client.js    the workspace UI (self-contained, no bundler)
  graph.js     node type registry, port rules, connection validation, preflight
  exec.js      DAG executor (topological order, concurrency, resumption)
  sequence.js  ffmpeg concat, manifest, shot ordering
  imagebed.js  frame extraction (the real last frame) and image-bed upload
  cast.js      bibles: fixed descriptions and references for characters/scenes
  pricing.js   cost ceilings
  store.js     graphs.json / jobs.json
  skills.js    registers the bundled skill with DSH
skills/openrouter-video/SKILL.md  the tool manual for agents
MANUAL.md                         the user manual (Chinese)
```

## Development

```bash
npm run check     # syntax
npm run all       # every suite (263 assertions)
npm run mutate    # mutation testing: break the source on purpose, prove the tests go red
```

The four mutation suites hold **88 mutations**; the bar is 100% caught, zero skips, and a
byte-identical restore of every file afterwards.

## Compatibility

- `engines.dsh` is **declarative** and never executed; DSH enforces `peerDependencies["@deepseek-ai/dsh"]`.
- `dsh.manifestVersion` is `1`.
- The Host half **does not hot-reload**: `lib/` changes need a DSH restart; the client half needs a page refresh.

## License

MIT — see [LICENSE](LICENSE).
