# HeapScope

**React Native 0.81+ JS 堆内存泄漏分析工具** —— 零依赖 Node CLI + Web 服务，不修改被测 App 的任何源码。

版本 **0.1.0** ｜ Node ≥ 22 ｜ 目标引擎 Hermes（RN dev build）

通过 Metro inspector 通道（CDP）对 Hermes 采集多轮堆快照，自动差分、符号化到业务源码行，输出「泄漏候选排名 + 重点关注标记」报告。

回答的问题是：**退出页面后堆没降，到底是哪个构造函数没被释放、在哪一行分配的、被谁持有。**

```
┌─────────┐   CDP(WebSocket)   ┌────────┐   /index.map    ┌────────────────┐
│ RN App   │ ←──────────────── │Metro    │ ──────────────→ │ dev source map │
│ (Hermes) │   HeapProfiler    │:8081    │   54MB VLQ      │ (sourcesContent)│
└─────────┘                    └────────┘                 └───────┬────────┘
      │ takeHeapSnapshot ×N → .heapsnapshot（V8 标准格式）         │
      ▼                                                          ▼
  差分分组（devtools / heapscope 两种算法） ──→ 源码符号化 ──→ analysis.json
                                                              └→ report.html（打开时实时渲染）
```

## 核心能力

- **真实快照采集**：CDP `HeapProfiler.takeHeapSnapshot`，产物是标准 V8 `.heapsnapshot`，可直接拖进 Chrome DevTools Memory 面板人工复核
- **大堆实测通过**：iOS 真机 140MB 级快照完整采集，局域网直连 Metro 实测最高 246MB；通道断连时尝试重连并降级 `startSampling`（低开销概率采样），降级后需重新复现场景。Android 真机经 `adb reverse` 隧道上传大快照的限制见「已知边界」
- **源码级定位**：分配点经 Metro `/index.map`（dev source map，自解 VLQ）反解到 `.tsx:行号`，附命中行源码上下文；定位不到业务代码时展示可解析的 node 包位置（标「依赖」）
- **完整文件链路**：每个候选列出「分配点 → 属性值 → 持有者 → 持有链上层」全部可解析位置，逐段标业务/依赖
- **重点关注标记**：按「真实分配点 + 增量 ≥ 64KB + 逐轮线性」自动筛出 high/watch/low，单文件报告顶部单独列卡片可一键跳转，Web 详情页支持「只看重点关注」
- **两种分析算法**（可选）：DevTools 对比式（默认，与 Chrome 口径一致）与 HeapScope 加权式（多轮趋势精排）
- **自动 GC + 源码指纹**：每轮快照前 `collectGarbage`；watchman 校验采集期间源码树未变化，保证符号化可信
- **零依赖**：CDP 客户端、WebSocket（含 Origin 头）、VLQ 解码、报告渲染全部内置，`npm i` 无第三方包
- **磁盘友好**：报告以自包含 `analysis.json` 持久化，HTML 打开时实时渲染；`.heapsnapshot` 分析成功后自动清理（可选保留）
- **AI 分析（可选）**：报告支持接入 OpenAI 兼容模型做根因归纳与排查建议；配置页可管理服务商、密钥、模型、参数与提示词，结论流式生成、落盘并内嵌进单文件报告
- **深度 AI 分析（保留快照时）**：本机解析 `.heapsnapshot` 得到逐轮结构与精确 GC root 持有链，结合项目源码片段一起送入模型；原始快照与完整源码不上传，路径限制 + 密钥脱敏 + 字符预算

## 安装与运行

```bash
npm pack            # 生成 heapscope-0.1.0.tgz 到 out/，或直接在仓库根目录运行
npm i -g out/heapscope-0.1.0.tgz
```

要求：Node ≥ 22；被测 RN App 为 **dev 构建**（release 包无 inspector）；手机与 Mac 可访问 Metro。

> 分析 3 份 180MB 快照需要大内存：启动前建议 `NODE_OPTIONS=--max-old-space-size=8192`（8G 堆实测可跑 3×190MB）。

## 命令

| 命令 | 说明 |
|---|---|
| `devices` | 列出 Metro inspector 上的可调试设备/页面 |
| `capabilities` | 探测引擎与 CDP 能力（Hermes / GC / snapshot / sampling） |
| `capture` | **核心命令**：采集多轮堆快照并出报告 |
| `serve` | 启动 Web 服务（浏览器里完成分析全流程） |
| `analyze <a> <b> [c]` | 离线分析已有 `.heapsnapshot`（至少 2 个文件） |
| `probe --install\|--check` | WeakRef 存活探针（验证某个对象是否被回收） |
| `selftest` | 合成快照 + 假 CDP 跑通全链路（不接真机） |
| `ai-config` | 查看 / 修改 AI 配置（支持多个模型，密钥只显示掩码） |
| `ai-test` | 测试 AI 接口连通性（`--model` 指定测某个模型） |
| `ai-analyze <报告名>` | 用 AI 分析已有报告，结论写入报告目录（`--model` 指定模型） |

### capture（CLI 采集）

```bash
# Android：先 adb reverse
adb reverse tcp:8081 tcp:8081
NODE_OPTIONS=--max-old-space-size=8192 node bin/heapscope.js capture \
  --target 0 --project /path/to/MallApp --steps 3 --top 30 --out out/store-detail

# iOS：App 与 Metro 同一网络，直接运行
NODE_OPTIONS=--max-old-space-size=8192 heapscope capture \
  --target 0 --project /path/to/MallApp --steps 4 --algorithm devtools --keep-snaps
```

常用选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--target ID` | 单设备自动选 | 目标 id / 序号 / 标题片段；多设备时必填 |
| `--steps N` | 3 | 轮次数（基线 + N-1 次场景复现） |
| `--interval SEC` | 按回车 | 每轮自动等待秒数；不填则交互式按回车触发下一轮 |
| `--mode MODE` | auto | `snapshot` \| `sampling` \| `auto`（大堆断连自动降级） |
| `--algorithm NAME` | devtools | `devtools` \| `heapscope`，见下文 |
| `--top N` | 30 | 报告候选条数 |
| `--keep-snaps` | 关 | 分析成功后保留 `.heapsnapshot` / sampling / sourcemap（约 600MB/3 轮） |
| `--no-gc` | 开 GC | 每轮拍快照前不触发 `collectGarbage` |
| `--no-symbolicate` | 开符号化 | 跳过源码定位，速度更快 |
| `--no-track-alloc` | 开 | 关闭 HeapProfiler allocation tracking |
| `--max-snapshot-mb N` | 160 | 单快照预警阈值 |
| `--platform ios\|android` | 按 bundle 推断 | 拉 `/index.map` 用的平台 |
| `--line-base 0\|1` | 1 | 快照行号基准 |

### serve（Web 服务）

```bash
NODE_OPTIONS=--max-old-space-size=8192 node bin/heapscope.js serve \
  --port 7794 --metro http://127.0.0.1:8081 \
  --project /path/to/MallApp --out /path/to/out
# 浏览器打开 http://127.0.0.1:7794
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--port N` | 7788 | 监听端口 |
| `--host ADDR` | 127.0.0.1 | 局域网共享用 `0.0.0.0`（无认证，谨慎） |
| `--out DIR` | `./out` | 报告与快照根目录 |
| `--metro URL` | `http://127.0.0.1:8081` | 默认 Metro 地址 |
| `--project PATH` | 空 | 默认 RN 项目根（业务/依赖判定、源码指纹） |
| `--ai-config FILE` | `<out>/ai-config.json` | AI 配置文件路径 |

> **必须通过 `http://` 访问**。直接双击 `public/index.html`（`file:` 协议）时页面会显示提示条而不是功能界面，因为跨域请求全部失败。

## Web 界面

页面自上而下四个区块：

| 区块 | 内容 |
|---|---|
| **连接与输出** | Metro 地址、目标设备实时探测（含机型/系统版本）、RN 项目路径、输出目录名 |
| **采集配置** | 轮次（2/3/4）、采集模式（auto/snapshot/sampling）、等待方式（手动按钮 / 自动 15·30·60s）、**分析算法**、候选条数、**保留快照文件**开关 |
| **任务区** | 步进器 + 进度条 + 实时日志（SSE + 3s 轮询兜底）；大按钮「拍下一张快照 / 结束并出报告 / 取消」；刷新页面自动恢复进行中的任务 |
| **报告区** | 卡片列表（模式/轮次/堆首末值/候选数/符号化覆盖率/快照是否留存）→ 详情页：meta 概览、`重点关注 N / 观察 N` 计数、「只看重点关注」过滤、候选表（可展开行）、警告、内嵌完整报告、删除整条记录；列表下方单独列出**残留目录**（采集失败/取消，只有快照没有 analysis.json），可单个或一键删除 |

- **并发限制**：同一时间只允许一个任务，重复启动返回 `409`
- **快照进行中**点「结束并出报告」会排队（`queued: true`），当前步骤完成后生效
- **采样模式**下只能结束，不能拍下一张
- 详情页支持「只看重点关注」过滤、报告删除
- 任务状态在内存、报告在磁盘：刷新页面或换浏览器不丢报告，**重启服务会清空任务列表**（历史报告仍可打开）

### 报告怎么读

候选表：Web 详情页 6 列（`# / 类型·名称 / 数量 / 逐轮 / 增长 / 问题判断`），单文件 `report.html` 8 列（额外给出 `Δ bytes / 增长 1→2 / sizeΔ 或 score` 排序依据）。点行首箭头展开，左右两栏：

```
┌ 源码位置 ────────────────────────┬ GC root 持有链 ──────────────┐
│ 分配点（业务）  ↑ ↑ ↑            │ (GC roots) → _root → ...    │
│ store/Detail.tsx:214  业务        │   → FiberNode → ...         │
│ 文件链路 5 段                     │                             │
│   allocation  store.ts:88  业务   │                             │
│   property    List.tsx:52  业务   │                             │
│   holder      node_modules/...    │                             │
└──────────────────────────────────┴─────────────────────────────┘
```

- **逐轮数量**是判断泄漏的核心：每轮增量基本恒定（**线性↑**）才算线索；第一轮暴涨、第二轮几乎不动（**趋平**）说明是一次性预热
- 标「**关联位置（非分配点）**」表示这是持有链上最近的业务位置，不是对象真正 new 出来的地方——Hermes 只有约 17% 节点带 debug location
- 单文件 `report.html` 顶部另有「重点关注」卡片，只放 `high` 项，点名称跳到表内对应行；无 high 项时给出空态结论（全部为引擎对象/预热/小增量）。Web 详情页则用 `重点关注 N / 观察 N` 计数标签 + 「只看重点关注」开关达到同样目的

## AI 分析（可选）

把报告摘要交给 OpenAI 兼容的 `/chat/completions` 接口，让模型归纳最可疑的候选、给出排查步骤与复测方案。**不启用也能正常使用全部采集/差分能力。**

采集时勾选「保留快照文件」（CLI `--keep-snaps`）后，AI 分析会自动升级为**深度分析**：在本机解析 `.heapsnapshot` 并读取项目源码，把「报告 + 快照结构 + 源码上下文」一起交给模型。没有保留快照的报告自动退回纯报告摘要模式。

### 配置

Web：左侧「AI 配置」页；CLI：`ai-config`。配置落盘 `<out>/ai-config.json`（权限 `0600`），API Key 只写本地文件，**接口返回的一直是掩码**（`sk-t••••3456`），页面也拿不到明文。

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `custom` | 服务商预设，仅用于一键填充 Base URL / 模型 |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容根地址，工具自动追加 `/chat/completions` |
| `apiKey` | 空 | 本地模型（Ollama）可留空；其余必填 |
| `model` | `gpt-4o-mini` | 模型名 |
| `temperature` / `maxTokens` | `0.2` / `2048` | 生成参数 |
| `maxCandidates` | `15` | 送进 prompt 的候选条数；报告体量上限约 32K 字符，超限时自动压缩候选 |
| `timeoutMs` | `120000` | **空闲超时**：连接 / 等待首个响应 / 流式输出中「连续没有新数据」的最长等待。每收到一个数据块（含 SSE 心跳）就重新计时，所以持续输出的长分析不会被掐断 |
| `totalTimeoutMs` | `1800000` | 单次 AI 请求的**总时长上限**（30 分钟），防止上游一直慢速吐字导致永不结束；`0` = 不限制 |
| `stream` | `true` | 流式输出；关闭后等完整响应 |
| `systemPrompt` | 内置中文模板 | 输出结构（结论 / 重点候选 / 排查建议 / 复测方案 / 不确定性） |
| `extraHeaders` | `{}` | 自定义请求头（过滤 `host` / `content-length` / `connection` / `authorization`） |
| `deepAnalysis` | `true` | 报告保留了快照时自动启用深度分析；单次运行可用 `deep: false` / `--no-deep` 关闭 |
| `deepMaxSnapshots` | `4` | 深度分析最多解析几份快照（超出时按首末均匀分布取样） |
| `deepMaxCandidates` | `8` | 从原始快照里深挖精确持有链的候选数（按 focus / 增量排序） |
| `deepMaxSourceFiles` | `12` | 最多读取几个源码片段，0 表示只读依赖摘要 |
| `deepSourceRadius` | `12` | 每处源码位置的上下文行数（前后各 N 行） |
| `deepMaxChars` | `18000` | 深度证据文本总字符上限，超限按「源码片段 → 持有链 → 构造器分组」顺序裁剪 |
| `deepMaxSnapshotMB` | `400` | 单份快照大小上限，超过则跳过并记警告 |
| `models` | `[默认]` | **多模型**：模型档案数组，每个档案 `{ name, provider, baseUrl, apiKey, model, extraHeaders }`；`provider/baseUrl/apiKey/model/extraHeaders` 仅存在档案内，按 `name` 区分；生成参数（temperature/maxTokens/超时/stream/systemPrompt/深度分析）为全局共享，不随模型变化 |
| `defaultModel` | `默认` | 默认启用的模型档案 `name`；Web/CLI 省略 `--model` 时使用；若指向不存在的档案会自动回退到第一个 |

预设：OpenAI、DeepSeek、Moonshot/Kimi、通义千问（兼容模式）、Ollama（本地）、自定义。

**多模型**：可同时配置多个服务商/模型，保存时每个档案的 API Key 各自脱敏落盘（掩码，权限 `0600`），互不覆盖。Web「AI 配置」页点「+ 添加模型」新增档案、勾选「默认」设为主模型、每档单独填服务商/Base URL/模型/密钥；报告详情页的「AI 分析」面板有模型下拉框，可选本报告的模型（不传则走默认模型）。老旧单模型配置（`provider/baseUrl/apiKey/model` 在顶层）首次读取时会自动合成一个名为 `默认` 的档案，向后兼容。环境变量 `HEAPSCOPE_AI_*` 只作用于**默认模型**档案。

环境变量优先级高于文件，适合 CI 或临时切模型：`HEAPSCOPE_AI_BASE_URL`、`HEAPSCOPE_AI_API_KEY`、`HEAPSCOPE_AI_MODEL`、`HEAPSCOPE_AI_TIMEOUT_MS`、`HEAPSCOPE_AI_TOTAL_TIMEOUT_MS`、`HEAPSCOPE_AI_CONFIG`（配置文件路径）。被环境变量覆盖的字段在配置页有标注，保存文件不会覆盖它。

> **超时语义**：两项计时都只覆盖「发请求 → 收完模型响应」这一段，**不包含本机解析快照 / 读项目源码的深度证据采集时间**。只要模型持续输出，空闲超时就不断重置；只有连接卡住、迟迟不给首字节、或中途连续静默超过 `timeoutMs` 才会中断，报错文案会明确写「连续 Ns 没有返回数据」。若确实要限制整次分析的最长耗时，用 `totalTimeoutMs`（配置页「总时长上限（分钟）」，0 不限）。服务端每 15s 发一个 SSE 心跳事件，界面显示「分析进行中，已等待 Ns」，同时避免代理把静默中的连接判死。

```bash
# 查看当前配置（脱敏）
node bin/heapscope.js ai-config

# 写入配置并测试
node bin/heapscope.js ai-config --base-url https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat
node bin/heapscope.js ai-test

# 对已有报告跑 AI 分析（--out 指向报告根目录，保留快照时自动走深度分析）
node bin/heapscope.js ai-analyze analysis-202611051726 --out out \
  --project /path/to/MallApp --note "重点看 StoreDetail 的订阅"

# 调整深度分析预算 / 单次关闭
node bin/heapscope.js ai-config --deep-snapshots 3 --deep-candidates 10 --deep-chars 24000
node bin/heapscope.js ai-analyze analysis-202611051726 --out out --no-deep

# 多模型：ai-config 查看时会列出 models 数组与 defaultModel（密钥脱敏）
#   上传/录入模型在 Web「AI 配置」页点「+ 添加模型」，或 PUT /api/ai/config 传 models 数组
node bin/heapscope.js ai-test --model "备选"
node bin/heapscope.js ai-analyze analysis-202611051726 --out out --model "备选"
```

### 深度分析（保留快照文件后自动生效）

触发条件：`analysis.json` 所在目录存在 `.heapsnapshot`，且 `deepAnalysis=true`。Web 详情页的「结合保留快照与项目源码」开关会随报告自动勾选，也可单次取消；`GET /api/ai/reports/:name/context` 可先预览可用证据。

本机解析（**不上传原始文件**）产出三类证据，压缩后作为独立章节追加到 prompt：

| 证据 | 内容 |
|---|---|
| 快照逐轮结构 | 每份快照的 nodes / edges / shallow bytes、相对首轮新增且仍存活的节点数、self size 最大的构造器分组、末轮新增对象分组、报告候选在各轮的精确数量与字节 |
| 候选精确持有链 | 从末轮原始快照按报告候选编号重新定位代表节点，取 GC root 最短强引用链（含属性名、是否为首轮之后新增、持有者数量），与报告里的启发式 `retainerText` 互相印证 |
| 项目源码上下文 | 按候选 `sourceDetail` / `allocDetail` / `sourceChain` / 采样热点的文件行号，读取项目内对应片段（带行号），外加 `package.json` 的 RN/React 版本与相关依赖名 |

安全与边界：

- 项目根来自 `serve --project`（或报告 `meta.project`），**不从浏览器请求体任意指定**；所有读取路径都做 realpath 校验，必须落在项目根内，符号链接逃逸会被拒绝。
- 只读取代码类文件，`.env` / 密钥 / 证书类文件名直接跳过；片段里的 `apiKey = "..."`、`sk-...`、PEM 私钥块会脱敏；单文件 256KB 上限、总字符受 `deepMaxChars` 约束。
- sourcemap 里的绝对路径只按**路径后缀**在项目内匹配；prompt 中的项目名用目录名，不暴露本机绝对路径。
- 源码来自当前工作区，可能已与采集时 bundle 不一致；`sourceCheck.clean=false` 会作为警告送给模型。快照文件本身仍是原始二进制，从不进入 HTTP 请求。
- 模型输出统一按 Markdown 转义后渲染，不执行其中任何 HTML/JS。AI 结论是启发式推断，不是泄漏证明，仍需结合 `.heapsnapshot` 的 Retainers 与业务源码复核。

### 使用流程

1. 采集时勾选「保留快照文件」→ 报告详情页「AI 分析」面板勾选「结合保留快照与项目源码」→ 填补充关注点 → 点「生成 AI 分析」。
2. 服务端读取 `analysis.json` 压缩成结构化摘要；深度模式下先在本机逐份解析快照、读取项目源码（SSE 上报 `stage` / `context` 阶段事件），再一起交给模型，结论经 SSE 边生成边显示。
3. 完成后写入报告目录 `ai-analysis.json`（含 Markdown、渲染 HTML、模型、usage、输入字符数、`deep` 元数据）；报告卡片显示「✦ AI 深度分析」，单文件 `report.html` 顶部内嵌同一份结论并标注深度证据，离线打开也能看。
4. 可「重新生成」「清除」「复制 Markdown」；同一报告同时只允许一个 AI 任务（重复请求返回 409）。

**未启用深度分析时送出去的只有报告摘要**：不含 `.heapsnapshot`、不含 API Key、不读项目源码；启用后也只把上面三类压缩证据文本送出。

| 常见报错 | 处理 |
|---|---|
| `AI 尚未配置完成` | 补 Base URL / 模型 / API Key 并保存 |
| `API Key 无效（HTTP 401）` | 检查密钥与服务商；配置页「测试连接」可快速验证 |
| `接口或模型不存在（HTTP 404）` | Base URL 通常需以 `/v1` 结尾；核对模型名 |
| `AI 流式响应中断 / 未返回任何文本` | 关掉「流式输出」重试；或换支持 `stream` 的模型 |
| `连续 Ns 没有返回数据（空闲超时）` | 模型/网络静默超过「空闲超时（秒）」；提高该值、检查服务端是否在正常吐字，或减少候选条数与 `max tokens` |
| `AI 分析总时长超过 ... 已停止` | 单次请求达到「总时长上限（分钟）」；调大或设为 `0` 不限 |
| 分析总时长超过设定值但仍在输出 | **正常**：空闲超时不是总时长上限，只要持续有数据就不会中断 |

## 泄漏判定规则

`markFocus` 对每个候选打分（阈值写在 `src/snapshot.js`，改写需重跑回归）：

| 级别 | 条件 | 含义 |
|---|---|---|
| **重点关注 high** | 有真实分配点 + Δ ≥ **64KB** + 逐轮线性（每轮递增、`d2/d1 ≥ 0.7`、全程相对增长 ≥ 2%），或 Δ ≥ 64KB 且**全局持有** | 最像真泄漏，优先查 |
| **观察 watch** | Δ ≥ 64KB 但末轮趋平（`d2/d1 ≤ 0.35`）/ 只有 2 份快照无法判单调 / 趋势放缓；或线性但只有 16~64KB | 需多跑几轮确认 |
| **忽略 low** | 引擎内部对象（HiddenClass、CodeBlock、chunk）、无源码位置、dev 专属开销（release 不存在）、字符串/数字、Δ < 16KB | 不是业务泄漏 |

排除项永远不进 high：`string`/`number` 没有可靠分配点，`HiddenClass` 等是引擎自身增长，dev-only 文件在 release 包里根本不存在。

> 这些标记是**启发式线索**，不是泄漏证明。真正确认要结合 GC 状态、持有链是否合理、以及 release 包的生产监控。

## HTTP API

Web 界面全部走这些接口，也可直接脚本化（端口以实际为准）：

| 方法与路径 | 说明 |
|---|---|
| `GET /api/env` | 版本、输出目录、Metro、项目路径、Node 堆上限、当前任务、AI 就绪状态 |
| `GET /api/targets?metro=` | 列出可调试目标；Metro 不通时返回 `hints` |
| `POST /api/jobs` | 创建任务，body 同采集参数（`target/steps/mode/interval/top/algorithm/keepSnapshots/name/project/metro`） |
| `GET /api/jobs` | 任务列表（内存态，重启清空） |
| `GET /api/jobs/:id` | 单个任务状态与日志 |
| `GET /api/jobs/:id/events` | SSE 实时事件流（`job` / `log` / `end`） |
| `POST /api/jobs/:id/action` | `{"action":"next"}` 拍下一张；`{"action":"quit"}` 结束并出报告 |
| `POST /api/jobs/:id/cancel` | 取消任务（分析阶段不可取消） |
| `GET /api/reports` | 报告列表 + `orphans`（没有 analysis.json 的残留目录） |
| `GET /api/reports/:name?top=20` | 报告 JSON 详情 |
| `DELETE /api/reports/:name` | **删除整条记录目录**（含快照/sourcemap/采样），返回 `{freedBytes, files}` |
| `GET /reports/:name/report.html` | 报告 HTML；文件不存在时从 `analysis.json` 实时渲染 |
| `GET /reports/:name/<file>` | 报告目录内的资产（保留快照时可下载） |
| `GET /api/ai/config` | 脱敏 AI 配置 + 服务商预设 + 环境变量覆盖标记 + 深度分析参数 |
| `PUT /api/ai/config` | 保存配置；`apiKey` 为掩码/空表示保留原值，`clearApiKey:true` 删除密钥 |
| `POST /api/ai/test` | 连通性探测（可用未保存的表单配置），返回模型与延迟 |
| `GET /api/ai/reports/:name/context` | 预览深度证据：保留快照数/体积、项目路径、源码位置数、是否启用、警告、预算参数 |
| `POST /api/ai/reports/:name/analyze` | SSE 流：`start` / `stage` / `context` / `delta` / `done` / `error`；body 支持 `note`、`deep`（单次开关）与 `model`（指定多模型中的某档 `name`，省略则走默认模型），`done.result` 含结论全文与 `deep` 元数据 |
| `GET /api/ai/reports/:name/result` | 已保存的 AI 结论（含转义后的 HTML） |
| `DELETE /api/ai/reports/:name/result` | 清除该报告的 AI 结论 |

服务会拒绝跨来源浏览器请求（`Origin` 不匹配返回 403），但这不替代认证。

## 采集流程与操作方式

```
t=0  连接（~1s）→ S0 基线快照（自动，~10-15s，App 冻结属正常）
      ↓ 提示「第 1 轮」—— 你在 App 里复现一次 进入→使用→退出（15~60s）
      按回车 / 点「拍下一张快照」→ S1
      ↓ 第 2 轮：同样的路径再来一次
      S2 ……（--steps 决定轮数）→ 符号化出报告（20~60s）
```

- **快照是瞬时的**：`takeHeapSnapshot` 会把 JS 线程冻住 10~15s 做全堆遍历，这段窗口内 App 无响应是正常的，**不要操作手机**；想要「持续性」观测只能用采样模式（`startSampling`，概率抽样、低开销，但没有逐分配栈）
- 两轮必须走**同一条路径**（同样滚动距离、停留时间），否则差分被缓存/图片等噪声干扰
- 看到 `streaming ... chunks` 时 App 正在冻结遍历堆
- 全程不要锁屏、不要把 App 切后台，否则 inspector 断连（会自动降级或快速失败）
- 提前结束：CLI 输入 `q` 回车；Web 点「结束并出报告」（快照进行中会排队生效）

## 两种分析算法

| | **devtools**（默认） | **heapscope** |
|---|---|---|
| 分组 | 构造器（类型+名称），同 Chrome DevTools Summary | 构造器（类型+名称），附分配点信息 |
| 对比 | 首末两份快照 pairwise，#New/#Deleted/Size Δ | 多轮趋势（评分考虑所有轮次） |
| 排序 | 裸字节增量（size Δ） | 单调增长 ×2.2 + 新增 ×1.35 + 全局持有者 ×1.4 |
| 逐轮趋势 | 提供（仅展示，不参与排序） | 提供（参与打分） |
| 适用 | 与 DevTools 对照、单基线+单复现快速对比 | 多轮复现后的精排，过滤缓存预热噪声 |

## 产物

```
out/analysis-YYYYMMDDHHmm/          # 一次采集 = 一个目录（报告名留空时自动生成）
├── analysis.json    # 唯一持久产物：meta / totals / candidates / sourceChain / trend / focus
├── report.html      # 可选（writeHtml）；缺失时由 analysis.json 实时渲染
├── ai-analysis.json # 可选：AI 结论（Markdown + 模型 + usage + deep 元数据），会内嵌进 report.html
├── snap-YYYYMMDDHHmmss.heapsnapshot   # --keep-snaps 时保留；AI 深度分析的本机输入（不上传）
├── sampling-YYYYMMDDHHmmss.json       # 采样降级时产生（同上）
└── sourcemap.json   # dev source map 副本（同上，~54MB）

out/ai-config.json   # 全局 AI 配置（不在报告目录内，删除报告不会清掉密钥）
```

- 目录名 `analysis-年月日时分`（如 `analysis-202611051628`）；同名目录已存在时拒绝启动（409），不覆盖旧记录
- 快照名 `snap-年月日时分秒`（如 `snap-20261105162830.heapsnapshot`）；同一秒内连拍时追加 `-2`、`-3` 保唯一
- 分析成功后默认删除快照/采样/sourcemap 并在日志里报释放量；失败时**全部保留**，可用 `analyze` 离线重跑
- `report.html` 是零依赖单文件，可离线双击打开；服务端渲染版本会把「源码位置 + 持有链」展开成两栏

## 工作原理（要点）

- **Metro 只是通道**：`/json/list` 发现目标、`/inspector/debug?device&page` 连调试器；真正抓堆的是 Hermes 的 CDP `HeapProfiler` 域
- **RN 0.81 dev-middleware 校验 Origin 头**，内置 WebSocket 客户端带 Origin 握手
- `HeapProfiler.enable` 在部分 RN 0.81.x 返回 -32601，但 `takeHeapSnapshot`/`startSampling` 可用——自动忽略
- Hermes 仅约 17% 的节点带 debug location，通过「分配点 + 持有链 1~2 跳 + retainer 链」多路采集，符号化覆盖率可达 90%+
- 快照格式即 V8 `.heapsnapshot`；`watchman` 用于检测采集期间源码树指纹变化，指纹一致不能保证 `/index.map` 与 bundle 匹配
- 差分只做「同构对象组」聚合，不做对象级追踪；组内个体增删会被抵消

## 项目结构

```
bin/heapscope.js      CLI 入口（devices/capture/analyze/serve/probe/selftest）
src/lib.js            CDP 客户端 + MiniWebSocket + 目标发现 + 能力探测
src/capture.js        快照流式采集、sampling、GC、探针
src/snapshot.js       解析/分组/差分（devtools & heapscope）/retainer path/markFocus
src/sourcemap.js      VLQ 流式解码、SourceMap
src/symbolicate.js    /symbolicate → /index.map 回退、业务/依赖判定
src/pipeline.js       连接 + 分析管线（CLI 与 Web 共用）
src/job.js            采集编排（gate 钩子解耦「按回车」与「等 HTTP」）
src/config.js         参数校验
src/service/server.js HTTP + SSE 服务、静态前端
src/service/store.js  任务表与报告索引、旧报告 focus 补算、AI 结论读写
src/report.js         单文件 HTML 报告渲染（内嵌 AI 结论）
src/ai.js             AI 配置存储/脱敏、prompt 组装（含深度证据章节）、OpenAI 兼容流式客户端
src/deep-evidence.js  本机快照挖掘 + 项目源码片段读取 + 路径限制/脱敏/字符预算
src/markdown.js       零依赖 Markdown → 转义 HTML
public/               Web 前端（无构建单页应用，含 AI 配置页、深度参数与详情面板）
test/                 integration（15 用例）/ ai（19 用例）/ ai-models（12 用例）/ deep（33 用例）/ ai-timeout / mock-metro / regression
```

## 测试

```bash
npm test                           # selftest 13 + integration 15 + regression + ai 19 + ai-models 12 + deep 33 + ai-timeout 8，全绿
node test/ai.js                    # 单跑 AI：配置脱敏、连接测试、SSE 分析、落盘、报告注入、并发/错误处理
node test/ai-models.js             # 单跑多模型：models 数组、按模型保存密钥、selectModel 挑选、按次分析使用指定模型
node test/deep.js                  # 单跑深度证据：快照挖掘、跨机器路径回退、逃逸防护、密钥脱敏、预算裁剪、SSE 阶段、降级
node test/ai-timeout.js            # 单跑超时：慢速流不中断、静默仍超时、总时长兜底、客户端取消、心跳
```

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 用 `file://` 打开页面一片空白 | 前端请求被跨域拦截 | 用 `serve` 启动后访问 `http://127.0.0.1:<port>` |
| 点「拍下一张快照」报 `409 当前任务不在等待状态` | 任务已失败/已完成，或正处于快照/采样中 | 看日志里的失败原因（多为 inspector 超时），重新发起任务 |
| 提示 `inspector 通道健康检查失败：Runtime.evaluate timeout` | App 被切后台/锁屏，或设备与 Metro 断开 | 唤醒 App，`curl 127.0.0.1:8081/json/list` 确认目标还在 |
| 端口被占用 / 想重启服务 | 旧进程还在监听 | `lsof -nP -iTCP:<port> -sTCP:LISTEN` 取 PID → `kill -TERM <pid>` → 重新 `serve`；任务列表是内存态，重启后清空，报告不受影响 |
| 快照文件找不到 | 分析成功后已自动清理 | 采集时加 `--keep-snaps` 或勾选「保留快照文件」 |
| 只定位到 FlashList/ScrollView 这类组件 | 引擎对象无分配点，只能给持有链上最近的业务位置 | 看「关联位置（非分配点）」与文件链路，结合源码判断 |
| Metro 上只看到部分设备 | Metro 只注册已连上过的 App | 重新打开 App，或 `adb reverse tcp:8081 tcp:8081`（iOS 需同一 WiFi） |
| 报 `target not found: <设备哈希>-1` | 采集断连时 Metro 会把设备从 `/json/list` 摘除，App 重连后 target id 也可能变化 | 重连会按 title/deviceName 重新解析并持续重试；仍失败就回上一步刷新设备列表后重跑 |
| 删除记录后磁盘仍占空间 / 找不到失败任务的目录 | 失败或取消的采集只有快照、没有 analysis.json，不进报告列表 | 报告页下方会列出「残留目录」，可单个或一键删除；`DELETE /api/reports/<目录名>` 会整目录移除并返回释放量 |
| 报告里全是 HiddenClass / (system) | 页面本身没泄漏，增长来自引擎/预热 | 看顶部「重点关注」是否为空，空即无 high 候选 |
| 点「生成 AI 分析」提示未配置 / 401 / 404 | 配置缺项、密钥无效或 Base URL 少了 `/v1` | 见「AI 分析 → 常见报错」，配置页可先「测试连接」 |
| AI 结论里的 `<script>` 会不会执行 | 不会 | 模型输出统一按 Markdown 转义后渲染，落盘 HTML 字段也会被重新生成 |
| 「结合保留快照与项目源码」是灰的 | 该报告采集时没勾「保留快照文件」，或 `deepAnalysis` 被关掉 | 重新采集并勾选保留快照；或在 AI 配置页打开深度分析。预览接口 `/api/ai/reports/<名>/context` 会给出具体原因 |
| 深度分析卡在「解析快照 1/3」很久 | 单份快照 100MB+，JSON 解析需要数秒到数十秒 | 调小 `deepMaxSnapshots` / 提高 `deepMaxSnapshotMB` 上限跳过超大快照；SSE `stage` 事件会逐份上报进度 |
| 深度证据里源码位置缺失 | sourcemap 路径与当前项目结构不一致，或来自依赖/bundle | 检查 `serve --project` 是否指向正确的 RN 项目根；警告里会统计未定位的位置数 |

## 已知边界

- 只分析 **JS 堆**（Hermes/V8），原生内存（图片解码、native view、Bitmap）不在范围内
- release 包无 inspector，无法采集；结论最终应以 release 复测为准
- 采样模式（降级后）是概率抽样，不是逐分配栈的 Allocation instrumentation
- 大快照断连风险来自设备→Metro inspector 通道，非协议限制：Android 真机走 `adb reverse tcp:8081`（USB 转发隧道）时，持续大流量下设备侧写失败会关闭 socket，Metro 转述为 `1000 [CONNECTION_LOST]`，实测约 64MB / 5s 处确定性截断并自动降级 sampling；同网段改用局域网直连 Metro（Dev Menu → Settings → Debug server host & port for device 填 Mac IP）可绕开该转发层。iOS 真机走标准 TCP 直连已实测 246MB 完整传输。遇到断连先确认 App 未被切后台
- 通道断开瞬间设备会短暂从 Metro `/json/list` 消失，断连后立刻重连可能拿到空列表；工具按设备身份持续重试（约 30s 窗口）
- 差分基于对象组（构造器分组），无法区分同一构造函数下「该留」与「该扔」的实例
- 深度分析会在本机重新 `JSON.parse` 快照：实测 2 份 130–156MB 快照约 4s、进程峰值 RSS 约 1.9GB。快照特别多或特别大时建议 `NODE_OPTIONS=--max-old-space-size=8192` 启动 `serve`，并调小 `deepMaxSnapshots` / 用 `deepMaxSnapshotMB` 跳过超大文件

### 安全与结果可信度

Web 服务默认仅监听本机，**不提供身份认证**；使用 `--host 0.0.0.0` 会将报告、源码片段及删除操作暴露给可访问该端口的客户端，仅应在可信网络使用。浏览器跨来源请求会被拒绝，但不能替代认证。相同报告名不会覆盖。

快照采集分片直接写入临时文件并验证后发布；JSON 校验和分析仍需大量内存。源码指纹仅用于检测部分文件变化，无法证明 bundle 与 source map 一定匹配。启用采样或断线降级后需在采样开始后重新复现场景；采样热点不是快照存活对象差分。

## 关联源码位置与面包屑

候选详情中的“关联源码证据”会列出快照对象自身、属性值或附近持有者能解析到的源码位置，并展示文件路径、已知函数名和行号；仅在列号基准可确认时展示列号。可用时显示采集时保存的源码行或上下文，绝对路径可尝试通过 VS Code 打开（浏览器所在机器需有相同路径和版本的源码）。

**这些是独立关联线索，不是调用栈，不一定是对象分配点或泄漏根因。** GC Root 持有链单独展示；堆快照和 source map 本身不能凭空还原缺失的业务调用轨迹。报告页对历史报告只使用已保存的位置和源码，不读取当前项目文件填充旧报告；如果缺少上下文，需要使用同版本的快照和 source map 重新分析。**AI 深度分析是唯一例外**：仅在用户启用且报告保留了快照时，它才会读取当前项目源码片段，并在 prompt 中明确标注源码可能已与采集时不一致。通过 Web 服务查看带 `analysis.json` 的旧报告时会实时重新渲染，不会改写磁盘上已有的离线 HTML。
