# civitai-downloader

[English](README.md) | [简体中文](README.zh-CN.md)

Download every model file in a [Civitai](https://civitai.com) collection in bulk: entries are enumerated automatically, file metadata is fetched, downloads resume where they stopped, and every file is verified against the SHA256 published by the site. All files are saved in folders named after the model title.

> Background: Civitai's public REST API cannot enumerate collection entries. This tool calls the site's internal endpoint through your own browser login session to enumerate them, so a one-time manual login is required.

---

## Features

- **Web UI** (`npm run webui`, or `node web.js`): a local browser interface that covers the same ground as the terminal UI — dashboard, collection enumeration with a filterable pick list, per-model version switching, live progress with logs, model library with version pinning, update checks, verification/repair, settings editor, browser login and an environment check. Dependency-free (Node's own `http` server + vanilla JavaScript, no build step) and bound to `127.0.0.1` by default
- **Terminal UI** (`npm run tui`): menu-driven operations — login, filtering/picking collection entries to download, live progress bars and logs, completion-state management, version pinning, local verify and repair, environment check, settings editor. No commands to memorize
- Enumerate collection entries in one go (automatic paging, dedup and merge, rate limiting)
- Automatically fetch each model's latest version and its primary Model file's: file name / size / SHA256 / direct download URL
- **Version selection and pinning**: for models with several versions you can choose which one to download — pick them one by one in the TUI (pinning along the way), or override with `--version <modelId=versionId>` on the CLI; the `pin` command **pins** a version so a newer release on the site can never overwrite it
- **Several versions of the same model side by side**: every version records its own directory / file manifest / SHA256. The first version goes to `outDir/<model name>/`, later ones to `outDir/<model name>/<version name>/`, so switching versions never overwrites anything
- **Single models (no collection needed)**: `download <model URL | model:<id> | version:<id>>` downloads directly (batch pasting / `--models` / `--from-file` supported); the `models` command manages them in one place — list with search and sorting, export to JSON/CSV, pin versions, delete records (optionally together with their files); `check`/`verify` accept `model:<id>` and `--models`; item 2 of the TUI main menu, "Single models", offers the same entry point
- Download capabilities (built on curl + the login cookie):
  - Resumable transfers (`curl -C -`): after a network drop, just re-run the same command. Before resuming it compares the **ETag** and discards the old part when the remote file changed, instead of assembling a file that is bound to fail verification
  - Automatic retries on failure (up to 5 attempts per item, configurable) and slow-speed protection (disconnect and retry after 2 minutes below 50KB/s)
  - Downloads into `*.part` and only renames it to the final file once the SHA256 check passes
  - Files that already exist and verify are skipped automatically; `state` records completed models, so repeat runs skip them in seconds
  - **Lazy metadata**: completed entries no longer fetch metadata one by one (a second run makes almost no requests)
  - **Concurrent downloads** (`--jobs N`) and concurrent metadata fetching
  - A session that expires mid-download is **re-exported as cookies and retried automatically**
  - Free disk space is checked before downloading; in the TUI Ctrl+C cancels (keeping `.part` files resumable) and `s` skips the current model
  - **Checkpoint list**: cancelling saves the remaining plan and `--resume` continues from it, with no re-enumeration
- **Check for updates** (`npm run check -- <collectionId>` or TUI "Check for updates"):
  - Collections are compared through their **membership snapshot** (`.data/collections/<id>.json`, written by `list` / `download`), so checking needs no browser at all
  - **Fast mode** (default): compares only version IDs and local file sizes, skipping metadata requests for completed entries — returns in seconds
  - **Deep mode** (`--verify-files`): additionally fetches online file hashes and verifies local SHA256 values. It detects "the same version re-uploaded by the author", renamed files and added/removed files
  - Reports "update available / files changed / missing locally / removed from the collection / not downloaded / version pinned", plus the membership changes since the previous enumeration
  - `--all` checks every collection with a snapshot; `--models` checks the whole library; `--out <file>` exports the report; results are compared with the previous check (new issues / fixed)
- **Local verify and repair** (`npm run verify`): verifies the library against the files on disk without enumerating online (optionally comparing sizes only); `--repair` re-downloads only broken/missing files, and `--offline` avoids opening a browser at all
- **Environment check** (`npm run doctor`): one command that checks Node, the config, curl, the browser, the debug port, the login session, directory writability, disk space, long-path support and how many models/versions the library holds
- Forgiving input: collection IDs, collection URLs and model URLs can all be pasted directly; `--collections` processes several collections at once
- **Optional hardware/network acceleration**:
  - `engine: aria2` (or `auto`): uses multi-connection downloads for large files when aria2c is installed (`-x8 -s8`); curl is still the default
  - `dedup: hardlink` (or `copy`): deduplicates identical content across collections by SHA256, keeping a single copy of the data (hardlinks cost no extra space)
  - `notifyWebhook` / `notifyToast`: POST the result to a Webhook or raise a system notification when the job finishes (plus a terminal bell)
- **Chrome profile isolated per site** (`.data/chrome-profile/civitai.red`): switching sites never mixes sessions or cookies; an explicitly configured **non-default** `profileDir` is left as is
- **Switchable UI language** (`zh-CN` / `en`), resolved in this order: explicit `-l` / `--lang` / `--language` or `language` in `config.json` → auto-detection (`CIVITAI_LANG` / `LC_ALL` / `LANG` environment variables, then the system locale) → English fallback
- **The model is the single source of truth**: every model has exactly one record in `.data/library.json` (no matter how many collections it came from), and a collection is only a **membership snapshot** (`.data/collections/<id>.json`) with an added/removed/version-changed report
- **Layered directories by type**: `layout` picks the folder preset (`a1111` (default) / `comfy` / `custom` with `typeFolders`), and `baseModelLayer` optionally inserts a base-model level named after the site's own Base Model value, e.g. `Lora/SDXL 1.0/<model>` (`unknown` when the site reports none)
- **One directory per model**: versions that share a base model live together; when two versions would use the same file name with different content, **both sides** get their own `-<version>` suffix (`model.safetensors` → `model-v1.safetensors` / `model-v2.safetensors`). **When one model's versions span several base models** (this exists on the site: the same model with SDXL / SD 1.5 / Illustrious versions), each version goes under its own base-model folder, so an SD 1.5 LoRA never lands in an SDXL folder; `models --relayout` moves an existing library onto a new layout
- `--dry-run` previews the plan, `--only` downloads just the given models, `--force` re-downloads regardless, `--refresh-meta` re-compares against the online manifest
- Logs from every run are written to disk (`.data/download-<collectionId>.log`, rotated by size, with elapsed-time statistics)
- Data safety: atomic library writes + automatic backups + one global lock (so two processes cannot overwrite each other); a corrupt library is backed up and reported loudly instead of silently losing records
- The old per-target files (`state-*.json`, `items-*.json`, `plan-*.json`, `report-*.json`) are ignored by the new format: the first run moves them into `.data/legacy/`

## How It Works

1. **Login (`npm run login`)**: launches Chrome with a dedicated user directory (`.data/chrome-profile`) where you sign in manually (including any CAPTCHA). The session is kept in that profile and its cookies are exported in Netscape format for curl; a minimal request is sent right afterwards to confirm the session really is valid.
2. **Enumeration (`list` / `download`)**: connects to that browser and calls the site's tRPC endpoint `model.getAll` from the page context with your session, paging through every collection entry. The enumeration is written to `.data/collections/<id>.json` together with the membership changes. If the site shows a CAPTCHA page, you are explicitly told to complete it manually.
3. **Metadata**: fetches primary Model file information through the public endpoint `GET /api/v1/model-versions/{versionId}` (anonymous access works), with retries, backoff and rate limiting; the raw version object is mirrored into the library record.
4. **Download**: curl requests `/api/download/models/{versionId}?fileId=...` with the login cookie, follows the 307 redirect to the signed object-storage URL, then verifies SHA256 and writes one record per model into `.data/library.json`.

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows / macOS / Linux (bring your own curl and Chrome/Edge) |
| Node.js | ≥ 18 (this project is verified on v24) |
| Browser | Chrome (recommended) or Edge, used for the login session |
| curl | Bundled with Windows 10/11; install it yourself on other systems |

## Quick Start

```powershell
cd C:\Users\kongf\Downloads\loras\civitai-collection-downloader
npm install
copy config.example.json config.json    # create the config on first use
notepad config.json                     # adjust outDir / jobs / proxy etc. as needed (see below)
npm run doctor                          # recommended as a first check
```

> Tip: if Chinese text is garbled in your terminal, run `chcp 65001` first, or switch to Windows Terminal / the VS Code terminal.

### 0a. Web UI (recommended)

```powershell
npm run webui
```

> The start commands were renamed: `npm run web` is now **`npm run webui`**, and `npm run ui` is now
> **`npm run tui`**. Both UIs are kept; they share the same config, session and library.

This starts a local server (default <http://127.0.0.1:4310/>) and opens the browser. The server is
dependency-free (Node's own `http` module plus one page of vanilla JavaScript — nothing to build),
listens on `127.0.0.1` only, and shares the same `config.json`, session and model library as the CLI
and the TUI.

Pages:

- **Dashboard**: site, output directory, free space, session state, library totals, a doctor run, a
  session probe, and the collection snapshots — click one to see its members and what changed
  (added / removed / version changed) and to reset the changed records, or jump straight into the
  download page
- **Download**: paste a collection ID/URL → the server enumerates it and fetches every item's files →
  filter by keyword/type/base model, sort, select all/new/none, **switch the version of any item**,
  choose the output directory and concurrency → start. The same page also accepts **pasted single
  models** (model URL / `model:<id>` / `version:<id>`, one per line) for downloads that need no
  collection. Progress, speed, ETA, the file being written and the full log stream live in a bottom
  drawer; the download can be cancelled from there
- **Library**: searchable table (by collection too); click a row for versions, folders, pinning,
  "download this version", per-model check/verify and record deletion (optionally with files)
- **Updates**: pick collection snapshots and/or library models, choose fast or deep (SHA256) →
  reports per target → **download only the changed items** in one click
- **Verify**: verify the whole library or selected models, deep or size-only → broken files listed
  with reasons and a one-click re-download
- **Settings**: grouped form for `config.json`; values are validated before they are written, and a
  language change reloads the interface
- **Login**: start the browser login, then press "I have finished logging in" when done; or just
  probe the saved session
- **Help**: every workflow and its CLI equivalent

Options (with npm, pass arguments after `--`):

```powershell
npm run webui                              # defaults: 127.0.0.1:4310
npm run webui -- --port 5000 --no-open     # custom port, do not open a browser

node web.js --port 4310 --host 127.0.0.1   # same options when started directly
node web.js --no-open
node web.js --lang en
node web.js --help
```

> The TUI (`npm run tui`) and the CLI stay available: all three share the same configuration and
> library, so they can be mixed freely. The web UI prints its events over SSE and keeps one job at a
> time, which is what makes the terminal and browser views agree on what is running.

### 0b. Terminal UI

```powershell
npm run tui
```

The terminal UI is a full-screen app rather than a scrolling log: the screen is cleared once at start-up and the same frame stays on screen afterwards.

```
  civitai-downloader

  ┌── Dashboard ─────────────────────────────────────────────────┐
  │ Current settings                                             │
  │ Site          https://civitai.com                            │
  │ Session       exported (log in again if it reports expired)  │
  │ Download dir  D:\downloads                                   │
  │ Concurrency   3                                              │
  │                                                              │
  │ Task overview                                                │
  │ Total  ███████░░░░░░░░░ 42.5% · 1/3 done · 1 running · 1 queued │
  └──────────────────────────────────────────────────────────────┘

  Main menu
  ────────────────────────────────────────────────────────────────

  ▸ Download                  Download models or collections: paste a link / ID, tick the items
    Local model management    Manage local files per model: update, verify, pin, delete records
    Local collection management  Manage per collection: check, re-download, reset members
    Settings                  Login, download directory, concurrency, proxy and every option
    Exit

  ↑↓ Select · Enter Open · Tab Task view · Ctrl+C Quit
```

The fixed part of the screen: the project name on the first line, the **dashboard** in the middle — "Current settings" (site, session, download directory, concurrency), a blank line, then **"Task overview"** (one fixed aggregate progress line over every task in the registry: a bar, the percentage and the counts per state; it returns to "idle" once nothing is running or queued, and `Tab` opens the per-task detail) — the current page below that (a **breadcrumb** such as `Main menu › Settings` with a rule under it, the content and, when there is something to say, one transient `✔ …` line that fades after 5 seconds), and **the last line is the key hint of that page**. The wording follows the configured language; the sample above is the English one.

The raw log is no longer a permanent strip: it is **a page** — `L` opens it, `L` or `Esc` closes it (`↑↓` / `PgUp` / `PgDn` scroll), and it keeps being written to the run log on disk. Results show up in that transient line (saved, download summary, failure), and the details live in the log page.

There is only one hint line: the page owns it and lists **only the keys that work there**. That is why the main menu's line does not mention Esc (it does nothing there), a text field's line does not mention ↑↓, and the task view's line changes with the selected task (`c` / `s` while running, `r` / `d` / `l` when finished). On a terminal too narrow for the page's own line, a compact universal spelling takes over instead of clipping it.

Two "system views" open on top of whatever is there and are mutually exclusive: `Tab` is the task view, `L` is the log page, and each one's footer lists its own keys. The task view is the **only** home of a download's progress and result: a download keeps running after you leave the download pages, and the task view shows its live progress, current files, failures and final result (plus `c` cancel, `s` skip, `r` retry failed items, `d` open the output folder and `l` the per-task log tail).

The main menu has exactly five entries:

- **Download**: one entry point for models and collections. "Download models" accepts model links, `model:<ID>` and `version:<ID>` (several per line or comma separated); "Download a collection" enumerates the items and records the collection snapshot. Both then share the same shell flow: **plan page** (filter / tick / `v` choose a version per item / `n` select only new) → **confirmation page** (totals, disk space, output directory, concurrency, already-finished handling, start) → **receipt page** ("added to the task list", `Tab` for progress, `Esc` leaves the download screen). If a download is already running, the new one is **queued** and starts automatically when the previous task ends
- **Local model management**: the list of locally known models (`Enter` opens one), and that model's page holds **everything that concerns this one model** — check for updates, verify/repair its files, download another version, pin/unpin a version, open its folder, delete its record. The library-wide "check every model" and "verify every file" passes sit next to the list
- **Local collection management**: the list of collections (members, enumeration time, changes); opening one gives **check for updates** (quick/deep), **re-download**, **reset the members for re-download**, and the membership/change report
- **Settings**: one page listing **every option** (site, download directory, browser, language, concurrency, request timeout, retries, file types, directory layout, base-model layer, primary-only, engine, dedup, rate limit, proxy, User-Agent, notifications) with its current value; `Enter` edits the current row and **confirms it straight into config.json** (there is no separate save step), while `Esc` goes back. `Ctrl+R` in a text field fills in that field's built-in default (still editable; `Enter` applies it), and the last row, "Restore all defaults", resets the whole page after a confirmation. The download directory can also be filled with the platform's folder dialog (`Ctrl+O`): the picked path is put into the input line, so it can still be edited, and a device without a dialog simply types it. Login, "open the download directory" and the environment check live here too
- **Exit**

Keys: `↑↓` move (wrapping at both ends), `Enter` selects/confirms and always moves on to the next screen, `Esc` cancels or goes back one level without saving (it has **no effect in the main menu**, so a repeated Esc cannot quit the program by accident), `Tab` switches to the task view from anywhere (press again to return; while running `c` cancels and `s` skips the current model, when finished `r` retries failed items, `d` opens the output folder, `l` shows the task log tail and `x` clears finished ones), `L` opens the log page (press again or `Esc` to go back), `Ctrl+C` quits the program, `?` opens the key reference. During a download, `Esc` on the receipt page only leaves the download screen; the task keeps running in the task list. `s` (skip) and `c` (cancel) live in the task view; Ctrl+C on a running task asks to cancel it first.

Keys on the settings page: `↑↓` select (wrapping), `Enter` edits or runs the row, `Esc` goes back; inside a text field `Ctrl+R` restores the default and `Ctrl+O` picks a folder. Every confirmation is written immediately, and the line under the list briefly shows `✔ Saved: <field> = <new value>`; re-entering the same value says "unchanged" and writes nothing.

Keys in the item-selection screen (useful when there are many entries):

| Key | Action |
|---|---|
| `↑`/`↓`, `k`/`j` | Move the cursor (the list scrolls along so the cursor stays visible); `Home`/`End` jump to the first/last item |
| `PgUp`/`PgDn`, `[`/`]` | Scroll one screen up / down |
| `1`-`9` | Jump to row n; `Shift`+`1`-`9` toggles row n directly |
| `space` | Tick / untick the current item; `Shift`+`↑`/`↓` extends the selection |
| `a` / `i` | Select all **current filter results** (press again to clear) / invert the selection |
| `n` / `c` | Select only items whose target version is not downloaded yet / clear the selection (download plan) |
| `v` / `o` | Choose the version of the current item / open the download confirmation (download plan) |
| `/` | Search (Enter exits and keeps the keyword, `Esc` exits and clears it, backspace is supported) |
| `t` / `b` / `s` | Cycle the type / base model / sort order (default, name, largest first, smallest first) |
| `?` | Show the key reference of the screen you are in |
| `enter` | Confirm (you are warned when nothing is selected); `Esc`/`q` cancels |

The footer of every list only describes the keys that do something right now, and the list carries its own position and totals. The same picker drives every "choose one / choose several" step, so there is only one set of keys to learn.

> In a non-interactive environment (when output is redirected) the tool falls back to the original step-by-step prompts plus a multi-select list; set `CIVITAI_PLAIN=1` to force that mode.

> If you prefer the command line, you can keep using the `login` / `list` / `download` / `check` / `verify` commands below — both share the same config, login session and completion records.

### 1. Login

```powershell
npm run login
npm run login -- --check    # only validate the saved session; do not open a browser
```

A Chrome window opens: sign in to Civitai there (complete the CAPTCHA manually if one appears), then press `Enter` back in the terminal. You are done once the session check passes.

The session is stored in `.data/chrome-profile`, so later runs need no new login (unless the site session expires).

### 2. Listing a collection

```powershell
npm run list -- 161131
npm run list -- https://civitai.red/collections/161131 --plan
npm run list -- 161131 --from-cache     # no network: reuse the last enumeration cache
```

Example output:

```
Collection 161131: 20 items:
  1. [modelId=1191424] [versionId=1990837] Illustrious | LORA | PornMaster - rule 34 prompts - Illustrious & noob
  2. [modelId=1730869] [versionId=1958935] SDXL 1.0 | LORA | PornMaster-nose hook-鼻鈎
  ...
```

The enumeration is also written to `.data/collections/161131.json` as a **membership snapshot**, together with how the members changed since the previous enumeration (added / removed / version changed). `check` reports against that snapshot, so it needs no browser.

Common optional flags: `--plan` (also fetch file metadata and show sizes), `--json` (machine-readable output), `--from-cache`.

### 3. Downloading

```powershell
npm run download -- 161131
npm run download -- 161131 --jobs 2
npm run download -- https://civitai.red/models/1191424?modelVersionId=1990837
npm run download -- 161131 --resume        # continue the job that was cancelled last time
```

Common optional flags:

| Flag | Description | Example |
|---|---|---|
| `--out <dir>` | Override the download directory (relative paths are relative to the **project root**) | `npm run download -- 161131 --out D:\models` |
| `--only <id[,id]>` | Process only the given modelIds / versionIds | `npm run download -- 161131 --only 276011` |
| `--version <m=v[,m=v]>` | Choose which version of a model to download | `npm run download -- 161131 --version 1191424=1341400` |
| `--jobs <n>` | Number of models to download at once (1-8) | `npm run download -- 161131 --jobs 3` |
| `--refresh-meta` | Re-fetch metadata to discover files re-uploaded under the same version | `npm run download -- 161131 --refresh-meta` |
| `--resume` | Resume the last cancelled job from its checkpoint list | `npm run download -- 161131 --resume` |
| `--from-cache` | Use the item cache written by the last `list` run instead of re-enumerating the collection; with `--offline` no browser is opened at all | `npm run download -- 161131 --from-cache --offline` |
| `--file-types <t,t>` | Download only the given file types (default `Model`) | `npm run download -- 161131 --file-types Model,VAE` |
| `--force` | Ignore completion records and download again | `npm run download -- 161131 --only 276011 --force` |
| `--dry-run` | Only list the plan; do not download | `npm run download -- 161131 --dry-run` |
| `--ignore-space` | Continue even when disk space is insufficient | |
| `--force-lock` | Ignore the "another process is already handling this" notice | |
| `--reset-state` | Ignore corrupt records when the state file is damaged (the corrupt content is backed up automatically) | |
| `--engine <name>` | Download engine: `curl` (default) / `aria2` / `auto` | `npm run download -- 161131 --engine aria2` |
| `--dedup <mode>` | Cross-collection content dedup: `off` (default) / `hardlink` / `copy` | `npm run download -- 161131 --dedup hardlink` |
| `--notify <url>` | POST the result to this Webhook when the job finishes | `npm run download -- 161131 --notify https://example.com/hook` |
| `--toast` | Show a system notification when the job finishes | |

> Always pass `--` to npm, for example `npm run download -- 161131`. You can also skip npm and run `node cli.js download 161131` directly.

### 4. Checking for updates

```powershell
npm run check -- 161131                 # fast check against the collection snapshot (seconds)
npm run check -- 161131 --verify-files  # deep check (compares file hashes)
npm run check -- --all                  # check every collection with a snapshot
npm run check -- 161131 --download      # download only the changed items after checking
npm run check -- 161131 --out report.json
```

It compares the library (`.data/library.json`, including each file's size and SHA256 manifest) against the collection membership snapshot (`.data/collections/<id>.json`, written by `list` / `download`). Output categories:

- **Membership changes**: members added, removed or moved to another version since the previous enumeration
- **Update available**: the model has a new version (recorded versionId ≠ the version in the snapshot)
- **Files changed**: under the same version, files changed content / were renamed / added or removed (requires a deep check)
- **Missing/broken locally**: the local file is absent or its size does not match; a deep check also verifies SHA256
- **Version pinned**: the model was pinned with `pin`, so a newer online version will not overwrite it automatically
- **Removed from the collection**, **in the collection but not downloaded**: informational notes

### 5. Verify and repair

```powershell
npm run verify -- 161131              # full SHA256 verification of the models in that collection snapshot
npm run verify -- --all --no-hash     # the whole library, size comparison only (fast)
npm run verify -- model:1191424       # one model
npm run verify -- 161131 --repair --offline   # repair broken files using the existing cookies only
```

### 6. Version pinning

```powershell
npm run pin -- --list                 # show every pinned model
npm run pin -- 1191424                # pin to the newest downloaded version
npm run pin -- 1191424 1341400        # pin to a specific version
npm run pin -- 1191424 --unpin        # unpin
```

### 7. The model library (download and manage)

Download and manage models/versions directly, without a collection. Every model has **one** record in `.data/library.json`, so downloading the same model from two collections never creates two records.

```powershell
# Download (paste a model page URL, model:<id> or version:<id> — all work)
npm run download -- https://civitai.red/models/1191424
npm run download -- model:1191424
npm run download -- version:1990837          # a version id alone is fine (the owning model is resolved automatically)
npm run download -- model:1191424 --version 1191424=1341400   # choose a version

# Batch-paste several models (positional arguments, --models and --from-file are all supported)
npm run download -- https://civitai.red/models/1191424 https://civitai.red/models/1730869
npm run download -- --models model:1191424,model:1730869
npm run download -- --from-file models.txt   # one ref per line, # starts a comment

# Management
npm run models                                  # list the whole library
npm run models -- --search lora --sort size     # filter + sort (name|size|recent)
npm run models -- --json                        # JSON output (same structure as the --export .json)
npm run models -- --export models.json          # .csv works too
npm run models -- --pin 1191424                 # pin the current version (or --pin 1191424=1990837)
npm run models -- --unpin 1191424
npm run models -- --forget 1191424              # delete the record (local files are kept by default)
npm run models -- --forget 1191424 --delete-files     # also delete the recorded files and prune empty directories
npm run models -- --forget 1191424 --version 1341400  # delete the record of one version only
npm run models -- --relayout --dry-run          # report what a layout change would move
npm run models -- --relayout                    # actually move every file to the layout directory

# Check for updates / verify and repair (model:<id> targets one model, --models covers the library)
npm run check  -- --models                       # check every model of the library
npm run check  -- --models --verify-files        # deep: compare file hashes
npm run check  -- model:1191424 --download       # download only the changed items of one model
npm run verify -- --models --repair --offline    # verify and repair local files
npm run pin    -- 1191424 1990837                # pin a model to a version (model:1191424 also works)
npm run pin    -- --list                         # list every pinned model
```

`check` / `verify` target one model with `model:<id>` (or a model URL) and cover the whole library with `--models` / `--all`. A collection ID (`check 161131`) compares the **membership snapshot** written by `list` / `download` and reports the added / removed / version-changed members. Records live in `pin` / `models` of the library, not of a collection.

**A model can keep several versions at once** (for example both v1 and v2 locally):

- All versions of a model live in **one** directory, decided by the layout: `outDir/<type folder>/<base-model?>/<model name>/`
- When two versions use the same file name with **different content**, both sides get their own `-<version>` suffix (`model.safetensors` → `model-v1.safetensors` / `model-v2.safetensors`), so a file name always maps to a version; identical content is shared and never renamed. Once a model folder is in "suffix mode", later versions keep the suffix even when their own names do not clash, so the naming stays consistent
- Each version records its own file manifest and SHA256; switching or re-downloading versions does not affect the others
- Once a version is pinned with `pin`, `check` reports "version pinned" instead of "update available"
- Changed `layout` / `baseModelLayer` later? `npm run models -- --relayout` moves the existing files onto the new layout

### Download results

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

- Folders follow the layout: one folder per type (`Lora`, `checkpoints`, `embeddings`, …), an optional base-model level (`baseModelLayer: true`, named after the site's Base Model value, `unknown` when the site reports none) and then the model title
- Illegal Windows characters are replaced, over-long names are shortened automatically and kept unique
- The library is `.data\library.json` (schema v1): `{ "schemaVersion": 1, "updatedAt", "entries": { "<modelId>": { "name", "type", "baseModel", "creator", "stats", "nsfw", "mode", "pinnedVersionId", "versions": { "<versionId>": { "versionName", "baseModel", "dirName", "outDir", "files": [...], "verifiedAt", "site": {...} } } } } }` — `site` mirrors the raw `/api/v1/model-versions/{id}` object (long texts truncated) so nothing is lost
- Collection snapshots are `.data\collections\<collectionId>.json`: the member list plus `changes { added, removed, versionChanged }`
- To re-download a version: use `models --forget <id> --version <versionId>`, or the TUI "Model library → delete record" / "Collection members and changes → reset a model for re-download"
- Run logs: `.data\download-<collectionId>.log` (`download-model-<modelId>.log` for single models; rotated to `.1` once it exceeds 5MB)
- The old `state-*.json` / `items-*.json` / `plan-*.json` / `report-*.json` files are ignored from v1 on: the first run moves them into `.data\legacy\` (nothing is deleted, and there is no migration)

## Configuration (config.json)

| Field | Default | Description |
|---|---|---|
| `site` | `https://civitai.red` | Site address; can be changed to `https://civitai.com` (log in again afterwards) |
| `outDir` | `downloads` | Download root; relative paths are relative to the **project root** (no longer affected by the working directory) |
| `profileDir` | `.data/chrome-profile` | Chrome user directory used for the login session; **by default one more level is added per site** (e.g. `.data/chrome-profile/civitai.red`). To share one directory across sites (not recommended), set this field to a path **different from the default**, for example `.data/chrome-profile-shared` |
| `chromePath` | empty = auto-detect | Chrome/Edge path (built-in candidates for Windows/macOS/Linux; specify it manually if detection fails) |
| `debugPort` | `9222` | Chrome remote debugging port; change it (e.g. 9223) when it is taken |
| `userAgent` | Chrome UA | User-Agent used for request headers |
| `proxy` | empty = no proxy | Proxy, e.g. `http://127.0.0.1:7890` (used by both curl and API requests) |
| `headless` | `auto` | Browser window: `auto` (visible window for the login flow, headless afterwards) / `always` / `never`. With headless no window pops up; commands that need no browser at all (single-model download, `models`, local `verify`) never launch one |
| `jobs` | `1` | Number of models to download at once (1-8) |
| `metaConcurrency` | `4` | Metadata request concurrency (1-8) |
| `apiRateLimit` | `4` | Site API requests per second limit (0 = unlimited) |
| `requestTimeoutMs` | `60000` | Timeout of a single HTTP request |
| `retries` | `3` | Metadata request retries (honours 429 Retry-After) |
| `downloadAttempts` | `5` | Maximum attempts per file |
| `logMaxBytes` | `5242880` | Log rotation threshold |
| `engine` | `curl` | Download engine: `curl` / `aria2` / `auto` (use aria2c when it is available) |
| `dedup` | `off` | Cross-collection dedup: `off` / `hardlink` / `copy` |
| `layout` | `a1111` | Directory layout preset: `a1111` (`Lora`, `Stable-diffusion`, `embeddings`, `VAE`, `ControlNet`, `ESRGAN`, `AnimateDiff`, `workflows`) / `comfy` (`loras`, `checkpoints`, `embeddings`, `vae`, `controlnet`, `upscale_models`, `animatediff_models`, `workflows`) / `custom` (uses `typeFolders`; a missing type falls back to `other`) |
| `baseModelLayer` | `false` | Insert one more folder level for the base model, e.g. `Lora/SDXL 1.0/<model>`. The folder name is **the Base Model value exactly as the site reports it** (case and spaces kept, illegal characters replaced), so one base model always maps to one folder; `unknown` when the site reports none |
| `typeFolders` | `{}` | `layout: "custom"` only: site type → folder name, e.g. `{ "LORA": "lora", "Checkpoint": "ckpt" }` |
| `notifyWebhook` | empty | Webhook URL that receives the result via POST when a job finishes |
| `notifyToast` | `false` | Show a system notification when a job finishes (best effort on Windows/macOS/Linux) |
| `language` | empty = auto | UI language: `zh-CN` / `en`. When empty it is resolved as "explicit `-l` / `--lang` / `--language` → auto-detection (`CIVITAI_LANG` / `LC_ALL` / `LANG`, then the system locale) → English fallback" |
| `primaryOnly` | `true` | For multi-file versions, download the primary file only |
| `fileTypes` | `["Model"]` | File types that participate in downloads |
| `trpcPath` | `model.getAll` | Site tRPC procedure name (override it when the site is redesigned) |
| `trpcInput` | `{}` | Overrides for the site tRPC request body (shallow-merged with the built-in template) |

> Unknown config fields do not cause a failure, but the startup prints "config hint: unknown option …" so typos are easy to spot.

## Project Structure

```
civitai-collection-downloader/
├─ web.js                   # web UI entry point (npm run webui; local server + browser UI)
├─ ui.js                    # terminal UI entry point (npm run tui)
├─ cli.js                   # command-line entry point (login / list / download / check / verify / pin / doctor)
├─ config.json              # your configuration (ignored by .gitignore)
├─ config.example.json      # configuration sample
├─ scripts/run-tests.js     # sequential test runner (replaces node --test in restricted environments)
├─ tests/                   # unit and integration tests (node:test)
├─ src/
│  ├─ config.js            # config loading, validation and path resolution
│  ├─ util.js              # logging / hashing (worker thread) / file name sanitizing / long paths / argument parsing / concurrency pool / retries
│  ├─ errors.js            # typed errors (auth / cancel / rate limit / corrupt state / CAPTCHA …)
│  ├─ runtime.js           # runtime wiring (proxy, API context, error presentation)
│  ├─ urls.js              # input parsing (collection ID/URL, model URL)
│  ├─ storage.js           # .data paths / model library + collection snapshots / global lock / legacy cleanup / log rotation
│  ├─ layout.js            # directory layout rules (type folders, base-model layer, version file names)
│  ├─ browser.js           # Chrome launch and connection (puppeteer-core, cross-platform path probing)
│  ├─ cookies.js           # export browser cookies (Netscape format)
│  ├─ collection.js        # enumerate collection entries over tRPC / session probe / CAPTCHA detection
│  ├─ api.js               # version file metadata (retries / rate limiting / concurrency)
│  ├─ manifest.js          # two-way file manifest comparison (content changes / renames / additions and removals)
│  ├─ dedup.js             # cross-collection content dedup index (SHA256 → path, hardlink/copy)
│  ├─ notify.js            # job-finished notifications (bell / system notification / Webhook)
│  ├─ i18n.js              # message engine (t / placeholders / language fallback)
│  ├─ i18n/                # message tables (zh-CN.js / en.js; CLI + core module + TUI strings)
│  │  └─ web/              # web UI strings (zh-CN.json / en.json; served through /api/i18n)
│  ├─ ratelimit.js         # steady-rate limiter
│  ├─ hashWorker.js        # SHA256 worker thread
│  ├─ downloader.js        # curl / aria2c downloads (resume / ETag check / retries / cancellation)
│  ├─ job.js               # main download loop (shared by the CLI and both UIs)
│  ├─ updater.js           # update checks (fast/deep) and version pinning
│  ├─ loginFlow.js         # login and session validation
│  ├─ commandSpec.js       # command and flag registry
│  ├─ commands/            # command-line subcommands
│  │  ├─ login.js  list.js  download.js  check.js  verify.js  doctor.js  pin.js  models.js
│  ├─ webui/               # web UI
│  │  ├─ server.js         # http server: static files, JSON API, SSE stream, request guards
│  │  ├─ api.js            # route table (method + anchored pattern → business action)
│  │  ├─ actions.js        # business actions built on the existing core modules
│  │  ├─ jobs.js           # job manager (one job at a time, logs, progress, cancellation)
│  │  ├─ progress.js       # download progress arithmetic (bytes on disk, speed, ETA)
│  │  ├─ http.js           # JSON bodies, static files, path-traversal guard, SSE writer
│  │  └─ public/           # index.html + styles.css + app.js (no build step)
│  └─ tui/                 # terminal UI
│     ├─ app.js            # banner / status line / main menu / dispatch
│     ├─ pages.js          # shared interaction: menus, confirmations, list pickers, help page
│     ├─ select.js         # full-screen picker (scrolling window, search/filter/sort, help overlay)
│     ├─ keys.js           # raw keyboard handling (Ctrl+C / Ctrl+Z semantics)
│     ├─ layout.js         # terminal metrics and glyph set (ASCII fallback)
│     ├─ view.js  run.js   # screen helpers and the download progress panel
│     └─ download.js  check.js  models.js  login.js  manage.js  settings.js
└─ .data/                  # runtime data (session / cookies / cache / state / logs)
```

### Code Comments

All code comments are **bilingual (English + Chinese)** and are validated automatically by `node scripts/check-comments.js` (CI runs it):

- every standalone comment block must contain both English and Chinese, with **English first and Chinese after**;
- the blank comment lines between the two languages depend on the granularity: **no blank line for a single-line pair**, **1 blank line for a single multi-line paragraph on each side**, and **2 blank lines for multiple sections (2+ on either side)**;
- sections within the same language are separated by exactly 1 blank line, and trailing comments (`code; // …`) must be bilingual on that same line.

## Tests

```powershell
npm test           # node --test tests/ (the standard way)
npm run test:seq   # run sequentially in one process (for restricted environments where node --test child-process pipes are rejected)
```

Coverage: argument parsing, atomic writes and corrupt-state handling, manifest comparison (including renames/additions/removals), download resume (complete parts, 416, changed ETag, hash mismatch, cancellation, exhausted retries), config validation and site isolation, API retries/rate limiting/timeouts, aria2 arguments and engine selection, content dedup, notification payloads, the three message layers (CLI / core modules / TUI) with their Chinese-English switching, the pure functions of the TUI layer (selector filtering/sorting/scrolling-window/rendering, menu and help-page building, progress-panel lines, key semantics, terminal metrics), the web UI (job manager, progress arithmetic, path-traversal guard, HTTP API and request guards, static layer and SPA fallback, `web.*` i18n contract), and one end-to-end integration path (enumerate → metadata → download → state → check for updates → repair → resume from a checkpoint).

Test files: `tests/{util,storage,config,manifest,api,downloader,commands,platform,i18n,i18n-cli,i18n-core,i18n-tui,select,models,models-cli,integration}.test.js`.

## FAQ

**1. Chinese text is garbled in my terminal?** Run `chcp 65001`, or use Windows Terminal / the VS Code terminal.

**2. "Browser launch timed out", or port 9222 does not respond?**
- Chrome may already be running with the same profile but without the debugging port enabled — close it completely and retry;
- or the port is taken by another program — change `debugPort` in `config.json`;
- run `npm run doctor` first to see which of the two it is.

**3. "Not signed in, or the session has expired" (HTTP 401/403)?**
Run `npm run login` again; `npm run login -- --check` quickly confirms the session. If it expires during a download, the tool re-exports the cookies and retries once automatically.

**4. The download was interrupted — what now?** Re-run the same download command (curl resumes and completed files are skipped); if it was cancelled with Ctrl+C, `--resume` continues the remaining plan directly.

**5. A CAPTCHA (Cloudflare) page appeared?** Complete it manually in the browser window and retry; the tool tells you it is a CAPTCHA instead of reporting a parse failure.

**6. I want to download collections on civitai.com?** Change `"site": "https://civitai.com"` in `config.json` and run `npm run login` again (the Chrome profile switches to that site's own directory, so they stay independent).

**6b. After upgrading, the tool asks me to log in again?** Newer versions isolate the Chrome user directory per site (`.data/chrome-profile/civitai.red`), and the old session lives in the shared directory from before that change, so one more login is needed. If you really want several sites to share one directory (not recommended, sessions easily mix), set `profileDir` in `config.json` to a path **different from the default** (for example `".data/chrome-profile-shared"`).

**7. Are the cookies safe?** `.data/cookies.txt` contains your login credentials (file permissions are tightened as much as possible); never share it or commit it to a repository (the project `.gitignore` already ignores `.data/`).

**8. I just want to see how much would be downloaded?** `npm run list -- <collectionId> --plan` or `npm run download -- <collectionId> --dry-run`.

**8b. The browser/site is unavailable but I still want to download or repair?** First run `npm run list -- <collectionId>` to write the item cache, then use `npm run download -- <collectionId> --from-cache --offline` (no browser at all, downloading directly with the existing cookies); repairing broken files works the same way: `npm run verify -- <collectionId> --repair --offline`.

**9. What happens when the library is corrupt?** The tool backs it up as `library.json.corrupt-<timestamp>` and stops; it never silently clears the records. Once you have checked it, delete the original file to start over (already downloaded files are unaffected).

**9b. I want to keep both v1 and v2 of the same model?** Just download the two versions separately (for example `download model:<id>` for v1, then `download model:<id> --version <id>=<v2>`); both live in the same layout folder, each with its own record. When they share a file name with different content, both sides are renamed with their version (`model-v1.safetensors` / `model-v2.safetensors`) so a file name always maps to a version. Use `models` or the TUI "Model library → list records" to see every version.

**9c. Do I get two records when the same model is in two collections?** No. The model library `.data/library.json` holds exactly one record per model; a collection is only a membership snapshot under `.data/collections/`. `check <collectionId>` reports against that snapshot, `check --models` / `verify --models` cover the whole library, and `models --relayout` moves an existing library onto a new `layout` setting (add `--dry-run` to see the plan first).

**9d. Where did the old `state-*.json` files go?** The new format (schema v1) does not read them: on the first run they are moved into `.data/legacy/` and a notice is printed. Nothing is deleted and there is no migration, so a fresh start is expected.

**10. The site endpoints changed — what now?** Use `npm run doctor` and the logs to find out which request fails; the enumeration endpoint can be overridden with `trpcPath` / `trpcInput` in `config.json`, with no code changes needed.

**11. The TUI looks frozen — what should I do?** Every page-context request has a deadline (30 s), so a stalled connection or a wedged browser tab now fails with a message instead of hanging. Long phases (browser startup, SHA256 verification) print a phase line and a "still waiting…" heartbeat every 15 s. If a screen still stops responding, press `Ctrl+C` once to cancel (twice to quit); set `CIVITAI_TUI_DEBUG=1` and reproduce — key events, raw-mode takeovers and screen exits are then appended to `.data/tui-debug.log`. The terminal is always restored on exit (cursor visible, raw mode off, alternate screen left), so a crashed run cannot leave your shell in a broken state.

## Disclaimer

This tool is meant for personal backup and learning only. Please respect Civitai's terms of service and the copyright and usage licences of model authors; content may include NSFW material, so make sure it complies with the laws and regulations of your region. Users are solely responsible for any consequences.

## License

This project is licensed under the [MIT License](LICENSE).
