# Coderix vs claude-code-coderix vs claude-code-source 对比分析

## 项目概述

| 维度 | Coderix (当前项目) | claude-code-coderix | claude-code-source |
|---|---|---|---|
| **定位** | 自研开源 Claude Code 替代品 | Claude Code 源码社区 Fork + 增强 | Claude Code 官方泄漏源码快照 |
| **协议** | Apache 2.0 | 学习研究用途 | Anthropic 专有 |
| **运行时** | Node.js >= 22 | Bun >= 1.3.11 | Bun |
| **UI 框架** | Ink 7 + React 19 | 自定义 Ink + React 19 | 自定义 Ink + React 19 |
| **源码规模** | ~332 个文件 / 2.3MB | ~2293 个文件 / 27MB | ~1884 个文件 / 33MB |
| **提交数** | 191 commits | 732 commits | 2 commits |

---

## 一、工具系统

| 工具 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| 文件读写编辑 | Read / Write / Edit | Read / Write / Edit | Read / Write / Edit |
| Shell 执行 | Bash | Bash + PowerShell | Bash + PowerShell |
| 文件搜索 | Glob + Grep | Glob + Grep (条件加载) | Glob + Grep (条件加载) |
| Web 抓取 / 搜索 | WebFetch + WebSearch | WebFetch + WebSearch + VaultHttpFetch | WebFetch + WebSearch |
| 任务管理 | TaskCreate/Get/List/Update | TaskCreate/Get/List/Update | TaskCreate/Get/List/Update |
| 笔记本编辑 | NotebookEdit | NotebookEdit | NotebookEdit |
| Agent 工具 | Agent + SendMessage + TaskStop + TaskGet | Agent + SendMessage + TaskStop | Agent + SendMessage + TaskStop |
| 计划模式 | EnterPlanMode + ExitPlanMode | EnterPlanMode + ExitPlanMode | EnterPlanMode + ExitPlanMode |
| Worktree | EnterWorktree + ExitWorktree | EnterWorktree + ExitWorktree | EnterWorktree + ExitWorktree |
| 用户交互 | AskUserQuestion | AskUserQuestion | AskUserQuestion |
| Skill 调用 | Skill | Skill | Skill |
| **定时任务** | 未实现 (占位) | CronCreate/Delete/List | CronCreate/Delete/List |
| **LSP 集成** | 未实现 (占位) | LSPTool | LSPTool |
| **浏览器自动化** | Chrome MCP (built-in) | WebBrowserTool + Chrome MCP | WebBrowserTool |
| **Computer Use** | Computer Use MCP (built-in) | Computer Use MCP + native | Computer Use |
| **语音输入** | 无 | Voice Mode (豆包 ASR) | Voice (native capture) |
| **团队管理** | TeamCreate/Dispatch/Status/Message | TeamCreate/Delete | TeamCreate/Delete |
| **工作流** | WorkflowTool | WorkflowTool | WorkflowTool |
| **UDS 通信** | 无 | ListPeersTool | ListPeersTool |
| MCP 资源 | 未实现 | ListMcpResources + ReadMcpResource | ListMcpResources + ReadMcpResource |
| 延迟工具发现 | 无 | SearchExtraTools + Execute | ToolSearch |

---

## 二、Provider 模型支持

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| Anthropic API | 直接 SDK | 直接 SDK | 仅 Anthropic |
| DeepSeek | 独立 Provider (X-DS-Prefix-Cache) | OpenAI Compatible | 无 |
| OpenAI | OpenAICompatProvider | OpenAI SDK | 无 |
| Gemini | 无 | Gemini SDK | 无 |
| Grok | 无 | Grok SDK | 无 |
| AWS Bedrock | 无 | Bedrock SDK | 无 |
| GCP Vertex | 无 | Vertex SDK | 无 |
| 模型路由 | ProviderRouter (复杂度自动选择) | Provider 注册表 | 无 |
| 重试机制 | 指数退避 + 分类错误 | API 层重试 | API 层重试 |
| 成本追踪 | 内置模型定价表 | GrowthBook 动态定价 | 简单追踪 |

---

## 三、Agent 多智能体系统

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| 子 Agent 生成 | Agent spawn/read/stop/message | Agent + SendMessage + TaskStop | Agent + SendMessage + TaskStop |
| 内置 Agent 类型 | 13 种 (explore/plan/general/verify/guide/coordinator/researcher/implementer/reviewer/tester 等) | 6 种 (explore/plan/general/verify/guide/statusline) | 6 种 |
| Coordinator 模式 | 完整 (coordinatorAgent + Teams) | 完整 (coordinatorAgent + 动态 Team) | 完整 (coordinatorAgent + 动态 Team) |
| Team 系统 | team-create/dispatch/status/message | team-create/delete | team-create/delete |
| Swarm 并行 | 无 | in-process swarm + 权限桥接 | in-process swarm + 权限桥接 |
| Workflow 脚本 | 沙箱 JS runtime (agent/parallel/pipeline/phase) | WorkflowTool | WorkflowTool |
| Agent 注册 | YAML/MD 文件加载 | 代码定义 | 代码定义 |

---

## 四、上下文管理

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| Token 预算 | 字符估算 (3.5/2.5/2.0 chars/token) | Token 估算 + API 精确 | Token 估算 + API 精确 |
| 压缩策略 | 4 种 (micro-compact / memory / LLM / truncation) | 6 种 (+ reactive / snip compact) | 6 种 |
| 自动压缩 | 时间 + 阈值触发 | 多种触发条件 | 多种触发条件 |
| 历史裁剪 | 无 | SnipTool (HISTORY_SNIP) | SnipTool |
| 上下文可视化 | 无 | ContextVisualization 组件 | ContextVisualization 组件 |
| Brief Mode | 无 | BriefTool + /brief 命令 | BriefTool |

---

## 五、Memory 记忆系统

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| 文件存储 | Markdown + YAML frontmatter | Markdown + YAML frontmatter | Markdown + YAML frontmatter |
| 记忆类型 | user / feedback / project / reference | 同类 | 同类 |
| 自动提取 | LLM 提取 (fire-and-forget) | LLM 提取 + Skill Learning | extractMemories |
| 召回 | Jaccard 相似度排序 | 语义搜索 | Prompt 注入 |
| 索引 | MEMORY.md | MEMORY.md | MEMORY.md |
| **Dream 整理** | 无 | /dream + autoDream 服务 | autoDream 服务 |
| **Skill Learning** | 无 | 完整 pipeline (observe -> generate -> evolve) | 无 |
| 过时检测 | staleness 警告 | 有 | 有 |

---

## 六、MCP 协议支持

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| 客户端连接 | stdio + HTTP transport | 全协议 | 全协议 |
| 配置管理 | project + user config | 多层配置 | 多层配置 |
| 自动重连 | 指数退避 (5 次) | 有 | 有 |
| OAuth 认证 | 无 | MCP OAuth 端口 | MCP OAuth |
| Channel 过滤 | 无 | channel allowlist | channel allowlist |
| MCP 资源 | 无 | List/Read MCP Resources | List/Read MCP Resources |
| MCP Skills | 发现 + 格式化 | 发现 + 格式化 | 发现 + 格式化 |
| 内置 MCP Server | Chrome + Computer Use | 无 (通过 packages 提供) | 无 |

---

## 七、扩展性与插件

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| Hook 系统 | 19 种事件 + ScriptProvider | 完整 Hook 系统 | 完整 Hook 系统 |
| Skill 系统 | 静态加载 (SKILL.md) | 动态加载 + 自动生成 | 动态加载 |
| **Plugin 安装** | 无 | Plugin 安装/管理 | Plugin 安装/管理 |
| **Skill Learning** | 无 | observe -> generate -> evolve | 无 |
| Skill Creator | LLM 生成 + 改进 | 自动学习 + 生成 | 手动创建 |
| **Marketplace** | 无 | MCP marketplace | MCP marketplace |
| Custom Agent | MD 文件注册 | 代码定义 | 代码定义 |

---

## 八、远程控制与 IDE 集成

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| ACP 协议 | 支持 | 支持 | 支持 |
| Remote Control | 无 | 完整 (Docker 自托管 + 手机) | 完整 (bridge 系统) |
| IDE Bridge | 无 | VS Code / JetBrains | VS Code / JetBrains |
| UDS 进程通信 | 无 | Pipe IPC (同机 + LAN) | Pipe IPC |
| Teleport | 无 | 会话迁移 | 会话迁移 |
| Direct Connect | 无 | SSH 风格直连 | SSH 风格直连 |

---

## 九、企业级特性

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| GrowthBook 开关 | 无 | 完整集成 | 完整集成 |
| Langfuse 监控 | 无 | OpenTelemetry 集成 | 无 |
| Sentry 追踪 | 无 | 错误追踪 | 无 |
| OAuth 登录 | 无 | 完整 OAuth | 完整 OAuth |
| Policy Limits | 无 | 企业策略限制 | 企业策略限制 |
| 远程管理设置 | 无 | MDM 同步 | MDM 同步 |
| Channel 通知 | 无 | 飞书/Slack/Discord/微信 | 无 |

---

## 十、终端 UI / 交互体验

| 能力 | Coderix | claude-code-coderix | claude-code-source |
|---|---|---|---|
| UI 框架 | Ink 7 + React 19 | 自定义 Ink + React 19 | 自定义 Ink + React 19 |
| Vim 模式 | 无 | 完整 Vim 编辑 | 完整 Vim 编辑 |
| Typeahead | 无 | 智能补全 (213KB) | 智能补全 |
| Buddy 伴侣 | 无 | 18 物种抽卡系统 | 18 物种抽卡系统 |
| 快捷键绑定 | 基础 | 全面 (可自定义) | 全面 |
| Poor Mode | 无 | /poor 开关 | 无 |
| Status Bar | 有 | 完整 (model/cost/session) | 完整 |
| 输出样式 | 基础 | 多风格切换 | 多风格切换 |

---

## 总结

### Coderix 的核心优势

1. **架构清晰度高** — 模块化设计好，代码量只有 CCB 的 1/8 但功能覆盖率高
2. **Provider 架构优秀** — ProviderRouter 自动模型选择，代码独立清晰
3. **Agent 类型丰富** — 13 种内置 Agent 比 CCB 多一倍，Workflow 沙箱独创
4. **内置 MCP 服务器** — Chrome MCP 和 Computer Use MCP 开箱即用
5. **Hook 系统完整** — 19 种事件，设计全面
6. **Node.js 生态** — 不需要 Bun，用户门槛低

### 需要追赶的方向

#### 高优先级（核心体验差距）

- 定时任务 (CronCreate/Delete/List)
- LSP 代码智能集成
- 延迟工具发现 (MCP 工具多时的关键优化)
- Vim 模式 + 智能补全
- MCP OAuth 认证

#### 中优先级（多厂商支持）

- Gemini / Grok / Bedrock / Vertex Provider
- MCP 资源访问 (List/Read MCP Resources)

#### 低优先级（差异化功能）

- Remote Control / IDE Bridge
- Dream 自动记忆整理
- Plugin 安装管理
- GrowthBook / Langfuse 企业特性
- UDS 跨会话通信
- Buddy 伴侣系统
