import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopResult, LoopTool } from './types.ts'

function textBlock(text: string) {
  return { type: 'text' as const, text }
}

function toolResultMessage(toolCallId: string, text: string, isError: boolean): Message {
  return {
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId, content: [textBlock(text)], isError },
    ],
  } as Message
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
    { role: 'user', content: [textBlock(opts.prompt)] } as Message,
  ]

  let turns = 0
  let toolCalls = 0
  let usage: LoopResult['usage']
  let finish = 'stop'

  for (let i = 0; i < maxTurns; i++) {
    turns = i + 1
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
    const msg = asm.message()
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
