# dsh-busyloop

DSH agent-loop 引擎:宿主 LLM 通道(官方 `ctx.llm`)+ 轻量 loop 骨架 + 工具表注入。

> **能力等价,范式不同**:装上 busyloop,dsh 就有一样的 agent 循环能力(LLM 多轮 + 工具调度);
> 但不保证像 codex 一样工作(AGENTS.md/工具协议/会话格式) —— 那是 codexstyle 层的事。

## 架构(三件套)

```
dsh-busyloop ──────────── 引擎(能力:LLM 适配器 + loop + 宿主工具调度)
├── dsh-busyloop-codex ──── 范式①:桥接 codex CLI(外包)
└── dsh-busyloop-codexstyle ─ 范式②:自研 codex 风格(规划中)
```

## 设计原则

- **LLM 适配器不是手刻、不是外接**:直接消费宿主 `ctx.llm`(`@deepseek-ai/dsh-llm` 的 LlmRuntime),类型来自官方包,运行时由宿主提供
- **不造独立运行时**:全部活在 dsh 宿主内,发布物在"纯 dsh + 官方包"环境可跑(bundle 自包含)
- **工具表注入**:宿主 `ctx.tools` 只读不可枚举,loop 的工具由调用方提供(schema + execute)

## 用法

```ts
import { createBusyLoop, hostLlm } from '@snow-the/dsh-busyloop'

// 插件内:
const engine = createBusyLoop(ctx)           // ctx.llm 宿主服务
const result = await engine.run({
  provider: 'deepseek',
  model: 'deepseek-chat',
  prompt: '东京天气如何?用 get_weather 工具查询后一句话回答',
  tools: [weatherTool],
  onEvent: (ev) => console.log(ev),          // turn / tool / done
})
// { output, turns, toolCalls, usage, finish }
```

纯库方式:`hostLlm(ctx.llm)` → `runBusyLoop(llm, options)`。

## HTTP 端点(apply 挂载于 /api/busyloop)

| 端点 | 说明 |
|---|---|
| `/health` | 引擎存活 + hostLlm 状态 |
| `/providers` | 宿主已注册的 LLM provider 列表 |

## 测试金字塔(14 个测试)

1. **单元/集成**(`npm test`,node --test 串行):fake chunks(不碰真模型)——多轮循环、工具参数解析、结果回填、maxTurns 截断、未知/抛错工具、providers/health 端点、sessionId 透传
2. **宿主解析链验证**:dist 放入宿主 node_modules 树加载(官方包全部宿主解析)
3. **真机 E2E**(`node e2e/e2e-host.mjs`,手动运行,需要真 API key):真实 DeepSeekAdapter + 真实模型(纯对话 + 多轮工具调用,`cacheReadTokens` 命中验证)

## 发布

```bash
pnpm build        # tsc 类型 + esbuild bundle(官方包 external,宿主提供)
npm test          # node --test
npm publish       # GitHub Packages(@snow-the 下同款流程)
```
