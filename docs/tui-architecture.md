# TUI 架构契约（Phase 0 基线）

本文档定义 TUI 的目标分层、依赖方向与页面契约。Phase 0 只记录现状和目标，不要求代码立即符合；
后续每个 Phase 按文末的退出条件逐步收紧。

## 1. 当前分层事实

| 层 | 文件 | 职责 | 现状 |
|---|---|---|---|
| 终端适配 | `layout.js`、`keys.js`、`fspicker.js` | ANSI、字符集、颜色、显示宽度、raw mode、系统目录框 | 基本独立 |
| 应用外壳 | `screen.js` | 备用屏生命周期、帧合成、输入路由、模态栈、面包屑、页脚、日志页、任务视图 | 约 1680 行，包含任务视图与下载 schema |
| 页面原语 | `pages.js`、`report.js`、`select.js` | 菜单/确认/文本/信息页/帮助；报告页；选择器 | 分别约 1128 / 460 / 1628 行 |
| 输出兼容 | `view.js` | 日志/提示门面、legacy 状态块与全屏、取消回调、终端恢复 | 同时依赖 `screen` |
| 业务流程 | `app.js`、`settings.js`、`models.js`、`download.js`、`check.js`、`manage.js`、`login.js` | 主菜单、设置、模型、下载、检查、收藏集、登录 | 有 9 处 `screen.isActive()` 分叉 |
| 任务运行时 | `tasks.js`、`downloadTask.js`、`run.js` | 任务登记表、后台队列、进度采样 | 只服务下载任务 |

## 2. 目标分层

```
core/       ansi.js  metrics.js  keys.js  fspicker.js  format.js
shell/      screen.js  frame.js  input.js  systemViews.js
ui/         tokens.js  page.js  list.js  menu.js  form.js
            report.js  picker.js  feedback.js  help.js  taskView.js
flows/      app.js  settings.js  models.js  download.js
            check.js  manage.js  login.js
runtime/    tasks.js  downloadTask.js  progress.js
adapters/   plain.js  shell.js
```

第一轮不移动文件，新增模块并从旧文件 re-export；Phase 7 再做物理迁移。

## 3. 依赖方向

只允许以下方向：

```
core  ←  ui  ←  shell
core  ←  ui  ←  adapters  ←  flows
core  ←  runtime  ←  flows
```

具体要求：

1. `core` 不依赖 `ui`、`shell`、`flows`、`runtime`。
2. `ui` 只依赖 `core` 与 `i18n`；不得依赖 `screen`、`view`、`flows`。
3. `shell` 依赖 `core` 与 `ui`；不得依赖具体业务流程（`settings/models/download/check/manage/login`）。
4. `flows` 依赖 `ui`、`runtime`、`core` 与 `adapters`；不得直接调用 `screen.start/stop/bodyGeometry`，不得写终端。
5. `adapters` 是唯一允许同时接触“纯页面模型”和“具体呈现方式”的层：
   - `adapters/shell.js` 把页面模型交给 `screen.prompt`；
   - `adapters/plain.js` 把页面模型交给 `prompts` 库或文本打印。
6. `runtime` 不得依赖 `shell`；任务进度通过视图模型暴露。
7. 禁止新增循环依赖；已有 `screen ↔ view` 循环在 Phase 7 消除。

## 4. 核心契约

### 4.1 外壳页面契约

```js
{
  title,                 // 面包屑段；为空则不 push
  render(ctx),           // 返回 string[]，不得写终端
  hints(),               // 恰好一行，只列当前可用的键
  onKey(text, key),      // 消费返回 true
  onEscape(),            // 返回 false 表示自己处理，不离开
  acceptsText,           // 文本输入页为 true
  help(),                // 可选；覆盖通用 ? 帮助
}
```

`ctx` 至少包含 `{ width, columns, rows }`，其中 `rows` 是外壳已经扣掉页眉、仪表盘、面包屑、
提示行和页脚之后真正可用的主体行数。

### 4.2 页面模型契约

```js
{
  title?,                // 实体名，不是页面标题
  summary?: [{ label, value, color? }],
  sections?: [{ title, rows, emptyText?, emptyColor?, onEnter? }],
  actions?: [{ label, description?, danger?, value?, run? }],
  status?,               // 固定在主体最后一行的状态
  select?,               // 选中一行返回，而不是执行 action
}
```

`page.js` 负责：摘要列对齐、分区标题、行裁剪、光标替换、滚动视窗、actions 永远在最后、
status 贴底。页面不再自己计算列宽。

### 4.3 列表契约

所有列表只允许两种变体：

- `menu` / `form`：首尾循环，翻页 10 行，光标 `▸`，选中行加粗。
- `table`：夹紧不循环，翻页使用自身 pageSize，整行反显，用于选择器。

列表状态只保留 `{ cursor, windowStart }`，由 `ui/list.js` 统一移动。

### 4.4 任务视图契约

外壳只接受视图模型，不再读取下载任务字段：

```js
{
  id, kind, title, subtitle,
  status,
  progress: { bytes, totalBytes, pct, speed, eta },
  meta: [{ label, value }],
  current: [{ model, file, bytes, expected }],
  failures: [{ name, message }],
  actions: [{ key, label, enabled }],
}
```

下载任务通过 `toDownloadTaskViewModel()` 适配；未来 check/verify 任务各自提供适配器，
`shell/taskView.js` 不需要修改。

### 4.5 反馈契约

- `emptyPage(title, lines)`：没有数据，但用户需要知道下一步做什么。
- `toast(text, color)`：一次动作的结果，5 秒消失，同时写入日志。
- `log(line)`：过程细节，按 `Ctrl+L` 查看。
- `withSpinner(message, fn)`：超过数秒的等待，阶段写进面包屑。

### 4.6 下载工作台与步骤

下载计划页/确认页使用独立的 workspace 契约，不强行塞进 `page.js`：

- 输入只接受模型/收藏集 ID 或完整链接；其他格式直接提示格式错误。
- 模型：顶部输入框、下方一行结果、下方已选模型列表、最后是下一步按钮。
- 收藏集：一次只处理一个；输入框和结果行相同，下方区域改为成员多选。
- 收藏集默认全选，每个成员默认使用枚举返回的版本；`Space` 取消单个成员，`Enter` 修改该成员的版本。
- `Tab` 在区域之间切换焦点；`Enter` 执行当前焦点动作，不是全局确认。
- 选择页已经完成版本选择；确认页只读展示目录、并发、文件类型等设置，目录与并发只能在设置中修改。
- 确认页列表 + 确认按钮两个区域，`Tab` 切换；不再提供“强制重下”开关。
- 版本列表是“期望状态”选择器：勾选表示本地应保留，取消已下载版本表示删除对应文件，取消未下载版本表示跳过。
- 已下载版本默认勾选：任务运行时新增 `verifyExisting`，不提前跳过已记录行，交给 downloader 校验；通过则 skipped，失败则重新下载对应文件。
- 可以同时勾选同一模型的多个版本；勾选新版本不会隐式替换旧版本。
- 确认页汇总“下载 / 校验 / 删除”的数量与体积；删除属于危险操作，必须二次确认。
- 删除只在新版本下载或校验成功后执行；取消任务不执行删除；pinned 版本需先取消固定；仍被其它保留版本引用的共享文件不删除。
- “强制重下”只从 TUI 确认页移除；核心/CLI 的 `force` 保留给显式重试、修复与 `--force` 场景。
- 模型管理与收藏集管理复用同一套“期望状态”版本选择逻辑。
- 建议抽出 `ui/versionSelection.js`：输入“已安装版本 + 目标版本”，输出 `keep / download / delete / skip` 差异，供下载计划、模型详情与收藏集成员共用。
- 回执页 `Enter` 返回“主菜单 › 下载”子菜单，`Esc` 返回主菜单；任务继续运行，两者都不表示取消任务。
- 流程步骤固定为 `[选择 | 确认 | 回执]`；窄屏显示 `步骤 2/3 确认`。

### 4.7 全局覆盖层与日志

- 任务视图：`Ctrl+M` 打开/关闭，不属于主菜单路径。
- 日志页：`Ctrl+L` 打开，标题为 `日志`，只接受 `Esc` 关闭。
- 单任务日志移除；会话日志保留一层。
- 帮助页：`?` 打开，是模态，不属于步骤，也不进入主菜单路径。

## 5. Phase 0 基线指标

| 指标 | Phase 0 基线 | Phase 1 结果 | 目标 |
|---|---|---|---|
| 自定义列表/表单实现 | 6 处（主菜单、菜单、确认、设置、确认页、版本页） | 6 处 | 2 种变体 |
| 流程级 `screen.isActive()` | 9 处 | 9 处 | 0–2 个适配器 |
| 硬编码日期截断 | 8 处（check/download/models） | 0 | 0 |
| 流程内硬编码展示字符 | 2 处（models/download） | 0 | 0 |
| 流程内直接 `colors.*` | 95 处（6 个流程文件） | 0 | 0 |
| `screen.js` 任务字段引用 | 17 处 | 17 处 | 0 |
| `?` 覆盖页面类型 | 3 类（主菜单、报告页、选择器） | 3 类 | 全部 |
| 相邻重复面包屑 | 2 处（`modelsFlow`、`versionActions`） | 2 处 | 0 |
| `screen.js` 行数 | 约 1680 | 约 1680 | < 800 |
| `pages.js` 行数 | 约 1128 | 约 1128 | < 500 |
| `select.js` 行数 | 约 1628 | 约 1628 | 拆分后单文件 < 700 |

## 6. 各 Phase 的架构退出条件

| Phase | 退出条件 |
|---|---|
| 0 | 文档、测试助手、契约脚本、`npm run check:tui` 可用 |
| 1 | 流程内日期截断与硬编码展示字符为 0；语义令牌可用 |
| 1.5 | TUI 内容、页脚提示与 TUI 硬编码分隔符统一为 ` \| `；CLI/Web 不改；项目符号仍为 `·` |
| 2 | 页面统一走 `ui/page.js`；报告页输出不变；页面最多一条横线 |
| 3 | 6 处自定义列表收敛到 `menu/form/table`；下载计划/确认页支持 Tab 区域焦点 |
| 4 | `screen.js` 不再出现下载任务字段；任务视图接受通用视图模型；日志页合并为一层并独立标题 `日志` |
| 5 | StepFlow 可用；页脚只列本页动作键；`?` 全页面可用；`Ctrl+M`/`Ctrl+L` 全局覆盖层；移除 `j/k` 与旧 `L`/`l` |
| 6 | 下载工作台支持 ID/完整链接、模型/收藏集两种输入、确认页与回执页；版本列表为期望状态（取消已下载=删除）；删除有确认、pinned 与共享文件保护；流程文件中 `screen.isActive()` 为 0 或只剩适配器 |
| 7 | 依赖图无环；契约脚本 0 违规；旧路径仅保留兼容 re-export |

## 7. 当前已知例外

Phase 1 已完成：

- 新增 `src/tui/tokens.js`，提供 `color`、`status`、`glyph`、`format`、`space`、`breakpoint`。
- 6 个流程文件不再直接使用 `colors.*`，统一改为语义角色。
- 8 处日期截断改为 `format.date/dateTime/dateTimeFull`，输出与此前一致。
- 2 处硬编码 `'·'` 改为 `glyph.bullet`，ASCII 控制台会随字符集降级为 `*`。
- `scripts/check-tui-contracts.js` 的 allowlist 已收缩为只有 `task-schema`。

仍保留的唯一例外：

- `task-schema`：`screen.js`，计划在 Phase 4 移除。

每个 Phase 完成时删除对应白名单项；脚本会对“已不再需要的白名单项”给出 `[NOTE]`。

## 8. 实施状态

以下阶段已完成：

- Phase 1.5：TUI 分隔符统一为 ` | `，CLI/Web 不变。
- Phase 2：新增 `ui/page.js`，报告页改为薄封装；页面正文不再重复短横线。
- Phase 3：`Ctrl+M`/`Ctrl+L` 全局覆盖层；`Tab` 交给页面区域焦点；移除 `j/k` 与旧 `L/l`。
- Phase 4：任务视图行构建器迁入 `ui/taskView.js`；移除单任务日志；日志页独立标题为 `日志`。
- Phase 5：`ui/steps.js` 步骤条；页脚只列本页动作键；`?` 全页面帮助。
- Phase 6a：下载工作台 `ui/planWorkspace.js` 与只读确认页，模型/收藏集流程接入。
- Phase 6b：`ui/versionSelection.js` 期望状态差异与下载工作台删除逻辑；模型详情/收藏集成员页可复用该组件，页面级切换留待后续打磨。
- Phase 7：`check-tui-contracts.js` 白名单清零；无用导入清理；新增列表/步骤/版本差异测试。

契约脚本当前输出：`0 failure(s), 0 allowlisted violation(s)`。
