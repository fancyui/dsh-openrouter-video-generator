# dsh-openrouter-video

把「一次只出一条 5–15 秒片段」的视频模型，变成一条**能计划、能续跑、能出成片**的流水线。

一个 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）插件：**节点图视频工作台**。
镜头是节点，衔接是连线，成片是本地 ffmpeg 拼出来的产物。图是唯一真相源 —— 人和 agent 读写同一份。

**中文** · [English](README.en.md) · **[使用手册](MANUAL.md)** · [agent skill](skills/openrouter-video/SKILL.md)

---

## 为什么需要它

OpenRouter 的 Video API 一次只生成**一条**片段，提交即计费，而且**没有取消端点**。
做一部三分钟的片子就是 23 次这样的调用。裸调 API 的问题不在生成，在这三件事：

| 问题 | 这个插件的答案 |
|---|---|
| 第 14 条失败，前面 13 条的钱怎么办 | **可续跑**：已完成的镜头永不重复提交；失败的镜头默认跳过，要重跑必须显式 `retry_failed` |
| 不知道会花多少 | **预检默认开**：`run` 不传 `dry_run:false` 就只报上界；超预算直接拒绝派发 |
| 每一镜的猫长得都不一样 | **设定库**：角色/场景 = 一段固定描述（原样插进每条出场镜头的提示词）+ 一张可选参考图，**按镜头连线** |
| 镜头之间接不上 | **取帧接龙**：上一镜的末帧 → 下一镜的首帧（本地 ffmpeg 抽帧 + 图床上传，不产生 API 费用） |
| 角色和场景都稳了，故事还是接不上 | **结尾状况（`endsOn`）**：把上一镜留下的**事实**（不是姿势）作为"已生成的上一段"插进下一镜提示词，并注明不要重演 —— 接龙只交画面，硬切镜头里文字是唯一能过到下一镜的东西 |
| 一堆零散 mp4 要手工拼 | **成片序列节点**：按 `shotIndex` 用 ffmpeg 拼成一条，写同名 `-manifest.json` |

---

## 它是什么

- **一个工作台**（DSH 侧栏「视频生成」）：节点画布、端口连线、检查器、缩略图、迷你图、顺序表、成片预览。
- **14 种节点**，其中只有 4 种会发网络请求：`generate` / `extend` / `edit` / `upscale`。
  其余（脚本、提示词、参考素材、角色、场景、取帧、成片序列、注释、分组、模板）都是本地且免费。
- **一个 DAG 执行器**：拓扑排序、并发受控、逐节点成本记账、中断可续。
- **5 个 agent 工具**：`openrouter_video_plan`（建图）/ `openrouter_video_run`（预检与执行）/
  `openrouter_video_status`（实账）/ `openrouter_video_graph`（增删改图）/ `openrouter_generate_video`（单条）。
- **一个 agent skill**：告诉创意/导演 agent 有哪些工具、怎么用 —— 见 [SKILL.md](skills/openrouter-video/SKILL.md)。

**它不是什么**：不是一键出片，不是剪辑软件，不跑本地模型。创意不在这里，这里只保证机器接得住。

```
脚本/分镜 ──► 镜头1 ──► 镜头2 ──► 镜头3         每个镜头接：
               │         ▲        ▲              · endsOn（上一镜留下的事实）
               │         │        │              · refs（角色/场景/参考图）
            取帧 ───────┘        │              · frames（上一镜的末帧）
            取帧 ────────────────┘
                （提示词写在每个镜头自己的检查器里）
                                      └──► 成片序列 ──► film.mp4 + film-manifest.json
角色/场景 ──► refs
```

---

## 安装

### 前置

| 需要 | 说明 |
|---|---|
| DSH `0.2.0-rc.2` 或更高 | 插件通过 `peerDependencies` 判定（`engines.dsh` 只是声明，不生效） |
| Node.js `^22.19.0` 或 `>=24.0.0` | 见 `engines.node` |
| `ffmpeg` + `ffprobe` 在 PATH | 取帧与拼成片要用；不可用时这两步会明确报错，不会静默 |
| 一个 OpenRouter API key（`sk-or-` 开头） | 需要能访问视频模型 |
| 一个图床（可选） | **只有取帧接龙需要** —— provider 只接受公开 https URL，抽出的帧得先传上去 |

### 方式 A：官方 CLI（从 git 安装，尚未实测）

包**还没有发布到 npm**。用 pnpm 的 git 协议安装：

```bash
dsh plugin --profile desktop add github:fancyui/dsh-openrouter-video
```

该包声明了 `dsh.bundle.patch`，CLI 会把它记进 `dsh.profile.bundles`，profile 启动时合并包内
`cordis.patch.yml`（一行 `insert`）—— 相当于自动完成方式 B 的第 2 步。

> ⚠️ **方式 A 与方式 B 只能选一个。** 两条路同时生效会注册两次同一个 web 路由前缀，
> 启动时 `(kind, path)` 重复会直接抛错，整棵插件树起不来。

### 方式 B：本地源码挂载（本仓库当前实际运行的方式）

**① 建 junction**

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-openrouter-video" `
  -Target "X:\path\to\dsh-openrouter-video-generator"
```

必须是 **Junction**（`mklink /J`，无需管理员），不是符号链接 —— ESM 会解析真实路径，
symlink 会让包自己的裸导入解析失败。

**② 在 profile patch 里插入一行** —— `~/.dsh/profiles/desktop/cordis.patch.yml`：

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

`id` 就是设置命名空间（`openrouter-video`），必须和它一致。
`config` 是**基础层**；工作台里「设置」保存的值写在同一个文件里另一条 `- id: openrouter-video`
覆盖行上 —— 同一 id 出现两行（一行 insert、一行覆盖）是正常的，不是双重挂载。

**③ 重启 DSH。** Host 半边不热重载。

### ⚠️ 一条会删掉你源码的坑

**不要把 junction 建在 `~/.dsh/profiles/desktop/.dsh-module-fallback/` 下面。**

DSH 启动时会调用 `removeLinkProjections()`：它先删掉 profile `node_modules` 下指向
`.dsh-module-fallback/node_modules` 的链接，然后**递归删除整个 `.dsh-module-fallback`**。
junction 指向外部目录时，递归删除会**顺着 junction 逃出去，把目标目录删光**。

2026-10-04 实测：junction 建在 `.dsh-module-fallback\node_modules\dsh-openrouter-video`，
重启后整个源码工作区被清空，回收站里没有记录。

正确位置只有一个：`~/.dsh/profiles/desktop/node_modules/dsh-openrouter-video`。

### 第一次配置（约 3 分钟）

打开侧栏的 **「视频生成」** →顶栏 **「设置」**：

1. **密钥** —— 填 `sk-or-...`，点「测试密钥」；它会真的去拉一次视频模型目录。
2. **模型** —— 加入你打算用的模型 id（例如 `heygen/heygen-video-1`），把其中一个「设为默认」。
   列表为空时节点上的模型下拉会退回显示线上全部视频模型（几百个）。
3. **图床**（只有要用取帧接龙才需要）—— 地址、文件夹、User-Agent、令牌，保存后点「测试连通」。
   **先点它**：有的图床靠 User-Agent 过 Cloudflare，普通 UA 会拿到 403 + HTML 校验页，
   而这个失败要等到成片出来才发现。

---

## 快速开始

```
1. 侧栏「视频生成」 → 顶栏标题 ▾ →「+ 新建项目」
2. 左栏「节点库」点几下加入节点：生成 ×3 → 成片序列
3. 点节点，在右侧检查器里填提示词、时长、模型；给三个「生成」节点填 1/2/3 为镜头序号，
   并给 1 号、2 号填「结尾状况（写给下一镜）」—— 那是故事过到下一镜的唯一通道
4. 连线：三个生成的 job ──jobs──► 成片序列
5. 点「预检」（不花钱）看成本上界 → 点「执行全图」真跑 → 底部「成片」出现 mp4
```

> **注意：`提示词`/`脚本` 节点的 `brief` 端口目前没有消费者**（实测：接上去的文字不会进请求）。
> 逐镜提示词写在该镜头自己的检查器里；分镜节点留在画布上只是给人读的分镜稿。

详细的每一步、每个按钮、每个报错怎么读：**[MANUAL.md](MANUAL.md)**。

---

## 卸载

```powershell
# 1) 删 junction
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-openrouter-video" -Force

# 2) 从 profile patch 里删掉该插件的两行
#    一条 `- insert:` 里的 openrouter-video 行，和一条 `- id: openrouter-video` 覆盖行
#    文件：~/.dsh/profiles/desktop/cordis.patch.yml
```

方式 A 安装的则用：

```bash
dsh plugin --profile desktop remove dsh-openrouter-video
```

并从 `dsh.profile.bundles` 里确认它已移除。**然后重启 DSH。**

**卸载不会删除**（它们是「事实」，不是「意图」）：

- `~/.dsh/openrouter-video/graphs.json` —— 项目（图文档）
- `~/.dsh/openrouter-video/jobs.json` —— 任务台账与实账
- `<会话工作目录>/generated-videos/*.mp4` —— 已经生成并下载的视频

想彻底清干净就手工删掉这三处。

---

## 数据与隐私

| 数据 | 位置 |
|---|---|
| 项目（图文档） | `~/.dsh/openrouter-video/graphs.json` |
| 任务台账（含实账 `usage.cost`） | `~/.dsh/openrouter-video/jobs.json` |
| 成片与片段 | `<会话工作目录>/generated-videos/`（可用 `saveDir` 改） |
| API key / 图床令牌 | profile patch 的用户层（`~/.dsh/profiles/desktop/cordis.patch.yml`），不随仓库分发 |

工作台**从不显示密钥或图床地址的任何一段**：顶栏只给一个灯和一个词（●已配置 / ●未配置）。
一个打了码的密钥仍然是密钥的前 9 位和后 4 位，而投影、截图和 issue 里的截图都会把它带出去 ——
"配了没"才是你要判断的那件事。

**提示词与素材会离开本机**，发往 OpenRouter 及你配置的图床。每次调用都消耗**你自己的**额度。
生成一条 8 秒镜头的量级：约 `$0.16`（heygen 480p）到 `$3.20`（veo-3.1 720p）。

---

## 目录结构

```
lib/
  index.js      Host 半边：5 个工具、HTTP 路由、设置、请求构建、执行调度
  client.js     工作台 UI（自包含，无打包器）
  graph.js      节点类型表、端口规则、连线校验、预检
  exec.js       DAG 执行器（拓扑序、并发、续跑）
  sequence.js   ffmpeg 拼接、manifest、镜头排序
  imagebed.js   抽帧（真正的尾帧）与图床上传
  cast.js       设定库：角色/场景的固定描述与参考图
  pricing.js    成本上界
  store.js      graphs.json / jobs.json
  skills.js     把 skills/ 里的 skill 注册给 DSH
skills/openrouter-video/SKILL.md   agent 用的工具手册
MANUAL.md                          人用的使用手册
```

## 开发

```bash
npm run check     # 语法检查
npm run all       # 全部套件（263 项）
npm run mutate    # 变异测试：故意改坏源码，验证测试真的会红
```

四个变异套件共 **88 个变异**，要求 100% 被抓、零跳过，并在结束后逐字节还原源码。

## 兼容性

- `engines.dsh` 是**声明**，不执行；DSH 实际判定的是 `peerDependencies` 里的 `@deepseek-ai/dsh`。
- `dsh.manifestVersion` 固定为 `1`。
- Host 半边**不热重载**：改了 `lib/` 要重启 DSH；客户端半边刷新页面即可。

## 许可

MIT（见 [LICENSE](LICENSE)）。
