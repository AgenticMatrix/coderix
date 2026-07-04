# Plan Mode Upgrade Plan

## Context

Coderix 的 plan mode 目前只有骨架：EnterPlanMode 切换 mode 标记 + 一次性 system prompt 注入，ExitPlanMode 写文件后直接切回 auto。缺少 claude-code-coderix 中的分阶段工作流引擎、Attachment 动态注入、Plan 文件管理等核心能力。

**保留项**：PermissionEngine 在 PLAN mode 下对 MUTATION/DESTRUCTIVE 的硬阻断保持不变（这是 Coderix 比 claude-code-coderix 更安全的设计）。

---

## 架构概览

```
Turn N:  用户发任务 → 模型调用 EnterPlanMode → 用户批准
         → mode = 'plan', prePlanMode 保存
         → planFilePath 生成 (~/.coderix/plans/<word-slug>.md)

Turn N+1: query.ts 主循环 → injectPlanModeAttachment()
         → system prompt 前注入完整五阶段工作流
         
Turn N+2~N+4: 模型执行 Phase 1~4
         → Explore Agent × N 并行搜索
         → Plan Agent × N 设计方案
         → 读写 plan file（唯一可写的文件）
         → AskUserQuestion 澄清疑问

Turn N+5: 模型调用 ExitPlanMode（无需传 plan 参数，从文件读）
         → 审批 UI 弹出（已有，需增强）
         → 用户可编辑计划 / 选择恢复模式 / 设置 allowedPrompts
         
Turn N+6: mode 恢复为 prePlanMode
         → 注入 plan_mode_exit 通知
         → 计划内容注入上下文，模型开始实现
```

---

## 实现步骤

### Phase 1: Plan Mode 状态管理

**文件：`packages/coderix-core/src/core/types.ts`**

扩展权限上下文，新增字段：

```typescript
// ToolPermissionContext 或独立的状态对象
interface PlanModeState {
  prePlanMode: PermissionMode    // 进入 plan 前的 mode，退出时恢复
  planFilePath: string           // 当前 plan 文件路径
  planFileSlug: string           // word-slug，用于跨 turn 保持文件名一致
  planModeTurnCount: number      // plan mode 内已执行的 turn 数（用于节流）
  hasExitedPlanMode: boolean     // 本次 session 是否已退出过 plan（用于 reentry）
}
```

**文件：`packages/coderix-core/src/core/query.ts`** (execOpts.setPermissionMode)

增强 `setPermissionMode` 回调，在切换到 `plan` 时生成 plan file path 并初始化状态。

### Phase 2: Plan 文件管理

**新文件：`packages/coderix-core/src/core/plan-files.ts`**

```typescript
// 生成 word-slug 文件名 (eg. "brave-tiger.md")
generatePlanSlug(): string

// 获取 plan 文件完整路径
getPlanFilePath(agentId?: string): string

// 读取 plan 文件内容
getPlan(agentId?: string): string | null

// 写入 plan 文件
writePlan(content: string, filePath: string): void

// session 恢复时找回 plan slug
recoverPlanSlug(sessionId: string): string | null
```

- 目录从 `~/.claude/plans/` 迁移到 `~/.coderix/plans/`
- 文件名使用 word-slug（从单词表随机抽取两个单词），避免 timestamp 的不可读性
- 子 Agent 的 plan 文件加后缀：`<slug>-agent-<agentId>.md`

### Phase 3: Plan Mode Attachment 注入系统

**新文件：`packages/coderix-core/src/core/plan-mode-attachment.ts`**

核心函数：

```typescript
// 在 query.ts 每轮 API 调用前调用
getPlanModeAttachmentContent(state: PlanModeState): string | null
```

**注入点：`packages/coderix-core/src/core/query.ts`** (line 441 systemText 赋值处)

在 `let systemText = systemPrompt.prompt` 之后，`PreMessage` hook 之前：

```typescript
let systemText = systemPrompt.prompt

// ── Plan mode attachment injection ──
const planAttachment = getPlanModeAttachmentContent(planModeState)
if (planAttachment) {
  systemText = planAttachment + '\n\n' + systemText
}
```

**节流策略：**
- 第 1 个 turn（刚进入 plan mode）：注入**完整五阶段工作流**指令
- 之后每 5 个 turn：再次注入完整工作流
- 其余 turn：注入一行 sparse 提醒（"Plan mode active. Read-only except plan file..."）
- 计数值存在 `planModeState.planModeTurnCount`，每次注入后 +1

**完整工作流指令内容（五阶段）：**

```
<system-reminder>
Plan mode is active. You MUST NOT make any edits (except the plan file), 
run non-readonly tools, or make any changes to the system.

## Plan File
Location: {planFilePath}
(If exists: "A plan file already exists. Read it first before making changes.")
(If not: "No plan file yet. Create your plan at this path.")

## Plan Workflow

### Phase 1: Initial Understanding
Launch up to 3 Explore agents IN PARALLEL to search the codebase.
- At least 1 Explore agent required
- Quality over quantity — 3 agents max

### Phase 2: Design  
Launch up to 3 Plan agents to design implementation approaches.
- Default: at least 1 Plan agent
- Multiple agents for complex tasks needing different perspectives

### Phase 3: Review
- Read critical files identified by agents
- Use AskUserQuestion to clarify ambiguities
- Ensure alignment with user intent

### Phase 4: Final Plan
Write your final plan to the plan file (the ONLY file you can edit).
- Context: why this change
- Files to modify with paths
- Existing code to reuse with file:line references
- Verification: how to test end-to-end
- Keep it scannable but detailed enough to execute

### Phase 5: Call ExitPlanMode
End your turn with EITHER AskUserQuestion OR ExitPlanMode.
Use ExitPlanMode to request plan approval — do NOT ask "is this plan ok?" in text.
</system-reminder>
```

**Sparse 提醒内容：**

```
<system-reminder>
Plan mode active (see earlier instructions). Read-only except plan file ({planFilePath}). 
Follow the 5-phase workflow. End turns with AskUserQuestion or ExitPlanMode.
</system-reminder>
```

### Phase 4: EnterPlanMode 增强

**文件：`packages/coderix-core/src/tools/enter-plan-mode/executor.ts`**

```typescript
export const execute: ToolExecutor = async (_input, options) => {
  // 1. 保存当前 mode 为 prePlanMode
  const currentMode = options.getPermissionMode?.() ?? 'auto'
  
  // 2. 生成 plan file path
  const slug = generatePlanSlug()
  const planFilePath = getPlanFilePath()
  
  // 3. 切换到 plan mode
  options.setPermissionMode('plan')
  
  // 4. 初始化 plan mode 状态
  options.setPlanModeState?.({
    prePlanMode: currentMode,
    planFilePath,
    planFileSlug: slug,
    turnCount: 0,
  })
  
  return {
    content: 'Entered plan mode. Workflow instructions follow in the next turn.',
    metadata: { planFilePath },
  }
}
```

**文件：`packages/coderix-core/src/tools/enter-plan-mode/schema.ts`**

更新 description，加入何时使用/何时不用的明确指引（从 claude-code-coderix 的 prompt.ts 提取）。

### Phase 5: ExitPlanMode 增强

**文件：`packages/coderix-core/src/tools/exit-plan-mode/schema.ts`**

- `plan` 参数从 `required` 改为 `optional`
- 如果模型不传 `plan`，executor 从 `getPlan(planFilePath)` 读取文件内容
- 新增 `allowedPrompts` 可选参数（审批后自动允许的 Bash 操作）

```typescript
input_schema: {
  type: 'object',
  properties: {
    allowedPrompts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ['Bash'] },
          prompt: { type: 'string', description: 'e.g. "run tests"' }
        }
      },
      description: 'Bash operations needed during implementation'
    }
  },
  // plan 不再是 required
}
```

**文件：`packages/coderix-core/src/tools/exit-plan-mode/executor.ts`**

```typescript
export const execute: ToolExecutor = async (input, options) => {
  // 1. 获取 plan 内容（参数优先，fallback 到文件）
  const plan = input.plan || getPlan(options.planModeState?.planFilePath)
  if (!plan) {
    return { content: 'No plan content found.', isError: true }
  }
  
  // 2. 写入 plan 文件（如果内容来自参数）
  const filePath = options.planModeState?.planFilePath || getPlanFilePath()
  writePlan(plan, filePath)
  
  // 3. 恢复 prePlanMode（不是硬编码 'auto'）
  const restoreMode = options.planModeState?.prePlanMode || 'auto'
  options.setPermissionMode(restoreMode)
  
  // 4. 设置 allowedPrompts（供后续 Bash 调用自动批准）
  if (input.allowedPrompts) {
    options.setAllowedPrompts?.(input.allowedPrompts)
  }
  
  // 5. 设置 hasExitedPlanMode 标记
  options.setPlanModeState?.({ hasExitedPlanMode: true })
  
  return {
    content: `Plan written to ${filePath}. Implementation can now begin.`,
    metadata: { planFile: filePath, plan, allowedPrompts: input.allowedPrompts },
  }
}
```

**文件：`packages/coderix-core/src/core/query.ts`**

审批流已存在（line 534-563），需增强：
- 展示 plan 内容时支持外部编辑器打开（Ctrl+G）
- 审批选项增加：批准并恢复模式 / 编辑后批准 / 拒绝并反馈
- 审批通过后将 plan 内容和 `allowedPrompts` 传递给后续实现阶段

### Phase 6: 退出 Plan Mode 的上下文注入

**文件：`packages/coderix-core/src/core/query.ts`**

ExitPlanMode 审批通过后，在下一个 turn 注入退出通知：

```typescript
// 在 system prompt 组装时检查 hasExitedPlanMode 标记
if (planModeState?.hasExitedPlanMode && permissionMode !== 'plan') {
  const exitNotice = `<system-reminder>
## Exited Plan Mode
You can now make edits, run tools, and take actions.
${planModeState.planFilePath ? `Plan file: ${planModeState.planFilePath}` : ''}
</system-reminder>`
  systemText = exitNotice + '\n\n' + systemText
  // 一次性通知，发完清除
  planModeState.needsExitAttachment = false
}
```

### Phase 7: Post-Compaction Plan Mode 恢复增强

**文件：`packages/coderix-core/src/core/query.ts`** (现有 `buildRestoreContext`, line 1371)

将现有的简单提醒：

```typescript
'[Reminder] You are still in plan mode. Explore and design — do not modify files...'
```

替换为包含 plan 文件路径和完整 sparse 指令的恢复消息，确保 compaction 后模型不会丢失 plan mode 上下文。

### Phase 8: System Prompt 调整

**文件：`packages/coderix-core/src/core/system-prompt.ts`** (`buildPermissionMode`, line 332)

将静态的 plan mode 描述精简为一行标识，详细的五阶段工作流交给 Attachment 系统动态注入：

```typescript
case 'plan':
  return {
    name: 'permission_mode',
    content: '# Permission Mode: Plan\n\nPlan mode is active — see workflow instructions for the full planning protocol.',
    priority: 40,
  }
```

---

## 文件变更汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/coderix-core/src/core/types.ts` | 修改 | 新增 `PlanModeState` 接口 |
| `packages/coderix-core/src/core/plan-files.ts` | **新建** | Plan 文件管理（slug 生成、读写、恢复） |
| `packages/coderix-core/src/core/plan-mode-attachment.ts` | **新建** | Plan mode 工作流指令生成与节流 |
| `packages/coderix-core/src/core/query.ts` | 修改 | Attachment 注入点、setPermissionMode 增强、恢复上下文增强 |
| `packages/coderix-core/src/core/system-prompt.ts` | 修改 | 精简 `buildPermissionMode('plan')` |
| `packages/coderix-core/src/tools/enter-plan-mode/executor.ts` | 修改 | prePlanMode 保存、plan 文件路径生成 |
| `packages/coderix-core/src/tools/enter-plan-mode/schema.ts` | 修改 | 增强 description（何时用/不用） |
| `packages/coderix-core/src/tools/exit-plan-mode/schema.ts` | 修改 | plan 参数改为 optional，新增 allowedPrompts |
| `packages/coderix-core/src/tools/exit-plan-mode/executor.ts` | 修改 | 文件读取 fallback、恢复 prePlanMode |
| `packages/coderix-core/src/core/permission.ts` | **不改** | PLAN mode 硬阻断逻辑保留 |

---

## 不做的事项

1. **不实现 `/plan` slash command** — 属于 CLI 层的增强，可在后续迭代加入
2. **不实现 Ultraplan（远程规划）** — Coderix 暂无 CCR 基础设施
3. **不实现 Interview Phase** — 先用五阶段工作流跑通，interview 模式作为后续迭代
4. **不改变 PermissionEngine 的硬阻断** — 维持 SAFE only 策略，比 claude-code-coderix 更安全

---

## Verification

1. 进入 plan mode 后，下一个 turn 的 system prompt 包含完整五阶段指令
2. 每 5 个 turn 重新注入完整指令，其余 turn 注入 sparse 提醒
3. Plan 文件生成在 `~/.coderix/plans/<word-slug>.md`
4. 模型在 plan mode 中调用 Write/Edit 被 PermissionEngine 硬拒绝
5. ExitPlanMode 从文件读取 plan 内容，无需模型传参
6. 退出后恢复 prePlanMode（不是固定的 auto）
7. Compaction 后 plan mode 上下文不丢失
8. 退出 plan mode 后的下一个 turn 收到退出通知
