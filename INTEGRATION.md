# 如何在你自己的 DSH 插件里使用本适配器

> 面向**消费者**（consumer）：你要写一个 DSH 插件，并且希望复用某个预置类别的 hooks / rules。
> 如果你要找的是"本插件怎么做适配"，看 [README.md](README.md)。

一句话：**声明依赖 → `inject` 它 → 在 `apply()` 里注册 → 读返回的分级结果**。

---

## 0. 三分钟上手

### 1) 确保它已安装到同一个 profile

```bash
dsh plugin --profile <你的profile> add github:denceee/dsh-compat-adapter
```

它是**基座插件**：只提供 `ctx.compatAdapter` 服务，自身不做任何适配。适配由你的声明触发。

### 2) 你的插件声明注入

```js
// my-preset/index.js
export const name = 'my-preset'

// 关键：inject 里写 'compatAdapter'，否则 Cordis 不会在挂载前等待该服务
export const inject = ['compatAdapter']

export function apply(ctx) {
  // 在这里注册
}
```

`inject` 缺失的后果很具体：Cordis 读取未声明注入的 `ctx.compatAdapter` 会**直接抛错**，不是返回 undefined。

### 3) 注册一个 hook

```js
export function apply(ctx) {
  void ctx.compatAdapter.registerHook({
    vendor: 'copilot',        // 显式声明，绝不从文件名推断
    event: 'preToolUse',      // 厂商事件名（大小写按厂商规范）
    matcher: 'bash|edit',     // 厂商 matcher 语义，原样交给对应 seam
    handler: 'node ./hooks/guard.cjs',   // 命令字符串 = command hook
  })
}
```

### 4) 注册规则

```js
void ctx.compatAdapter.registerRules({
  vendor: 'codex',
  source: 'rules/*.rules',
  baseDir: new URL('.', import.meta.url).pathname,   // 必须是绝对路径
})
```

---

## 1. 注册前先问自己：这个事件真的支持吗？

**永远先查矩阵**，不要凭 vendor 文档猜：

```js
const matrix = ctx.compatAdapter.matrix()
const vendor = matrix.find((v) => v.vendor === 'copilot')
console.log(vendor.hooks.map((h) => `${h.event} → ${h.capability} (${h.route})`))
```

当前版本：5 家 vendor、112 个事件、**0 个拒绝**；其中 102 个为真实/精确映射，**10 个在自己的 `degradations` 里明确写着 `Approximate`**。但"支持"分两种，必须区别对待：

| `route` | 含义 | 你该期待什么 |
| :--- | :--- | :--- |
| `official-bridge` | 交给 DSH 官方桥 | 行为最接近原厂商 |
| `native-translate` | 本插件翻译成真实拦截 | 决策真的生效，但有列明的损失 |
| `native-seam` | 只观察 | **不能阻断**，只能记录 |
| `builtin-bridge` | 本插件自建的桥（仅官方无桥时，如 copilot） | 决策真的生效；它**不是** DSH 官方桥，升级 DSH 时需重新验证 |

### 必读：`degradations`

```js
const result = await ctx.compatAdapter.registerHook({ ... })
if (result.capability === 'ADAPTED') {
  for (const loss of result.degradations) ctx.logger.warn(`已知损失: ${loss}`)
}
```

`ADAPTED` 一定带 `degradations`（构造时强制），这是本适配器唯一诚实的用法：**把损失转告给用户，而不是假装没有**。

---

## 2. 各 vendor 的事件名大小写不同

这是最容易踩的坑，事件名写错会抛 `UNKNOWN_EVENT`（带可选列表，不会静默）。

| Vendor | 风格 | 例子 |
| :--- | :--- | :--- |
| `claude` | PascalCase | `PreToolUse`、`SessionStart`、`Stop` |
| `codex` | PascalCase | `PreToolUse`、`SessionStart`、`Stop` |
| `workbuddy` | PascalCase（CC 兼容） | `PreToolUse`、`Stop` |
| `copilot` | **lowerCamelCase** | `preToolUse`、`agentStop`、`sessionStart` |
| `opencode` | 点号命名 | `tool.execute.before`、`shell.env` |

写错时抛出的错误会含该 vendor 的完整可选列表：

```js
try { await ctx.compatAdapter.registerHook({ vendor: 'copilot', event: 'PreToolUse', handler: 'x' }) }
catch (e) {
  // e.code === 'UNKNOWN_EVENT'
  // e.message 里列出 copilot 的 12 个已知事件名
}
```

---

## 3. handler 只有一种能跨边界

| 你写的 | 结果 | 原因 |
| :--- | :--- | :--- |
| `'node hook.cjs'` | ✅ 走通 | 命令 hook |
| `{ type: 'command', command: '...', timeoutSec: 30 }` | ✅ 走通 | 同上 |
| `() => ({ deny: true })` | ❌ `UNSUPPORTED` | 本适配器**不把外部代码执行进 DSH Host** |
| `{ type: 'prompt' \| 'http' \| 'mcp_tool' \| 'agent' }` | ❌ 抛 `INVALID_HANDLER` | 无 DSH 等价通道 |

**为什么拒绝 JS 函数**：声明式适配器只搬运"资产"，不执行"别家插件的运行时"。需要 JS 行为时写原生 DSH 插件，挂到同一个 seam。

---

## 4. 阻断必须用 stdout 契约

本适配器统一的阻断契约（跨所有 vendor 一致）：

```bash
#!/usr/bin/env bash
# 读到 stdin 的 payload 后决定
cat >/dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"不允许写入"}}'
exit 0
```

- **不要**依赖 exit code 2（本 DSH 版本上该行为不可靠）
- Copilot 原生写法是顶层 `permissionDecision`，本插件会自动识别两种形状
- `ask` 会被翻译成 DSH 的等待批准

---

## 5. 运行时可观测：`status()`

注册完不代表真的跑起来了（比如缺 `ctx.shell` 会被降级）。用 `status()` 自检：

```js
const s = ctx.compatAdapter.status()
if (!s.surface.shell) {
  ctx.logger.warn('本组合没有 ctx.shell，需要执行命令的 hook 会被拒绝')
}
ctx.logger.info(`可执行 ${s.counts.executableHooks} / 拒绝 ${s.counts.unsupportedHooks}`)
```

**建议**：在你的插件 `apply()` 末尾打一行汇总日志，用户排查时能直接看到。

---

## 6. 完整示例

```js
// my-preset/index.js
export const name = 'my-preset'
export const inject = ['compatAdapter']

const HOOKS = [
  { vendor: 'copilot', event: 'preToolUse', matcher: 'bash', handler: 'node ./hooks/no-rm.cjs' },
  { vendor: 'claude',  event: 'PreToolUse', matcher: 'Write', handler: 'node ./hooks/no-write-outside.cjs' },
  { vendor: 'codex',   event: 'Stop',       handler: 'node ./hooks/require-tests.cjs' },
]

export function apply(ctx) {
  for (const hook of HOOKS) {
    void ctx.compatAdapter
      .registerHook(hook)
      .then((result) => {
        if (result.capability === 'UNSUPPORTED') {
          ctx.logger.warn(`${hook.vendor} ${hook.event} 无法适配：${result.reason}`)
        }
      })
      .catch((error) => {
        ctx.logger.error(`声明有误（${hook.vendor} ${hook.event}）：${error.message}`)
      })
  }

  void ctx.compatAdapter
    .registerRules({
      vendor: 'claude',
      source: ['CLAUDE.md', '.claude/rules/*.md'],
      baseDir: new URL('.', import.meta.url).pathname,
    })
    .then((result) => {
      ctx.logger.info(`携带 ${result.id}：${result.capability}`)
    })
}
```

---

## 7. 排查清单

| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| `cannot get property "compatAdapter" without inject` | 漏了 `inject` | 加上 `export const inject = ['compatAdapter']` |
| `UNKNOWN_VENDOR` | vendor 名拼错 | 用 `claude`/`codex`/`workbuddy`/`opencode`/`copilot` |
| `UNKNOWN_EVENT` | 大小写或名字错 | 读错误信息里的可选列表 |
| hook 注册为 `UNSUPPORTED` 且 reason 提到 `ctx.shell` | 组合里没有 shell 执行器 | 挂 `dsh-bash-local` 或 `dsh-bash-sandbox` |
| 注册成功但 hook 不触发 | 沙箱后端不可用 / matcher 不匹配 | 查 `status()`、先去掉 matcher 试 |
| `ADAPTER_DISPOSED` | 在 setup 之外注册 | 注册必须在 `apply()` 内，或插件重挂后 |

---

## 8. 类型支持

本包附带 `index.d.ts`。安装后直接获得补全与类型检查：

```ts
import type { HookDeclaration, CapabilityResult } from 'dsh-compat-adapter'

const hook: HookDeclaration = { vendor: 'copilot', event: 'preToolUse', handler: 'node a.cjs' }
```

`ctx.compatAdapter` 的声明通过 `declare module '@deepseek-ai/cordis'` 合并，所以你在 TS 里访问 `ctx.compatAdapter` 会有完整提示。
