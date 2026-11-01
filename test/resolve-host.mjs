// 把裸说明符 `@deepseek-ai/*` 解析到**宿主实际安装的那一份**。
//
// 为什么不用替身：`dsh-plugin-guide` 用的是一个恒等替换（`defineTool = spec => spec`），
// 那对「只取一个薄工厂」的插件够用，但它同时意味着**测试跑的不是真 API**。
// 这里直接用宿主自己那份：插件 dist 里 `import { defineTool } from '@deepseek-ai/dsh-tools'`
// 在宿主里解析到的就是它，测试也就应该解析到同一个东西。
//
// 为什么需要它：插件的 package.json 已经把 @deepseek-ai/* 声明成 peer（运行期由宿主提供），
// 所以本地 node_modules 里**不该**有副本。但 `node --test` 直接 import `src/index.ts` 时，
// Node 从插件目录往上找不到宿主的那份 → ERR_MODULE_NOT_FOUND。这一层只补解析，不改行为。
//
// 找不到宿主时**明确報錯並退出**，不要静默兜底：静默兜底的代价是「测试全绿但跑的不是真包」。
import { existsSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 候选宿主根目录，按可信度排序；第一个存在的就是它。 */
function hostRoot() {
  const fromEnv = process.env.DSH_HOST_PKG_ROOT
  if (fromEnv && existsSync(join(fromEnv, 'package.json'))) return fromEnv

  // 全局安装的 dsh：<prefix>/node_modules/@deepseek-ai/dsh
  const appData = process.env.APPDATA
  if (appData) {
    const p = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    if (existsSync(join(p, 'package.json'))) return p
  }

  // 从当前 node 可执行文件推 prefix（Linux/macOS 全局安装）
  const prefix = process.execPath.replace(/[\\/]bin[\\/]node$/, '').replace(/[\\/]node\.exe$/, '')
  for (const p of [join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), join(prefix, 'node_modules', '@deepseek-ai', 'dsh')]) {
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

const root = hostRoot()
if (!root) {
  console.error(
    '[resolve-host] cannot find the host install of @deepseek-ai/dsh.\n' +
      '  Set DSH_HOST_PKG_ROOT to the directory containing the dsh package.json,\n' +
      '  or install this plugin into a profile so the host supplies the peer dependencies.',
  )
  process.exit(1)
}

const hostRequire = createRequire(join(root, 'package.json'))

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      try {
        return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
      } catch {
        // 宿主没有这个包：让 Node 照常解析，不要静默兜住一个不存在的模块。
      }
    }
    return nextResolve(specifier, context)
  },
})
