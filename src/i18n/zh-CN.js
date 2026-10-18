'use strict';

/**
 * 中文（默认语言）文案表。
 *
 * 键名规范：`<模块>.<场景>[.<细节>]`，例如 `cli.unknownCommand`、`download.usage`。
 * 占位符用 `{name}` 形式，由 src/i18n.js 插值。
 *
 * 注意：默认语言必须保证既有输出与旧版本逐字一致（测试会断言部分文案）。
 * 多行的 usage() 文案整体作为一个键存放，保留原始缩进与换行。
 */

module.exports = {
  // 通用
  'common.yes': '是',
  'common.no': '否',
  'common.cancelled': '已取消',
  'common.back': '返回',
  'common.unknownError': '未知错误',
  'common.unknown': '未知',
  'common.tip': '提示',
  'common.settingsSaved': '设置已保存',
  'common.seconds': '{n} 秒',
  'common.minutesSeconds': '{m} 分 {s} 秒',
  'common.hoursMinutes': '{h} 时 {m} 分',
  'common.listSeparator': '，',
  'common.reasonSeparator': '；',

  // ---------------------------------------------------------------------------
  // cli.js
  // ---------------------------------------------------------------------------
  'cli.usage': `civitai-downloader

用法:
  node cli.js login [--check]                     打开浏览器完成登录并保存会话（--check 只校验登录态）
  node cli.js list <收藏集ID|URL> [--json] [--plan] [--from-cache]
  node cli.js download <收藏集ID|URL|模型URL> [选项]
  node cli.js check <收藏集ID…> [--verify-files] [--download] [--all] [--json] [--out <文件>]
  node cli.js verify [收藏集ID…] [--all] [--no-hash] [--repair] [--offline]
  node cli.js pin <收藏集ID> <modelId> [versionId] | --list | --unpin
  node cli.js models [--json] [--search <关键字>] [--sort <name|size|recent>] [--export <文件>]
  node cli.js doctor [收藏集ID] [--deep] [--json]

全局选项:
  -l / --lang / --language <en|zh-CN>   强制界面语言（也可在 config.json 里设置 language）

download 常用选项:
  --out <目录>  --only <id,id>  --version <modelId=versionId>  --force  --dry-run
  --jobs <n>  --refresh-meta  --resume  --file-types <t,t>  --no-primary  --ignore-space

npm 用法（传参需要 -- 分隔）:
  npm run login
  npm run list -- 161131 --plan
  npm run download -- 161131 --jobs 2
  npm run check -- 161131 --download
  npm run verify -- --all
  npm run doctor

提示: 也可以用 node cli.js <命令> --help 查看单个命令的说明。
`,
  'cli.unknownCommand': '未知命令: {cmd}\n',
  'cli.unknownFlag': '警告: 已忽略未知参数 --{flag}（用 --help 查看可用参数）',

  // ---------------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------------
  'loginFlow.openingPage': '打开登录页: {url}',
  'loginFlow.gotoFailed': '跳转登录页失败（可手动在浏览器中导航）: {message}',
  'loginFlow.pleaseLogin': '请在弹出的浏览器窗口中完成登录（已登录可忽略）',
  'loginFlow.captcha': '如出现人机验证，请在浏览器中手动完成',
  'loginFlow.confirmHint': '登录完成后回到本终端确认继续…',
  'loginFlow.cancelled': '已取消登录保存',
  'loginFlow.noAuthCookie': '未检测到登录凭证 Cookie（已导出 {count} 条 Cookie）。',
  'loginFlow.checkBrowser': '请确认浏览器中已登录成功，然后重新登录',
  'loginFlow.saved': '登录态已保存（{count} 条 Cookie）: {file}',
  'loginFlow.probeFailed': '登录态校验未通过：{reason}',
  'loginFlow.probeRetry': '请确认浏览器中已登录成功并完成人机验证，然后重新运行登录',
  'loginFlow.probeOk': '登录态校验通过',
  'loginFlow.nextStep': '下一步: npm run list -- <收藏集ID> 或 npm run download -- <收藏集ID>（TUI 中可直接下载）',
  'loginFlow.checkOk': '登录态有效',
  'loginFlow.checkFailed': '登录态无效：{reason}（请运行登录流程）',
  'login.usage': `用法: node cli.js login [--check]

  （无参数）打开浏览器完成登录并保存会话
  --check   只校验已保存的登录态是否有效，不打开登录页
`,

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------
  'list.usage': `用法: node cli.js list <收藏集ID|收藏集URL> [选项]

选项:
  --json        以 JSON 输出条目列表
  --plan        同时获取文件元数据，显示每个模型的文件与总大小
  --from-cache  不联网，直接使用上次枚举缓存（.data/items-<ID>.json）
`,
  'list.cacheMissing': '没有可用的缓存：{file}（请先不带 --from-cache 运行一次）',
  'list.usingCache': '使用缓存 {file}（枚举于 {time}）',
  'list.unknownTime': '未知时间',
  'list.enumerating': '枚举收藏集 {collectionId} 的条目…',
  'list.countHeader': '收藏集 {collectionId} 共 {count} 项:',
  'list.snapshotSaved': '成员快照已更新：{collectionId} 共 {count} 项（枚举于 {fetchedAt}）',
  'list.changes': '与上次枚举相比：新增 {added}，移除 {removed}，版本变化 {versionChanged}（上次枚举于 {previousFetchedAt}）',
  'list.firstSnapshot': '首次枚举',
  'list.changeAdded': '  + 新增 {name}',
  'list.changeRemoved': '  - 移除 {name}',
  'list.changeVersion': '  ~ 版本变化 {name}: {from} → {to}',
  'list.fetchingMeta': '获取文件元数据（并发 {concurrency}）…',
  'list.totalSize': '全部文件合计: {size}（已保存到 {file}）',
  'list.metaFailed': '其中 {count} 项元数据获取失败，可在下载时重试',
  'list.saved': '结果已保存: {file}',

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------
  'download.usage': `用法: node cli.js download <收藏集ID|收藏集URL|模型URL> [选项]

选项:
  --out <目录>        下载到指定目录（相对路径相对项目根）
  --only <id[,id]>    只处理指定 modelId / versionId（逗号分隔）
  --version <m=v[,m=v]>  指定模型下载哪个版本
  --force             忽略已完成记录，强制重新下载
  --dry-run           只列出下载计划，不实际下载
  --jobs <n>          同时下载的模型数（默认取 config.json 的 jobs）
  --refresh-meta      重新拉取元数据，以发现同版本被重传的文件
  --resume            从断点清单继续上次被取消的任务
  --from-cache        用上次 list 生成的条目缓存，不重新枚举收藏集（配合 --offline 可完全不开浏览器）
  --file-types <t,t>  只下载指定文件类型（默认 Model）
  --no-primary        不只下载 primary 文件
  --ignore-space      磁盘空间不足时仍然继续
  --force-lock        忽略「已有其它进程在处理该收藏集」的提示
  --reset-state       状态文件损坏时忽略损坏记录、从空状态继续（损坏内容已自动备份）
  --engine <name>     下载引擎：curl（默认）/ aria2 / auto
  --dedup <mode>      跨收藏集去重：off（默认）/ hardlink / copy
  --notify <url>      任务结束后 POST 结果到该 Webhook
  --toast             任务结束后弹系统通知
  --collections <id,id>  追加多个收藏集（依次处理）
  --model <URL|ID>    下载单个模型（也可直接作为位置参数传入模型 URL）
  --models <ref,ref>  批量下载单个模型（逗号分隔：模型 URL / model:<ID> / version:<ID>）
  --from-file <文件>  从文件读取要下载的目标（一行一个，空行与 # 注释会被忽略）

示例:
  node cli.js download 161131
  node cli.js download https://civitai.red/collections/161131 --jobs 2
  node cli.js download https://civitai.red/models/1191424?modelVersionId=1990837
  node cli.js download --models model:1191424,version:1990837
`,
  'download.versionFormat': '--version 格式错误: {pair}（应为 modelId=versionId）',
  'download.resumeRestored': '从断点清单恢复 {count} 项（保存于 {savedAt}）',
  'download.resumeMissing': '没有找到断点清单，将按正常流程执行',
  'download.noCache': '没有可用的条目缓存：{file}\n请先运行 node cli.js list {id} 生成缓存。',
  'download.usingCache': '使用条目缓存（枚举于 {fetchedAt}），共 {count} 项',
  'download.modelNoVersions': '模型 {modelId} 没有可用版本',
  'download.modelVersionNotFound': '模型 {modelId} 中未找到版本 {versionId}',
  'download.singleModel': '单模型下载: {name}（版本 {version}）',
  'download.unrecognizedArg': '无法识别的参数: {value}（应为收藏集 ID/URL 或模型 URL）',
  'download.badCollectionItem': '--collections 中的项无法识别: {value}',
  'download.badModelFlag': '--model 无法识别: {value}',
  'download.metaFailedHint': '提示：有 {count} 项元数据获取失败（多为临时网络问题），重跑同一命令即可重试',
  'download.modelsBadItem': '--models 中的项无法识别: {value}（应为模型 URL、model:<模型ID> 或 version:<版本ID>）',
  'download.fromFileError': '无法读取 --from-file 文件: {file}（{message}）',
  'download.fromFileEmpty': '--from-file 中没有有效的目标: {file}',
  'download.fromFileLoaded': '从 {file} 读取 {count} 个目标',
  'download.versionResolved': '由版本 {versionId} 定位到模型 {name}（{modelId}）',
  'download.versionNoModel': '版本 {versionId} 的元数据里没有 modelId，无法定位模型',

  // ---------------------------------------------------------------------------
  // check
  // ---------------------------------------------------------------------------
  'check.usage': `用法: node cli.js check <收藏集ID|收藏集URL|model:<模型ID>|模型URL> [更多目标…] [选项]

对比收藏集成员快照（或离线记录）与模型库，报告成员变化与本地文件状态（默认不下载）。
收藏集用 list/download 写下的成员快照比对（先运行一次 list）；model:<模型ID> / 模型 URL 只检查该模型。

选项:
  --verify-files     深度校验：拉取线上文件哈希并校验本地 SHA256（能发现同版本重传/改名/增删）
  --download         检查后只下载有变化的项（版本更新 / 文件变化 / 本地缺失）
  --all              检查所有有成员快照的收藏集
  --models           检查模型库里的全部模型
  --json             以 JSON 输出检查报告
  --out <文件>       把报告写入指定文件（JSON）
  --quiet            不输出逐项报告，只输出汇总

两种模式:
  默认「快速」：只比对版本号与本地文件大小，跳过已完成项的元数据请求（秒级）
  --verify-files「深度」：额外比对线上/本地文件哈希，可发现作者重传
`,
  'check.quietSummary':
    '收藏集 {collectionId}：共 {total} 项｜有更新 {updated}｜文件变化 {fileChanged}｜' +
    '缺失 {missing}｜未下载 {notDownloaded}｜固定版本 {pinned}',
  'check.modelQuietSummary':
    '模型 {label}：共 {total} 项｜有更新 {updated}｜文件变化 {fileChanged}｜' +
    '缺失 {missing}｜未下载 {notDownloaded}｜固定版本 {pinned}',
  'check.modelHeader': '— 模型 {label} —',
  'check.modelIdLabel': 'modelId={modelId}',
  'check.modelsNone': '还没有单模型下载记录（先运行 node cli.js download model:<模型ID>）',
  'check.modelVersionHint': '无法只凭版本号定位模型：请改用 model:<模型ID> 或模型 URL',
  'check.deltaNew': '新增问题 {count} 项',
  'check.deltaFixed': '已修复 {count} 项',
  'check.deltaSummary': '与上次检查（{checkedAt}）相比：{parts}',
  'check.unrecognizedCollection': '无法识别的收藏集: {value}',
  'check.collectionHeader': '— 收藏集 {collectionId} —',
  'check.reportWritten': '报告已写入 {file}',
  'check.changesFound': '共 {count} 项有变化，加 --download 可只下载这些项',
  'check.noChanges': '没有需要处理的变化',
  'check.noDownloadChanges': '没有需要下载的变化项',
  'check.stateReset': '已重置 {count} 项状态以便重新校验/下载',

  // ---------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------
  'verify.usage': `用法: node cli.js verify [收藏集ID…|model:<模型ID>…] [选项]

不联网枚举，直接按模型库校验文件（默认做完整 SHA256 校验）。

选项:
  --all          校验模型库里的全部模型
  --models       同 --all（保留的旧写法）
  --no-hash      只比对文件大小，不计算 SHA256（快很多）
  --repair       重新下载损坏/缺失的文件（需要记录里有下载直链）
  --offline      修复时不打开浏览器，直接使用已有 Cookie 文件
  --json         以 JSON 输出结果
`,
  'verify.summary': '{label}：共 {total} 个模型（{versions} 个版本），合计 {size}',
  'verify.allLabel': '模型库',
  'verify.collectionLabel': '收藏集 {collectionId}',
  'verify.modelLabel': '模型 {label}',
  'verify.libraryEmpty': '模型库为空（先下载一个收藏集或单个模型）',
  'verify.snapshotMissing': '收藏集 {value} 还没有成员快照，请先运行 node cli.js list {value}',
  'verify.corruptLine': '  ! {message}',
  'verify.brokenLine': '  ! {name}: {reasons}',
  'verify.brokenDir': '    目录: {dir}',
  'verify.counts': '  正常 {ok} 项，异常 {broken} 项',
  'verify.unrecognizedCollection': '无法识别的收藏集: {value}',
  'verify.brokenTotal': '共 {count} 项异常；加 --repair 可重新下载这些文件（--offline 可不开浏览器）',
  'verify.allPassed': '全部文件校验通过',
  'verify.nothingToRepair': '没有需要修复的文件',
  'verify.missingDownloadUrl':
    '提示：{name} 有 {count} 个文件缺少下载直链（旧记录），请先运行一次 check --verify-files 补齐',
  'verify.repairing': '修复 {name}（{count} 个文件）…',

  // ---------------------------------------------------------------------------
  // doctor
  // ---------------------------------------------------------------------------
  'doctor.usage': `用法: node cli.js doctor [收藏集ID] [--json] [--deep]

检查：Node 版本、配置、curl、浏览器、调试端口、Cookie、目录可写、磁盘空间、长路径支持。
  --deep  额外检查登录态是否真的有效（需要浏览器）
  --json  以 JSON 输出
`,
  'doctor.title': '环境体检',
  'doctor.tagOk': '[ OK ]',
  'doctor.tagWarn': '[警告]',
  'doctor.tagFail': '[失败]',
  'doctor.line': '{tag} {name}: {detail}',
  'doctor.hintLine': '        → {hint}',
  'doctor.summaryFails': '发现 {fails} 项问题、{warns} 项警告',
  'doctor.summaryWarns': '未发现阻断问题，{warns} 项警告',
  'doctor.summaryOk': '一切正常',
  'doctor.nodeVersion': '{version}（{platform} {arch}）',
  'doctor.itemConfigWarnings': '配置项',
  'doctor.hintConfigWarnings': '请检查 config.json 是否拼写错误',
  'doctor.itemConfigFile': '配置文件',
  'doctor.configMissingSuffix': '（不存在，使用默认值）',
  'doctor.hintConfigFileMissing': '可复制 config.example.json 为 config.json',
  'doctor.itemSite': '站点',
  'doctor.itemProxy': '代理',
  'doctor.curlAvailable': '{bin} 可用',
  'doctor.hintCurl': '安装 curl 或将其加入 PATH',
  'doctor.itemBrowser': '浏览器',
  'doctor.hintChromePath': '在 config.json 中指定 chromePath',
  'doctor.itemBrowserProfile': '浏览器 profile',
  'doctor.profileExplicit': '（显式配置，未按站点隔离）',
  'doctor.profileIsolated': '（已按站点隔离，换站点不会串会话）',
  'doctor.itemEngine': '下载引擎',
  'doctor.engineDetail': '配置 {engine}；aria2c {aria2}{dedup}',
  'doctor.aria2Available': '可用（多连接更快）',
  'doctor.aria2Missing': '未安装',
  'doctor.dedupSuffix': '；去重 {mode}',
  'doctor.hintAria2Missing': '未安装 aria2c：请安装或把 engine 改回 curl',
  'doctor.itemDebugPort': '调试端口',
  'doctor.portReady': '端口 {port} 已有浏览器（{browser}）',
  'doctor.unknownBrowser': '未知',
  'doctor.portNotReady': '端口 {port} 当前未就绪（{reason}）',
  'doctor.hintDebugPort': '运行时会自动启动浏览器；若被占用请改 config.json 的 debugPort',
  'doctor.itemLogin': '登录态',
  'doctor.cookiesMissing': '未找到 {file}',
  'doctor.hintRunLogin': '运行登录流程（npm run login）',
  'doctor.cookiesNoAuth': '已导出 {count} 条 Cookie，但未发现登录凭证',
  'doctor.hintRelogin': '重新运行登录流程',
  'doctor.credentialExpiring': '凭证即将过期（{expiresAt}）',
  'doctor.hintReloginSuggested': '建议重新登录',
  'doctor.cookiesOk': '已导出 {count} 条 Cookie，包含登录凭证',
  'doctor.itemOutDir': '输出目录',
  'doctor.dirError': '{dir}：{error}',
  'doctor.hintOutDirPermission': '检查目录权限或改用其它目录',
  'doctor.itemDataDir': '数据目录',
  'doctor.itemDiskSpace': '磁盘空间',
  'doctor.spaceUnknown': '无法读取',
  'doctor.spaceRemaining': '剩余 {size}',
  'doctor.itemLongPath': '长路径',
  'doctor.longPathOk': '可创建超过 260 字符的路径',
  'doctor.hintLongPath': '可在系统策略中启用长路径支持，或缩短 outDir',
  'doctor.itemSnapshot': '收藏集快照',
  'doctor.hintSnapshot': '删除 .data/collections 下对应文件可重新枚举',
  'doctor.snapshotMissing': '收藏集 {collectionId} 还没有成员快照（先运行 node cli.js list {collectionId}）',
  'doctor.hintRunList': '运行 list 或下载一次即可写入成员快照',
  'doctor.snapshotInfo': '收藏集 {collectionId} 有 {count} 项成员（枚举于 {fetchedAt}）',
  'doctor.itemLibrary': '模型库',
  'doctor.libraryStats': '{models} 个模型 / {versions} 个版本（用 node cli.js models 查看）',
  'doctor.hintLibrary': '模型库损坏：可删除 .data/library.json 后重新下载（本地文件不会被删除）',
  'doctor.hintLibraryList': '同一模型只保留一条记录，收藏集只是成员清单',
  'doctor.itemLanguage': '界面语言',
  'doctor.itemBrowserMode': '浏览器模式',
  'doctor.browserModeHeadless': '无头（不弹窗口；登录仍会用可见窗口）',
  'doctor.browserModeHeadful': '有窗口（首次登录需要）',
  'doctor.languageExplicit': '{language}（来自显式设置：-l/--lang 或 config.json）',
  'doctor.languageAuto': '{language}（自动检测的系统语言）',
  'doctor.languageFallback': '{language}（没有可用的系统语言，使用英文兜底）',
  'doctor.itemLoginProbe': '登录态实测',

  // ---------------------------------------------------------------------------
  // pin
  // ---------------------------------------------------------------------------
  'pin.usage': `用法:
  node cli.js pin <模型ID> [版本ID]        固定版本（省略版本ID = 固定当前已下载的最新版本）
  node cli.js pin model:<模型ID> [版本ID]  同上（兼容写法）
  node cli.js pin <模型ID> --list          列出该模型已固定的版本
  node cli.js pin <模型ID> --unpin         取消固定
  node cli.js pin --list                   列出模型库里全部已固定的模型
`,
  'pin.listHeader': '模型库：共 {total} 个模型，其中 {pinned} 个已固定版本',
  'pin.modelListHeader': '模型 {modelId}：{versions} 个版本，其中 {pinned} 项已固定版本',
  'pin.listEmpty': '暂无下载记录（.data/library.json 里还没有模型）',
  'pin.invalidTarget': '无法识别的目标: {value}（应为模型 ID 或 model:<模型ID>）',
  'pin.modelNoRecord': '模型 {modelId} 没有完成记录',
  'pin.listItem': '  * {name} → 固定 {version}',
  'pin.modelIdLabel': 'modelId={modelId}',
  'pin.emptyHint': '  提示: node cli.js pin <模型ID> 可把某个模型固定在当前版本',
  'pin.unpinned': '已取消固定: {name}（下次下载会跟随线上版本）',
  'pin.noVersion': '无法确定要固定的版本：记录中没有 versionId，请显式指定 versionId',
  'pin.pinned': '已固定: {name} → {version}',

  // ---------------------------------------------------------------------------
  // models（模型库：列表 / 导出 / 遗忘 / 固定 / 重排目录）
  // ---------------------------------------------------------------------------
  'models.usage': `用法: node cli.js models [选项]

列出并管理模型库（一个模型多个版本，一模型一记录）的下载记录（.data/library.json）。

选项:
  --json                     以 JSON 输出（结构与 --export 的 .json 相同）
  --search <关键字>           按名称或模型 ID 过滤
  --sort <name|size|recent>  排序：名称 / 体积（大→小）/ 最近完成（默认 recent）
  --export <文件>             导出为 .json 或 .csv（按扩展名决定格式）
  --forget <id[,id]>         从模型库中删除记录（1191424 或 model:1191424 均可）
  --version <versionId>      配合 --forget：只删除该版本的记录
  --delete-files             配合 --forget：同时删除记录中的文件，并清理空目录
  --pin <id>[=<versionId>]   固定版本（省略版本 = 固定最新记录的版本）
  --unpin <id>               取消固定
  --relayout                 按当前 layout / baseModelLayer 重新计算目录并移动已下载文件
  --dry-run                  配合 --relayout：只报告将要移动的内容，不改动磁盘与记录

--export 的 CSV 列: modelId,name,type,versionId,versionName,files,bytes,outDir,dirName,pinned,verifiedAt
（pinned 列表示该行版本是否为固定版本：yes 或空）

示例:
  node cli.js models
  node cli.js models --search lora --sort size
  node cli.js models --export models.csv
  node cli.js models --forget 1191424 --version 1990837 --delete-files
  node cli.js models --pin 1191424=1990837
  node cli.js models --relayout --dry-run
`,
  'models.listHeader': '模型库 {count} 项:',
  'models.listEmpty': '模型库暂无下载记录（node cli.js download model:<模型ID> 可下载单个模型）',
  'models.noMatch': '没有匹配的模型记录',
  'models.listLine': '  · {name}（modelId={modelId}）｜版本 {count} 个｜合计 {size}｜{pinned}',
  'models.versionLine': '版本: {versions}',
  'models.versionItem': '{name}（{versionId}，{size}）',
  'models.versionItemPinned': '{name}（{versionId}，{size}，已固定）',
  'models.noVersions': '（记录里没有版本信息）',
  'models.separator': '、',
  'models.dirLine': '目录: {dir}',
  'models.modelIdLabel': 'modelId={modelId}',
  'models.pinnedTag': '已固定 {version}',
  'models.notPinnedTag': '未固定',
  'models.corruptLine': '  ! {message}',
  'models.sortInvalid': '未知的排序方式: {value}（可选 name / size / recent）',
  'models.exportBadExt': '不支持的导出格式: {file}（请使用 .json 或 .csv）',
  'models.exportWritten': '已导出 {count} 条模型记录到 {file}',
  'models.forgetNoId': '--forget 至少需要一个模型 ID',
  'models.forgetNoRecord': '没有找到模型记录: {modelId}',
  'models.forgetNoVersion': '模型 {modelId} 中没有版本 {versionId} 的记录',
  'models.forgetModelsDone': '已删除 {count} 条模型记录',
  'models.forgetVersionsDone': '已删除 {count} 个版本记录',
  'models.forgetNothing': '没有删除任何记录',
  'models.filesDeleted': '已删除 {files} 个文件、{dirs} 个空目录',
  'models.filesMissing': '有 {count} 个记录中的文件已不存在（已跳过）',
  'models.legacyNoFiles': '记录没有文件清单，无法按记录删除文件: {modelId}',
  'models.deleteFilesHint': '提示: 加 --delete-files 可同时删除记录中的文件',
  'models.pinFormat': '--pin/--unpin 格式错误: {value}（应为 <模型ID> 或 <模型ID>=<版本ID>）',
  'models.noRecord': '没有找到模型记录: {modelId}',
  'models.pinNoVersion': '模型 {modelId} 没有可固定的版本记录',
  'models.pinVersionNotFound': '模型 {modelId} 中没有版本 {versionId} 的记录（已有: {versions}）',
  'models.pinDone': '已固定: {name} → {version}',
  'models.unpinDone': '已取消固定: {name}',
  'models.relayoutPlanned': '重排计划：{models} 个模型 / {versions} 个版本，将处理 {files} 个文件，其中 {renamed} 个因同名冲突需要改名',
  'models.relayoutDryRun': '（--dry-run）未改动任何文件与记录',
  'models.relayoutDone': '重排完成：{models} 个模型 / {versions} 个版本，处理 {files} 个文件、清理 {dirs} 个空目录，同名冲突改名 {renamed} 个（跨卷复制 {copied} 个）',
  'models.relayoutMissing': '有 {count} 个记录中的文件已不存在（已跳过）',

  // ---------------------------------------------------------------------------
  // runtime（错误呈现）
  // ---------------------------------------------------------------------------
  'runtime.configWarning': '配置提示: {message}',
  'runtime.fatalError': '错误: {message}',
  'runtime.hintAuth': '提示：请运行登录流程刷新会话（npm run login 或 TUI「登录 / 更新登录」）',
  'runtime.hintChallenge': '提示：请在浏览器窗口中完成人机验证后重试',
  'runtime.hintRateLimit': '提示：站点限流，可稍后重试或调低 config.json 的 apiRateLimit',
  'runtime.hintSiteInterface': '提示：站点接口可能已调整，可在 config.json 中覆盖 trpcPath / trpcInput',
  'runtime.hintNetwork': '提示：检查网络/代理设置（config.json 的 proxy）',

  // ---------------------------------------------------------------------------
  // util.js（错误与格式化，被其它模块复用）
  // ---------------------------------------------------------------------------
  'util.verifyCancelled': '校验已取消',
  'util.hashWorkerExited': '哈希线程异常退出（code {code}）',
  'util.emptyFile': '文件为空',

  // ---------------------------------------------------------------------------
  // notify.js
  // ---------------------------------------------------------------------------
  'notify.finished': '任务结束',
  'notify.cancelledSummary': '已取消：完成 {done}，跳过 {skipped}，失败 {failed}',
  'notify.summary': '完成 {done}，跳过 {skipped}，失败 {failed}',
  'notify.toastTitle': 'Civitai 下载任务结束',
  'notify.webhookFailed': 'Webhook 通知失败: {error}',

  // ---------------------------------------------------------------------------
  // config.js
  // ---------------------------------------------------------------------------
  'config.intRange': 'config.json 中 {key} 必须是 {range} 之间的整数（当前：{value}）',
  'config.hintSuffix': '（{hint}）',
  'config.required': 'config.json 中 {key} 不能为空{hint}',
  'config.invalidFormat': 'config.json 中 {key} 格式不正确：{value}{hint}',
  'config.unknownKey': '未知配置项 "{key}"（已忽略，请检查是否拼写错误）',
  'config.trpcInputNotObject': 'config.json 中 trpcInput 必须是对象（会与内置 tRPC 请求体模板合并）',
  'config.fileTypesInvalid': 'config.json 中 fileTypes 必须是非空字符串数组，例如 ["Model"]',
  'config.engineInvalid': 'config.json 中 engine 只能是 "curl"、"aria2" 或 "auto"',
  'config.dedupInvalid': 'config.json 中 dedup 只能是 "off"、"hardlink" 或 "copy"',
  'config.layoutInvalid': 'config.json 中 layout 只能是 "a1111"、"comfy" 或 "custom"（当前：{value}）',
  'config.typeFoldersNotObject': 'config.json 中 typeFolders 必须是对象，例如 { "LORA": "lora" }',
  'config.typeFoldersInvalid': 'config.json 中 typeFolders["{type}"] 必须是非空字符串',
  'config.headlessInvalid': 'config.json 中 headless 只能是 "auto"、"always" 或 "never"（当前：{value}）',
  'config.readFailed': '无法读取 config.json：{error}',
  'config.parseFailed': 'config.json 解析失败: {error}',
  'config.topLevelNotObject': 'config.json 顶层必须是一个对象',
  'config.hintSiteUrl': '需以 http(s):// 开头',
  'config.hintOutDir': '下载目录',
  'config.hintProxy': '如 http://127.0.0.1:7890',
  'config.hintWebhook': '如 https://example.com/hook',
  'config.languageUnsupported': 'config.json 中 language 不支持：{value}（可用 en、zh-CN，或留空自动解析）',

  // ---------------------------------------------------------------------------
  // browser.js
  // ---------------------------------------------------------------------------
  'browser.chromePathMissing': 'config.json 中 chromePath 指向的文件不存在：{path}',
  'browser.notFound':
    '未找到 Chrome/Edge。请安装 Chrome，或在 config.json 中设置 chromePath（当前系统：{platform}）',
  'browser.portNotDebug': '端口有响应但不是调试接口（可能被其它程序占用）',
  'browser.portNoWsUrl': '调试接口缺少 webSocketDebuggerUrl',
  'browser.connectTimeout': '连接超时',
  'browser.portNoResponse': '端口无响应',
  'browser.launching': '启动浏览器: {exe}',
  'browser.launchingHeadless': '启动无头浏览器（无窗口）: {exe}',
  'browser.debugPortLine': '  调试端口: {port}',
  'browser.proxyLine': '  代理: {proxy}',
  'browser.noResponse': '无响应',
  'browser.launchTimeout':
    '浏览器启动超时（30 秒，端口 {port}：{reason}）。\n' +
    '常见原因：\n' +
    '  1) 已有 Chrome 用同一个 profile（{profileDir}）在运行但没有开启调试端口 —— 请先完全关闭该浏览器再重试；\n' +
    '  2) 端口 {port} 被其它程序占用 —— 请修改 config.json 的 debugPort；\n' +
    '  3) 启动失败 —— 可在 config.json 中显式指定 chromePath。',
  'browser.connected': '已连接到运行中的浏览器（端口 {port}）',
  'browser.portOccupied': '端口 {port} 被其它程序占用（{reason}），将尝试启动新浏览器…',
  'browser.portNotReady': '端口 {port} {reason}，尝试启动新浏览器…',
  'browser.started': '浏览器已启动',
  'browser.startedHeadless': '无头浏览器已启动（不弹窗口）',

  // ---------------------------------------------------------------------------
  // collection.js
  // ---------------------------------------------------------------------------
  'collection.challengeProbe': '站点要求人机验证，请在浏览器窗口完成后再试',
  'collection.unauthorized': '未登录或登录已过期',
  'collection.trpcBadJson': 'tRPC 响应不是合法 JSON（接口结构可能已变更）：{sample}',
  'collection.trpcError': 'tRPC 错误: {message}',
  'collection.trpcDevalueFailed': 'tRPC 数据解析失败（devalue）：{message}',
  'collection.challenge': '站点返回了人机验证页面。请切换到浏览器窗口手动完成验证，然后重新运行本命令。',
  'collection.authRequired': '未登录或登录已过期，请先运行: npm run login',
  'collection.trpcRequestFailed': 'tRPC 请求失败 HTTP {status}: {sample}',
  'collection.unexpectedShape':
    '响应结构异常（接口结构可能已变更）：期望 items 数组，实际 {actual}\n原始响应片段: {sample}',
  'collection.usingPage': '使用页面: {url}',
  'collection.pageProgress': '  第 {page} 页: 返回 {count} 项，新增 {added}，累计 {total}',

  // ---------------------------------------------------------------------------
  // api.js
  // ---------------------------------------------------------------------------
  'api.requestFailed': '请求失败（{reason}）：{url}',
  'api.timeout': '超时',
  'api.rateLimited': 'HTTP 429（触发站点限流）',
  'api.authRequired': 'HTTP {status}：未登录或登录已过期',
  'api.notFound': 'HTTP 404：{url}',
  'api.httpError': 'HTTP {status}：{url}',
  'api.badJson': '响应不是合法 JSON（接口结构可能已变更）：{url}',
  'api.retrying': '  请求失败（第 {attempt} 次）：{message}，{seconds} 秒后重试',
  'api.noLatestVersionLine': '[{index}/{total}] {name} -> 没有可用的最新版本',
  'api.noLatestVersion': '没有最新版本',
  'api.noFiles': '没有可下载的 {types} 文件（接口结构可能已变更）',
  'api.itemFiles': '[{index}/{total}] {name} | {count} 个文件 | {size}',
  'api.metaFailedLine': '[{index}/{total}] 元数据获取失败: {name} -> {message}',

  // ---------------------------------------------------------------------------
  // storage.js
  // ---------------------------------------------------------------------------
  'storage.stateCorrupt':
    '文件无法解析（{reason}）：{file}\n已备份为 {backup}。' +
    '确认后删除该文件可重新开始记录（本地已下载文件不会被删除）。',
  'storage.backupFailed': '(备份失败)',
  'storage.reasonEmpty': '文件为空',
  'storage.reasonUnknown': '未知原因',
  'storage.reasonNotObject': '顶层不是对象',
  'storage.reasonNoEntries': '顶层缺少 entries 对象',
  'storage.lockConflict':
    '另一个进程正在使用模型库（PID {pid}，开始于 {startedAt}）。\n' +
    '若确认没有其它任务在运行，可加 --force 重试，或删除锁文件：{file}',
  'storage.unknownStart': '未知',
  'storage.lockFailed': '无法获取模型库的锁文件：{file}',
  'storage.legacyMoved': '已将 {count} 个旧格式文件移入 {dir}（新格式不再读取它们）',

  // ---------------------------------------------------------------------------
  // downloader.js
  // ---------------------------------------------------------------------------
  'downloader.curlExitCode': '{bin} 退出码 {code}',
  'downloader.curlLastError': '（最后一次尝试：{error}）',
  'downloader.curlMissing': '未找到可用的 curl{detail}。请安装 curl（Windows 10/11 自带）或将其加入 PATH。',
  'downloader.aria2Missing':
    'config.json 指定了 engine=aria2，但未找到 aria2c（请安装后加入 PATH，或改用 curl）',
  'downloader.existingHashMismatch': '  已存在的文件哈希不匹配，将重新下载: {file}',
  'downloader.partTooLarge': '  已存在的分片超出预期大小（{size}），丢弃',
  'downloader.partReused': '  使用已完成的分片: {file}',
  'downloader.partVerifyFailed': '  已完整的分片校验不通过，删除后重新下载: {file}',
  'downloader.remoteChanged': '  远端文件已变化（ETag 不同），丢弃旧分片重新下载',
  'downloader.authFailed': '认证失败（HTTP {status}），登录可能已过期，请重新运行: npm run login',
  'downloader.notFound404': 'HTTP 404: 下载链接无效或文件已下架',
  'downloader.rangeRejected': '  服务端拒绝续传（HTTP 416），丢弃分片重新下载',
  'downloader.rateLimited': '  触发限流（HTTP 429），等待 30 秒后重试',
  'downloader.resumeFailed': '  续传失败（{engine} exit {code}），丢弃分片重新下载',
  'downloader.attemptFailed': '  第 {attempt}/{attempts} 次失败（exit={code}, HTTP {http}）{detail}，稍后重试',
  'downloader.attemptNoFile': '  第 {attempt}/{attempts} 次未产生文件，稍后重试',
  'downloader.sizeExceeded': '  文件超出预期大小（{size} > {expected}），删除后重试',
  'downloader.shaMismatch': '  SHA256 不匹配（实际 {actual}），删除后重新下载',
  'downloader.hashComputeFailed': '计算失败',
  'downloader.resuming': '  已下载 {size} / {total}，继续断点续传（第 {attempt}/{attempts} 次）',
  'downloader.failed': '下载失败（已重试 {attempts} 次）: {file}',

  // ---------------------------------------------------------------------------
  // job.js
  // ---------------------------------------------------------------------------
  'job.offlineNeedsPlan': '离线模式下必须提供下载计划（--resume 或 verify --repair），无法枚举收藏集',
  'job.start': '=== 开始 === 收藏集 {collectionId} | 输出目录: {outDir}',
  'job.corruptWarning': '警告：{message}',
  'job.resetStateNotice': '已按 --reset-state 忽略损坏记录，从空模型库重新开始（本地已下载文件不会被删除）。',
  'job.snapshotSaved': '收藏集快照已更新：{count} 项（新增 {added}，移除 {removed}，版本变化 {versionChanged}）',
  'job.filesRenamed': '旧版本文件名冲突，已重命名 {count} 个文件（模型 {name}）',
  'job.versionSuffix': '{name} 的版本 {version} 与已下载版本同名，文件名统一加版本后缀',
  'job.onlyFiltered': '--only 过滤: {before} -> {after} 项',
  'job.onlyNoMatch': '没有匹配 --only 的项目，请检查 ID',
  'job.emptyCollection': '收藏集为空，无内容可下载',
  'job.versionAdded': '新增版本 {name}: {to}（本地已保留 {from}）',
  'job.fetchingMeta': '获取文件元数据（{count} 项，并发 {concurrency}）…',
  'job.resolvingVersions': '解析指定版本（{count} 项）…',
  'job.versionNotFound': '未找到版本 {versionId}',
  'job.versionNoFiles': '该版本没有可下载的文件',
  'job.versionOverride': '版本覆盖({source}): {name} -> {version}',
  'job.versionOverrideFailed': '版本覆盖失败: {message}',
  'job.versionOverrideIgnored': '--version 指定的 modelId {modelId} 不在本次计划中，已忽略',
  'job.noMetadata': '未获取到元数据',
  'job.contentUnchanged': '内容未变化，跳过 {name}',
  'job.planSummary': '下载计划: {todo} 项待下载，{skipped} 项已完成，共 {total}',
  'job.metaFailedItem': '元数据失败: {name} -> {error}',
  'job.planLine': '  [计划] {name} / {file} ({size})',
  'job.dryRunDone': '--dry-run 结束，未下载任何文件',
  'job.nothingToDownload': '没有需要下载的内容（全部已完成；如需强制重下请加 --force）',
  'job.summary': '{head} 完成 {done}，跳过 {skipped}，失败 {failed}{metaFailed}（用时 {elapsed}）',
  'job.summaryMetaSuffix': '，元数据失败 {count}',
  'job.headDone': '=== 结束 ===',
  'job.headCancelled': '=== 已取消 ===',
  'job.insufficientSpace': '磁盘空间不足：计划下载 {total}，但 {dir} 所在磁盘仅剩 {free}。',
  'job.insufficientSpaceHint': '可清理磁盘后重试，或加 --ignore-space 忽略该检查。',
  'job.offlineNoCookies': '离线模式下需要已存在的 Cookie 文件：{file}\n请先运行登录流程。',
  'job.offlineUsingCookies': '离线模式：直接使用现有 Cookie 文件 {file}',
  'job.unknownCookieCount': '未知',
  'job.cookiesExported': '已导出浏览器 Cookie（{count} 条）-> {file}',
  'job.browserSkipped': '无需浏览器（已有 Cookie，直接走 HTTP 下载）',
  'job.dedupEnabled': '内容去重已开启（{mode}）',
  'job.modeHardlink': '硬链接',
  'job.modeCopy': '复制',
  'job.stateWriteFailed': '状态写入失败: {message}',
  'job.itemSkipped': '已跳过 {name}（已下载的 .part 文件保留，可续传）',
  'job.downloadLine': '下载 [{index}/{total}] {name} / {file} ({size})',
  'job.dedupLine': '  内容去重（{mode}）: {file} ← {source}',
  'job.dedupFailed': '  去重失败（{message}），改为正常下载: {file}',
  'job.authRefreshing': '登录态可能已过期，正在重新导出 Cookie 并重试…',
  'job.cookiesRefreshed': '已重新导出 {count} 条 Cookie',
  'job.cancelNotice': '已取消当前下载（已下载的 .part 文件保留，可续传）',
  'job.fileFailed': '  失败: {file} -> {message}',
  'job.fileVerified': '  已存在且校验通过: {file}',
  'job.fileDeduped': '  已通过内容去重就位: {file}',
  'job.fileDownloaded': '  下载完成并校验通过: {file}',
  'job.itemDone': '完成 {name}（完成 {done} / 跳过 {skipped} / 失败 {failed}）',
  'job.queueSaved': '已保存断点清单（{count} 项）-> {file}，可用 --resume 继续',
  'job.queueSaveFailed': '断点清单保存失败: {message}',
  'job.logFile': '日志文件: {file}',

  // ---------------------------------------------------------------------------
  // updater.js
  // ---------------------------------------------------------------------------
  'updater.missingFile': '缺失 {file}',
  'updater.sizeMismatch': '大小不符 {file}',
  'updater.shaMismatch': 'SHA256 不符 {file}',
  'updater.verifying': '  校验 {file} …',
  'updater.noMetadata': '未获取到元数据',
  'updater.snapshotMissing': '收藏集 {collectionId} 还没有成员快照，请先运行 node cli.js list {collectionId}',
  'updater.snapshotLine': '成员快照：{count} 项（枚举于 {fetchedAt}）',
  'updater.changesLine': '与上次枚举相比：新增 {added}，移除 {removed}，版本变化 {versionChanged}（上次枚举于 {previousFetchedAt}）',
  'updater.firstSnapshot': '首次枚举',
  'updater.corruptLine': '  ! {message}',
  'updater.fetchingMeta': '获取线上文件元数据（{count} 项，并发 {concurrency}）…',
  'updater.unknownVersion': '未知版本',
  'updater.checkDone': '检查完成：收藏集 {collectionId} @ {checkedAt}（{mode}）',
  'updater.deepCheck': '深度校验',
  'updater.quickCheck': '快速检查',
  'updater.noState': '该收藏集暂无下载记录，先运行下载后再来检查更新',
  'updater.updatedHeader': '【有更新】{count} 项',
  'updater.updatedLine': '  ↑ {name}: {from} → {to}',
  'updater.pinnedHeader': '【已固定版本（不随线上更新）】{count} 项',
  'updater.pinnedLine': '  * {name}: 固定 {pinned}，线上已是 {online}',
  'updater.fileChangedHeader': '【文件变化（同版本重传）】{count} 项',
  'updater.changePart': '内容变化: {names}',
  'updater.addedPart': '新增: {names}',
  'updater.removedPart': '移除: {names}',
  'updater.renamedPart': '改名: {names}',
  'updater.renamePair': '{from}→{to}',
  'updater.fileChangedLine': '  ~ {name}: {parts}',
  'updater.nameSeparator': '、',
  'updater.uncheckedChanges':
    '【文件变化】未检查（快速模式只比对版本号与本地文件大小；加 --verify-files 可检查同版本重传）',
  'updater.missingHeader': '【本地缺失/损坏】{count} 项',
  'updater.missingLine': '  ! {name}: {reasons}',
  'updater.legacyHeader': '【旧记录（无文件清单，未做本地校验）】{count} 项',
  'updater.legacyLine': '  ? {name}',
  'updater.legacyHint': '  提示: 用 --verify-files（TUI 中勾选深度校验）可校验本地文件并补齐清单',
  'updater.upgradedHeader': '【已校验并补齐清单】{count} 项',
  'updater.failedHeader': '【元数据获取失败，跳过】{count} 项',
  'updater.failedLine': '  x {name}: {error}',
  'updater.removedHeader': '【已从收藏集移除（本地文件保留）】{count} 项',
  'updater.removedLine': '  - {name}',
  'updater.modelIdLabel': 'modelId={modelId}',
  'updater.notDownloadedHeader': '【收藏集中未下载】{count} 项（需要下载请在下载流程中勾选）',
  'updater.allGood': '全部正常：{count} 项已下载且为最新',
  'updater.stats':
    '统计：共 {total} 项（有更新 {updated}，文件变化 {fileChanged}，' +
    '缺失 {missing}，未下载 {notDownloaded}，固定版本 {pinned}）',
  'updater.modelCheckDone': '检查完成：模型 {name}（{modelId}）@ {checkedAt}（{mode}）',
  'updater.fetchingModel': '获取模型 {modelId} 的版本信息…',
  'updater.noOnlineVersions': '站点上没有可用版本',
  'updater.versionGoneOnline': '线上已不存在该版本',
  'updater.notDownloadedShort': '未下载',
  'updater.removedVersionSuffix': '（版本 {versionId}）',
  'updater.historyHeader': '【本地保留的历史版本】{count} 项',
  'updater.historyLine': '  · {name}：{versions}',

  // ---------------------------------------------------------------------------
  // TUI（终端交互界面，src/tui/**）
  // 注意：光标符号（▸）、进度条字符（█░）、勾选框（[×]/[ ]）、标签括号（[ OK ] 等）
  //       以及缩进/分隔符（· / ｜ / 空格）保留在代码里，文案表只放用户可读文字。
  // ---------------------------------------------------------------------------

  // app.js：横幅 / 上下文行 / 主菜单
  'tui.app.bannerTitle': 'civitai-downloader',
  'tui.app.bannerHint': '↑↓ 选择 · 回车确认 · Ctrl+C 取消/退出；下载中按 s 跳过当前模型',
  'tui.app.loggedIn': '已导出（如提示过期请重新登录）',
  'tui.app.notLoggedIn': '未登录',
  'tui.app.contextLine': '站点 {site} · 输出目录 {outDir} · 并发 {jobs} · 登录态 {logged}',
  'tui.app.menuTitle': '主菜单',
  'tui.app.menuDownload': '下载收藏集',
  'tui.app.menuDownloadDesc': '枚举条目 → 筛选/勾选 → 选版本 → 下载（支持断点续传）',
  'tui.app.menuModels': '模型库',
  'tui.app.menuModelsDesc': '下载/管理模型（一个模型多版本）：检查更新、校验、固定版本、删除记录',
  'tui.app.menuCheck': '检查更新',
  'tui.app.menuCheckDesc': '按收藏集成员快照与模型库对比，并只下载变化项',
  'tui.app.menuVerify': '校验 / 修复本地文件',
  'tui.app.menuVerifyDesc': '按模型库记录校验文件完整性，可只重下损坏的文件',
  'tui.app.menuLogin': '登录 / 更新登录',
  'tui.app.menuLoginDesc': '打开浏览器完成 Civitai 登录，或只校验登录态',
  'tui.app.menuManage': '收藏集成员与变化',
  'tui.app.menuManageDesc': '查看收藏集快照时间与新增/移除/版本变化，可重置某个模型的重下标记',
  'tui.app.menuSettings': '设置',
  'tui.app.menuSettingsDesc': '编辑 config.json（目录、站点、并发、代理等）',
  'tui.app.menuDoctor': '环境体检',
  'tui.app.menuDoctorDesc': '检查 curl / 浏览器 / 端口 / 登录态 / 磁盘空间',
  'tui.app.menuOpen': '打开下载目录',
  'tui.app.menuOpenDesc': '在资源管理器中打开当前输出目录',
  'tui.app.menuExit': '退出',
  'tui.app.opened': '已打开: {dir}',
  'tui.app.openFailed': '打开目录失败',
  'tui.app.operationFailed': '操作失败: {error}',
  'tui.app.goodbye': '再见。',

  // view.js
  'tui.view.goodbye': '再见。',

  // select.js：排序标签 / 按键提示 / 状态文案
  'tui.select.sortDefault': '默认排序',
  'tui.select.sortName': '按名称',
  'tui.select.sortSizeDesc': '按大小↓',
  'tui.select.sortSizeAsc': '按大小↑',
  'tui.select.keyHintMove': '↑/↓·k/j 移动｜Home/End 首尾｜PgUp/PgDn·[ ] 翻页',
  'tui.select.keyHintSelect': '空格 勾选｜a 全选/全不选｜i 反选｜/ 搜索',
  'tui.select.keyHintAction': 't 类型｜b 模型｜s 排序｜回车 确认｜Esc/q/Ctrl+C 取消',
  'tui.select.statusDownloaded': '已下载',
  'tui.select.statusUpdated': '版本有更新',
  'tui.select.statusPinned': '已固定版本',
  // select.js：表头 / 列头 / 页脚
  'tui.select.filterSearchQuoted': '搜索：“{value}”',
  'tui.select.filterSearchOff': '搜索：未启用',
  'tui.select.filterType': '类型：{value}',
  'tui.select.filterBaseModel': '基础模型：{value}',
  'tui.select.filterSort': '排序：{value}',
  'tui.select.filterPage': '第 {page}/{pageCount} 页',
  'tui.select.allValues': '全部',
  'tui.select.summary':
    '已选 {selected} 项 / 共 {total} 项 · 过滤后 {visible} 项 · 合计 {selectedSize}（全部 {visibleSize}）',
  'tui.select.defaultTitle': '选择要下载的条目',
  'tui.select.columnIndex': '序号',
  'tui.select.columnName': '名称',
  'tui.select.columnDetail': '状态 / 类型 / 基础模型',
  'tui.select.columnSize': '大小',
  'tui.select.footer': '第 {page}/{pageCount} 页 · 本页 {count} 项 · 已选 {selected}/{total}',
  'tui.select.noMatches': '没有匹配的条目（用 / t b 调整过滤）',
  'tui.select.typing': '输入中…',
  // select.js：操作反馈
  'tui.select.toggledOn': '已勾选',
  'tui.select.toggledOff': '已取消勾选',
  'tui.select.allCleared': '已取消全选',
  'tui.select.allSelected': '已全选 {count} 项',
  'tui.select.inverted': '已反选',
  'tui.select.searchExited': '已退出搜索输入',
  'tui.select.messageSearch': '搜索：{value}',
  'tui.select.searchCleared': '已清空搜索',
  'tui.select.searchHint': '输入关键字（回车/Esc 退出输入）',
  'tui.select.needSelection': '请先选择至少 1 项（空格勾选 / a 全选）',
  'tui.select.noItems': '没有任何可选择的条目',
  'tui.select.selectorUnavailable': '交互式选择器不可用（{error}），改用简易选择',
  'tui.select.selectorRenderFailed': '交互式选择器渲染失败（{error}），改用简易选择',

  // run.js：下载进度面板
  'tui.run.downloading': '下载中',
  'tui.run.counts': '完成 {ok} · 跳过 {skipped} · 失败 {failed} / 共 {total} 项',
  'tui.run.remaining': '剩余 {eta}',
  'tui.run.current': '当前 {name}',
  'tui.run.retry': '[第 {attempt}/{max} 次尝试 HTTP {code}]',
  'tui.run.waiting': '当前 · 等待下一项…（按 s 跳过当前模型，Ctrl+C 取消）',
  'tui.run.cancelNotice': '收到 Ctrl+C，正在取消（再按一次强制退出）…',
  'tui.run.skipNotice': '收到跳过请求，将跳过当前模型（已下载部分保留）…',

  // download.js：筛选 / 勾选
  'tui.download.prefilterHint': '可用 / 搜索、t 类型、b 基础模型、s 排序 在全屏列表里筛选，不再逐步提问',
  'tui.download.keywordPrompt': '共 {count} 项，可先输入关键字筛选（留空 = 全部）',
  'tui.download.filterByType': '按类型筛选',
  'tui.download.allTypes': '全部类型',
  'tui.download.filterByBaseModel': '按基础模型筛选',
  'tui.download.allBaseModels': '全部基础模型',
  'tui.download.noMatch': '筛选后没有匹配的条目',
  'tui.download.filterResult': '筛选结果：{filtered} / {available} 项',
  'tui.download.metaExcluded': '有 {count} 项元数据获取失败，已从列表排除',
  'tui.download.noDownloadable': '没有任何可下载项',
  'tui.download.doneCount': '其中 {count} 项已完成（默认不勾选；如需重下可在后面选择强制重下）',
  'tui.download.fileCount': '{count} 个文件',
  'tui.download.statusDownloaded': '已下载',
  'tui.download.statusUpdated': '版本有更新',
  'tui.download.statusPinned': '已固定版本',
  'tui.download.selectTitle': '选择要下载的条目（共 {count} 项，合计 {size}）',
  'tui.download.selectionCancelled': '已取消选择',
  'tui.download.multiselectInstructions': '空格勾选/取消，a 全选/全不选，回车确认',
  'tui.download.noneSelected': '未选择任何条目',
  // download.js：版本选择
  'tui.download.versionListFailed': '版本列表获取失败（保持默认版本）: {name} -> {error}',
  'tui.download.singleVersionOnly': '所选模型均只有一个版本，无需选择',
  'tui.download.multiVersionNotice': '其中 {count} 个模型包含多个版本，请逐个选择（默认 = 收藏集当前版本）',
  'tui.download.currentMark': '（当前）',
  'tui.download.versionDescription': '{baseModel} · {files} · {size} · {date}',
  'tui.download.unknownDate': '未知日期',
  'tui.download.chooseVersionTitle': '选择版本 · {name}',
  'tui.download.versionSwitched': '已切换版本: {name} -> {version}',
  'tui.download.pinConfirm': '已手动指定 {count} 个模型的版本，是否固定这些版本（下次下载不再自动跟随新版）？',
  'tui.download.pinMarked': '已标记固定；下载完成后会写入完成记录',
  // download.js：下载选项
  'tui.download.outDirPrompt': '输出目录（相对路径相对项目根：{root}）',
  'tui.download.notEmpty': '不能为空',
  'tui.download.forceConfirm': '所选条目中有 {count} 项已完成，强制重新下载？（否 = 直接跳过）',
  'tui.download.lowSpace': '注意：计划下载 {planned}，但 {dir} 所在磁盘仅剩 {free}',
  'tui.download.concurrencyPrompt': '同时下载几个模型？（并发越高越吃带宽/磁盘）',
  'tui.download.jobsOne': '1 个（串行，最稳）',
  'tui.download.jobsTwo': '2 个',
  'tui.download.jobsThree': '3 个',
  'tui.download.startConfirm': '开始下载 {count} 项，共 {size} → {dir}？',
  'tui.download.startConfirmForce': '开始下载 {count} 项，共 {size} → {dir}？（强制重下）',
  // download.js：主流程
  'tui.download.collectionIdPrompt': '收藏集 ID 或收藏集页 URL',
  'tui.download.invalidCollectionId': '请输入数字 ID 或收藏集 URL',
  'tui.download.collectionEmpty': '收藏集为空',
  'tui.download.collectionCount': '收藏集 {collectionId} 共 {count} 项',
  'tui.download.fetchMeta': '获取文件元数据（{count} 项，并发 {concurrency}）…',
  'tui.download.metaFailed': '有 {count} 项元数据获取失败（可稍后重跑，或先下载其它项）',
  'tui.download.versionStrategy': '版本策略',
  'tui.download.strategyLatest': '全部使用最新版',
  'tui.download.strategyLatestDesc': '每个模型使用收藏集列表中的版本（通常为该模型最新版）',
  'tui.download.strategyChoose': '逐个选择版本',
  'tui.download.strategyChooseDesc': '为包含多个版本的模型手动指定要下载的版本（可顺带固定）',
  'tui.download.fetchVersions': '获取版本列表…',
  'tui.download.pinsApplied': '已固定 {count} 个模型的版本',
  'tui.download.summaryCancelled': '本次已取消：完成 {done}，跳过 {skipped}，失败 {failed}（已下载文件保留，可续传）',
  'tui.download.summaryDone': '本次完成：完成 {done}，跳过 {skipped}，失败 {failed}',
  'tui.download.summaryDoneMeta': '本次完成：完成 {done}，跳过 {skipped}，失败 {failed}，元数据失败 {metaFailed}',
  'tui.download.elapsed': '用时 {elapsed}；日志文件: {file}',
  'tui.download.openDirConfirm': '打开下载目录？',
  'tui.download.opened': '已打开: {dir}',

  // check.js
  'tui.check.noRecords': '暂无收藏集成员快照（先运行 node cli.js list <收藏集ID> 或下载一次）',
  'tui.check.collectionLabel': '收藏集 {id}',
  'tui.check.completionRecords': '成员 {count} 项',
  'tui.check.manualId': '手动输入收藏集 ID',
  'tui.check.allCollections': '全部收藏集',
  'tui.check.collectionIdLabel': '收藏集 ID',
  'tui.check.invalidId': '请输入数字 ID',
  'tui.check.pickCollection': '检查哪个收藏集的更新？',
  'tui.check.modeTitle': '检查模式',
  'tui.check.modeQuick': '快速检查（只比对版本号与本地文件大小）',
  'tui.check.modeQuickDesc': '秒级完成，发现不了「同版本被作者重传」',
  'tui.check.modeDeep': '深度检查（校验本地 SHA256 + 线上文件哈希）',
  'tui.check.modeDeepDesc': '较慢，但能发现文件变化/改名/增删',
  'tui.check.collectionHeader': '— 收藏集 {id} —',
  'tui.check.downloadConfirm': '现在下载 {count} 项变化（有更新 / 文件变化 / 本地缺失）？',
  'tui.check.stateReset': '已重置 {count} 项状态，将重新校验/下载',
  'tui.check.startUpdate': '开始更新收藏集 {collectionId} 的 {count} 项，共 {size}',
  'tui.check.summaryCancelled': '本次已取消：完成 {done}，跳过 {skipped}，失败 {failed}（可续传）',
  'tui.check.summaryDone': '更新完成：完成 {done}，跳过 {skipped}，失败 {failed}',
  'tui.check.failedNotice': '有项目更新失败，可重跑或查看日志',

  // login.js
  'tui.login.title': '登录 / 校验登录态（{site}）',
  'tui.login.modeLogin': '登录 / 更新登录',
  'tui.login.modeLoginDesc': '打开浏览器完成登录并保存会话',
  'tui.login.modeCheck': '只校验当前登录态',
  'tui.login.modeCheckDesc': '不打开登录页，验证保存的会话是否仍有效',
  'tui.login.startConfirm': '将打开浏览器登录 {site}，现在开始？',
  'tui.login.waitConfirm': '浏览器中完成登录后按 y 继续（n 放弃本次保存）',
  'tui.login.done': '登录流程结束，可返回主菜单继续使用',

  // manage.js（收藏集成员与变化）
  'tui.manage.cancelled': '已取消',
  'tui.manage.back': '返回',
  'tui.manage.collectionLabel': '收藏集 {id}',
  'tui.manage.memberCount': '成员 {count} 项',
  'tui.manage.memberVersions': '{versions} 个版本 · {pinned}',
  'tui.manage.noRecords': '暂无收藏集成员快照（先运行 node cli.js list <收藏集ID> 或下载一次）',
  'tui.manage.pickCollection': '选择收藏集',
  'tui.manage.changesShort': '新增 {added} / 移除 {removed} / 版本变化 {versionChanged}',
  'tui.manage.snapshotLine': '成员快照：{count} 项（枚举于 {fetchedAt}）',
  'tui.manage.changesLine': '与上次枚举相比：新增 {added}，移除 {removed}，版本变化 {versionChanged}（上次枚举于 {previousFetchedAt}）',
  'tui.manage.firstSnapshot': '首次枚举',
  'tui.manage.changeAdded': '  + 新增 {name}',
  'tui.manage.changeRemoved': '  - 移除 {name}',
  'tui.manage.changeVersion': '  ~ 版本变化 {name}: {from} → {to}',
  'tui.manage.modelIdLabel': 'modelId={modelId}',
  'tui.manage.unknownTime': '未知时间',
  'tui.manage.pinnedVersion': '已固定版本',
  'tui.manage.notPinned': '未固定',
  'tui.manage.noChanges': '未做任何更改',
  'tui.manage.nameSeparator': '、',
  'tui.manage.actionPrompt': '收藏集 {collectionId} 要做什么？',
  'tui.manage.resetAction': '重置某个模型的重下标记',
  'tui.manage.resetActionDesc': '删除记录后，下次下载会重新下载该模型',
  'tui.manage.resetPick': '选择要重置记录的模型（空格多选）',
  'tui.manage.resetConfirm': '将 {count} 个模型的记录重置为重下，确认？',
  'tui.manage.resetDone': '已重置 {count} 个模型的记录：{names}',
  'tui.manage.resetEmpty': '收藏集 {collectionId} 中没有已记录的模型',
  'tui.manage.pinnedMark': '已固定',
  'tui.manage.noVersionId': '该记录没有版本号，无法固定',
  'tui.manage.pinAction': '固定某模型的当前版本',
  'tui.manage.pinActionDesc': '固定后不会因为站点发布新版而被覆盖',
  'tui.manage.unpinAction': '取消固定',
  'tui.manage.unpinActionDesc': '恢复跟随线上最新版本',
  'tui.manage.noPinned': '没有已固定的模型',
  'tui.manage.unpinInstructions': '空格勾选/取消，回车确认',
  'tui.manage.hashConfirm': '是否计算本地文件 SHA256？（否 = 只比对大小，快很多）',
  'tui.manage.verifying': '校验本地文件…',
  'tui.manage.verifySummary': '{label}：共 {total} 个模型，合计 {size}',
  'tui.manage.verifyCounts': '正常 {ok} 项，异常 {broken} 项',
  'tui.manage.brokenLine': '{name}: {reasons}',
  'tui.manage.reasonSeparator': '；',
  'tui.manage.dirLine': '目录: {dir}',
  'tui.manage.verifyAllOk': '全部文件校验通过',
  'tui.manage.repairConfirm': '重新下载 {count} 项中损坏/缺失的文件？',
  'tui.manage.skipNoUrl': '跳过 {name}：记录中没有下载直链',
  'tui.manage.repairFailed': '有文件修复失败，可稍后重试',

  // models.js（模型库：一模型一记录）
  'tui.models.menuTitle': '模型库',
  'tui.models.menuDownload': '下载单个模型',
  'tui.models.menuDownloadDesc': '粘贴模型 URL / model:<模型ID> / version:<版本ID>，可多行或逗号分隔批量',
  'tui.models.menuList': '列出模型库记录',
  'tui.models.menuListDesc': '名称 / 版本 / 大小 / 固定 / 目录，可按收藏集与关键字过滤',
  'tui.models.menuCheck': '检查模型更新',
  'tui.models.menuCheckDesc': '单个或全部模型，快速/深度对比线上版本并下载变化项',
  'tui.models.menuVerify': '校验 / 修复模型文件',
  'tui.models.menuVerifyDesc': '按记录校验本地文件，可只重下损坏/缺失的文件',
  'tui.models.menuPin': '固定 / 取消固定版本',
  'tui.models.menuPinDesc': '固定后不会因为站点发布新版而覆盖该版本',
  'tui.models.menuForget': '删除模型记录',
  'tui.models.menuForgetDesc': '删除记录，可选择同时删除已下载的文件',
  'tui.models.downloadPrompt': '模型 URL / model:<模型ID> / version:<版本ID>（可多行或逗号分隔）',
  'tui.models.notEmpty': '不能为空',
  'tui.models.refInvalid': '无法识别的目标: {value}',
  'tui.models.noRefs': '没有解析出任何可下载的目标',
  'tui.models.fetchingModel': '获取模型 {modelId} 的版本信息…',
  'tui.models.chooseVersion': '选择版本 · {name}',
  'tui.models.noVersionsOnline': '模型 {name} 在站点上没有可用版本',
  'tui.models.noFiles': '{name} 的版本 {version} 没有可下载的文件（检查 config.json 的 fileTypes）',
  'tui.models.fetchFailed': '获取模型信息失败: {name} -> {error}',
  'tui.models.downloadFailed': '有模型下载失败，可重跑或查看日志',
  'tui.models.noRecords': '模型库暂无记录（先用「下载单个模型」下载一个）',
  'tui.models.modelChoiceDesc': '{versions} 个版本 · 合计 {size} · {pinned}',
  'tui.models.notPinned': '未固定',
  'tui.models.header': '— 模型 {label} —',
  'tui.models.checkScope': '检查哪些模型？',
  'tui.models.checkAll': '全部模型（{count} 个）',
  'tui.models.checkOne': '选择一个模型',
  'tui.models.checkPick': '选择要操作的模型',
  'tui.models.startUpdate': '开始更新模型 {label} 的 {count} 项，共 {size}',
  'tui.models.verifyPick': '校验哪些模型的本地文件？',
  'tui.models.verifyAll': '全部模型（{count} 个）',
  'tui.models.pinPick': '选择要操作的模型',
  'tui.models.pinMode': '固定还是取消固定？',
  'tui.models.pinVersionPick': '固定哪个版本？',
  'tui.models.versionChoiceDesc': '{versionId} · {size} · {date}',
  'tui.models.forgetPick': '选择要删除记录的模型（空格多选）',
  'tui.models.forgetConfirm': '删除 {count} 条模型记录，确认？',
  'tui.models.forgetFilesConfirm': '同时删除这些记录里的文件？（不可恢复；否 = 只删记录）',
  'tui.models.filterCollection': '按收藏集筛选（快照成员）',
  'tui.models.allCollections': '全部模型（不过滤）',
  'tui.models.collectionItem': '收藏集 {id}（{count} 项）',

  // settings.js
  'tui.settings.site': '站点地址（改后需重新登录）',
  'tui.settings.invalidSite': '需以 http(s):// 开头',
  'tui.settings.outDir': '下载目录（相对路径相对项目根：{root}）',
  'tui.settings.notEmpty': '不能为空',
  'tui.settings.chromePath': 'Chrome/Edge 路径（留空自动检测）',
  'tui.settings.debugPort': '浏览器调试端口',
  'tui.settings.invalidPort': '请输入端口号（如 9222）',
  'tui.settings.userAgent': 'User-Agent',
  'tui.settings.jobs': '同时下载的模型数（1 = 串行）',
  'tui.settings.invalidJobs': '请输入 1-8',
  'tui.settings.metaConcurrency': '元数据请求并发数',
  'tui.settings.apiRateLimit': '站点 API 每秒请求上限（0 = 不限）',
  'tui.settings.invalidInteger': '请输入整数',
  'tui.settings.proxy': '代理（留空 = 不使用），如 http://127.0.0.1:7890',
  'tui.settings.invalidProxy': '格式如 http://127.0.0.1:7890',
  'tui.settings.fileTypes': '下载哪些文件类型（逗号分隔）',
  'tui.settings.invalidFileTypes': '至少填一个类型',
  'tui.settings.downloadAttempts': '单个文件最大尝试次数',
  'tui.settings.engine': '下载引擎（aria2 需已安装 aria2c，可多连接提速）',
  'tui.settings.engineCurl': 'curl（默认，最稳）',
  'tui.settings.engineAuto': 'auto（有 aria2c 就用）',
  'tui.settings.engineAria2': 'aria2（强制，未安装会报错）',
  'tui.settings.dedup': '跨收藏集内容去重（同一文件只保留一份数据）',
  'tui.settings.dedupOff': '关闭（默认）',
  'tui.settings.dedupHardlink': '硬链接（同盘零占用，注意：删一处不影响另一处，但改内容会同步）',
  'tui.settings.dedupCopy': '复制（跨盘可用，占用额外空间）',
  'tui.settings.notifyWebhook': '任务结束通知 Webhook（留空 = 不发送）',
  'tui.settings.notifyToast': '任务结束后弹系统通知？',
  'tui.settings.language': '界面语言',
  'tui.settings.languageAuto': '自动（CIVITAI_LANG / 系统语言；没有可用语言时英文兜底）',
  'tui.settings.headless': '浏览器窗口',
  'tui.settings.headlessAuto': '自动（登录用可见窗口，之后无头不弹窗）',
  'tui.settings.headlessAlways': '总是无头（不弹窗口）',
  'tui.settings.headlessNever': '总是显示窗口',
  'tui.settings.languageZh': '简体中文',
  'tui.settings.languageEn': 'English',
  'tui.settings.cancelled': '已取消设置编辑',
  'tui.settings.saved': '设置已保存到 config.json',
  'tui.settings.siteChanged':
    '站点已变更：Chrome profile 会切换到新站点的独立目录，请重新登录（主菜单 → 登录 / 更新登录）',
};
