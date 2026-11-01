import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolCallBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopResult, LoopTool } from './types.ts'

function textBlock(text: string) {
  return { type: 'text' as const, text }
}

// rc.5：tool 結果不再是塞在 user 消息裡的 `tool-result` 內容塊
// （`ContentBlockMap` 已經沒有這個 type），而是**一等的 `role:'tool'` 消息**，
// 由官方 `createToolResultMessage` 產生，並帶 `source: {kind:'tool', callId}`。
// 手搓的消息體在 rc.5 上既通不過型別，也沒有對應的 block 型別。
function toolResultMessage(callId: ToolCallId, text: string, isError: boolean): Message {
  return createToolResultMessage({ callId, content: [textBlock(text)], isError })
}

function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringifyResult(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * Run the busy loop: generate → assemble (official BlockAssembler) → execute
 * tool calls → feed results back → repeat until the model stops calling tools
 * or `maxTurns` is reached. LLM access goes exclusively through the host
 * `ctx.llm` channel; tools are injected by the caller.
 */
export async function runBusyLoop(llm: HostLlm, opts: BusyLoopOptions): Promise<LoopResult> {
  const maxTurns = opts.maxTurns ?? 8
  const toolMap = new Map<string, LoopTool>((opts.tools ?? []).map((t) => [t.name, t]))

  const messages: Message[] = [
    // rc.5：每條消息都有穩定身分與生產者來源（`id` + `source`），
    // 由官方工廠產生，不要自己拼物件——拼出來的缺欄位，型別過不了，執行期也對不上。
    createUserMessage({ content: [textBlock(opts.prompt)], source: { kind: 'user' } }),
  ]

  let turns = 0
  let toolCalls = 0
  let usage: LoopResult['usage']
  let finish = 'stop'

  for (let i = 0; i < maxTurns; i++) {
    turns = i + 1
    // Per-call throttle knob (0.1.26): wait before EVERY generation so the
    // caller can pace requests on the spot — one router key may back models
    // with different rate limits, so this is a parameter, never a constant.
    await sleep(opts.delayMs ?? 0)
    const gen: GenerateOptions = {
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages,
      tools: (opts.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      reasoningEffort: opts.reasoningEffort as GenerateOptions['reasoningEffort'],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      sessionId: opts.sessionId as GenerateOptions['sessionId'],
    }

    const asm = new BlockAssembler()
    for await (const chunk of llm.stream(gen)) asm.push(chunk)
    // rc.5：message() 需要生產者資訊（provider/model），因為 assistant 消息現在
    // 必須自己帶 `source: {kind:'model', provider, model}`。少了它，這條消息在
    // 後續請求裡無法被歸因，型別也不允許。
    const msg = asm.message({ provider: opts.provider, model: opts.model })
    usage = asm.usage
    finish = asm.finish?.kind ?? 'stop'
    messages.push(msg)

    const calls = msg.content.filter((b) => b.type === 'tool-call') as ToolCallBlock[]
    if (calls.length === 0) break

    for (const call of calls) {
      const tool = toolMap.get(call.name)
      let text: string
      let isError = false
      if (!tool) {
        text = `unknown tool: ${call.name}`
        isError = true
      } else {
        try {
          let args: unknown = {}
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {}
          } catch {
            /* malformed arguments: pass through as-is */
          }
          const result = await tool.execute(args, opts.signal)
          toolCalls++
          text = stringifyResult(result)
        } catch (err) {
          text = `tool error: ${err instanceof Error ? err.message : String(err)}`
          isError = true
        }
      }
      messages.push(toolResultMessage(call.id, text, isError))
      opts.onEvent?.({ type: 'tool', name: call.name, ok: !isError })
    }
    opts.onEvent?.({ type: 'turn', turn: turns + 1, toolCalls: calls.length })
  }

  const last = messages.at(-1)
  const output =
    last?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('') ?? ''

  opts.onEvent?.({ type: 'done', turns })
  return { output, turns, toolCalls, usage, finish }
}
