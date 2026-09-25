# Blender MCP —— 用 Claude 操控 Blender 建模

> 本文档从历史会话（`blender-harness` 项目，2026-09-15）整理而来，记录如何**安装**官方
> Blender MCP 并**实现**「自然语言 → bpy 代码 → 3D 模型」的完整链路，以及工程化封装成
> 对话式建模界面的做法。

---

## 一、整体架构

官方 Blender MCP（`lab/blender_mcp`）由两个组件组成，通过 **TCP socket** 通信：

```
MCP Client (Claude Code)  ⇐ MCP/stdio ⇒  blender-mcp  ⇐ TCP :9876 ⇒  Blender Add-on
```

| 组件 | 位置 | 作用 |
|---|---|---|
| **Blender Add-on** | `addon/blender_mcp_addon/` | 运行在 Blender 内部，监听 `127.0.0.1:9876`，真正执行 bpy 代码 |
| **MCP Server** | `mcp/blmcp/`（entry point `blender-mcp`） | 独立进程，被 MCP client 经 stdio 拉起，把请求经 TCP 转发给 addon |

**数据流（一次建模）**：
1. 用户用自然语言描述要建的模型。
2. Claude Code 通过 MCP 工具 `execute_blender_code` 等，把 bpy Python 代码发给 MCP server。
3. MCP server 经 TCP 把代码转发给 Blender addon，addon 在 Blender 内 `exec` 执行。
4. Claude 用 `get_objects_summary` 等工具核对结构，最终保存 `.blend`、导出 `.glb`、渲染 `.png`。

---

## 二、安装

### 2.1 运行前提

| 依赖 | 版本/说明 |
|---|---|
| Blender | **5.1.0+**（addon 的 `blender_manifest.toml` 硬性要求 `blender_version_min = "5.1.0"`） |
| uv | 用于 `uv run blender-mcp` 启动 MCP server |
| Python | ≥ 3.10（MCP server 依赖） |
| claude-code | 驱动端，需配好认证（`ANTHROPIC_API_KEY` 或代理 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`） |

### 2.2 安装并启用 Blender Add-on

1. 打开 Blender → **Edit → Preferences → Get Extensions**，搜索 `MCP`；
   或从 https://www.blender.org/lab/mcp-server/ 下载 addon，用 **Install from Disk** 安装。
2. 勾选启用。addon 的 **Auto Start** 默认开启（`use_autostart=true`），Blender GUI 启动后
   自动监听 `127.0.0.1:9876`，无需手动点 `Start Server`。

> ⚠️ **Online Access 权限**：addon manifest 声明了 `network` 权限，自动启动依赖 Blender 的
> 在线访问权限。否则 auto-start 会被**静默跳过**，偏好面板会提示
> "Online access must be enabled in the system preferences"。
> 解决：**Edit → Preferences → System → Online Access 开启**，或启动 Blender 时加 `--online-mode`。

### 2.3 获取 MCP Server 代码

```bash
git clone https://projects.blender.org/lab/blender_mcp.git
# MCP server 在 mcp/ 子目录
cd blender_mcp/mcp
```

`mcp/pyproject.toml` 定义了 entry point `blender-mcp = "blmcp:main"`，`uv run blender-mcp`
即启动 stdio MCP server。也可用 pip 直接装：

```bash
pip install "git+https://projects.blender.org/lab/blender_mcp.git#subdirectory=mcp"
```

---

## 三、接入 Claude Code

### 3.1 方式 A：直接 `mcpServers` 配置（settings.json）

```jsonc
// ~/.claude/settings.json（或项目 .mcp.json）
{
  "mcpServers": {
    "blender": {
      "command": "uv",
      "args": ["--directory", "/path/to/blender_mcp/mcp", "run", "blender-mcp"]
    }
  }
}
```

非默认端口时，通过环境变量显式注入 addon 端点：

```jsonc
"blender": {
  "command": "uv",
  "args": ["--directory", "/path/to/blender_mcp/mcp", "run", "blender-mcp"],
  "env": {
    "BLENDER_MCP_HOST": "127.0.0.1",
    "BLENDER_MCP_PORT": "9876"
  }
}
```

### 3.2 方式 B：通过 claude-agent-sdk 注入（工程化封装）

`blender-harness` 用 `@anthropic-ai/claude-agent-sdk` 驱动 claude-code 子进程，核心配置
（见 `server/executor.mjs`）：

```js
query({
  prompt,
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools: ['AskUserQuestion'],   // 建模自主推进，不中途停等
    cwd,                                    // 指向共享 workspace
    mcpServers: {
      blender: {
        command: 'uv',
        args: ['--directory', blenderMcpDir, 'run', 'blender-mcp'],
        // 仅当非默认 host/port 时才注入 env
      },
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
  },
});
```

关键细节：
- 默认 `BLENDER_MCP_HOST=127.0.0.1` / `BLENDER_MCP_PORT=9876` 时不显式传 env，交给 MCP server 自身解析。
- 通过 SDK `system/init` 消息捕获 session id，下一轮用 `options.resume` 续接，保持多轮上下文。
- 过滤 `CLAUDE*` 环境变量（保留 `CLAUDE_CODE_*`），避免 Claude 会话内再 spawn claude 触发嵌套会话错误。

### 3.3 推荐 system prompt（建模工作流约束）

```text
你通过 `blender` MCP 工具操控正在运行的 Blender 实例（官方 Blender MCP，TCP 端口 9876）。
核心工具：
- execute_blender_code：在 Blender 内执行任意 bpy Python 代码（建模/材质/灯光/相机/导出全靠它）
- get_objects_summary / get_object_detail_summary：读取场景对象层级与属性，做几何核对
- render_viewport_to_path / render_thumbnail_to_path：渲染当前场景到文件
- get_screenshot_of_area_as_image：截取单个编辑器区域（返回 PNG，供视觉核对）
- jump_to_view3d_object_by_name：把 3D 视口聚焦到指定对象
- get_python_api_docs / search_api_docs / search_manual_docs：查询 bpy API 与用户手册

execute_blender_code 的返回值约定：把要返回的数据放进 `result` 字典，
例如 result = {"objects": len(bpy.data.objects)}；result 必须是 dict 且 JSON 可序列化。

建模工作流约束：
- 用 execute_blender_code 分小步构建模型（每次一个逻辑步骤），避免单段超长代码超时
- 步骤间用 get_objects_summary / get_object_detail_summary 核对结构、尺寸、包围盒、面数
- 完成后把 .blend 保存到工作目录（cwd），再用 bpy.ops.export_scene.gltf 导出同名 .glb
```

---

## 四、MCP 工具清单（官方暴露）

| 工具 | 作用 |
|---|---|
| `execute_blender_code` | 在**正在运行**的 Blender 实例里执行 Python 代码（**最常用**） |
| `execute_blender_code_for_cli` | 在**后台** Blender 进程里执行 Python 代码 |
| `get_objects_summary` / `get_object_detail_summary` | 读场景集合层级 / 单个对象结构摘要 |
| `get_blendfile_summary_*` | blend 文件级摘要（datablocks、缺失文件、外链库、路径、用途猜测） |
| `get_screenshot_of_area_as_image` / `..._window_as_image` / `..._window_as_json` | 截图 / 窗口布局描述 |
| `render_viewport_to_path` / `render_thumbnail_to_path` | 渲染到文件 / 低质量缩略图 |
| `jump_to_tab_by_name` / `jump_to_tab_by_space_type` | 切换工作区 |
| `jump_to_view3d_object_by_name` / `..._object_data_by_name` | 视口聚焦到对象 |
| `get_python_api_docs` / `search_api_docs` / `search_manual_docs` | 查询 bpy API / 用户手册（自带 RST 文档） |

---

## 五、核心：`execute_blender_code` 的协议与约定

### 5.1 addon TCP 协议（null-byte 分隔 JSON）

```
请求:  {"type":"execute","code":"<bpy 代码>","strict_json":true}\0
响应:  {"status":"ok","result":{...},"stdout":"...","stderr":"..."}\0
       {"status":"error","message":"...","stdout":"...","stderr":"..."}\0
```

**约定**：bpy 代码里把要返回的数据写入 `result` 变量（必须为 dict 且 JSON 可序列化）。

### 5.2 真实建模代码示例（来自历史会话「画一辆车」）

```python
import bpy

# 删除默认 Cube
for name in ["Cube"]:
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

# 创建金属车漆材质
paint = bpy.data.materials.new("Car_Paint")
paint.use_nodes = True
bsdf = paint.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.72, 0.05, 0.05, 1.0)  # 深红
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.28
bsdf.inputs["Clearcoat"].default_value = 1.0
bsdf.inputs["Clearcoat Roughness"].default_value = 0.06

# 车身主体
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.9))
body = bpy.context.active_object
body.name = "Car_Body"
body.scale = (4.4, 1.8, 1.1)
body.data.materials.append(paint)

# 倒角修饰，让边缘圆润
bevel = body.modifiers.new("Bevel", 'BEVEL')
bevel.width = 0.05

# 返回结果
result = {"objects": len(bpy.data.objects)}
```

### 5.3 保存 / 导出

```python
import bpy
bpy.ops.wm.save_as_mainfile(filepath="/abs/path/workspace/human.blend")
bpy.ops.export_scene.gltf(filepath="/abs/path/workspace/human.glb")
result = {"blend": ".../human.blend", "glb": ".../human.glb"}
```

---

## 六、工程化封装（blender-harness 范式）

`~/Documents/apps/blender-harness` 是完整参考实现：**对话式 Web 界面 + claude-agent-sdk +
官方 Blender MCP**，架构沿用 `cad_harness` / `freecad-harness`。

```
浏览器 (web/)  ─ REST + SSE ─▶  harness server (server/*.mjs) :9528
                                    ├─ index.mjs       路由 + SSE + 会话持久化 + 单活动运行
                                    ├─ executor.mjs    claude-agent-sdk 注入 Blender MCP
                                    ├─ blender-rpc.mjs 直接 TCP 连 addon（渲染预览）
                                    ├─ sse-bus.mjs     事件总线 + toSSE
                                    └─ config.mjs      环境变量 + system prompt
```

**关键设计**：
- **渲染预览独立走 TCP**：网页右侧实时渲染不依赖模型能力——后端直接连 addon `:9876`，
  用 `{"type":"execute","code":"<bpy 渲染代码>"}\0` 协议渲染 PNG，读 base64 后经 SSE 推送。
  渲染时强制 `BLENDER_EEVEE` + `resolution_percentage = 50`，避免高频完整渲染拖垮线程池。
- **单活动运行**：一次只跑一轮，运行中再发消息返回 `409`，前端禁用输入并提供「停止」。
- **共享文档**：Blender 单实例单文档，所有会话共享同一 Blender 实例与 `workspace/` 目录。

**环境变量**（见 `.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BLENDER_HARNESS_PORT` | `9528` | HTTP 服务端口 |
| `BLENDER_MCP_DIR` | `<repo>/../blender-mcp/mcp` | 官方 blender_mcp 的 `mcp/` 目录 |
| `BLENDER_MCP_HOST` / `BLENDER_MCP_PORT` | `127.0.0.1` / `9876` | addon TCP 端点 |
| `BLENDER_MCP_COMMAND` / `BLENDER_MCP_ARGS` | `uv` / `--directory <dir> run blender-mcp` | 启动 MCP server 的命令 |
| `CLAUDE_MODEL` | 空 | 覆盖 claude 子进程模型 |
| `BLENDER_SCREENSHOT_INTERVAL_MS` | `4000` | 轮询渲染预览间隔 |
| `BLENDER_PREVIEW_NAME` | `preview.png` | 预览图文件名 |

**启动**：

```bash
cd blender-harness
npm install
cp .env.example .env     # 按需配置 BLENDER_MCP_DIR 等
npm start                # 等价 node server/index.mjs
# 或 ./start.sh [--install]
```

打开 http://127.0.0.1:9528 即可用自然语言建模。

---

## 七、踩坑清单

1. **Online Access 未开** → addon auto-start 静默失败，MCP 工具连不上。开系统偏好或加 `--online-mode`。
2. **Blender 版本过低**（< 5.1.0）→ addon manifest 硬性要求，安装即报错。
3. **Blender 必须保持 GUI 运行**且 addon server 已启动——截图/渲染依赖视口与场景。
4. **返回值必须写进 `result` dict**，且 JSON 可序列化，否则 MCP server 报错。
5. **单段代码别太长**：分小步构建，避免执行超时；步骤间用 `get_objects_summary` 核对。
6. **渲染成本**：每次轮询都是一次完整渲染，EEVEE 快、Cycles 慢；预览用低分辨率 + EEVEE。
7. **bpy 属性名探针**：不确定 Principled BSDF 输入名时，先用一小段探针代码（如
   `[i.name for i in bsdf.inputs]`）查清楚，再写正式代码。
8. **高精度生物/雕刻模型**：不建议纯几何体硬搭，先用 Tripo / Rodin 等专用 AI 3D 生成器出模型，
   再导入 Blender 做后续处理。
