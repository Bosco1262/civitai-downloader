# Civitai 收藏集下载器

批量下载 [Civitai](https://civitai.com) 收藏集（Collection）中的全部模型文件：自动枚举条目、获取文件元数据、断点续传下载，并用 SHA256 与站点发布值比对校验，全部文件按「模型标题」分文件夹保存。

> 背景：Civitai 公开 REST API 不支持枚举收藏集条目，本工具通过你本人的浏览器登录会话调用站点内部接口完成枚举，因此需要一次性手动登录。

---

## 功能特性

- 一键枚举收藏集条目（分页自动翻页，去重合并）
- 自动获取每个模型的最新版本、主 Model 文件的：文件名 / 大小 / SHA256 / 下载直链
- 下载能力（基于 curl + 登录 Cookie）：
  - 断点续传（`curl -C -`），网络中断后重跑同一命令即可续传
  - 失败自动重试（单项最多 5 次），低速保护（<50KB/s 持续 2 分钟自动断开重试）
  - 下载到 `*.part`，SHA256 校验通过后才改名为正式文件
  - 已存在且校验通过的文件自动跳过；`state` 记录已完成模型，重复运行秒级跳过
- `--dry-run` 预览计划、`--only` 只下指定模型、`--force` 强制重下
- 全流程日志落盘（`.data/download-<收藏集ID>.log`）

## 工作原理

1. **登录（`npm run login`）**：启动一个使用独立用户目录（`.data/chrome-profile`）的 Chrome，你手动完成登录（含人机验证）。会话保存在该 profile 中，并把 Cookie 导出为 Netscape 格式供 curl 使用。
2. **枚举（`list` / `download`）**：连接到该浏览器，在 `civitai.red` 页面上下文中携带登录态调用站点 tRPC 接口 `model.getAll`，分页拉取收藏集全部条目。
3. **元数据**：通过公开接口 `GET /api/v1/model-versions/{版本ID}` 获取主 Model 文件信息（匿名可用）。
4. **下载**：curl 携带登录 Cookie 请求 `/api/download/models/{版本ID}?fileId=...`，307 跳转到对象存储签名直链下载；完成后按 SHA256 校验，成功后写入状态文件。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows（macOS / Linux 亦可，需自备 curl 与 Chrome） |
| Node.js | ≥ 18（本项目在 v24 验证通过） |
| 浏览器 | Chrome（推荐）或 Edge，用于登录会话 |
| curl | Windows 10/11 自带；其它系统请自行安装 |

## 快速开始

```powershell
cd C:\Users\kongf\Downloads\loras\civitai-collection-downloader
npm install
copy config.example.json config.json    # 首次使用时创建配置
notepad config.json                     # 按需修改 outDir 等（见下文）
```

> 提示：若终端中文显示乱码，先执行 `chcp 65001`，或改用 Windows Terminal / VS Code 终端。

### 1. 登录

```powershell
npm run login
```

会弹出 Chrome 窗口，请在其中登录 Civitai（如有人机验证请手动完成），然后回到终端按 `Enter`。看到「登录态已保存」即成功。

登录态保存在 `.data/chrome-profile`，下次运行无需重新登录（除非站点会话过期）。

### 2. 查看收藏集

```powershell
npm run list -- 161131
```

输出示例：

```
收藏集 161131 共 20 项:
  1. [modelId=1191424] [versionId=1990837] Illustrious | LORA | PornMaster - rule 34 prompts - Illustrious & noob
  2. [modelId=1730869] [versionId=1958935] SDXL 1.0 | LORA | PornMaster-nose hook-鼻鈎
  ...
```

常用可选参数：
- `--plan`：同时获取文件元数据，显示每个模型的文件与总大小（`npm run list -- 161131 --plan`）
- `--json`：以 JSON 输出，便于脚本处理

### 3. 下载

```powershell
npm run download -- 161131
```

首次会先显示下载计划（每项文件数/大小），随后逐项下载、校验、记录状态。

常用可选参数：

| 参数 | 说明 | 示例 |
|---|---|---|
| `--out <目录>` | 覆盖下载目录 | `npm run download -- 161131 --out D:\models` |
| `--only <id[,id]>` | 只处理指定 modelId / versionId | `npm run download -- 161131 --only 276011` |
| `--force` | 忽略已完成记录，强制重新下载 | `npm run download -- 161131 --only 276011 --force` |
| `--dry-run` | 只列出计划不下载 | `npm run download -- 161131 --dry-run` |

> npm 传参请务必带 `--`，例如 `npm run download -- 161131`。也可以不用 npm，直接 `node cli.js download 161131`。

### 下载结果

```
<outDir>\
├─ PornMaster - rule 34 prompts - Illustrious & noob\
│  └─ rule34-BDSM-IL-V2.safetensors          (3.77 GiB)
├─ PornMaster-nose hook-鼻鈎\
│  └─ PornMaster-nose hook 01-sdxl-V1-lora.safetensors
└─ ...
```

- 每个模型一个文件夹（文件夹名 = 模型标题，已做 Windows 非法字符替换）
- 完成状态记录在 `.data\state-<收藏集ID>.json`：删除其中对应条目即可重新下载
- 运行日志：`.data\download-<收藏集ID>.log`

## 配置说明（config.json）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `site` | `https://civitai.red` | 站点地址，可改为 `https://civitai.com`（改后需重新登录） |
| `outDir` | `downloads` | 下载根目录，相对项目路径或绝对路径均可 |
| `profileDir` | `.data/chrome-profile` | 登录会话使用的 Chrome 用户目录（相对项目路径） |
| `chromePath` | 空 = 自动检测 | Chrome/Edge 可执行文件路径，自动检测失败时手动指定 |
| `debugPort` | `9222` | Chrome 远程调试端口，被占用时可改（如 9223） |
| `userAgent` | Chrome UA | 请求头使用的 User-Agent |

## 项目结构

```
civitai-collection-downloader/
├─ cli.js                  # 命令入口（login / list / download）
├─ config.json             # 你的配置（.gitignore 已忽略）
├─ config.example.json     # 配置样例
├─ src/
│  ├─ config.js            # 配置加载与路径解析
│  ├─ util.js              # 日志 / 哈希 / 文件名清理 / 参数解析
│  ├─ browser.js           # Chrome 启动与连接（puppeteer-core）
│  ├─ cookies.js           # 导出浏览器 Cookie（Netscape 格式）
│  ├─ collection.js        # 通过 tRPC 枚举收藏集条目
│  ├─ api.js               # 版本文件元数据（大小 / SHA256 / 直链）
│  ├─ downloader.js        # curl 下载（断点续传 / 重试 / 校验）
│  └─ commands/
│     ├─ login.js          # 登录并保存会话
│     ├─ list.js           # 列出收藏集
│     └─ download.js       # 下载收藏集
└─ .data/                  # 运行时数据（会话 / Cookie / 缓存 / 状态 / 日志）
```

## 常见问题（FAQ）

**1. 终端中文乱码？**
执行 `chcp 65001`，或使用 Windows Terminal / VS Code 终端。

**2. 提示「浏览器启动超时」或端口 9222 无响应？**
- 可能已有 Chrome 用同一 profile 打开，但没有开启调试端口——请先完全关闭它再重试；
- 或端口被其它程序占用——修改 `config.json` 的 `debugPort`。

**3. 提示「未登录或登录已过期」（HTTP 401/403）？**
重新运行 `npm run login`，在浏览器中确认登录成功后按 Enter。

**4. 下载中途断了怎么办？**
重跑同一条下载命令即可。curl 断点续传，已完成且校验通过的文件会直接跳过。

**5. 页面出现人机验证（Cloudflare）？**
在登录浏览器窗口中手动完成验证后，再继续操作。

**6. 想下载 civitai.com 上的收藏集？**
修改 `config.json` 中 `"site": "https://civitai.com"`，重新运行 `npm run login` 登录即可。

**7. Cookie 安全吗？**
`.data/cookies.txt` 含你的登录凭证，请勿分享或提交到代码仓库（项目 `.gitignore` 已忽略 `.data/`）。

**8. 只想先看看要下多少东西？**
`npm run list -- <收藏集ID> --plan` 或 `npm run download -- <收藏集ID> --dry-run`。

## 免责声明

本工具仅用于个人备份与学习。请遵守 Civitai 的服务条款以及模型作者的版权与使用许可；内容可能包含成人向（NSFW）素材，请确保符合你所在地区的法律法规。使用者需自行承担一切责任。
