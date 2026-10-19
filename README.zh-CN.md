# civitai-downloader

[English](README.md) | [简体中文](README.zh-CN.md)

批量下载 [Civitai](https://civitai.com) 收藏集（Collection）中的全部模型文件：自动枚举条目、获取文件元数据、断点续传下载，并用 SHA256 与站点发布值比对校验，全部文件按「模型标题」分文件夹保存。

> 背景：Civitai 公开 REST API 不支持枚举收藏集条目，本工具通过你本人的浏览器登录会话调用站点内部接口完成枚举，因此需要一次性手动登录。

---

## 功能特性

- **Web 界面**（`npm run webui` 或 `node web.js`）：本地浏览器界面，覆盖终端界面的全部能力——仪表盘、收藏集枚举与可筛选勾选、逐项切换版本、实时进度与日志、模型库与版本固定、检查更新、校验修复、设置编辑、浏览器登录、环境体检。零额外依赖（Node 自带 `http` + 原生 JavaScript，无需构建），默认只监听 `127.0.0.1`
- **终端交互界面**（`npm run tui`）：菜单式操作——登录、收藏集条目筛选/勾选下载、实时进度条与日志、完成状态管理、版本固定、本地校验修复、环境体检、设置编辑，无需记命令
- 一键枚举收藏集条目（分页自动翻页、去重合并、限流）
- 自动获取每个模型的最新版本、主 Model 文件的：文件名 / 大小 / SHA256 / 下载直链
- **版本选择与固定**：多版本模型可指定下载哪个版本——TUI 中逐个挑选（可顺带固定），或 CLI `--version <modelId=versionId>` 覆盖；`pin` 命令可把版本**固定**下来，之后不会被站点新版覆盖
- **同一模型多版本共存**：每个版本独立记录目录/文件清单/SHA256，首个版本在 `outDir/<模型名>/`、追加版本在 `outDir/<模型名>/<版本名>/`，切换版本不会互相覆盖
- **单个模型（不依赖收藏集）**：`download <模型URL | model:<id> | version:<id>>` 直接下载（支持批量粘贴 / `--models` / `--from-file`）；`models` 命令统一管理——列表与搜索排序、导出 JSON/CSV、固定版本、删除记录（可连文件一起删）；`check`/`verify` 支持 `model:<id>` 与 `--models`；TUI 主菜单第 2 项「单个模型」有同款入口
- 下载能力（基于 curl + 登录 Cookie）：
  - 断点续传（`curl -C -`），网络中断后重跑同一命令即可续传；续传前比对 **ETag**，远端文件变了会丢弃旧分片，避免拼出必然校验失败的文件
  - 失败自动重试（单项最多 5 次，可配），低速保护（<50KB/s 持续 2 分钟自动断开重试）
  - 下载到 `*.part`，SHA256 校验通过后才改名为正式文件
  - 已存在且校验通过的文件自动跳过；`state` 记录已完成模型，重复运行秒级跳过
  - **惰性元数据**：已完成的条目不再逐个拉元数据（二次运行几乎零请求）
  - **并发下载**（`--jobs N`）与元数据并发获取
  - 登录态中途过期会**自动重新导出 Cookie 并重试**
  - 下载前检查磁盘剩余空间；TUI 中可 Ctrl+C 取消（保留 `.part` 续传）、按 `s` 跳过当前模型
  - **断点清单**：取消时保存剩余计划，`--resume` 可继续，无需重新枚举
- **检查更新**（`npm run check -- <收藏集ID>` 或 TUI「检查更新」）：
  - 收藏集通过**成员快照**（`.data/collections/<ID>.json`，由 `list` / `download` 写入）比对，检查时完全不需要浏览器
  - **快速模式**（默认）：只比对版本号与本地文件大小，跳过已完成项的元数据请求，秒级返回
  - **深度模式**（`--verify-files`）：额外拉取线上文件哈希并校验本地 SHA256，可发现「同版本被作者重传」、文件改名、增删文件
  - 报告「有更新 / 文件变化 / 本地缺失 / 已从收藏集移除 / 未下载 / 已固定版本」，并列出与上次枚举相比的成员变化
  - `--all` 批量检查所有有快照的收藏集；`--models` 检查整个模型库；`--out <文件>` 导出报告；并与上次检查结果对比（新增问题 / 已修复）
- **本地校验与修复**（`npm run verify`）：不联网枚举，直接按模型库校验磁盘上的文件（可选只比大小），`--repair` 只重下损坏/缺失的文件，`--offline` 连浏览器都不用开
- **环境体检**（`npm run doctor`）：一条命令检查 Node、配置、curl、浏览器、调试端口、登录态、目录可写、磁盘空间、长路径支持，以及模型库里的模型/版本数量
- 输入更宽容：收藏集 ID、收藏集 URL、模型 URL 都能直接粘贴；`--collections` 可一次处理多个收藏集
- **可选硬件/网络加速**：
  - `engine: aria2`（或 `auto`）：装了 aria2c 就用多连接下载大文件（`-x8 -s8`），默认仍是 curl
  - `dedup: hardlink`（或 `copy`）：跨收藏集按 SHA256 内容去重，同一文件只保留一份数据（硬链接零额外占用）
  - `notifyWebhook` / `notifyToast`：任务结束后 POST 结果到 Webhook 或弹系统通知（另附终端响铃）
- **Chrome profile 按站点隔离**（`.data/chrome-profile/civitai.red`）：切换站点不会串会话/Cookie；显式配置了**非默认**的 `profileDir` 时保持原样
- **界面语言可切换**（`zh-CN` / `en`）：解析顺序为「显式 `-l` / `--lang` / `--language` 或 `config.json` 的 `language`」→「自动检测（`CIVITAI_LANG` / `LC_ALL` / `LANG` 环境变量，其次系统区域）」→「英文兜底」
- **模型是唯一事实源**：每个模型在 `.data/library.json` 里只有一条记录（不论来自多少个收藏集）；收藏集只是**成员快照**（`.data/collections/<ID>.json`），并附带新增/移除/版本变化报告
- **按类型分层目录**：`layout` 选择目录预设（`a1111`（默认）/ `comfy` / `custom` + `typeFolders`），`baseModelLayer` 可选再插一层底模，目录名用站点 Base Model 原值，例如 `Lora/SDXL 1.0/<模型>`（站点未给底模时用 `unknown`）
- **一个模型一个目录**：同一底模的所有版本放在同一目录；若两个版本的同名文件内容不同，**双方**都加上各自的 `-<版本>` 后缀（`model.safetensors` → `model-v1.safetensors` / `model-v2.safetensors`）；一旦某个目录进入「后缀模式」，之后的新版本即使不撞名也会带上自己的后缀，保持命名一致。**若同一个模型的版本横跨多个底模**（站点上确实存在，例如同一模型同时有 SDXL / SD 1.5 / Illustrious 版本），则按各自底模各放一处，避免把 SD 1.5 的 LoRA 放进 SDXL 目录；`models --relayout` 可把已有文件搬到新布局
- `--dry-run` 预览计划、`--only` 只下指定模型、`--force` 强制重下、`--refresh-meta` 重新比对线上清单
- 全流程日志落盘（`.data/download-<收藏集ID>.log`，按大小自动轮转，含耗时统计）
- 数据安全：模型库原子写入 + 自动备份 + 全局单锁（防止两个进程互相覆盖）；损坏的模型库会被备份并明确报错，而不是静默丢记录
- 旧的按目标分文件产物（`state-*.json`、`items-*.json`、`plan-*.json`、`report-*.json`）在新格式下一律忽略：首次运行会把它们移入 `.data/legacy/`

## 工作原理

1. **登录（`npm run login`）**：启动一个使用独立用户目录（`.data/chrome-profile`）的 Chrome，你手动完成登录（含人机验证）。会话保存在该 profile 中，并把 Cookie 导出为 Netscape 格式供 curl 使用；登录后会立即发一个最小请求校验登录态是否真的有效。
2. **枚举（`list` / `download`）**：连接到该浏览器，在站点页面上下文中携带登录态调用站点 tRPC 接口 `model.getAll`，分页拉取收藏集全部条目，并把这次枚举写成 `.data/collections/<ID>.json`（含成员变化）。若站点出现人机验证页会明确提示你手动完成。
3. **元数据**：通过公开接口 `GET /api/v1/model-versions/{版本ID}` 获取主 Model 文件信息（匿名可用），带重试、退避与限流；站点返回的原始版本对象会镜像进模型库记录。
4. **下载**：curl 携带登录 Cookie 请求 `/api/download/models/{版本ID}?fileId=...`，307 跳转到对象存储签名直链下载；完成后按 SHA256 校验，成功后把该模型的一条记录写入 `.data/library.json`。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows / macOS / Linux（需自备 curl 与 Chrome/Edge） |
| Node.js | ≥ 18（本项目在 v24 验证通过） |
| 浏览器 | Chrome（推荐）或 Edge，用于登录会话 |
| curl | Windows 10/11 自带；其它系统请自行安装 |

## 快速开始

```powershell
cd C:\Users\kongf\Downloads\loras\civitai-collection-downloader
npm install
copy config.example.json config.json    # 首次使用时创建配置
notepad config.json                     # 按需修改 outDir / jobs / proxy 等（见下文）
npm run doctor                          # 建议先体检一次
```

> 提示：若终端中文显示乱码，先执行 `chcp 65001`，或改用 Windows Terminal / VS Code 终端。

### 0a. Web 界面（推荐）

```powershell
npm run webui
```

> 启动命令已改名：`npm run web` 现在是 **`npm run webui`**，`npm run ui` 现在是 **`npm run tui`**。
> 两个界面都会保留，共用同一份配置、登录态与模型库。

会启动本地服务（默认 <http://127.0.0.1:4310/>）并打开浏览器。服务端零额外依赖（Node 自带 `http` 加一页原生 JavaScript，无需构建），
只监听 `127.0.0.1`，与命令行/TUI 共用同一份 `config.json`、登录态与模型库。

页面：

- **仪表盘**：站点、输出目录、剩余空间、登录态、模型库总量、一键环境体检、登录态探测，以及收藏集快照列表——
  点开某个快照可以看到成员与变化（新增 / 移除 / 版本变化）并重置变化项的记录，也可以直接跳到下载页
- **下载**：粘贴收藏集 ID/链接 → 服务端枚举并拉取每个条目的文件 → 按关键字/类型/底模筛选、排序、全选/只选未下载/全不选 → **逐项切换版本**、设置输出目录与并发 → 开始。同一页也支持**粘贴单个模型**
  （模型页链接 / `model:<id>` / `version:<id>`，一行一个），不需要收藏集。进度、速度、剩余时间、正在写的文件与完整日志都实时显示在底部抽屉里，也可以在那里取消
- **模型库**：可搜索的表格（也能按收藏集筛选）；点一行查看版本、目录、固定版本、下载指定版本、单模型检查/校验、删除记录（可选连文件一起删）
- **检查更新**：选择收藏集快照和/或模型库模型，快速或深度（SHA256）→ 每个目标一份报告 → **一键只下载变化项**
- **校验**：校验整个模型库或选中模型，深度或只比大小 → 列出异常文件与原因，并一键重新下载
- **设置**：分组表单编辑 `config.json`，保存前校验；切换语言会刷新界面
- **登录**：启动浏览器登录，完成后点「我已完成登录」；也可以只探测已保存的会话
- **帮助**：每个功能对应的工作流与命令行等价写法

参数（用 npm 启动时，参数要写在 `--` 之后）：

```powershell
npm run webui                              # 默认 127.0.0.1:4310
npm run webui -- --port 5000 --no-open     # 自定义端口、不自动开浏览器

node web.js --port 4310 --host 127.0.0.1   # 直接启动时的同样参数
node web.js --no-open
node web.js --lang en
node web.js --help
```

> TUI（`npm run tui`）与命令行依旧可用：三者共用同一份配置与模型库，可以混用。Web 界面通过 SSE 推送事件、
> 同一时间只跑一个任务，因此终端与浏览器看到的状态始终一致。

### 0b. 终端交互界面

```powershell
npm run tui
```

终端界面是一个整屏应用，而不是不断向上滚动的日志：启动时先清屏，之后屏幕上始终是同一个框架。

```
  civitai-downloader

  ┌── 仪表盘 ────────────────────────────────────────────────────┐
  │ 当前配置                                                     │
  │ 站点      https://civitai.com                                │
  │ 登录态    已导出（如提示过期请重新登录）                     │
  │ 下载目录  D:\downloads                                       │
  │ 并发      3                                                  │
  │                                                              │
  │ 任务总览                                                     │
  │ 总进度  ███████░░░░░░░░░ 42.5% · 完成 1/3 · 运行 1 · 排队 1  │
  └──────────────────────────────────────────────────────────────┘

  主菜单
  ────────────────────────────────────────────────────────────────

  ▸ 下载                  下载模型或收藏集：粘贴链接 / ID，勾选条目后开始
    本地模型管理          按模型管理本地文件：更新、校验、固定版本、删除记录
    本地收藏集管理        按收藏集管理：检查更新、重新下载、重置成员记录
    设置                  登录、下载目录、并发、代理等全部可修改项
    退出

  ↑↓ 选择 · Enter 进入 · Tab 任务视图 · Ctrl+C 退出
```

固定显示的部分：第一行是项目名，中间是**仪表盘**——先「当前配置」（站点 / 登录态 / 本地目录 / 并发），空一行后是**「任务总览」**（固定一行：对登记表里的全部任务合计出一条进度条、百分比与各状态数量；没有运行中/排队中的任务时回到「空闲」；按 `Tab` 看逐个任务详情）；下方是当前页面：一行**面包屑**（`主菜单 › 设置`，下面跟一条横线，用来看清自己在哪一层）+ 内容 +（需要时）一行临时提示 `✔ …`（5 秒后消失）；**最后一行是这一个页面的按键说明**。

原始日志不再常驻在屏幕上，而是**一页**：按 `L` 打开、再按 `L` 或 `Esc` 返回（`↑↓` / `PgUp` / `PgDn` 滚动），内容同时写进磁盘上的运行日志。页面上的结果用那一行提示呈现——保存成功、下载摘要、失败原因都在那里，细节去日志页看。

按键说明只有一份：页脚那一行由当前页面完全拥有，**只列出这一页真正能用的键**，不再分「全局」与「局部」。所以主菜单那一行不写 Esc（它在那里没有作用），输入框那一行不写 ↑↓，任务视图那一行会随选中任务变化（运行中 `c` / `s`，已结束 `r` / `d` / `l`），设置页那一行写「Enter 修改 / 执行」。终端太窄放不下这一行时，换成一行的紧凑写法（`↑↓ 选择 · Enter · Esc · Tab · Ctrl+C`）而不是截断。

两个「系统视图」随按随开、互斥：`Tab` 是任务视图、`L` 是日志页，各自的页脚写着各自的按键。**任务视图是下载进度与结果的唯一归属**：离开下载页面后下载继续运行，任务视图里能看到实时进度、当前文件、失败项与最终结果，以及 `c` 取消、`s` 跳过、`r` 重试失败项、`d` 打开目录、`l` 查看单任务日志尾部。

主菜单只有五项：

- **下载**：模型与收藏集的统一入口。选「下载模型」可粘贴模型链接、`model:<ID>`、`version:<ID>`（支持多行/逗号批量）；选「下载收藏集」则枚举条目并写入收藏集快照。两者随后共用同一套外壳流程：**计划页**（筛选 / 勾选 / `v` 逐项选版本 / `n` 只选未下载）→ **确认页**（合计、磁盘余量、输出目录、并发、已完成项处理、开始）→ **回执页**（已加入任务列表，`Tab` 看进度，`Esc` 退出下载界面）。已有下载在跑时，新下载会**排队**，前一个任务结束后自动开始
- **本地模型管理**：先看本地模型列表（`Enter` 进入某个模型），在单个模型的页面里做**针对这一个模型**的全部操作——检查更新、校验 / 修复文件、下载其它版本、固定 / 取消固定版本、打开所在目录、删除记录；列表页旁边也可以对整个模型库做一次「检查全部更新 / 校验全部文件」
- **本地收藏集管理**：先看收藏集列表（成员数、枚举时间、变化数），进入某个收藏集后可**检查更新**（快速/深度）、**重新下载**、**重置成员的重下标记**，并查看成员快照与新增/移除/版本变化
- **设置**：一页列出**所有可修改项**（站点、下载目录、浏览器、界面语言、并发、请求超时、重试、文件类型、目录布局、底模分层、仅 primary、下载引擎、去重、限速、代理、User-Agent、通知），每项后面跟着当前值；`Enter` 修改当前项，**确认后立刻写入 config.json**（没有单独的保存步骤，页脚也不会再问「是否保存」），`Esc` 直接返回。输入框里按 `Ctrl+R` 把当前项填回内置默认值（仍可编辑，`Enter` 才生效），列表最后一行的「全部恢复默认值」可一次性恢复整页设置（会先确认）。下载目录可以用 `Ctrl+O` 调出系统目录选择框（选完只是填进输入框，仍可改）。登录、打开下载目录与环境体检也在这里
- **退出**

按键：`↑↓` 移动（首尾循环）、`Enter` 选中/确认（并且一定进入下一个界面）、`Esc` 取消或返回上一级且不保存（在**主菜单里不生效**，避免连按 Esc 误退出）、`Tab` 随时切换任务视图（再按一次返回；运行中 `c` 取消、`s` 跳过当前模型，已结束 `r` 重试失败项、`d` 打开目录、`l` 单任务日志、`x` 清理已结束任务）、`L` 随时打开日志页（再按一次或 `Esc` 返回）、`Ctrl+C` 退出程序、`?` 打开按键速查。下载开始后，回执页按 `Esc` 只退出下载界面，任务继续在任务列表里跑；`s`（跳过）与 `c`（取消）在任务视图里；对运行中的任务按 Ctrl+C 会先请求取消。

设置页按键：`↑↓` 选择（首尾循环）、`Enter` 修改或执行、`Esc` 返回；输入框里 `Ctrl+R` 恢复默认值、`Ctrl+O` 选择目录。每次确认都会立即写盘，页脚下方会短暂显示 `✔ 已保存：<字段> = <新值>`；重填同样的值则显示「未修改」，不会写盘。

条目选择界面（条目多时）的按键：

| 按键 | 作用 |
|---|---|
| `↑`/`↓`、`k`/`j` | 移动光标（列表自动跟随滚动，光标始终可见）；`Home`/`End` 跳到首尾 |
| `PgUp`/`PgDn`、`[`/`]` | 向上 / 向下翻一屏 |
| `1`-`9` | 跳到第 n 行；`Shift`+`1`-`9` 直接勾选第 n 行 |
| `空格` | 勾选 / 取消当前项；`Shift`+`↑`/`↓` 连续勾选 |
| `a` / `i` | 对**当前筛选结果**全选（再按取消）/ 反选 |
| `n` / `c` | 只选目标版本尚未下载的项 / 清空选择（下载计划页） |
| `v` / `o` | 为当前项选版本 / 打开下载确认页（下载计划页） |
| `/` | 搜索（回车退出并保留关键字，`Esc` 退出并清空，支持退格） |
| `t` / `b` / `s` | 循环切换 类型 / 基础模型 / 排序（默认、名称、大到小、小到大） |
| `?` | 查看当前界面的按键速查 |
| `回车` | 确认（未选中会提示）；`Esc`/`q` 取消 |

每个列表的页脚只列出「此刻真正可用」的按键，列表自带位置与合计信息。所有「单选 / 多选」步骤用的都是同一个选择器，因此只需记住一套按键。

> 非交互环境（输出被重定向时）会自动回退到原来的逐步提问 + 多选界面；也可以用 `CIVITAI_PLAIN=1` 强制使用该模式。

> 喜欢命令行也可以继续使用下面的 `login` / `list` / `download` / `check` / `verify` 命令，两者共用同一套配置、登录态和模型库记录。

### 1. 登录

```powershell
npm run login
npm run login -- --check    # 只校验已保存的登录态，不开浏览器
```

会弹出 Chrome 窗口，请在其中登录 Civitai（如有人机验证请手动完成），然后回到终端按 `Enter`。看到「登录态校验通过」即成功。

登录态保存在 `.data/chrome-profile`，下次运行无需重新登录（除非站点会话过期）。

### 2. 查看收藏集

```powershell
npm run list -- 161131
npm run list -- https://civitai.red/collections/161131 --plan
npm run list -- 161131 --from-cache     # 不联网，用上次枚举缓存
```

输出示例：

```
收藏集 161131 共 20 项:
  1. [modelId=1191424] [versionId=1990837] Illustrious | LORA | PornMaster - rule 34 prompts - Illustrious & noob
  2. [modelId=1730869] [versionId=1958935] SDXL 1.0 | LORA | PornMaster-nose hook-鼻鈎
  ...
```

常用可选参数：`--plan`（同时取文件元数据并显示体积）、`--json`（机读输出）、`--from-cache`。

枚举结果同时会写成**成员快照** `.data/collections/161131.json`，并附带与上次枚举相比的成员变化（新增 / 移除 / 版本变化）；`check` 就是按这份快照比对，因此检查时不需要浏览器。

### 3. 下载

```powershell
npm run download -- 161131
npm run download -- 161131 --jobs 2
npm run download -- https://civitai.red/models/1191424?modelVersionId=1990837
npm run download -- 161131 --resume        # 继续上次取消的任务
```

常用可选参数：

| 参数 | 说明 | 示例 |
|---|---|---|
| `--out <目录>` | 覆盖下载目录（相对路径相对**项目根**） | `npm run download -- 161131 --out D:\models` |
| `--only <id[,id]>` | 只处理指定 modelId / versionId | `npm run download -- 161131 --only 276011` |
| `--version <m=v[,m=v]>` | 指定模型下载哪个版本 | `npm run download -- 161131 --version 1191424=1341400` |
| `--jobs <n>` | 同时下载的模型数（1-8） | `npm run download -- 161131 --jobs 3` |
| `--refresh-meta` | 重新拉元数据，发现同版本被重传的文件 | `npm run download -- 161131 --refresh-meta` |
| `--resume` | 从断点清单继续上次被取消的任务 | `npm run download -- 161131 --resume` |
| `--from-cache` | 用上次 `list` 生成的条目缓存，不重新枚举收藏集；配合 `--offline` 可完全不开浏览器 | `npm run download -- 161131 --from-cache --offline` |
| `--file-types <t,t>` | 只下载指定文件类型（默认 `Model`） | `npm run download -- 161131 --file-types Model,VAE` |
| `--force` | 忽略已完成记录，强制重新下载 | `npm run download -- 161131 --only 276011 --force` |
| `--dry-run` | 只列出计划不下载 | `npm run download -- 161131 --dry-run` |
| `--ignore-space` | 磁盘空间不足时仍继续 | |
| `--force-lock` | 忽略「已有其它进程在处理」的提示 | |
| `--reset-state` | 状态文件损坏时忽略损坏记录继续（损坏内容已自动备份） | |
| `--engine <name>` | 下载引擎：`curl`（默认）/ `aria2` / `auto` | `npm run download -- 161131 --engine aria2` |
| `--dedup <mode>` | 跨收藏集内容去重：`off`（默认）/ `hardlink` / `copy` | `npm run download -- 161131 --dedup hardlink` |
| `--notify <url>` | 任务结束后 POST 结果到 Webhook | `npm run download -- 161131 --notify https://example.com/hook` |
| `--toast` | 任务结束后弹系统通知 | |

> npm 传参请务必带 `--`，例如 `npm run download -- 161131`。也可以不用 npm，直接 `node cli.js download 161131`。

### 4. 检查更新

```powershell
npm run check -- 161131                 # 按收藏集成员快照快速检查（秒级）
npm run check -- 161131 --verify-files  # 深度检查（比对文件哈希）
npm run check -- --all                  # 检查所有有快照的收藏集
npm run check -- 161131 --download      # 检查后只下载有变化的项
npm run check -- 161131 --out report.json
```

对比模型库（`.data/library.json`，含每个文件的大小与 SHA256 清单）与收藏集成员快照（`.data/collections/<ID>.json`，由 `list` / `download` 写入）。输出分类：

- **成员变化**：与上次枚举相比新增 / 移除 / 版本变化的成员
- **有更新**：模型发布了新版本（本地记录 versionId ≠ 快照中的 versionId）
- **文件变化**：同版本下文件内容变了 / 改名 / 增删（需要深度检查）
- **本地缺失/损坏**：本地文件不存在、大小不符；深度检查时额外做 SHA256 校验
- **已固定版本**：该模型被 `pin` 固定，线上即使有新版也不会自动覆盖
- **已从收藏集移除**、**收藏集中未下载**：提示性信息

### 5. 校验与修复

```powershell
npm run verify -- 161131              # 完整 SHA256 校验该收藏集快照里的模型
npm run verify -- --all --no-hash     # 整个模型库，只比大小（快）
npm run verify -- model:1191424       # 只校验一个模型
npm run verify -- 161131 --repair --offline   # 只用已有 Cookie 修复损坏文件
```

### 6. 版本固定

```powershell
npm run pin -- --list                 # 查看模型库里已固定的模型
npm run pin -- 1191424                # 固定到最新记录的版本
npm run pin -- 1191424 1341400        # 固定到指定版本
npm run pin -- 1191424 --unpin        # 取消固定
```

### 7. 模型库（下载与管理）

不依赖收藏集，直接按模型/版本下载并管理。每个模型在 `.data/library.json` 里只有**一条**记录，所以同一个模型从两个收藏集下载也不会产生两份记录。

```powershell
# 下载（粘贴模型页 URL、model:<id> 或 version:<id> 均可）
npm run download -- https://civitai.red/models/1191424
npm run download -- model:1191424
npm run download -- version:1990837          # 只给版本号也行（自动反查所属模型）
npm run download -- model:1191424 --version 1191424=1341400   # 指定版本

# 批量粘贴多个模型（位置参数、--models、--from-file 都支持）
npm run download -- https://civitai.red/models/1191424 https://civitai.red/models/1730869
npm run download -- --models model:1191424,model:1730869
npm run download -- --from-file models.txt   # 一行一个 ref，# 开头是注释

# 管理
npm run models                                  # 列出整个模型库
npm run models -- --search lora --sort size     # 过滤 + 排序（name|size|recent）
npm run models -- --json                        # JSON 输出（结构与 --export 的 .json 相同）
npm run models -- --export models.json          # 也支持 .csv
npm run models -- --pin 1191424                 # 固定当前版本（也可 --pin 1191424=1990837）
npm run models -- --unpin 1191424
npm run models -- --forget 1191424              # 删除记录（默认保留本地文件）
npm run models -- --forget 1191424 --delete-files     # 同时删除记录里的文件并清理空目录
npm run models -- --forget 1191424 --version 1341400  # 只删某个版本的记录
npm run models -- --relayout --dry-run          # 只报告切换布局会移动哪些文件
npm run models -- --relayout                    # 真正把文件搬到布局目录

# 检查更新 / 校验修复（model:<id> 指定单个模型，--models 覆盖整个模型库）
npm run check  -- --models                       # 检查模型库里的全部模型
npm run check  -- --models --verify-files        # 深度：比对文件哈希
npm run check  -- model:1191424 --download       # 只下单个模型的变化项
npm run verify -- --models --repair --offline    # 校验并修复本地文件
npm run pin    -- 1191424 1990837                # 固定到某版本（model:1191424 也可）
npm run pin    -- --list                         # 列出所有已固定的模型
```

`check` / `verify` 用 `model:<id>`（或模型 URL）指定单个模型、用 `--models` / `--all` 覆盖整个模型库；收藏集 ID（`check 161131`）则比对 `list` / `download` 写下的**成员快照**，报告新增 / 移除 / 版本变化。固定与删除记录都按模型 ID 操作（`pin` / `models`）。

**同一模型可以同时保留多个版本**（例如 v1 与 v2 都在本地）：

- 目录由布局决定：`outDir/<类型目录>/<底模?>/<模型名>/`；**同一底模**的版本共用一个目录，**底模不同**的版本按底模各放一处
- 若两个版本的**同名文件内容不同**，双方都加上各自的 `-<版本>` 后缀（`model.safetensors` → `model-v1.safetensors` / `model-v2.safetensors`），让文件名能对应到版本；内容相同则共用同一份文件，不改名
- 每个版本的文件清单、SHA256 都独立记录；切换/重下不会相互影响
- `pin` 固定某个版本后，`check` 会报「已固定版本」而不是「有更新」
- 事后改了 `layout` / `baseModelLayer`？用 `npm run models -- --relayout` 把已有文件搬到新布局

### 下载结果

```
<outDir>\
├─ Lora\
│  ├─ Illustrious\
│  │  └─ rule34-BDSM-IL-V2.safetensors        (3.77 GiB)
│  └─ unknown\
│     └─ PornMaster-nose hook-鼻鈎\
│        ├─ model-v1.safetensors
│        └─ model-v2.safetensors
└─ checkpoints\
   └─ ...
```

- 目录遵循布局：一级是类型目录（`Lora`、`checkpoints`、`embeddings`…），可选一层底模（`baseModelLayer: true`，目录名用站点 Base Model 原值，站点没给时为 `unknown`），然后是模型标题
- 已做 Windows 非法字符替换；过长会自动缩短并保证唯一
- 模型库是 `.data\library.json`（schema v1）：`{ "schemaVersion": 1, "updatedAt", "entries": { "<模型ID>": { "name", "type", "baseModel", "creator", "stats", "nsfw", "mode", "pinnedVersionId", "versions": { "<版本ID>": { "versionName", "baseModel", "dirName", "outDir", "files": [...], "verifiedAt", "site": {...} } } } } }`——`site` 原样镜像 `/api/v1/model-versions/{ID}` 返回的对象（超长文本会截断），尽量不丢信息
- 收藏集快照是 `.data\collections\<收藏集ID>.json`：成员清单 + `changes { added, removed, versionChanged }`
- 想重下某个版本：用 `models --forget <id> --version <版本ID>`，也可用 TUI「模型库 → 删除记录」/「收藏集成员与变化 → 重置某个模型的重下标记」
- 运行日志：`.data\download-<收藏集ID>.log`（单模型为 `download-model-<模型ID>.log`，超过 5MB 自动轮转为 `.1`）
- 旧的 `state-*.json` / `items-*.json` / `plan-*.json` / `report-*.json` 从 v1 起一律忽略：首次运行会把它们移入 `.data\legacy\`（不删除，也不做迁移）

## 配置说明（config.json）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `site` | `https://civitai.red` | 站点地址，可改为 `https://civitai.com`（改后需重新登录） |
| `outDir` | `downloads` | 下载根目录，相对路径相对**项目根**（不再受启动目录影响） |
| `profileDir` | `.data/chrome-profile` | 登录会话使用的 Chrome 用户目录；**默认会再按站点分一层**（如 `.data/chrome-profile/civitai.red`）。想跨站点共用同一个目录（不推荐）就把本字段设成**不同于默认值**的路径，例如 `.data/chrome-profile-shared` |
| `chromePath` | 空 = 自动检测 | Chrome/Edge 路径（Windows/macOS/Linux 均有内置候选，失败时手动指定） |
| `debugPort` | `9222` | Chrome 远程调试端口，被占用时可改（如 9223） |
| `userAgent` | Chrome UA | 请求头使用的 User-Agent |
| `proxy` | 空 = 不使用 | 代理，如 `http://127.0.0.1:7890`（curl 与 API 请求都会走） |
| `headless` | `auto` | 浏览器窗口：`auto`（登录流程用可见窗口，之后无头不弹窗）/ `always` / `never`。无头模式不弹窗口；完全不需要浏览器的命令（单模型下载、`models`、本地 `verify`）则根本不启动浏览器 |
| `jobs` | `1` | 同时下载的模型数（1-8） |
| `metaConcurrency` | `4` | 元数据请求并发数（1-8） |
| `apiRateLimit` | `4` | 站点 API 每秒请求上限（0 = 不限） |
| `requestTimeoutMs` | `60000` | 单次 HTTP 请求超时 |
| `retries` | `3` | 元数据请求重试次数（识别 429 Retry-After） |
| `downloadAttempts` | `5` | 单个文件最大尝试次数 |
| `logMaxBytes` | `5242880` | 日志轮转阈值 |
| `engine` | `curl` | 下载引擎：`curl` / `aria2` / `auto`（有 aria2c 就用它） |
| `dedup` | `off` | 跨收藏集去重：`off` / `hardlink` / `copy` |
| `layout` | `a1111` | 目录布局预设：`a1111`（`Lora`、`Stable-diffusion`、`embeddings`、`VAE`、`ControlNet`、`ESRGAN`、`AnimateDiff`、`workflows`）/ `comfy`（`loras`、`checkpoints`、`embeddings`、`vae`、`controlnet`、`upscale_models`、`animatediff_models`、`workflows`）/ `custom`（用 `typeFolders`，缺失的类型回退 `other`） |
| `baseModelLayer` | `false` | 是否再按底模加一层目录，如 `Lora/SDXL 1.0/<模型>`。目录名**直接用站点 details 里的 Base Model 原值**（保留大小写与空格，只替换非法字符），所以同一个底模始终对应同一个目录；站点没有给底模时用 `unknown` |
| `typeFolders` | `{}` | 仅 `layout: "custom"` 使用：站点类型 → 目录名，例如 `{ "LORA": "lora", "Checkpoint": "ckpt" }` |
| `notifyWebhook` | 空 | 任务结束后 POST 结果的 Webhook 地址 |
| `notifyToast` | `false` | 任务结束后弹系统通知（Windows/macOS/Linux 尽力而为） |
| `language` | 空 = 自动 | 界面语言：`zh-CN` / `en`。留空时按「显式 `-l` / `--lang` / `--language` → 自动检测（`CIVITAI_LANG` / `LC_ALL` / `LANG`，其次系统区域）→ 英文兜底」解析 |
| `primaryOnly` | `true` | 多文件版本只下载主文件 |
| `fileTypes` | `["Model"]` | 参与下载的文件类型 |
| `trpcPath` | `model.getAll` | 站点 tRPC 过程名（站点改版时可覆盖） |
| `trpcInput` | `{}` | 站点 tRPC 请求体覆盖项（与内置模板浅合并） |

> 未知配置项不会导致失败，但会在启动时提示「配置提示: 未知配置项 …」，便于发现拼写错误。

## 项目结构

```
civitai-collection-downloader/
├─ web.js                  # Web 界面入口（npm run webui；本地服务 + 浏览器界面）
├─ ui.js                   # 终端交互界面入口（npm run tui）
├─ cli.js                  # 命令行入口（login / list / download / check / verify / pin / doctor）
├─ config.json             # 你的配置（.gitignore 已忽略）
├─ config.example.json     # 配置样例
├─ scripts/run-tests.js    # 顺序测试 runner（受限环境替代 node --test）
├─ tests/                  # 单元测试与集成测试（node:test）
├─ src/
│  ├─ config.js            # 配置加载、校验与路径解析
│  ├─ util.js              # 日志 / 哈希（worker 线程）/ 文件名清理 / 长路径 / 参数解析 / 并发池 / 重试
│  ├─ errors.js            # 类型化错误（认证 / 取消 / 限流 / 状态损坏 / 人机验证 …）
│  ├─ runtime.js           # 运行时装配（代理、API 上下文、错误呈现）
│  ├─ urls.js              # 输入解析（收藏集 ID/URL、模型 URL）
│  ├─ storage.js           # .data 数据路径 / 模型库与收藏集快照 / 全局锁 / 旧格式清理 / 日志轮转
│  ├─ layout.js            # 目录布局规则（类型目录、底模层、版本文件名规划）
│  ├─ browser.js           # Chrome 启动与连接（puppeteer-core，跨平台路径探测）
│  ├─ cookies.js           # 导出浏览器 Cookie（Netscape 格式）
│  ├─ collection.js        # 通过 tRPC 枚举收藏集条目 / 登录态探测 / 人机验证识别
│  ├─ api.js               # 版本文件元数据（重试 / 限流 / 并发）
│  ├─ manifest.js          # 文件清单双向比对（内容变化 / 改名 / 增删）
│  ├─ dedup.js             # 跨收藏集内容去重索引（SHA256 → 路径，硬链接/复制）
│  ├─ notify.js            # 任务结束通知（响铃 / 系统通知 / Webhook）
│  ├─ i18n.js              # 文案引擎（t / 占位符 / 语言回退）
│  ├─ i18n/                # 文案表（zh-CN.js / en.js，CLI + 核心模块 + TUI 全部文案）
│  │  └─ web/              # Web 界面文案（zh-CN.json / en.json，经 /api/i18n 下发）
│  ├─ ratelimit.js         # 匀速限流器
│  ├─ hashWorker.js        # SHA256 计算工作线程
│  ├─ downloader.js        # curl / aria2c 下载（断点续传 / ETag 校验 / 重试 / 取消）
│  ├─ job.js               # 下载任务主循环（CLI 与两个界面共用）
│  ├─ updater.js           # 检查更新（快速/深度）与版本固定
│  ├─ loginFlow.js         # 登录与登录态校验
│  ├─ commandSpec.js       # 命令与参数注册表
│  ├─ commands/            # 命令行子命令
│  │  ├─ login.js  list.js  download.js  check.js  verify.js  doctor.js  pin.js  models.js
│  ├─ webui/               # Web 界面
│  │  ├─ server.js         # http 服务：静态文件、JSON API、SSE 事件流、请求防护
│  │  ├─ api.js            # 路由表（方法 + 锚定正则 → 业务动作）
│  │  ├─ actions.js        # 业务动作，全部基于既有核心模块
│  │  ├─ jobs.js           # 任务管理（同一时间一个任务、日志、进度、取消）
│  │  ├─ progress.js       # 下载进度换算（磁盘字节、速度、剩余时间）
│  │  ├─ http.js           # JSON 请求体、静态文件、路径穿越防护、SSE 写入
│  │  └─ public/           # index.html + styles.css + app.js（无需构建）
│  └─ tui/                 # 终端交互界面
│     ├─ app.js            # 横幅 / 状态行 / 主菜单 / 分发
│     ├─ pages.js          # 公共交互：菜单、确认框、列表选择器、帮助页
│     ├─ select.js         # 全屏选择器（跟随光标的视窗、搜索/过滤/排序、帮助浮层）
│     ├─ keys.js           # 原始键盘处理（Ctrl+C / Ctrl+Z 语义）
│     ├─ layout.js         # 终端尺寸与字符集（ASCII 降级）
│     ├─ view.js  run.js   # 屏幕助手与下载进度面板
│     └─ download.js  check.js  models.js  login.js  manage.js  settings.js
└─ .data/                  # 运行时数据（会话 / Cookie / 缓存 / 状态 / 日志）
```

### 注释规范

代码注释统一采用**中英双语**，由 `node scripts/check-comments.js` 自动校验（CI 会跑）：

- 每个独立注释块都必须同时包含英文与中文，且**英文在前、中文在后**；
- 两种语言之间的空注释行按对照粒度决定：**单行对照不留空行**、**单段多行留 1 行空行**、**多段（任一侧 2 段以上）留 2 行空行**；
- 同一语言内部的段落之间恰好 1 行空行；行尾注释（`code; // …`）需在同一行内中英双语。

## 测试

```powershell
npm test           # node --test tests/（标准方式）
npm run test:seq   # 同一进程顺序执行（某些受限环境下 node --test 的子进程管道会被拒绝时使用）
```

覆盖：参数解析、模型库与收藏集快照、目录布局与版本文件名冲突（双方加后缀、幂等、多扩展名）、`models --relayout`、旧格式清理、原子写与损坏处理、清单比对（含改名/增删）、下载续传（完整分片、416、ETag 变化、哈希不符、取消、重试耗尽）、配置校验与站点隔离、API 重试/限流/超时、aria2 参数与引擎选择、内容去重、通知负载、三语言层（CLI / 核心模块 / TUI）的文案与中英切换、TUI 各层的纯函数（选择器的过滤/排序/滚动视窗/渲染、菜单与帮助页构造、进度面板文本、按键语义、终端尺寸与字符集）、Web 界面（任务管理、进度换算、路径穿越防护、HTTP API 与请求防护、静态文件与 SPA 回落、`web.*` 文案契约），以及一条端到端集成链路（枚举 → 元数据 → 下载 → 模型库与快照 → 检查更新 → 修复 → 断点续跑）。

测试文件：`tests/{util,storage,library,config,manifest,api,downloader,commands,platform,i18n,i18n-cli,i18n-core,i18n-tui,select,models,models-cli,integration}.test.js`。

## 常见问题（FAQ）

**1. 终端中文乱码？** 执行 `chcp 65001`，或使用 Windows Terminal / VS Code 终端。

**2. 提示「浏览器启动超时」或端口 9222 无响应？**
- 可能已有 Chrome 用同一 profile 打开，但没有开启调试端口——请先完全关闭它再重试；
- 或端口被其它程序占用——修改 `config.json` 的 `debugPort`；
- 先运行 `npm run doctor` 能看到具体是哪一种。

**3. 提示「未登录或登录已过期」（HTTP 401/403）？**
重新运行 `npm run login`；用 `npm run login -- --check` 可以快速确认登录态。下载过程中过期的话工具会自动重新导出 Cookie 重试一次。

**4. 下载中途断了怎么办？** 重跑同一条下载命令即可（curl 断点续传 + 已完成文件跳过）；如果是被 Ctrl+C 取消的，用 `--resume` 可直接续跑上次剩余的计划。

**5. 页面出现人机验证（Cloudflare）？** 在浏览器窗口中手动完成验证后重试；工具会明确提示是人机验证而不是报解析失败。

**6. 想下载 civitai.com 上的收藏集？** 修改 `config.json` 中 `"site": "https://civitai.com"`，重新运行 `npm run login` 登录即可（Chrome profile 会切到该站点的独立目录，互不干扰）。

**6b. 升级后提示要重新登录？** 新版本把 Chrome 用户目录按站点隔离了（`.data/chrome-profile/civitai.red`），旧登录态在被隔离前的共享目录里，所以需要重新登录一次。若确实想让多个站点共用一个目录（不推荐，容易串会话），把 `config.json` 的 `profileDir` 改成**不同于默认值**的路径（例如 `".data/chrome-profile-shared"`）。

**7. Cookie 安全吗？** `.data/cookies.txt` 含你的登录凭证（已尽量收紧文件权限），请勿分享或提交到代码仓库（项目 `.gitignore` 已忽略 `.data/`）。

**8. 只想先看看要下多少东西？** `npm run list -- <收藏集ID> --plan` 或 `npm run download -- <收藏集ID> --dry-run`。

**8b. 浏览器/站点用不了，但想继续下载或修复？** 先用 `npm run list -- <收藏集ID>` 生成条目缓存，之后可以 `npm run download -- <收藏集ID> --from-cache --offline`（完全不开浏览器，用已有 Cookie 直连下载）；修复损坏文件同理：`npm run verify -- <收藏集ID> --repair --offline`。

**9. 模型库损坏了会怎样？** 工具会把它备份为 `library.json.corrupt-<时间戳>` 并停止，不会静默清空记录；确认后删除原文件即可重新开始（已下载的文件不受影响）。

**9b. 同一模型想同时留 v1 和 v2 怎么办？** 直接分别下载两个版本即可（例如 `download model:<id>` 选 v1，再 `download model:<id> --version <id>=<v2>`）；两个版本都在同一个布局目录里，各自独立记录。若它们同名但内容不同，双方都会带上版本后缀（`model-v1.safetensors` / `model-v2.safetensors`），文件名始终能对应到版本。用 `models` 或 TUI「模型库 → 列出记录」可以看到全部版本。事后改了布局配置，用 `models --relayout`（先加 `--dry-run` 看计划）把文件搬过去。

**9c. 同一个模型在两个收藏集里，会有两条记录吗？** 不会。模型库 `.data/library.json` 一个模型只有一条记录；收藏集只是 `.data/collections/` 下的成员快照。`check <收藏集ID>` 按快照比对，`check --models` / `verify --models` 覆盖整个模型库。

**9d. 旧的 `state-*.json` 去哪了？** 新格式（schema v1）不再读取它们：首次运行会移入 `.data/legacy/` 并打印提示。不会删除、也不做迁移，相当于重新开始记录。

**10. 站点接口变了怎么办？** 先用 `npm run doctor` 与日志确认是哪一个请求失败；枚举接口可在 `config.json` 里覆盖 `trpcPath` / `trpcInput`，无需改代码。

**11. 界面看起来卡住不动了怎么办？** 页面内的请求都有 30 秒时限，连接挂起或标签页卡死会直接报错，不再无限等待；耗时阶段（启动浏览器、SHA256 校验）会先打印一行阶段说明，之后每 15 秒补一行「仍在等待…」。若某个界面仍然没有反应，按一次 `Ctrl+C` 取消（连按两次退出）；设置 `CIVITAI_TUI_DEBUG=1` 后复现，按键事件、原始模式接管与界面退出都会写入 `.data/tui-debug.log`。程序退出时一定会恢复终端（显示光标、关闭原始模式、退出备用缓冲区），即使崩溃也不会把终端留在异常状态。

## 免责声明

本工具仅用于个人备份与学习。请遵守 Civitai 的服务条款以及模型作者的版权与使用许可；内容可能包含成人向（NSFW）素材，请确保符合你所在地区的法律法规。使用者需自行承担一切责任。

## License

本项目采用 [MIT License](LICENSE)。
