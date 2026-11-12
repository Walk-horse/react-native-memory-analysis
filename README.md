# HeapScope

React Native JS 堆快照采集与内存泄漏分析工具。

## 仓库结构

全部源码位于 [`heapscope/`](heapscope/)（零依赖 Node CLI + Web 服务）。核心模块包括 `src/capture.js`（快照采集）、`src/snapshot.js`（差分与判定）、`src/symbolicate.js`（源码符号化）、`src/source-evidence.js` / `src/deep-evidence.js`（源码与快照证据）、`src/ai.js`（AI 分析）。完整文档见 [`heapscope/README.md`](heapscope/README.md)。

## 快速开始

要求：Node ≥ 22、RN dev build（release 包无 inspector）、Metro 监听 8081、手机与 Mac 网络可达（Android 需 `adb reverse tcp:8081 tcp:8081` 或局域网直连 Metro）。

```bash
cd heapscope
node bin/heapscope.js --help
npm test
node bin/heapscope.js serve \
  --port 7794 --metro http://127.0.0.1:8081 \
  --project <RN项目路径> --out out
# 浏览器打开 http://127.0.0.1:7794
```

全局安装（可选）：

```bash
cd heapscope
npm pack --pack-destination out
npm i -g out/heapscope-0.1.0.tgz
```

工具通过 Metro inspector（CDP）连 Hermes 采集多轮堆快照，自动差分、符号化到业务源码行，输出泄漏候选排名报告；**不修改被测 App 任何源码**。

报告支持可选 **AI 分析**：在 Web「AI 配置」页或 CLI `ai-config` 配置 OpenAI 兼容接口（可配多个模型，密钥只存本地、掩码展示），报告详情页可流式生成根因归纳与排查建议，结论落盘并内嵌单文件 `report.html`。

采集时勾选「保留快照文件」的报告会启用 **AI 深度分析**：在本机解析 `.heapsnapshot`（逐轮构造器、新增存活对象、候选精确 GC root 持有链）并读取项目源码片段，与报告摘要一起送给模型；原始快照与完整源码不上传，源码读取限制在项目根内且密钥脱敏。详见 [`heapscope/README.md`](heapscope/README.md#深度分析保留快照文件后自动生效)。

## 说明

- `heapscope/out/` 存放运行时产物（`.heapsnapshot`、`sourcemap.json`、`analysis.json`、`report.html`），单份快照 100MB+、含设备数据，已在 `.gitignore` 中排除，不纳入版本控制。
- Web 服务默认仅监听 `127.0.0.1` 且不提供身份认证；使用 `--host 0.0.0.0` 前请确认处于可信网络。
- 分析 3 份 180MB 快照需要大内存，建议以 `NODE_OPTIONS=--max-old-space-size=8192` 启动。
- Android 真机经 `adb reverse` USB 隧道上传大快照时，可能在数十 MB 处因设备侧写失败断连并自动降级为采样；改用与 Metro 同网段的局域网直连可绕开该转发层，详见完整文档「已知边界」。
