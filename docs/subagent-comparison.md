# 子 Agent 系统对比分析

对比项目：**Coderix**（当前项目）、**claude-code-coderix**（Claude Code 反编译版本）、**claude-code-source**（Claude Code 源码参考）

---

## 一、项目关系

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 定位 | 自研 AI 编程助手 | Claude Code 反编译/逆向工程版本 | Claude Code 原始源码参考 |
| 语言 | TypeScript | TypeScript（保留原始结构） | TypeScript |
| 代码结构 | 自主设计的模块化架构 | 保留 Claude Code 原始目录结构 | 原始结构 |

---

## 二、Agent 类型定义

三者都使用 `AgentDefinition` 作为核心类型，但对比如下：

| 特性 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 定义来源 | `BuiltInAgentDefinition` / `CustomAgentDefinition` / `PluginAgentDefinition` | 同左，三个变体 | 同左，三个变体 |
| 优先级顺序 | `built-in < plugin < userSettings < projectSettings` | `built-in < plugin < userSettings < projectSettings < flagSettings < policySettings` | 同 claude-code-coderix |
| 配置字段 | `agentType`, `whenToUse`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `contextBudget`, `skills`, `initialPrompt`, `background`, `isolation`, `color`, `memory` | 基本一致，额外包含 `mcpServers`, `hooks`, `effort`, `omitClaudeMd` | 与 claude-code-coderix 一致 |
| 动态 System Prompt | `getSystemPrompt(params)` | 同左 | 同左 |

**关键差异**：
- Coderix 多了 `contextBudget` 字段显式控制上下文预算
- Coderix 缺少 `mcpServers`（Agent 级 MCP 服务器）、`hooks`（Agent 级钩子）、`effort`（努力级别）、`omitClaudeMd` 字段
- Coderix 的优先级层级更少（无 `flagSettings` 和 `policySettings`）

---

## 三、内置 Agent 类型

| Agent 类型 | Coderix | claude-code-coderix | claude-code-source |
|------------|:-------:|:-------------------:|:------------------:|
| `general-purpose` | ✅ 全工具，20轮 | ✅ 全工具 `['*']` | ✅ 全工具 `['*']` |
| `Explore/explore` | ✅ haiku，15轮，只读 | ✅ haiku，只读 | ✅ haiku（外部）/ inherit（内部），只读 |
| `Plan/plan` | ✅ haiku，20轮，只读 | ✅ inherit，只读 | ✅ inherit，只读 |
| `verification` | ✅ inherit，25轮，后台 | ✅ 特性门控 | ✅ 特性门控，始终后台 |
| `coderix-guide` / `claude-code-guide` | ✅ haiku，10轮 | ✅ haiku，非SDK入口 | ✅ haiku |
| `statusline-setup` | ✅ sonnet，8轮 | ✅ 存在 | ✅ 存在 |
| Fork Agent | ✅ 独立定义，20轮 | ✅ 合成定义 | ✅ 合成定义 |
| Coordinator Agents | ✅ 5个角色 | ❌ 仅 worker 模式 | ❌ 仅 worker |
| Worker | ❌ | ✅ 协调器模式专用 | ✅ 协调器模式专用 |

**关键差异**：
- Coderix 的 Coordinator 模式有 5 个专门角色（coordinator/researcher/implementer/reviewer/tester），claude-code-source 只有一个通用 `worker`
- Coderix 的 Explore/Plan 固定使用 haiku，claude-code-source 允许内部用户用 inherit
- claude-code-source 的 verification agent 始终后台运行，Coderix 可配置

---

## 四、Agent 生成（Spawn）机制

| 特性 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 入口工具名 | `Agent` | `Agent`（别名 `Task`） | `Agent`（别名 `Task`） |
| Fork 模式 | `agent_type` 省略时触发，继承父上下文 | `subagent_type` 省略时触发，共享 prompt cache | 同 claude-code-coderix |
| 命名 Agent | `agent_type` 指定 | `subagent_type` 指定 | `subagent_type` 指定 |
| 后台运行 | `background: true` | `run_in_background: true` | `run_in_background: true` |
| 隔离模式 | `isolation: 'worktree'` | `isolation: 'worktree' \| 'remote'` | `isolation: 'worktree' \| 'remote'` |
| 多 Agent/团队 | ❌ | ✅ `team_name` + `name` → `spawnTeammate()` | ✅ 同左（tmux/iTerm2/进程内） |
| 恢复/resume | `SendMessage` 工具 | `resumeAgent()` + `SendMessage` | `resumeAgent()` |

**关键差异**：
- Coderix 工具名已对齐为 `Agent`
- Coderix 无多 Agent 团队生成机制（`spawnTeammate`）
- Coderix 无远程隔离模式（`remote` / CCR）
- Coderix 无自动后台化机制（claude-code-source 有 120 秒超时自动转后台）
- Coderix 的 fork 模式不涉及 byte-identical prompt cache 共享优化

---

## 五、工具过滤机制

三者都使用多层过滤：

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 全局禁止 | `GLOBAL_DISALLOWED_FOR_SUBAGENTS`：Agent、SendMessage、TaskStop、TaskGet、TaskOutput、ask-user-question、exit/enter-plan-mode、cron-*、enter/exit-worktree、workflow | `ALL_AGENT_DISALLOWED_TOOLS`：Agent、TaskOutput、ExitPlanMode、EnterPlanMode、TaskStop、AskUserQuestion | 同 claude-code-coderix |
| 自定义 Agent 限制 | ❌ | ✅ `CUSTOM_AGENT_DISALLOWED_TOOLS` | ✅ |
| 异步 Agent 限制 | ❌ | ✅ `ASYNC_AGENT_ALLOWED_TOOLS` 白名单 | ✅ |
| 协调器限制 | ✅ `COORDINATOR_ALLOWED_TOOLS` | ✅ `COORDINATOR_MODE_ALLOWED_TOOLS` | ✅ |
| 权限模式 | `AUTO`（全部自动批准） | 继承父级，`bubble` 穿透 | 同左 |

**关键差异**：Coderix 只有全局禁止和 Agent 特定规则两层过滤，claude-code-source 有自定义 Agent 额外限制、异步 Agent 白名单、协调器专用集等更精细的分层。

---

## 六、生命周期管理

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 状态追踪 | `SubAgentRegistry`（独立类），running/done/error/stopped | `LocalAgentTaskState`（AppState 集成），running/completed/failed/killed | 同 claude-code-coderix |
| 通知机制 | `pushNotification` → `drainNotifications` 轮询 | `enqueueAgentNotification()` → `<task-notification>` XML | 同左 |
| 后台任务 | 独立 Promise 链 + `AsyncLocalStorage` 上下文 | `runAsyncAgentLifecycle()` fire-and-forget | 同左 |
| 终止/Abort | `registry.abort(agentId)` → AbortController | `killAsyncAgent()` → abort controller + 清理 | 同左 |
| 清理流程 | worktree 清理、上下文释放 | MCP 断开、hooks 清理、Perfetto 注销、todos 清理、shell 任务终止 | 同左 |
| 重复通知防护 | ❌ | ✅ `notified` 原子标志 | ✅ |

**关键差异**：
- Coderix 用独立 `SubAgentRegistry` 管理生命周期，claude-code-source 集成到 AppState
- Coderix 清理更简洁（主要关注 worktree），claude-code-source 有更全面的清理
- Coderix 缺少重复通知防护

---

## 七、Worktree 隔离

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 创建方式 | git worktree + hook 回退 | git worktree | git worktree |
| 变更检测 | `hasWorktreeChanges()`（HEAD 对比 + status） | ✅ 类似 | ✅ 类似 |
| 清理策略 | 有变更保留，无变更删除；`cleanupStaleAgentWorktrees()` | 同左 | 同左 |
| 稀疏检出 | ✅ 支持 | ❓ | ❓ |
| 符号链接 | ✅ 支持目录符号链接 | ❓ | ❓ |

Coderix 的 worktree 实现更丰富，支持稀疏检出和符号链接来减少磁盘占用。

---

## 八、Agent 内存系统

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 范围 | `user` / `project` / `local` | `user` / `project` / `local` | 同左 |
| 注入方式 | 系统提示词注入（8000 字符上限） | 系统提示词注入 | 同左 |
| 快照同步 | ❌ | ✅ 跨项目内存快照 | ✅ |
| 自动工具增强 | ✅ `augmentToolsForMemory()` | ❓ | ❓ |

Coderix 独有：启用内存时自动将 Read/Write/Edit 添加到工具允许列表。

---

## 九、工作流编排（Coderix 独有）

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|------|:-------:|:-------------------:|:------------------:|
| Workflow 工具 | ✅ 沙盒 JS 运行时 | ❌（特性门控 `WORKFLOW_SCRIPTS`） | ❌ |
| 并发控制 | ✅ `ConcurrencyController`（max=CPU核数-2） | ❌ | ❌ |
| 流水线 | ✅ `pipeline()` 真并发阶段执行 | ❌ | ❌ |
| 结构化输出 | ✅ `schema` 参数，最多 3 次重试 | ❌ | ❌ |
| 检查点/恢复 | ✅ `CheckpointManager` | ❌ | ❌ |

Coderix 的 Workflow 系统是其最大的差异化优势——允许用沙盒 JavaScript 编排多 Agent 并发流水线。

---

## 十、团队与协调器模式

| 维度 | Coderix | claude-code-coderix | claude-code-source |
|------|---------|---------------------|--------------------|
| 多 Agent 团队 | ❌（仅协调器模式有角色分工） | ✅ `spawnTeammate()`（tmux 多进程） | ✅ 同左 |
| 协调器模式 | ✅ 5 个角色，各有专门定义 | ✅ 仅 `worker` + 系统提示词 | ✅ 仅 `worker` |
| 进程内队友 | ❌ | ✅ `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` | ✅ |
| 文件邮箱通信 | ❌ | ✅ tmux 队友通过文件邮箱通信 | ✅ |

---

## 十一、总体评分矩阵

| 能力维度 | Coderix | claude-code-coderix | claude-code-source |
|----------|:-------:|:-------------------:|:------------------:|
| 内置 Agent 数量 | 🟢 8+（含5个协调器角色） | 🟡 6 | 🟡 6 |
| 自定义 Agent (Markdown) | 🟢 | 🟢 | 🟢 |
| 插件 Agent | 🟢 | 🟢 | 🟢 |
| Fork Agent | 🟡 简化版 | 🟢 完整版（缓存共享） | 🟢 完整版 |
| 后台执行 | 🟢 | 🟢 | 🟢 |
| 自动后台化 | 🔴 | 🟢 | 🟢 |
| Worktree 隔离 | 🟢 增强版 | 🟢 | 🟢 |
| 远程隔离 (CCR) | 🔴 | 🟢（仅内部） | 🟢（仅内部） |
| Agent 内存 | 🟢 带自动工具增强 | 🟢 | 🟢 |
| 多 Agent 团队 | 🔴 | 🟢 | 🟢 |
| 协调器模式 | 🟢 5角色 | 🟡 1角色(worker) | 🟡 1角色(worker) |
| 工作流编排 | 🟢 丰富 | 🔴 | 🔴 |
| 结构化输出 | 🟢 | 🔴 | 🔴 |
| Agent resume | 🟢 SendMessage | 🟢 SendMessage | 🟢 SendMessage |
| MCP Server（Agent级） | 🔴 | 🟢 | 🟢 |
| Agent Hooks | 🔴 | 🟢 | 🟢 |
| Effort 级别 | 🔴 | 🟢 | 🟢 |
| Prompt Cache 优化 | 🔴 | 🟢 | 🟢 |
| 测试覆盖 | 🟢 | ❓ | ❓ |

> 🟢 具备 / 🟡 部分具备 / 🔴 不具备 / ❓ 未知

---

## 十二、核心结论

1. **Coderix 的最大优势**在于工作流编排、并发控制、结构化输出——这是另外两个项目完全不具备的能力，使其在"单机智能体 + 工作流引擎"定位上有独特竞争力。

2. **Coderix 的主要缺失**在多 Agent 团队协作（spawnTeammate）、Prompt Cache 优化、MCP 集成、远程执行（CCR）、Agent 级 Hooks 等 Claude Code 原生的高级特性。

3. **协调器模式**Coderix 做得更精细（5 个角色 vs 1 个通用 worker），但缺少真正的多进程团队通信机制（tmux 队友 + 邮箱）。

4. 三个项目的 Agent 类型定义体系基本一致，Coderix 是在 Claude Code 设计基础上做了自主改造，添加了独特的工作流层，同时简化/移除了一些 Claude Code 的高级特性。
