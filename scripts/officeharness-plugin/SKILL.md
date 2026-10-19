---
name: ppt
description: 使用 OfficeHarness 在 Coderix 右侧原生 Impress 面板中创建、编辑、保存 PPTX，并支持人工与 AI 接续编辑。
---

# OfficeHarness PPT 工作区

## 打开与连接

工作区由 Coderix 右侧的 **OfficeHarness** 面板承载。插件卡片创建会话时会自动打开；如果面板未打开，请提示用户通过插件卡片或右上角应用按钮打开，不要启动外部浏览器，也不要调用宿主的通用预览工具。

开始操作前：

1. 调用 `ppt_get_workspace_info`。返回的 `url` 是当前工作区地址，`editor_online` 只表示编辑器是否已注册。
2. 调用 `ppt_get_state`。只有在返回了 `document_id` 和 `revision` 后才能修改文稿。
3. 如果 `editor_online` 为 false，等待面板加载完成；不要自行启动新的编辑器或重复创建会话。

## 读写规则

- 每次写入都传最新的 `document_id` 和 `expected_revision`。revision 过期时先重新读取状态，不要盲目重试。
- 对象使用 `ppt_get_state` / `ppt_read_object_tree` 返回的 `object_id`。不要用页面序号、对象名称或选中文字来推断对象。
- 修改前读取属性：`ppt_read_object_properties`、`ppt_read_paragraphs`、`ppt_read_rich_text`、`ppt_read_text_fields`。
- 修改后读回实际属性，并用 `ppt_read_slide_image`（`document_id`、`expected_revision`、`slide_id`、可选 `width_px`）查看页面 PNG，检查遮挡、布局和颜色。
- 局部文字格式使用 UTF-16 范围，`start` 含、`end` 不含；范围切到动态字段时，必须覆盖整个字段边界。
- 中文文字优先设置 `font_asian`、`size_asian`、`weight_asian`。颜色是整数 RGB；字重 100 常规、150 加粗。

## 人工编辑边界

- 不打断人工输入。`render_native_edit_pending` 表示用户仍在原生文字编辑中；请用户先结束编辑，不要用撤销、保存或切换页面强行清除。
- 原生模态窗口或输入进行中时，先等待用户完成。
- 结果未知的写入（超时、连接中断、`operation_outcome_unknown`）不要自动重放。先读取最新 state 和文件状态，把原操作 ID 与未知结果告诉用户。

## 保存与本地文件

- 保存用 `ppt_save_deck`，必须带 `document_id` 和 `expected_revision`。
- 有可写文件绑定时默认保存回原文件；无绑定时写入应用 exports 目录。
- 用户要求保存到本地目录时：
  1. `ppt_workspace_mount` 登记绝对目录（必要时 `read_only: true`）。
  2. `ppt_workspace_list_files` 确认目标路径。
  3. `ppt_save_deck` 传 `file_target: {mount_id, path, expected_version}`；新文件 `expected_version` 为 `null`。
- `file_conflict` 表示磁盘文件已变化，不要覆盖；改用另存为或让用户确认。
- 打开本地文件用 `ppt_open_local_deck`（`mount_id`、`path`）；有未保存修改时会拒绝，先保存再打开。
- 只访问用户显式挂载的目录，不要拼接或猜测路径。

## 表格、母版与动画

- `ppt_read_table` 读取实际 TableShape，行列从 0 开始，每次最多 16×16 格。它不提供边框、合并编辑或完整表格样式保证。
- 整表或局部文字格式的撤销必须重新读取实际格式确认，不能只看历史计数。
- 母版族修改需要已核实的来源绑定；`master_family_*` 错误时读取最新设置，不要强行统一修改。
- 动画与切换工具只覆盖已实现的属性；复杂 PowerPoint 动画不保证完全保真。

## 验收口径

- MCP 连接成功不等于文稿操作成功；以工具返回、读回属性和页面 PNG 为准。
- 保存成功以工具返回的路径/哈希和磁盘文件状态为准；仍在内存或导出失败不能称为已保存。
- 不要声称所有复杂 PPTX 都能完整保真。遇到未验证的字体、IME、合并表格、母版或动画场景，明确说明限制。
