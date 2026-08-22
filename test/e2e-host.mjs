/**
 * 真机 E2E 冒烟(可选运行,需要真实 API key):
 *   在宿主解析链下模拟宿主环境(Context + LlmRuntime + 官方 DeepSeekAdapter),
 *   让 busyloop 通过真实 ctx.llm 通道调用真实模型。
 *
 * 运行方式(在安装了 dsh 宿主的机器上):
 *   node test/e2e-host.mjs
 *
 * 密钥来源:~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY(脚本内注入,不打印)。
 * 覆盖:纯对话 1 轮 + 多轮工具调用(get_weather),验证 usage/cacheReadTokens。
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { hostLlm, runBusyLoop } from '../dist/index.js'

const creds = yaml.load(
  readFileSync(process.env.USERPROFILE + '\\.dsh\\.credentials.yaml', 'utf8'),
)
const key = creds.refs?.DEEPSEEK_API_KEY?.value ?? creds.refs?.DEEPSEEK_API_KEY ?? creds.DEEPSEEK_API_KEY
if (!key) {
  console.error('NO KEY: ~/.dsh/.credentials.yaml missing DEEPSEEK_API_KEY')
  process.exit(1)
}
process.env.DEEPSEEK_API_KEY = key

const ctx = new Context()
const runtime = new LlmRuntime(ctx)
const adapter = new DeepSeekAdapter({
  options: () => ({
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaults: {},
    maxTokens: 2048,
    defaultContextWindow: 65536,
    models: [{ id: 'deepseek-chat' }],
    streamIdleTimeoutMs: 120000,
    maxRequestFilesBytes: 0,
    maxInlineRequestImageBytes: 0,
    maxImagesPerRequest: 0,
    imageOffloadByteQuantum: 1,
    inlineImageOffloadByteQuantum: 1,
    imageOffloadCountQuantum: 1,
    filesApiTimeoutMs: 10000,
  }),
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY,
  resolveUserId: () => 'dsh-busyloop-e2e',
})
ctx.llm.registerAdapter(['deepseek'], adapter)
const llm = hostLlm(ctx.llm)

// 1) plain chat
const chat = await runBusyLoop(llm, {
  provider: 'deepseek',
  model: 'deepseek-chat',
  prompt: 'Answer in one short sentence: what is 2+2?',
  maxTokens: 200,
})
console.log('CHAT:', JSON.stringify(chat))
if (!chat.output || chat.turns < 1) throw new Error('chat e2e failed')

// 2) multi-turn tool call
const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async (args) => ({ city: args.city, temp: 26, condition: 'sunny' }),
}
const tooled = await runBusyLoop(llm, {
  provider: 'deepseek',
  model: 'deepseek-chat',
  prompt: 'What is the weather in Tokyo? Use the get_weather tool, then answer with one sentence.',
  tools: [weatherTool],
  maxTokens: 500,
})
console.log('TOOL:', JSON.stringify(tooled))
if (tooled.toolCalls < 1 || tooled.turns < 2) throw new Error('tool e2e failed')

console.log('E2E OK')
