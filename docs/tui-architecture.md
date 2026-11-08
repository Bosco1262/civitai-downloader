# TUI 架构契约（Phase 0 基线）

本文档定义 TUI 的目标分层、依赖方向与页面契约。Phase 0 只记录现状和目标，不要求代码立即符合；
后续每个 Phase 按文末的退出条件逐步收紧。

## 1. Phase 0 分层基线（历史）

> 本节记录 Phase 0 当时的扁平文件名；当前文件名与目录见第 2 节。

| 层 | 文件 | 职责 | 现状 |
|---|---|---|---|
| 终端适配 | `layout.js`、`keys.js`、`fspicker.js` | ANSI、字符集、颜色、显示宽度、raw mode、系统目录框 | 基本独立 |
| 应用外壳 | `screen.js` | 备用屏生命周期、帧合成、输入路由、模态栈、面包屑、页脚、日志页、任务视图 | 约 1680 行，包含任务视图与下载 schema |
| 页面原语 | `pages.js`、`report.js`、`select.js` | 菜单/确认/文本/信息页/帮助；报告页；选择器 | 分别约 1128 / 460 / 1628 行 |
| 输出兼容 | `view.js` | 日志/提示门面、legacy 状态块与全屏、取消回调、终端恢复 | 同时依赖 `screen` |
| 业务流程 | `app.js`、`settings.js`、`models.js`、`download.js`、`check.js`、`manage.js`、`login.js` | 主菜单、设置、模型、下载、检查、收藏集、登录 | 有 9 处 `screen.isActive()` 分叉 |
| 任务运行时 | `tasks.js`、`downloadTask.js`、`run.js` | 任务登记表、后台队列、进度采样 | 只服务下载任务 |

## 2. 当前分层

```
core/       layout.js  keys.js  fsPicker.js  versionDelete.js
shell/      screen.js  present.js
ui/         tokens.js  pageLayout.js  list.js  steps.js  prompts.js  report.js
            select.js  planWorkspace.js  taskView.js  versionPage.js
            versionDiff.js  versionSelectionPage.js
flows/      app.js  settings.js  models.js  download.js
            check.js  manage.js  login.js
runtime/    tasks.js  downloadTask.js  run.js
adapters/   view.js
```

根目录保留 re-export shim（文件名沿用旧路径，可能与实现名不同），旧 require 路径与测试入口继续可用；实现位于上述分层目录。

## 3. 依赖方向

目标方向如下；当前 `ui/planWorkspace.js`、`ui/versionPage.js`、`ui/versionSelectionPage.js`、
`ui/prompts.js`、`ui/select.js`、`ui/report.js` 仍是屏幕感知组件，直接调用 `shell/screen`
或 `adapters/view`，这是尚未消除的 `ui ↔ shell/adapters` 例外。

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
5. `adapters` 是唯一允许同时接触“纯页面模型”和“具体呈现方式”的层；当前由
   `adapters/view.js`（日志/提示门面）与 `shell/present.js`（屏幕与简易模式二选一）承担。
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

`pageLayout.js` 负责：摘要列对齐、分区标题、行裁剪、光标替换、滚动视窗、actions 永远在最后、
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
`ui/taskView.js` 不需要修改。

### 4.5 反馈契约

- 状态槽：外壳固定在页脚上方；成功/提示 3 秒，错误保留到下一次操作，进度显示到操作结束。
- 正文列表元信息：页码、筛选、已选数量位于列表上方，不进入状态槽。
- `emptyPage(title, lines)`：没有数据，但用户需要知道下一步做什么。
- `log(line)`：过程细节，按 `Ctrl+L` 查看。
- `withSpinner(message, fn)`：超过数秒的等待，阶段写入状态槽，不再写面包屑。

### 4.6 下载工作台与步骤

下载计划页/确认页使用独立的 workspace 契约，不强行塞进 `pageLayout.js`：

- 输入只接受模型/收藏集 ID 或完整链接；其他格式直接提示格式错误。
- 模型：顶部输入框、下方一行结果、下方已选模型列表、最后是下一步按钮。
- 收藏集：一次只处理一个；输入框和结果行相同，下方区域改为成员多选。
- 搜索页的行勾选 = 「这一行有版本被选中」；版本页的勾选 = 「具体哪些版本被选中」。两边是同一事实的两种视角，必须始终一致。
- 从 `[ ]` 的行进入版本页时**一个版本都不预选**（光标仍停在该行的默认版本上，按一次空格即可勾选）；从 `[✓]` 的行进入时预选这一行已有的版本。
- 版本页 `Enter` 应用当前勾选；**全部取消 + `Enter` = 把这一行移出本次下载（行保留、复选框变空）**，不再弹「尚未选择版本」。`Esc` 仍然是「放弃本次修改」，两者不混淆。
- 默认勾选只由「本行默认版本」（= 发布时间最新的版本）的访问状态决定：免费则勾选，付费/限时**不勾选**；不会因为模型里另有免费版本而勾上付费的最新版本。用户可以显式勾选，确认页提示「需已有权限、不会购买或消耗 Buzz」。
- 收藏集成员默认使用该模型的**最新**版本（`publishedAt` 最大），模型库固定版本优先；收藏集快照仍记录枚举到的登记版本（快照记的是「加入时是什么」，计划用的是「现在下载什么」）。
- 成员元数据请求使用 `/models/:id`（与模型入口一致，每成员仍是 1 次请求）；`fetchModelDetail` 带会话级缓存（LRU 300 / TTL 10 分钟），同一模型在一次会话内只拉一次，进入版本页因此 0 次额外请求。
- 版本页行按发布时间倒序排列，光标默认第一行（最新版本）；该行已有勾选时停在排序后第一个勾选版本。
- `Space` 取消单个成员，`Enter` 修改该成员的版本。
- `Tab` 在区域之间切换焦点；`Enter` 执行当前焦点动作，不是全局确认。
- 选择页已经完成版本选择；确认页只读展示目录、并发、文件类型等设置，目录与并发只能在设置中修改。
- 确认页列表 + 确认按钮两个区域，`Tab` 切换；不再提供“强制重下”开关。
- 下载计划的勾选只表示“本次是否处理”；取消勾选不会删除本地文件，也不会隐式替换旧版本。
- 已下载版本默认勾选：任务运行时新增 `verifyExisting`，不提前跳过已记录行，交给 downloader 校验；通过则 skipped，失败则重新下载对应文件。
- 可以同时勾选同一模型的多个版本；勾选新版本不会隐式替换旧版本。
- 确认页固定汇总“新下载 / 校验已有 / 合计体积 / 文件类型 / 磁盘余量 / 访问权限”；付费项显示“需已有权限、不会购买或消耗 Buzz”，列表独立滚动，开始按钮固定可见。
- 下载确认页不包含删除。删除只属于“本地版本管理”的显式期望状态操作，并在执行前列出数量、体积并要求二次确认。
- “强制重下”只从 TUI 确认页移除；核心/CLI 的 `force` 保留给显式重试、修复与 `--force` 场景。
- `ui/versionDiff.js` 的 `keep / download / delete / skip` 差异只用于本地版本管理，不再与下载计划共用危险语义。
- 回执页提供“查看任务 / 继续下载 / 返回主菜单”三个明确动作；`Esc` 只返回上一级，任务继续运行。
- 流程步骤固定为 `[ 选择 | 确认 | 回执 ]`；窄屏显示 `步骤 2/3 确认`。

### 4.7 付费/受限访问

- `src/access.js` 提供纯分类器，所有界面共用；版本级 `paidAccess` 优先于模型级标记和 `availability`。
- 计划项携带 `access`：`public / paid / early-access / unavailable`，以及 `requiresEntitlement`、`endsAt`。
- 公开 API 不提供价格或“当前账号已购买”，界面不得显示价格或“已购买”。
- 下载器将 402、付费版本 403 和 HTML 登录/购买页映射为 `AccessRequiredError`，不重试。
- 下载任务单独统计“需权限”，不计入网络失败；无权限不写入完成记录。
- 行徽标按「该行已知的全部版本」汇总（`summarizeAccess`）：全付费 `[付费]`，混合 `[付费/免费]`，限时 + 免费 `[限时访问/免费]`，全免费不显示徽标。
- 徽标与默认勾选是两件独立的事：`mixed` 只影响文案，勾选只看本行默认版本。因此「`[付费/免费]` + 已勾选」（模型有付费版本，而本行下的是免费版）是合法且常见的组合。
- 版本名后缀按「行徽标与版本自身标签不一致才显示」：混合行的付费版本写成 `Base_V2（付费）`、限时版本写成 `xxx（付费至 2026-11-15）`；纯付费行的版本不再重复加 `（付费）`。
- 同一模型多个基础模型时，行的「基础模型」显示去重列表（`MOSS Image / Krea 2`），`b` 筛选按「包含」匹配、候选值从每行的 `baseModels` 展开收集。
- 批量收藏集默认 `skip` 付费项；CLI 支持 `--include-paid / --skip-paid / --paid-only`。TUI 没有「显式单模型全勾」的开关：默认勾选统一按上一条规则判断。
- 不自动购买、不消耗 Buzz，仅使用当前站点与账号已有 Cookie。

### 4.8 全局覆盖层与日志

- 任务视图：`Ctrl+T` 打开/关闭，不属于主菜单路径；主菜单另提供稳定的「任务视图」入口。
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
| 2 | 页面统一走 `ui/pageLayout.js`；报告页输出不变；页面最多一条横线 |
| 3 | 6 处自定义列表收敛到 `menu/form/table`；下载计划/确认页支持 Tab 区域焦点 |
| 4 | `screen.js` 不再出现下载任务字段；任务视图接受通用视图模型；日志页合并为一层并独立标题 `日志` |
| 5 | StepFlow 可用；页脚只列本页动作键；`?` 全页面可用；`Ctrl+T`/`Ctrl+L` 全局覆盖层；移除 `j/k` 与旧 `L`/`l` |
| 6 | 下载工作台支持 ID/完整链接、模型/收藏集两种输入、确认页与回执页；下载勾选与本地删除完全分离；删除只存在于本地版本管理并有确认、pinned 与共享文件保护；流程文件中 `screen.isActive()` 为 0 或只剩适配器 |
| 7 | 依赖图无环；契约脚本 0 违规；旧路径仅保留兼容 re-export |

## 7. 当前已知例外

Phase 1 与 Phase 1.5 已完成：

- 新增 `src/tui/ui/tokens.js`，提供 `color`、`status`、`glyph`、`format`、`space`、`breakpoint`。
- 6 个流程文件不再直接使用 `colors.*`，统一改为语义角色。
- 8 处日期截断改为 `format.date/dateTime/dateTimeFull`，输出与此前一致。
- 2 处硬编码 `'·'` 改为 `glyph.bullet`，ASCII 控制台会随字符集降级为 `*`。
- TUI 分隔符统一为 ` | `；CLI/Web 文案不改。

契约脚本的 `ALLOWLIST` 已为空。`task-schema` 仍是一个缩小范围的检查：它只禁止
`metaFailed / logFile / attempts / failures` 直接出现在外壳，`task.outDir` 仍由外壳的
“打开目录”动作使用。

## 8. 实施状态

### 已完成

- Phase 1 / 1.5：语义令牌、日期格式、TUI 分隔符统一。
- Phase 2：`ui/pageLayout.js` 页面骨架；报告页、设置页、模型版本页、下载确认页均使用共享布局。
- Phase 3：`Ctrl+T`/`Ctrl+L` 全局覆盖层；`Tab` 用于页面区域焦点；移除 `j/k` 与旧 `L/l`；列表接入 `ui/list.js`。
- Phase 4：任务视图行构建器迁入 `ui/taskView.js`；移除单任务日志；日志页独立标题为 `日志`。
- Phase 5：`ui/steps.js` 步骤条；页脚只列本页动作键；`?` 全页面帮助；确认页和回执页显示步骤。
- Phase 6a：下载工作台 `ui/planWorkspace.js`、只读确认页、回执页接入模型/收藏集下载；收藏集 ID 输入已并入工作台。
- Phase 6b：`ui/versionDiff.js` 期望状态差异；`ui/versionSelectionPage.js` 版本选择页；`core/versionDelete.js` 删除逻辑；模型管理新增“管理版本（保留/删除）”，收藏集通过成员页进入模型页复用同一入口；pinned/共享文件保护。
- Phase 6c：`shell/present.js` 适配层用于设置、下载、模型下载、模型动作、收藏集动作、校验与检查流程；流程文件中不再直接判断 `screen.isActive()`。
- Phase 7：`core/shell/ui/flows/runtime/adapters` 物理分层；根目录保留兼容 re-export；契约脚本 0 违规；新增列表/步骤/版本差异/回执/删除保护/版本选择测试。

### 已保留的例外

- `ui/select.js` 仍保留表格专用滚动，这是有意的 table 变体，不强行改成菜单列表。
- 旧版 `runDownloadPlan` 的确认页保留为兼容路径，新下载流程已不使用它。
- `shell/screen.js` 约 1576 行、`ui/prompts.js` 约 1106 行、`ui/select.js` 约 1641 行，仍高于早期行数目标；功能与分层优先，后续可继续拆分。
- `task.outDir` 仍由外壳的“打开目录”动作使用；`task-schema` 检查只覆盖 `metaFailed / logFile / attempts / failures`。
- `ui/planWorkspace.js`、`ui/versionPage.js`、`ui/versionSelectionPage.js`、`ui/prompts.js`、`ui/select.js`、`ui/report.js` 仍直接依赖 `shell/screen` 或 `adapters/view`；物理目录已完成，但严格的无环依赖还差这一步。

契约脚本当前输出是 `0 failure(s), 0 allowlisted violation(s)`。
