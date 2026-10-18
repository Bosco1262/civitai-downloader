'use strict';

/**
 * English message catalog. Keys mirror src/i18n/zh-CN.js.
 * Any key missing here falls back to the zh-CN entry (see src/i18n.js).
 * Multi-line usage() texts are stored as a single key each, keeping the
 * original layout; sample commands stay untranslated on purpose.
 */

module.exports = {
  // Common
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.cancelled': 'Cancelled',
  'common.back': 'Back',
  'common.unknownError': 'Unknown error',
  'common.unknown': 'unknown',
  'common.tip': 'Tip',
  'common.settingsSaved': 'Settings saved',
  'common.seconds': '{n}s',
  'common.minutesSeconds': '{m}m {s}s',
  'common.hoursMinutes': '{h}h {m}m',
  'common.listSeparator': ', ',
  'common.reasonSeparator': '; ',

  // ---------------------------------------------------------------------------
  // cli.js
  // ---------------------------------------------------------------------------
  'cli.usage': `civitai-downloader

Usage:
  node cli.js login [--check]                     Open a browser to sign in and save the session (--check only validates the saved session)
  node cli.js list <collectionId|URL> [--json] [--plan] [--from-cache]
  node cli.js download <collectionId|URL|modelURL> [options]
  node cli.js check <collectionId…> [--verify-files] [--download] [--all] [--json] [--out <file>]
  node cli.js verify [collectionId…] [--all] [--no-hash] [--repair] [--offline]
  node cli.js pin <collectionId> <modelId> [versionId] | --list | --unpin
  node cli.js models [--json] [--search <keyword>] [--sort <name|size|recent>] [--export <file>]
  node cli.js doctor [collectionId] [--deep] [--json]

Global options:
  -l / --lang / --language <en|zh-CN>   Force the UI language (or set language in config.json)

Common download options:
  --out <dir>  --only <id,id>  --version <modelId=versionId>  --force  --dry-run
  --jobs <n>  --refresh-meta  --resume  --file-types <t,t>  --no-primary  --ignore-space

npm usage (pass arguments after --):
  npm run login
  npm run list -- 161131 --plan
  npm run download -- 161131 --jobs 2
  npm run check -- 161131 --download
  npm run verify -- --all
  npm run doctor

Tip: you can also run node cli.js <command> --help for help on a single command.
`,
  'cli.unknownCommand': 'Unknown command: {cmd}\n',
  'cli.unknownFlag': 'Warning: ignoring unknown option --{flag} (use --help to see available options)',

  // ---------------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------------
  'loginFlow.openingPage': 'Opening the sign-in page: {url}',
  'loginFlow.gotoFailed': 'Could not open the sign-in page (you can navigate manually): {message}',
  'loginFlow.pleaseLogin': 'Complete the sign-in in the browser window (skip if already signed in)',
  'loginFlow.captcha': 'If a CAPTCHA appears, solve it manually in the browser',
  'loginFlow.confirmHint': 'Come back to this terminal and confirm to continue…',
  'loginFlow.cancelled': 'Saving the session was cancelled',
  'loginFlow.noAuthCookie': 'No login credential cookie detected ({count} cookies exported).',
  'loginFlow.checkBrowser': 'Make sure you are signed in in the browser, then run the login flow again',
  'loginFlow.saved': 'Session saved ({count} cookies): {file}',
  'loginFlow.probeFailed': 'Session check failed: {reason}',
  'loginFlow.probeRetry': 'Make sure you are signed in and have passed the CAPTCHA, then run the login flow again',
  'loginFlow.probeOk': 'Session verified',
  'loginFlow.nextStep': 'Next: npm run list -- <collectionId> or npm run download -- <collectionId> (or use the TUI)',
  'loginFlow.checkOk': 'Session is valid',
  'loginFlow.checkFailed': 'Session is invalid: {reason} (run the login flow)',
  'login.usage': `Usage: node cli.js login [--check]

  (no arguments)  Open a browser to sign in and save the session
  --check   Only validate the saved session; do not open the sign-in page
`,

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------
  'list.usage': `Usage: node cli.js list <collectionId|collectionURL> [options]

Options:
  --json        Output the item list as JSON
  --plan        Also fetch file metadata and show each model's files and total size
  --from-cache  Skip the network and reuse the last enumeration cache (.data/items-<ID>.json)
`,
  'list.cacheMissing': 'No usable cache: {file} (run once without --from-cache first)',
  'list.usingCache': 'Using cache {file} (enumerated at {time})',
  'list.unknownTime': 'unknown time',
  'list.enumerating': 'Enumerating items of collection {collectionId}…',
  'list.countHeader': 'Collection {collectionId}: {count} items:',
  'list.snapshotSaved': 'Membership snapshot updated: collection {collectionId} has {count} items (enumerated at {fetchedAt})',
  'list.changes': 'Compared with the previous enumeration: {added} added, {removed} removed, {versionChanged} version changes (previous enumeration at {previousFetchedAt})',
  'list.firstSnapshot': 'first enumeration',
  'list.changeAdded': '  + added {name}',
  'list.changeRemoved': '  - removed {name}',
  'list.changeVersion': '  ~ version changed {name}: {from} → {to}',
  'list.fetchingMeta': 'Fetching file metadata (concurrency {concurrency})…',
  'list.totalSize': 'Total size of all files: {size} (saved to {file})',
  'list.metaFailed': '{count} items failed metadata fetching; they can be retried while downloading',
  'list.saved': 'Result saved: {file}',

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------
  'download.usage': `Usage: node cli.js download <collectionId|collectionURL|modelURL> [options]

Options:
  --out <dir>         Download into the given directory (relative to the project root)
  --only <id[,id]>    Process only the given modelId / versionId (comma separated)
  --version <m=v[,m=v]>  Choose which version of a model to download
  --force             Ignore completion records and download again
  --dry-run           Only list the download plan; do not download
  --jobs <n>          Number of models to download at once (defaults to jobs in config.json)
  --refresh-meta      Re-fetch metadata to discover files re-uploaded under the same version
  --resume            Resume the last cancelled job from its checkpoint list
  --from-cache        Use the item cache written by the last list run instead of re-enumerating (with --offline no browser is opened)
  --file-types <t,t>  Only download the given file types (default Model)
  --no-primary        Do not limit downloads to primary files
  --ignore-space      Continue even when disk space is insufficient
  --force-lock        Ignore the "another process is handling this collection" notice
  --reset-state       Ignore corrupt records and continue from an empty state (corrupt content is backed up automatically)
  --engine <name>     Download engine: curl (default) / aria2 / auto
  --dedup <mode>      Cross-collection dedup: off (default) / hardlink / copy
  --notify <url>      POST the result to this Webhook when the job finishes
  --toast             Show a system notification when the job finishes
  --collections <id,id>  Append more collections (processed in order)
  --model <URL|ID>    Download a single model (a model URL can also be passed as a positional argument)
  --models <ref,ref>  Download several single models (comma separated: model URL / model:<id> / version:<id>)
  --from-file <file>  Read targets from a file (one per line; blank lines and # comments are ignored)

Examples:
  node cli.js download 161131
  node cli.js download https://civitai.red/collections/161131 --jobs 2
  node cli.js download https://civitai.red/models/1191424?modelVersionId=1990837
  node cli.js download --models model:1191424,version:1990837
`,
  'download.versionFormat': 'Invalid --version format: {pair} (expected modelId=versionId)',
  'download.resumeRestored': 'Resumed {count} items from the checkpoint list (saved at {savedAt})',
  'download.resumeMissing': 'No checkpoint list found; running the normal flow',
  'download.noCache': 'No item cache available: {file}\nRun `node cli.js list {id}` first to create it.',
  'download.usingCache': 'Using item cache (fetched at {fetchedAt}) with {count} items',
  'download.modelNoVersions': 'Model {modelId} has no available versions',
  'download.modelVersionNotFound': 'Version {versionId} not found in model {modelId}',
  'download.singleModel': 'Single model download: {name} (version {version})',
  'download.unrecognizedArg': 'Unrecognized argument: {value} (expected a collection ID/URL or a model URL)',
  'download.badCollectionItem': 'Unrecognized item in --collections: {value}',
  'download.badModelFlag': 'Unrecognized --model: {value}',
  'download.metaFailedHint':
    'Tip: {count} items failed metadata fetching (usually a temporary network issue); rerun the same command to retry',
  'download.modelsBadItem': 'Unrecognized item in --models: {value} (expected a model URL, model:<id> or version:<id>)',
  'download.fromFileError': 'Cannot read the --from-file file: {file} ({message})',
  'download.fromFileEmpty': 'No valid targets in --from-file: {file}',
  'download.fromFileLoaded': 'Read {count} targets from {file}',
  'download.versionResolved': 'Version {versionId} belongs to model {name} ({modelId})',
  'download.versionNoModel': 'The metadata of version {versionId} has no modelId; cannot locate the model',

  // ---------------------------------------------------------------------------
  // check
  // ---------------------------------------------------------------------------
  'check.usage': `Usage: node cli.js check <collectionId|collectionURL|model:<modelId>|modelURL> [more targets…] [options]

Compare the collection membership snapshot (or an offline record) with the model library and report
membership changes plus the local file status (nothing is downloaded by default).
A collection is compared through the snapshot written by list/download (run list once);
model:<id> / a model URL checks that model only.

Options:
  --verify-files     Deep check: fetch online file hashes and verify local SHA256 (catches re-uploads/renames/additions/removals of the same version)
  --download         After checking, download only the changed items (version update / file change / missing locally)
  --all              Check every collection that has a membership snapshot
  --models           Check every model of the library
  --json             Output the check report as JSON
  --out <file>       Write the report to the given file (JSON)
  --quiet            Print only the summary, without the per-item report

Two modes:
  Default "quick": compares version numbers and local file sizes only, skipping metadata requests for completed items (takes seconds)
  --verify-files "deep": also compares online/local file hashes, which can reveal author re-uploads
`,
  'check.quietSummary':
    'Collection {collectionId}: {total} items | updated {updated} | file changed {fileChanged} | ' +
    'missing {missing} | not downloaded {notDownloaded} | pinned {pinned}',
  'check.modelQuietSummary':
    'Model {label}: {total} items | updated {updated} | file changed {fileChanged} | ' +
    'missing {missing} | not downloaded {notDownloaded} | pinned {pinned}',
  'check.modelHeader': '— Model {label} —',
  'check.modelIdLabel': 'modelId={modelId}',
  'check.modelsNone': 'No single-model download records yet (run node cli.js download model:<modelId> first)',
  'check.modelVersionHint': 'A version ID alone cannot locate a model: use model:<modelId> or a model URL',
  'check.deltaNew': '{count} new problem(s)',
  'check.deltaFixed': '{count} fixed',
  'check.deltaSummary': 'Compared with the last check ({checkedAt}): {parts}',
  'check.unrecognizedCollection': 'Unrecognized collection: {value}',
  'check.collectionHeader': '— Collection {collectionId} —',
  'check.reportWritten': 'Report written to {file}',
  'check.changesFound': '{count} items changed; add --download to download only these',
  'check.noChanges': 'No changes to handle',
  'check.noDownloadChanges': 'No changed items to download',
  'check.stateReset': 'Reset the state of {count} items for re-verification/download',

  // ---------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------
  'verify.usage': `Usage: node cli.js verify [collectionId…|model:<modelId>…] [options]

No network enumeration: verify files directly against the model library (full SHA256 check by default).

Options:
  --all          Verify every model of the library
  --models       Same as --all (kept for compatibility)
  --no-hash      Compare file sizes only, without computing SHA256 (much faster)
  --repair       Re-download broken/missing files (requires download URLs in the records)
  --offline      Do not open a browser when repairing; use the existing cookie file
  --json         Output the result as JSON
`,
  'verify.summary': '{label}: {total} models ({versions} versions), {size} in total',
  'verify.allLabel': 'Model library',
  'verify.collectionLabel': 'collection {collectionId}',
  'verify.modelLabel': 'model {label}',
  'verify.libraryEmpty': 'The model library is empty (download a collection or a single model first)',
  'verify.snapshotMissing': 'Collection {value} has no membership snapshot yet; run node cli.js list {value} first',
  'verify.corruptLine': '  ! {message}',
  'verify.brokenLine': '  ! {name}: {reasons}',
  'verify.brokenDir': '    Directory: {dir}',
  'verify.counts': '  {ok} OK, {broken} broken',
  'verify.unrecognizedCollection': 'Unrecognized collection: {value}',
  'verify.brokenTotal': '{count} items are broken; add --repair to download these files again (--offline avoids opening a browser)',
  'verify.allPassed': 'All files verified successfully',
  'verify.nothingToRepair': 'No files need repairing',
  'verify.missingDownloadUrl':
    'Tip: {count} files of {name} have no download URL (old records); run check --verify-files once to fill them in',
  'verify.repairing': 'Repairing {name} ({count} files)…',

  // ---------------------------------------------------------------------------
  // doctor
  // ---------------------------------------------------------------------------
  'doctor.usage': `Usage: node cli.js doctor [collectionId] [--json] [--deep]

Checks: Node version, config, curl, browser, debug port, cookies, writable directories, disk space, long path support.
  --deep  Also check whether the saved session really works (requires a browser)
  --json  Output as JSON
`,
  'doctor.title': 'Environment check',
  'doctor.tagOk': '[ OK ]',
  'doctor.tagWarn': '[WARN]',
  'doctor.tagFail': '[FAIL]',
  'doctor.line': '{tag} {name}: {detail}',
  'doctor.hintLine': '        → {hint}',
  'doctor.summaryFails': 'Found {fails} problem(s) and {warns} warning(s)',
  'doctor.summaryWarns': 'No blocking problems; {warns} warning(s)',
  'doctor.summaryOk': 'Everything looks fine',
  'doctor.nodeVersion': '{version} ({platform} {arch})',
  'doctor.itemConfigWarnings': 'Config',
  'doctor.hintConfigWarnings': 'Check config.json for typos',
  'doctor.itemConfigFile': 'Config file',
  'doctor.configMissingSuffix': ' (not found, using defaults)',
  'doctor.hintConfigFileMissing': 'Copy config.example.json to config.json',
  'doctor.itemSite': 'Site',
  'doctor.itemProxy': 'Proxy',
  'doctor.curlAvailable': '{bin} available',
  'doctor.hintCurl': 'Install curl or add it to PATH',
  'doctor.itemBrowser': 'Browser',
  'doctor.hintChromePath': 'Set chromePath in config.json',
  'doctor.itemBrowserProfile': 'Browser profile',
  'doctor.profileExplicit': 'explicitly configured, not isolated per site',
  'doctor.profileIsolated': 'isolated per site, so switching sites keeps sessions separate',
  'doctor.itemEngine': 'Download engine',
  'doctor.engineDetail': 'Configured {engine}; aria2c {aria2}{dedup}',
  'doctor.aria2Available': 'available (faster with multiple connections)',
  'doctor.aria2Missing': 'not installed',
  'doctor.dedupSuffix': '; dedup {mode}',
  'doctor.hintAria2Missing': 'aria2c is not installed: install it or switch engine back to curl',
  'doctor.itemDebugPort': 'Debug port',
  'doctor.portReady': 'Port {port} already has a browser ({browser})',
  'doctor.unknownBrowser': 'unknown',
  'doctor.portNotReady': 'Port {port} is not ready yet ({reason})',
  'doctor.hintDebugPort': 'A browser starts automatically at runtime; if the port is taken, change debugPort in config.json',
  'doctor.itemLogin': 'Session',
  'doctor.cookiesMissing': '{file} not found',
  'doctor.hintRunLogin': 'Run the login flow (npm run login)',
  'doctor.cookiesNoAuth': 'Exported {count} cookies, but no login credential was found',
  'doctor.hintRelogin': 'Run the login flow again',
  'doctor.credentialExpiring': 'Credential expires soon ({expiresAt})',
  'doctor.hintReloginSuggested': 'Signing in again is recommended',
  'doctor.cookiesOk': 'Exported {count} cookies including the login credential',
  'doctor.itemOutDir': 'Output directory',
  'doctor.dirError': '{dir}: {error}',
  'doctor.hintOutDirPermission': 'Check directory permissions or use another directory',
  'doctor.itemDataDir': 'Data directory',
  'doctor.itemDiskSpace': 'Disk space',
  'doctor.spaceUnknown': 'unreadable',
  'doctor.spaceRemaining': '{size} free',
  'doctor.itemLongPath': 'Long paths',
  'doctor.longPathOk': 'Paths longer than 260 characters can be created',
  'doctor.hintLongPath': 'Enable long path support in system policy, or shorten outDir',
  'doctor.itemSnapshot': 'Collection snapshot',
  'doctor.hintSnapshot': 'Delete the matching file under .data/collections to enumerate again',
  'doctor.snapshotMissing': 'Collection {collectionId} has no membership snapshot yet (run node cli.js list {collectionId})',
  'doctor.hintRunList': 'Run list or download once to write the membership snapshot',
  'doctor.snapshotInfo': 'Collection {collectionId} has {count} members (enumerated at {fetchedAt})',
  'doctor.itemLibrary': 'Model library',
  'doctor.libraryStats': '{models} models / {versions} versions (inspect with node cli.js models)',
  'doctor.hintLibrary': 'The library is corrupt: delete .data/library.json and download again (local files are kept)',
  'doctor.hintLibraryList': 'One record per model; collections are only membership lists',
  'doctor.itemLanguage': 'UI language',
  'doctor.itemBrowserMode': 'Browser mode',
  'doctor.browserModeHeadless': 'Headless (no window; the login flow still opens one)',
  'doctor.browserModeHeadful': 'Windowed (needed for the first login)',
  'doctor.languageExplicit': '{language} (explicit: -l/--lang or config.json)',
  'doctor.languageAuto': '{language} (auto-detected system language)',
  'doctor.languageFallback': '{language} (no usable system language; English fallback)',
  'doctor.itemLoginProbe': 'Live session check',

  // ---------------------------------------------------------------------------
  // pin
  // ---------------------------------------------------------------------------
  'pin.usage': `Usage:
  node cli.js pin <modelId> [versionId]        Pin a version (omit versionId to pin the newest downloaded version)
  node cli.js pin model:<modelId> [versionId]  Same, compatibility form
  node cli.js pin <modelId> --list             List the pinned versions of that model
  node cli.js pin <modelId> --unpin            Unpin
  node cli.js pin --list                       List every pinned model of the library
`,
  'pin.listHeader': 'Model library: {total} models, {pinned} with a pinned version',
  'pin.modelListHeader': 'Model {modelId}: {versions} versions, {pinned} with a pinned version',
  'pin.listEmpty': 'No download records yet (no model in .data/library.json)',
  'pin.invalidTarget': 'Unrecognized target: {value} (expected a model ID or model:<modelId>)',
  'pin.modelNoRecord': 'Model {modelId} has no completion record',
  'pin.listItem': '  * {name} → pinned {version}',
  'pin.modelIdLabel': 'modelId={modelId}',
  'pin.emptyHint': '  Tip: node cli.js pin <modelId> pins a model to its current version',
  'pin.unpinned': 'Unpinned: {name} (the next download will follow the online version)',
  'pin.noVersion': 'Cannot determine which version to pin: the record has no versionId, please pass one explicitly',
  'pin.pinned': 'Pinned: {name} → {version}',

  // ---------------------------------------------------------------------------
  // models (model library: list / export / forget / pin / relayout)
  // ---------------------------------------------------------------------------
  'models.usage': `Usage: node cli.js models [options]

List and manage the download records of the model library (one model, several versions, one record per model) in .data/library.json.

Options:
  --json                     Output JSON (same shape as the .json export)
  --search <keyword>         Filter by name or model ID
  --sort <name|size|recent>  Sort by name / size (largest first) / last completion (default recent)
  --export <file>            Export as .json or .csv (chosen by file extension)
  --forget <id[,id]>         Remove records from the library (1191424 or model:1191424)
  --version <versionId>      With --forget: remove only that version record
  --delete-files             With --forget: also delete the files listed in the record and prune empty directories
  --pin <id>[=<versionId>]   Pin a version (omit the version to pin the newest recorded one)
  --unpin <id>               Unpin
  --relayout                 Recompute directories from the current layout / baseModelLayer and move the downloaded files
  --dry-run                  With --relayout: only report what would move; touch neither disk nor records

CSV columns of --export: modelId,name,type,versionId,versionName,files,bytes,outDir,dirName,pinned,verifiedAt
(the pinned column marks whether that row is the pinned version: yes or empty)

Examples:
  node cli.js models
  node cli.js models --search lora --sort size
  node cli.js models --export models.csv
  node cli.js models --forget 1191424 --version 1990837 --delete-files
  node cli.js models --pin 1191424=1990837
  node cli.js models --relayout --dry-run
`,
  'models.listHeader': 'Model library: {count} records:',
  'models.listEmpty': 'No download records yet (node cli.js download model:<modelId> downloads one)',
  'models.noMatch': 'No matching model records',
  'models.listLine': '  · {name} (modelId={modelId}) | versions {count} | total {size} | {pinned}',
  'models.versionLine': 'Versions: {versions}',
  'models.versionItem': '{name} ({versionId}, {size})',
  'models.versionItemPinned': '{name} ({versionId}, {size}, pinned)',
  'models.noVersions': '(the record holds no version information)',
  'models.separator': ', ',
  'models.dirLine': 'Directory: {dir}',
  'models.modelIdLabel': 'modelId={modelId}',
  'models.pinnedTag': 'pinned {version}',
  'models.notPinnedTag': 'not pinned',
  'models.corruptLine': '  ! {message}',
  'models.sortInvalid': 'Unknown sort mode: {value} (available: name / size / recent)',
  'models.exportBadExt': 'Unsupported export format: {file} (use .json or .csv)',
  'models.exportWritten': 'Exported {count} model records to {file}',
  'models.forgetNoId': '--forget needs at least one model ID',
  'models.forgetNoRecord': 'No model record found: {modelId}',
  'models.forgetNoVersion': 'Model {modelId} has no record for version {versionId}',
  'models.forgetModelsDone': 'Removed {count} model records',
  'models.forgetVersionsDone': 'Removed {count} version records',
  'models.forgetNothing': 'Nothing was removed',
  'models.filesDeleted': 'Deleted {files} files and {dirs} empty directories',
  'models.filesMissing': '{count} files listed in the record no longer exist (skipped)',
  'models.legacyNoFiles': 'The record has no file manifest; cannot delete files by record: {modelId}',
  'models.deleteFilesHint': 'Tip: add --delete-files to also delete the files listed in the record',
  'models.pinFormat': 'Invalid --pin/--unpin value: {value} (expected <modelId> or <modelId>=<versionId>)',
  'models.noRecord': 'No model record found: {modelId}',
  'models.pinNoVersion': 'Model {modelId} has no version record to pin',
  'models.pinVersionNotFound': 'Model {modelId} has no record for version {versionId} (available: {versions})',
  'models.pinDone': 'Pinned: {name} → {version}',
  'models.unpinDone': 'Unpinned: {name}',
  'models.relayoutPlanned': 'Relayout plan: {models} models / {versions} versions, {files} files to handle, {renamed} of them need a name change after a clash',
  'models.relayoutDryRun': '(--dry-run) no file or record was changed',
  'models.relayoutDone': 'Relayout finished: {models} models / {versions} versions, {files} files handled, {dirs} empty directories pruned, {renamed} clash renames (cross-volume copies: {copied})',
  'models.relayoutMissing': '{count} files listed in the records no longer exist (skipped)',

  // ---------------------------------------------------------------------------
  // runtime (error presentation)
  // ---------------------------------------------------------------------------
  'runtime.configWarning': 'Config notice: {message}',
  'runtime.fatalError': 'Error: {message}',
  'runtime.hintAuth': 'Tip: run the login flow to refresh the session (npm run login, or "Login / Refresh login" in the TUI)',
  'runtime.hintChallenge': 'Tip: complete the human verification in the browser window and retry',
  'runtime.hintRateLimit': 'Tip: the site is rate limiting; retry later or lower apiRateLimit in config.json',
  'runtime.hintSiteInterface': 'Tip: the site interface may have changed; override trpcPath / trpcInput in config.json',
  'runtime.hintNetwork': 'Tip: check the network/proxy settings (proxy in config.json)',

  // ---------------------------------------------------------------------------
  // util.js (errors and formatting reused by other modules)
  // ---------------------------------------------------------------------------
  'util.verifyCancelled': 'Verification cancelled',
  'util.hashWorkerExited': 'Hash worker exited unexpectedly (code {code})',
  'util.emptyFile': 'File is empty',

  // ---------------------------------------------------------------------------
  // notify.js
  // ---------------------------------------------------------------------------
  'notify.finished': 'Job finished',
  'notify.cancelledSummary': 'Cancelled: {done} done, {skipped} skipped, {failed} failed',
  'notify.summary': '{done} done, {skipped} skipped, {failed} failed',
  'notify.toastTitle': 'Civitai download finished',
  'notify.webhookFailed': 'Webhook notification failed: {error}',

  // ---------------------------------------------------------------------------
  // config.js
  // ---------------------------------------------------------------------------
  'config.intRange': '{key} in config.json must be an integer in range {range} (current: {value})',
  'config.hintSuffix': ' ({hint})',
  'config.required': '{key} in config.json must not be empty{hint}',
  'config.invalidFormat': 'Invalid {key} in config.json: {value}{hint}',
  'config.unknownKey': 'Unknown config key "{key}" (ignored; check for typos)',
  'config.trpcInputNotObject':
    'trpcInput in config.json must be an object (it is merged into the built-in tRPC request body template)',
  'config.fileTypesInvalid':
    'fileTypes in config.json must be a non-empty array of strings, for example ["Model"]',
  'config.engineInvalid': 'engine in config.json must be "curl", "aria2" or "auto"',
  'config.dedupInvalid': 'dedup in config.json must be "off", "hardlink" or "copy"',
  'config.layoutInvalid': 'layout in config.json must be "a1111", "comfy" or "custom" (got: {value})',
  'config.typeFoldersNotObject': 'typeFolders in config.json must be an object, for example { "LORA": "lora" }',
  'config.typeFoldersInvalid': 'typeFolders["{type}"] in config.json must be a non-empty string',
  'config.headlessInvalid': 'headless in config.json must be "auto", "always" or "never" (got: {value})',
  'config.readFailed': 'Cannot read config.json: {error}',
  'config.parseFailed': 'Failed to parse config.json: {error}',
  'config.topLevelNotObject': 'The top level of config.json must be an object',
  'config.hintSiteUrl': 'must start with http(s)://',
  'config.hintOutDir': 'download directory',
  'config.hintProxy': 'e.g. http://127.0.0.1:7890',
  'config.hintWebhook': 'e.g. https://example.com/hook',
  'config.languageUnsupported':
    'Unsupported language in config.json: {value} (use en, zh-CN, or leave it empty for auto-detection)',

  // ---------------------------------------------------------------------------
  // browser.js
  // ---------------------------------------------------------------------------
  'browser.chromePathMissing': 'The file chromePath points to in config.json does not exist: {path}',
  'browser.notFound':
    'Chrome/Edge not found. Install Chrome, or set chromePath in config.json (current platform: {platform})',
  'browser.portNotDebug': 'the port responds but is not a debugging endpoint (it may be used by another program)',
  'browser.portNoWsUrl': 'the debugging endpoint has no webSocketDebuggerUrl',
  'browser.connectTimeout': 'connection timed out',
  'browser.portNoResponse': 'the port does not respond',
  'browser.launching': 'Launching browser: {exe}',
  'browser.launchingHeadless': 'Launching headless browser (no window): {exe}',
  'browser.debugPortLine': '  Debug port: {port}',
  'browser.proxyLine': '  Proxy: {proxy}',
  'browser.noResponse': 'no response',
  'browser.launchTimeout':
    'Browser launch timed out (30s, port {port}: {reason}).\n' +
    'Common causes:\n' +
    '  1) An existing Chrome is already running with the same profile ({profileDir}) but without the debug port — close that browser completely and retry;\n' +
    '  2) Port {port} is taken by another program — change debugPort in config.json;\n' +
    '  3) The launch failed — set chromePath explicitly in config.json.',
  'browser.connected': 'Connected to the running browser (port {port})',
  'browser.portOccupied': 'Port {port} is taken by another program ({reason}); trying to launch a new browser…',
  'browser.portNotReady': 'Port {port} {reason}; trying to launch a new browser…',
  'browser.started': 'Browser started',
  'browser.startedHeadless': 'Headless browser started (no window)',

  // ---------------------------------------------------------------------------
  // collection.js
  // ---------------------------------------------------------------------------
  'collection.challengeProbe':
    'The site requires human verification; complete it in the browser window and retry',
  'collection.unauthorized': 'Not signed in, or the session has expired',
  'collection.trpcBadJson': 'The tRPC response is not valid JSON (the site interface may have changed): {sample}',
  'collection.trpcError': 'tRPC error: {message}',
  'collection.trpcDevalueFailed': 'Failed to parse the tRPC payload (devalue): {message}',
  'collection.challenge':
    'The site returned a human verification page. Switch to the browser window, complete the verification manually, then run this command again.',
  'collection.authRequired': 'Not signed in, or the session has expired; run: npm run login',
  'collection.trpcRequestFailed': 'tRPC request failed with HTTP {status}: {sample}',
  'collection.unexpectedShape':
    'Unexpected response shape (the site interface may have changed): expected an items array, got {actual}\nRaw response snippet: {sample}',
  'collection.usingPage': 'Using page: {url}',
  'collection.requestTimeout': 'The page request did not return within {ms} ms (aborted; retry or check the network/proxy)',
  'collection.timeoutShort': 'Page request timed out',
  'collection.pageProgress': '  Page {page}: {count} items returned, {added} new, {total} total',

  // ---------------------------------------------------------------------------
  // api.js
  // ---------------------------------------------------------------------------
  'api.requestFailed': 'Request failed ({reason}): {url}',
  'api.timeout': 'timed out',
  'api.rateLimited': 'HTTP 429 (site rate limit hit)',
  'api.authRequired': 'HTTP {status}: not signed in, or the session has expired',
  'api.notFound': 'HTTP 404: {url}',
  'api.httpError': 'HTTP {status}: {url}',
  'api.badJson': 'The response is not valid JSON (the site interface may have changed): {url}',
  'api.retrying': '  Request failed (attempt {attempt}): {message}; retrying in {seconds}s',
  'api.noLatestVersionLine': '[{index}/{total}] {name} -> no available latest version',
  'api.noLatestVersion': 'no latest version',
  'api.noFiles': 'No downloadable {types} files (the site interface may have changed)',
  'api.itemFiles': '[{index}/{total}] {name} | {count} files | {size}',
  'api.metaFailedLine': '[{index}/{total}] Failed to fetch metadata: {name} -> {message}',

  // ---------------------------------------------------------------------------
  // storage.js
  // ---------------------------------------------------------------------------
  'storage.stateCorrupt':
    'Cannot parse the file ({reason}): {file}\nBacked up as {backup}. ' +
    'Once you are sure, delete that file to start recording from scratch (locally downloaded files are kept).',
  'storage.backupFailed': '(backup failed)',
  'storage.reasonEmpty': 'the file is empty',
  'storage.reasonUnknown': 'unknown reason',
  'storage.reasonNotObject': 'the top level is not an object',
  'storage.reasonNoEntries': 'the top level has no entries object',
  'storage.lockConflict':
    'Another process is using the model library (PID {pid}, started at {startedAt}).\n' +
    'If you are sure no other task is running, retry with --force, or delete the lock file: {file}',
  'storage.unknownStart': 'unknown',
  'storage.lockFailed': 'Cannot acquire the lock file of the model library: {file}',
  'storage.legacyMoved': 'Moved {count} old-format files into {dir} (the new format never reads them)',

  // ---------------------------------------------------------------------------
  // downloader.js
  // ---------------------------------------------------------------------------
  'downloader.curlExitCode': '{bin} exited with code {code}',
  'downloader.curlLastError': ' (last attempt: {error})',
  'downloader.curlMissing':
    'No usable curl found{detail}. Install curl (bundled with Windows 10/11) or add it to PATH.',
  'downloader.aria2Missing':
    'config.json sets engine=aria2, but aria2c was not found (install it and add it to PATH, or switch back to curl)',
  'downloader.existingHashMismatch': '  The existing file hash does not match; downloading again: {file}',
  'downloader.partTooLarge': '  The existing part is larger than expected ({size}); discarding it',
  'downloader.partReused': '  Using the completed part: {file}',
  'downloader.partVerifyFailed':
    '  The complete part failed verification; deleting it and downloading again: {file}',
  'downloader.remoteChanged': '  The remote file changed (different ETag); discarding the old part and downloading again',
  'downloader.authFailed': 'Authentication failed (HTTP {status}); the session may have expired, run again: npm run login',
  'downloader.notFound404': 'HTTP 404: the download link is invalid or the file was removed',
  'downloader.rangeRejected': '  The server rejected the resume request (HTTP 416); discarding the part and downloading again',
  'downloader.rateLimited': '  Rate limited (HTTP 429); waiting 30 seconds before retrying',
  'downloader.resumeFailed': '  Resume failed ({engine} exit {code}); discarding the part and downloading again',
  'downloader.attemptFailed': '  Attempt {attempt}/{attempts} failed (exit={code}, HTTP {http}){detail}; retrying later',
  'downloader.attemptNoFile': '  Attempt {attempt}/{attempts} produced no file; retrying later',
  'downloader.sizeExceeded': '  The file is larger than expected ({size} > {expected}); deleting it and retrying',
  'downloader.shaMismatch': '  SHA256 mismatch (actual {actual}); deleting it and downloading again',
  'downloader.hashComputeFailed': 'computation failed',
  'downloader.resuming': '  Downloaded {size} / {total}; resuming (attempt {attempt}/{attempts})',
  'downloader.failed': 'Download failed (retried {attempts} times): {file}',

  // ---------------------------------------------------------------------------
  // job.js
  // ---------------------------------------------------------------------------
  'job.offlineNeedsPlan':
    'Offline mode requires a download plan (--resume or verify --repair); the collection cannot be enumerated',
  'job.start': '=== Start === collection {collectionId} | output directory: {outDir}',
  'job.corruptWarning': 'Warning: {message}',
  'job.resetStateNotice':
    'Ignoring the corrupt records because of --reset-state and starting from an empty library (locally downloaded files are kept).',
  'job.snapshotSaved':
    'Membership snapshot updated: {count} items ({added} added, {removed} removed, {versionChanged} version changes)',
  'job.filesRenamed': 'A file name clashed with an older version; renamed {count} files (model {name})',
  'job.versionSuffix': 'Version {version} of {name} shares file names with a downloaded version, so its files get a version suffix',
  'job.onlyFiltered': '--only filter: {before} -> {after} items',
  'job.onlyNoMatch': 'No item matched --only; check the IDs',
  'job.emptyCollection': 'The collection is empty; nothing to download',
  'job.versionAdded': 'New version for {name}: {to} (keeping local {from})',
  'job.fetchingMeta': 'Fetching file metadata ({count} items, concurrency {concurrency})…',
  'job.resolvingVersions': 'Resolving the requested versions ({count} items)…',
  'job.versionNotFound': 'Version {versionId} not found',
  'job.versionNoFiles': 'This version has no downloadable files',
  'job.versionOverride': 'Version override ({source}): {name} -> {version}',
  'job.versionOverrideFailed': 'Version override failed: {message}',
  'job.versionOverrideIgnored': 'modelId {modelId} from --version is not in this plan; ignored',
  'job.noMetadata': 'no metadata available',
  'job.contentUnchanged': 'Content unchanged; skipping {name}',
  'job.planSummary': 'Download plan: {todo} to download, {skipped} already done, {total} in total',
  'job.metaFailedItem': 'Metadata failed: {name} -> {error}',
  'job.planLine': '  [plan] {name} / {file} ({size})',
  'job.dryRunDone': '--dry-run finished; nothing was downloaded',
  'job.nothingToDownload': 'Nothing to download (everything is done; add --force to download again)',
  'job.summary': '{head} {done} done, {skipped} skipped, {failed} failed{metaFailed} (took {elapsed})',
  'job.summaryMetaSuffix': ', {count} metadata failures',
  'job.headDone': '=== Done ===',
  'job.headCancelled': '=== Cancelled ===',
  'job.insufficientSpace':
    'Not enough disk space: {total} planned, but the disk holding {dir} has only {free} left.',
  'job.insufficientSpaceHint': 'Free up some space and retry, or add --ignore-space to skip this check.',
  'job.offlineNoCookies': 'Offline mode needs an existing cookie file: {file}\nRun the login flow first.',
  'job.offlineUsingCookies': 'Offline mode: using the existing cookie file {file}',
  'job.unknownCookieCount': 'unknown',
  'job.cookiesExported': 'Exported browser cookies ({count}) -> {file}',
  'job.browserSkipped': 'No browser needed (cookies already exported; downloading over plain HTTP)',
  'job.dedupEnabled': 'Content dedup enabled ({mode})',
  'job.modeHardlink': 'hardlink',
  'job.modeCopy': 'copy',
  'job.stateWriteFailed': 'Failed to write the state: {message}',
  'job.itemSkipped': 'Skipped {name} (downloaded .part files are kept and can be resumed)',
  'job.downloadLine': 'Downloading [{index}/{total}] {name} / {file} ({size})',
  'job.dedupLine': '  Content dedup ({mode}): {file} <- {source}',
  'job.dedupFailed': '  Dedup failed ({message}); falling back to a normal download: {file}',
  'job.authRefreshing': 'The session may have expired; re-exporting cookies and retrying…',
  'job.cookiesRefreshed': 'Re-exported {count} cookies',
  'job.cancelNotice': 'Current download cancelled (downloaded .part files are kept and can be resumed)',
  'job.fileFailed': '  Failed: {file} -> {message}',
  'job.fileVerified': '  Already exists and passed verification: {file}',
  'job.fileDeduped': '  Placed via content dedup: {file}',
  'job.fileDownloaded': '  Downloaded and verified: {file}',
  'job.itemDone': 'Completed {name} ({done} done / {skipped} skipped / {failed} failed)',
  'job.queueSaved': 'Saved the checkpoint list ({count} items) -> {file}; continue with --resume',
  'job.queueSaveFailed': 'Failed to save the checkpoint list: {message}',
  'job.logFile': 'Log file: {file}',

  // ---------------------------------------------------------------------------
  // updater.js
  // ---------------------------------------------------------------------------
  'updater.missingFile': 'missing {file}',
  'updater.sizeMismatch': 'size mismatch {file}',
  'updater.shaMismatch': 'SHA256 mismatch {file}',
  'updater.verifying': '  Verifying {file} …',
  'updater.noMetadata': 'no metadata available',
  'updater.snapshotMissing': 'Collection {collectionId} has no membership snapshot yet; run node cli.js list {collectionId} first',
  'updater.snapshotLine': 'Membership snapshot: {count} items (enumerated at {fetchedAt})',
  'updater.changesLine': 'Compared with the previous enumeration: {added} added, {removed} removed, {versionChanged} version changes (previous enumeration at {previousFetchedAt})',
  'updater.firstSnapshot': 'first enumeration',
  'updater.corruptLine': '  ! {message}',
  'updater.fetchingMeta': 'Fetching online file metadata ({count} items, concurrency {concurrency})…',
  'updater.unknownVersion': 'unknown version',
  'updater.checkDone': 'Check finished: collection {collectionId} @ {checkedAt} ({mode})',
  'updater.deepCheck': 'deep check',
  'updater.quickCheck': 'quick check',
  'updater.noState': 'This collection has no download records yet; download it first, then check for updates',
  'updater.updatedHeader': '[Updates] {count} items',
  'updater.updatedLine': '  ↑ {name}: {from} → {to}',
  'updater.pinnedHeader': '[Pinned versions (not following online updates)] {count} items',
  'updater.pinnedLine': '  * {name}: pinned {pinned}, online is now {online}',
  'updater.fileChangedHeader': '[File changes (re-uploaded under the same version)] {count} items',
  'updater.changePart': 'content changed: {names}',
  'updater.addedPart': 'added: {names}',
  'updater.removedPart': 'removed: {names}',
  'updater.renamedPart': 'renamed: {names}',
  'updater.renamePair': '{from}→{to}',
  'updater.fileChangedLine': '  ~ {name}: {parts}',
  'updater.nameSeparator': ', ',
  'updater.uncheckedChanges':
    '[File changes] not checked (quick mode only compares version numbers and local file sizes; add --verify-files to detect re-uploads under the same version)',
  'updater.missingHeader': '[Missing/broken locally] {count} items',
  'updater.missingLine': '  ! {name}: {reasons}',
  'updater.legacyHeader': '[Legacy records (no file manifest, not verified locally)] {count} items',
  'updater.legacyLine': '  ? {name}',
  'updater.legacyHint': '  Tip: use --verify-files (deep check in the TUI) to verify local files and fill in the manifest',
  'updater.upgradedHeader': '[Verified and manifest filled in] {count} items',
  'updater.failedHeader': '[Metadata fetch failed, skipped] {count} items',
  'updater.failedLine': '  x {name}: {error}',
  'updater.removedHeader': '[Removed from the collection (local files kept)] {count} items',
  'updater.removedLine': '  - {name}',
  'updater.modelIdLabel': 'modelId={modelId}',
  'updater.notDownloadedHeader':
    '[Not downloaded from the collection] {count} items (select them in the download flow to fetch)',
  'updater.allGood': 'All good: {count} items downloaded and up to date',
  'updater.stats':
    'Stats: {total} items ({updated} updated, {fileChanged} file changes, ' +
    '{missing} missing, {notDownloaded} not downloaded, {pinned} pinned)',
  'updater.modelCheckDone': 'Check finished: model {name} ({modelId}) @ {checkedAt} ({mode})',
  'updater.fetchingModel': 'Fetching version info for model {modelId}…',
  'updater.noOnlineVersions': 'No available version on the site',
  'updater.versionGoneOnline': 'This version no longer exists online',
  'updater.notDownloadedShort': 'not downloaded',
  'updater.removedVersionSuffix': ' (version {versionId})',
  'updater.historyHeader': '[Local historical versions kept] {count} items',
  'updater.historyLine': '  · {name}: {versions}',

  // ---------------------------------------------------------------------------
  // TUI (terminal UI, src/tui/**)
  // Cursor marks (▸), progress-bar glyphs (█░), checkboxes ([×]/[ ]), tag brackets
  // (e.g. [ OK ]) and separators (· / ｜ / spaces) stay in code; only user-readable
  // text lives here.
  // ---------------------------------------------------------------------------

  // app.js: banner / context line / main menu
  'tui.app.bannerTitle': 'civitai-downloader',
  'tui.app.bannerHint': '↑↓ Select · Enter Confirm · Ctrl+C Cancel/Quit; during a download press s to skip the current model',
  'tui.app.loggedIn': 'exported (log in again if it reports expired)',
  'tui.app.notLoggedIn': 'not logged in',
  'tui.app.contextLine': 'Site {site} · Output dir {outDir} · Concurrency {jobs} · Session {logged}',
  'tui.app.factSite': 'Site',
  'tui.app.factOutDir': 'Download directory',
  'tui.app.factJobs': 'Concurrency',
  'tui.app.factSession': 'Session',
  'tui.app.menuTitle': 'Main menu',
  'tui.app.menuDownload': 'Download a collection',
  'tui.app.menuDownloadDesc': 'Enumerate items → filter/select → choose versions → download (resumable)',
  'tui.app.menuModels': 'Model library',
  'tui.app.menuModelsDesc': 'Download/manage models (one model, several versions): check updates, verify, pin versions, delete records',
  'tui.app.menuCheck': 'Check for updates',
  'tui.app.menuCheckDesc': 'Compare collection membership snapshots against the library and download only what changed',
  'tui.app.menuVerify': 'Verify / repair local files',
  'tui.app.menuVerifyDesc': 'Verify file integrity against the library records; re-download only broken files',
  'tui.app.menuLogin': 'Log in / refresh login',
  'tui.app.menuLoginDesc': 'Open the browser to log in to Civitai, or just check the session',
  'tui.app.menuManage': 'Collection members and changes',
  'tui.app.menuManageDesc': 'Inspect a snapshot time and its added/removed/version changes; reset a model for re-download',
  'tui.app.menuSettings': 'Settings',
  'tui.app.menuSettingsDesc': 'Edit config.json (directories, site, concurrency, proxy, …)',
  'tui.app.menuDoctor': 'Environment check',
  'tui.app.menuDoctorDesc': 'Check curl / browser / port / session / disk space',
  'tui.app.menuOpen': 'Open the download directory',
  'tui.app.menuOpenDesc': 'Open the current output directory in the file explorer',
  'tui.app.menuHelp': 'Help / shortcuts',
  'tui.app.menuHelpDesc': 'Common workflows and every key (also available with ? inside a list)',
  'tui.app.menuExit': 'Exit',
  'tui.app.opened': 'Opened: {dir}',
  'tui.app.openFailed': 'Failed to open the directory',
  'tui.app.operationFailed': 'Operation failed: {error}',
  'tui.app.interruptNotice': 'Current operation cancelled (press Ctrl+C once more in the main menu to quit)',
  'tui.app.byeAbort': 'Exited.',
  'tui.app.goodbye': 'Goodbye.',

  // view.js
  'tui.view.helpNoWait': '(this terminal cannot read keys, so the help page will not wait; press Enter to continue)',
  // view.js: decision echo left behind by a full-screen screen
  'tui.view.decisionCancelled': 'Selection cancelled',
  'tui.view.decisionSelected': 'Selected: {name}',
  'tui.view.decisionPicked': '{count} items selected',
  'tui.view.nothingToCancel': 'Nothing to cancel right now (press Ctrl+C again in the main menu to quit)',

  // select.js: sort labels / key hints / status text
  'tui.select.sortDefault': 'Default order',
  'tui.select.sortName': 'By name',
  'tui.select.sortSizeDesc': 'By size ↓',
  'tui.select.sortSizeAsc': 'By size ↑',
  'tui.select.keyHintMove': '↑/↓·k/j Move | Home/End First/Last | PgUp/PgDn·[ ] Page',
  'tui.select.keyHintSelect': 'Space Toggle | a Select/deselect all | i Invert | / Search',
  'tui.select.keyHintAction': 't Type | b Base model | s Sort | 1-9 Jump | Enter Confirm | ? Help | Esc/q/Ctrl+C Cancel',
  'tui.select.statusDownloaded': 'Downloaded',
  'tui.select.statusUpdated': 'Update available',
  'tui.select.statusPinned': 'Version pinned',
  // select.js: header / columns / footer
  'tui.select.filterSearchQuoted': 'Search: "{value}"',
  'tui.select.filterSearchOff': 'Search: off',
  'tui.select.filterType': 'Type: {value}',
  'tui.select.filterBaseModel': 'Base model: {value}',
  'tui.select.filterSort': 'Sort: {value}',
  'tui.select.filterPage': 'Page {page}/{pageCount}',
  'tui.select.filterRows': 'Rows {from}-{to}/{total}',
  'tui.select.allValues': 'All',
  'tui.select.summary': 'Selected {selected} / {total} items · {visible} after filtering · Total {selectedSize} (all {visibleSize})',
  'tui.select.defaultTitle': 'Select items to download',
  'tui.select.columnIndex': 'No.',
  'tui.select.columnName': 'Name',
  'tui.select.columnDetail': 'Status / Type / Base model',
  'tui.select.columnSize': 'Size',
  'tui.select.footer': 'Page {page}/{pageCount} · {count} items on this page · Selected {selected}/{total}',
  'tui.select.noMatches': 'No matching items (adjust the filters with / t b)',
  'tui.select.typing': 'Typing…',
  // select.js: action feedback
  'tui.select.toggledOn': 'Selected',
  'tui.select.toggledOff': 'Deselected',
  'tui.select.allCleared': 'Selection cleared',
  'tui.select.allSelected': 'Selected all {count} items',
  'tui.select.inverted': 'Selection inverted',
  'tui.select.rangeSelected': '{count} rows selected in a run (keep using Shift+↑/↓)',
  'tui.select.searchExited': 'Search input closed',
  'tui.select.messageSearch': 'Search: {value}',
  'tui.select.searchCleared': 'Search cleared',
  'tui.select.searchHint': 'Type a keyword (Enter/Esc to finish)',
  'tui.select.needSelection': 'Select at least 1 item first (Space to toggle / a to select all)',
  'tui.select.noItems': 'No items to choose from',
  'tui.select.selectorUnavailable': 'Interactive selector unavailable ({error}); falling back to the simple prompt',
  'tui.select.selectorRenderFailed': 'Interactive selector failed to render ({error}); falling back to the simple prompt',

  // select.js: context-aware hints / help overlay / single-select mode
  'tui.select.searchHintTyping': 'Type the keyword (Backspace deletes, Enter applies the filter, Esc clears and closes)',
  'tui.select.searchHintKeys': 'Searching: ↑/↓ still move the cursor | Enter ends input | Esc clears the keyword',
  'tui.select.helpOpen': 'Help opened; press any key to return',
  'tui.select.helpClose': 'Help: press any key to return to the list (Esc/q cancels the selection)',
  'tui.select.helpPage': 'Help: ↑/↓ keep working while the list is visible',
  'tui.select.helpMove': '↑/↓ or k/j move the cursor (the list scrolls along)',
  'tui.select.helpToggle': 'Space toggles the row under the cursor',
  'tui.select.helpAll': 'a selects/deselects the whole list | i inverts | Shift+↑/↓ extends the selection',
  'tui.select.helpSearch': '/ searches by keyword (matches the name and the model ID)',
  'tui.select.helpFilter': 't filters by type | b filters by base model',
  'tui.select.helpSort': 's cycles the sort order (default / name / size)',
  'tui.select.helpQuick': '1-9 jump to row n | Shift+1-9 toggles row n directly',
  'tui.select.helpConfirm': 'Enter confirms (in multi-select at least one row must be selected)',
  'tui.select.helpCancel': 'Esc / q / Ctrl+C cancels this selection',
  'tui.select.singleHint': 'Single choice: ↑/↓ to move, Enter to confirm',
  'tui.select.singleNoInvert': 'Inverting is not needed in single-choice mode',
  'tui.select.rawUnavailable': 'This terminal cannot provide raw keyboard input (using the simple prompt)',
  'tui.select.suspendUnsupported': 'Suspend is not supported on Windows; Ctrl+Z ignored',

  // run.js: download progress panel
  'tui.run.downloading': 'Downloading',
  'tui.run.counts': 'Done {ok} · Skipped {skipped} · Failed {failed} / {total} items',
  'tui.run.remaining': 'ETA {eta}',
  'tui.run.fileLabel': 'Current file',
  'tui.run.elapsed': 'Elapsed {elapsed}',
  'tui.run.keys': 's Skip the current model | Ctrl+C Cancel (press again to force quit)',
  'tui.run.failedItems': '{count} items failed: {names}',
  'tui.run.retry': '[attempt {attempt}/{max} · HTTP {code}]',
  'tui.run.waiting': 'Current · Waiting for the next item… (press s to skip the current model, Ctrl+C to cancel)',
  'tui.run.cancelNotice': 'Ctrl+C received, cancelling (press again to force quit)…',
  'tui.run.skipNotice': 'Skip requested; the current model will be skipped (downloaded parts are kept)…',

  // download.js: filtering / selection
  'tui.download.prefilterHint': 'Available / filter in the full-screen list with / search, t type, b base model and s sort instead of step-by-step prompts',
  'tui.download.prefilterSummary': '{count} items · {size} in total {done}',
  'tui.download.prefilterDone': '· {count} already done',
  'tui.download.keywordPrompt': '{count} items; optionally type a keyword to filter (empty = all)',
  'tui.download.filterByType': 'Filter by type',
  'tui.download.allTypes': 'All types',
  'tui.download.filterByBaseModel': 'Filter by base model',
  'tui.download.allBaseModels': 'All base models',
  'tui.download.noMatch': 'No items match the filter',
  'tui.download.filterResult': 'Filtered: {filtered} / {available} items',
  'tui.download.metaExcluded': '{count} items failed metadata fetching and were excluded from the list',
  'tui.download.noDownloadable': 'No downloadable items',
  'tui.download.doneCount': '{count} of them are already done (unchecked by default; pick force re-download later to fetch them again)',
  'tui.download.fileCount': '{count} files',
  'tui.download.statusDownloaded': 'Downloaded',
  'tui.download.statusUpdated': 'Update available',
  'tui.download.statusPinned': 'Version pinned',
  'tui.download.selectTitle': 'Select items to download ({count} items, {size} total)',
  'tui.download.noneSelected': 'No items selected',
  // download.js: version picking
  'tui.download.versionListFailed': 'Failed to fetch the version list (keeping the default version): {name} -> {error}',
  'tui.download.singleVersionOnly': 'Every selected model has only one version; nothing to choose',
  'tui.download.multiVersionNotice': '{count} models have multiple versions; choose one by one (default = the collection version)',
  'tui.download.currentMark': ' (current)',
  'tui.download.unknownDate': 'unknown date',
  'tui.download.chooseVersionTitle': 'Choose a version · {name}',
  'tui.download.versionSwitched': 'Version switched: {name} -> {version}',
  'tui.download.pinConfirm': 'You picked versions for {count} models manually; pin them (so future downloads stop following new releases)?',
  'tui.download.pinMarked': 'Marked as pinned; this is written to the completion records once the download finishes',
  // download.js: download options
  'tui.download.outDirPrompt': 'Output directory (relative paths are resolved against the project root: {root})',
  'tui.download.notEmpty': 'Cannot be empty',
  'tui.download.lowSpace': 'Warning: the plan needs {planned}, but the disk holding {dir} has only {free} left',
  'tui.download.concurrencyPrompt': 'How many models to download at once? (higher concurrency uses more bandwidth/disk)',
  'tui.download.jobsOne': '1 (serial, safest)',
  'tui.download.jobsTwo': '2',
  'tui.download.jobsThree': '3',
  'tui.download.startConfirm': 'Start downloading {count} items, {size} total → {dir}?',
  // download.js: main flow
  'tui.download.collectionIdPrompt': 'Collection ID or collection page URL',
  'tui.download.enumerating': 'Enumerating the items of collection {collectionId}…',
  'tui.download.connectingBrowser': 'Connecting to / launching the browser (the first launch is slow, please wait)…',
  'tui.download.planTitle': 'Planned: {count} items, {size} in total',
  'tui.download.planMore': '… {count} more not shown',
  'tui.download.optionPrompt': 'Confirm the download settings',
  'tui.download.startNow': 'Start downloading',
  'tui.download.startNowDesc': 'Download {count} items with these settings (press s to skip the current model)',
  'tui.download.changeDir': 'Change the download directory',
  'tui.download.changeJobs': 'Change how many download at once',
  'tui.download.changeDirDesc': 'Current: {dir} (relative paths resolve against the project root: {root})',
  'tui.download.jobsCurrent': 'Currently {jobs} at a time',
  'tui.download.forceOff': 'Finished items: skip (recommended)',
  'tui.download.forceOn': 'Finished items: force re-download',
  'tui.download.forceToggleDesc': '{count} of them are already done; Enter switches the behaviour',
  'tui.download.lowSpaceConfirm': 'Disk space may be insufficient. Start anyway?',
  'tui.download.invalidCollectionId': 'Enter a numeric ID or a collection URL',
  'tui.download.collectionEmpty': 'The collection is empty',
  'tui.download.collectionCount': 'Collection {collectionId}: {count} items',
  'tui.download.fetchMeta': 'Fetching file metadata ({count} items, concurrency {concurrency})…',
  'tui.download.metaFailed': '{count} items failed metadata fetching (retry later, or download the others first)',
  'tui.download.versionStrategy': 'Version strategy',
  'tui.download.strategyLatest': 'Use the latest version for everything',
  'tui.download.strategyLatestDesc': 'Use the version listed in the collection for each model (usually its latest)',
  'tui.download.strategyChoose': 'Choose versions one by one',
  'tui.download.strategyChooseDesc': 'Manually pick the version to download for models with several versions (can pin them as well)',
  'tui.download.fetchVersions': 'Fetching the version list…',
  'tui.download.pinsApplied': 'Pinned the version of {count} models',
  'tui.download.summaryCancelled': 'Cancelled: {done} done, {skipped} skipped, {failed} failed (downloaded files are kept and can be resumed)',
  'tui.download.summaryDone': 'Finished: {done} done, {skipped} skipped, {failed} failed',
  'tui.download.summaryDoneMeta': 'Finished: {done} done, {skipped} skipped, {failed} failed, {metaFailed} metadata failures',
  'tui.download.elapsed': 'Elapsed {elapsed}; log file: {file}',
  'tui.download.openDirConfirm': 'Open the download directory?',
  'tui.download.opened': 'Opened: {dir}',

  // check.js
  'tui.check.noRecords': 'No collection membership snapshot yet (run node cli.js list <collectionId> or download once)',
  'tui.check.collectionLabel': 'Collection {id}',
  'tui.check.completionRecords': '{count} members',
  'tui.check.manualId': 'Enter a collection ID manually',
  'tui.check.allCollections': 'All collections',
  'tui.check.allCollectionsDesc': 'Check all {count} collections one after another',
  'tui.check.pickOne': 'Pick one collection',
  'tui.check.pickOneDesc': 'Choose from the snapshot list (searchable / sortable)',
  'tui.check.selected': 'Collection selected: {id}',
  'tui.check.changesShort': '{count} items changed',
  'tui.check.noChangesShort': 'No changes',
  'tui.check.collectionIdLabel': 'Collection ID',
  'tui.check.invalidId': 'Enter a numeric ID',
  'tui.check.pickCollection': 'Which collection should be checked for updates?',
  'tui.check.modeTitle': 'Check mode',
  'tui.check.modeQuick': 'Quick check (compare version numbers and local file sizes only)',
  'tui.check.modeQuickDesc': 'Takes seconds, but cannot detect an author re-upload under the same version',
  'tui.check.modeDeep': 'Deep check (verify local SHA256 + online file hashes)',
  'tui.check.modeDeepDesc': 'Slower, but detects changed/renamed/added/removed files',
  'tui.check.collectionHeader': '— Collection {id} —',
  'tui.check.downloadConfirm': 'Download the {count} changed items now (updates / file changes / missing locally)?',
  'tui.check.stateReset': 'Reset the state of {count} items; they will be verified/downloaded again',
  'tui.check.startUpdate': 'Updating {count} items of collection {collectionId}, {size} total',
  'tui.check.summaryCancelled': 'Cancelled: {done} done, {skipped} skipped, {failed} failed (can be resumed)',
  'tui.check.summaryDone': 'Update finished: {done} done, {skipped} skipped, {failed} failed',
  'tui.check.failedNotice': 'Some items failed to update; retry or check the logs',

  // login.js
  'tui.login.title': 'Log in / check session ({site})',
  'tui.login.modeLogin': 'Log in / refresh login',
  'tui.login.modeLoginDesc': 'Open the browser to log in and save the session',
  'tui.login.modeCheck': 'Only check the current session',
  'tui.login.modeCheckDesc': 'Verify that the saved session is still valid without opening the login page',
  'tui.login.startConfirm': 'A browser will open to log in to {site}; start now?',
  'tui.login.waitConfirm': 'Press y after finishing the login in the browser (n discards this save)',
  'tui.login.done': 'Login flow finished; you can go back to the main menu',

  // manage.js (collection members and changes)
  'tui.manage.cancelled': 'Cancelled',
  'tui.manage.back': 'Back',
  'tui.manage.collectionLabel': 'Collection {id}',
  'tui.manage.memberCount': '{count} members',
  'tui.manage.memberVersions': '{versions} versions · {pinned}',
  'tui.manage.noRecords': 'No collection membership snapshot yet (run node cli.js list <collectionId> or download once)',
  'tui.manage.pickCollection': 'Choose a collection',
  'tui.manage.changesShort': '{added} added / {removed} removed / {versionChanged} version changes',
  'tui.manage.snapshotLine': 'Membership snapshot: {count} items (enumerated at {fetchedAt})',
  'tui.manage.changesLine': 'Compared with the previous enumeration: {added} added, {removed} removed, {versionChanged} version changes (previous enumeration at {previousFetchedAt})',
  'tui.manage.firstSnapshot': 'first enumeration',
  'tui.manage.changeAdded': '  + added {name}',
  'tui.manage.changeRemoved': '  - removed {name}',
  'tui.manage.changeVersion': '  ~ version changed {name}: {from} → {to}',
  'tui.manage.modelIdLabel': 'modelId={modelId}',
  'tui.manage.unknownTime': 'unknown time',
  'tui.manage.pinnedVersion': 'version pinned',
  'tui.manage.notPinned': 'not pinned',
  'tui.manage.noChanges': 'No changes made',
  'tui.manage.nameSeparator': ', ',
  'tui.manage.actionPrompt': 'What do you want to do with collection {collectionId}?',
  'tui.manage.resetAction': 'Reset a model for re-download',
  'tui.manage.resetActionDesc': 'After the record is deleted the model is downloaded again next time',
  'tui.manage.resetPick': 'Choose the models whose records should be reset (Space to toggle)',
  'tui.manage.resetConfirm': 'Reset the records of {count} models for re-download?',
  'tui.manage.resetDone': 'Reset {count} model records: {names}',
  'tui.manage.resetEmpty': 'Collection {collectionId} has no recorded model',
  'tui.manage.pinnedMark': 'pinned',
  'tui.manage.noVersionId': 'This record has no version ID; it cannot be pinned',
  'tui.manage.pinAction': 'Pin the current version of a model',
  'tui.manage.pinActionDesc': 'A pinned version is not overwritten when the site publishes a new one',
  'tui.manage.unpinAction': 'Unpin',
  'tui.manage.unpinActionDesc': 'Follow the latest online version again',
  'tui.manage.hashConfirm': 'Compute SHA256 for local files? (No = compare sizes only, much faster)',
  'tui.manage.verifying': 'Verifying local files…',
  'tui.manage.verifyProgress': 'Verifying {index}/{total}: {name}',
  'tui.manage.verifySummary': '{label}: {total} models, {size} total',
  'tui.manage.verifyCounts': 'OK: {ok}, broken: {broken}',
  'tui.manage.brokenLine': '{name}: {reasons}',
  'tui.manage.reasonSeparator': '; ',
  'tui.manage.dirLine': 'Directory: {dir}',
  'tui.manage.verifyAllOk': 'All files verified',
  'tui.manage.repairConfirm': 'Re-download the broken/missing files among the {count} items?',
  'tui.manage.skipNoUrl': 'Skipping {name}: the record has no direct download URL',
  'tui.manage.repairFailed': 'Some files failed to repair; try again later',

  // models.js (model library: one record per model)
  'tui.models.menuTitle': 'Model library',
  'tui.models.menuDownload': 'Download a single model',
  'tui.models.menuDownloadDesc': 'Paste a model URL / model:<id> / version:<id>; multiple lines or comma separated',
  'tui.models.menuList': 'List library records',
  'tui.models.menuListDesc': 'Name / versions / size / pin / directory, filterable by collection and keyword',
  'tui.models.menuCheck': 'Check model updates',
  'tui.models.menuCheckDesc': 'One or all models; quick/deep comparison against online versions, then download changes',
  'tui.models.menuVerify': 'Verify / repair model files',
  'tui.models.menuVerifyDesc': 'Verify local files against the records and re-download only broken/missing ones',
  'tui.models.menuPin': 'Pin / unpin a version',
  'tui.models.menuPinDesc': 'A pinned version is not overwritten when the site publishes a new one',
  'tui.models.menuForget': 'Delete model records',
  'tui.models.menuForgetDesc': 'Delete records, optionally deleting the downloaded files as well',
  'tui.models.downloadPrompt': 'Model URL / model:<id> / version:<id> (multiple lines or comma separated)',
  'tui.models.notEmpty': 'Cannot be empty',
  'tui.models.refInvalid': 'Unrecognized target: {value}',
  'tui.models.noRefs': 'No downloadable target was parsed',
  'tui.models.fetchingModel': 'Fetching versions of model {modelId}…',
  'tui.models.chooseVersion': 'Choose a version · {name}',
  'tui.models.noVersionsOnline': 'Model {name} has no available version on the site',
  'tui.models.noFiles': 'Version {version} of {name} has no downloadable files (check fileTypes in config.json)',
  'tui.models.fetchFailed': 'Failed to fetch the model: {name} -> {error}',
  'tui.models.downloadFailed': 'Some models failed to download; rerun or check the logs',
  'tui.models.noRecords': 'No library records yet (download one with "Download a single model")',
  'tui.models.notPinned': 'not pinned',
  'tui.models.checkingModel': 'Checking {label} (a deep check hashes local files, please wait)',
  'tui.models.checkScope': 'Which models should be checked?',
  'tui.models.checkAll': 'All models ({count})',
  'tui.models.checkOne': 'Pick one model',
  'tui.models.checkPick': 'Choose the model to work on',
  'tui.models.startUpdate': 'Updating {count} item(s) of model {label}, {size} in total',
  'tui.models.verifyPick': 'Which models should be verified locally?',
  'tui.models.verifyAll': 'All models ({count})',
  'tui.models.pinPick': 'Choose the model to work on',
  'tui.models.pinVersionPick': 'Which version should be pinned?',
  'tui.models.forgetPick': 'Choose the models whose records should be deleted (Space to toggle)',
  'tui.models.forgetConfirm': 'Delete {count} model records?',
  'tui.models.forgetFilesConfirm': 'Also delete the files listed in these records? (irreversible; No = records only)',
  'tui.models.filterCollection': 'Filter by collection (snapshot members)',
  'tui.models.allCollections': 'All models (no filter)',
  'tui.models.collectionItem': 'Collection {id} ({count} items)',

  // models.js: source picker / browser / detail page
  'tui.models.sourcePrompt': 'Where do the models come from?',
  'tui.models.sourcePaste': 'Paste model URLs / references',
  'tui.models.sourcePasteDesc': 'Supports model:<ID>, version:<ID> and model page URLs; several lines or comma separated',
  'tui.models.sourceLibrary': 'Pick from the model library',
  'tui.models.sourceLibraryDesc': 'Lists existing records; pick some, then choose the version to download for each',
  'tui.models.sourceLibraryHint': 'Press / to search, t/b to filter, Space to select, Enter to continue',
  'tui.models.pickForDownload': 'Choose the models to download (Space toggles, Enter continues)',
  'tui.models.nonePicked': 'No model was selected',
  'tui.models.menuBrowse': 'Browse the model library',
  'tui.models.menuBrowseDesc': 'Open one model to see its versions / folders / pin state and act on it',
  'tui.models.browseHint': 'Press / to search, t for type, b for base model, s to sort; Enter opens the details',
  'tui.models.browsePick': 'Choose the model to inspect',
  'tui.models.pickerSummary': '{count} library records · {size} in total {pinned}',
  'tui.models.pickerPinned': '· {count} with a pinned version',
  'tui.models.rowVersions': '{count} versions',
  'tui.models.factModelId': 'Model ID',
  'tui.models.factType': 'Type',
  'tui.models.factVersions': 'Versions',
  'tui.models.factSize': 'Total size',
  'tui.models.factPinned': 'Pinned version',
  'tui.models.pinnedTo': 'Pinned to {version}',
  'tui.models.recordMissing': 'No library record for {modelId}',
  'tui.models.actionPrompt': 'What should happen with {name}?',
  'tui.models.actionDownload': 'Download another version',
  'tui.models.actionDownloadDesc': 'Enter or pick models and choose the version to download',
  'tui.models.actionCheck': 'Check this model for updates',
  'tui.models.actionCheckDesc': 'Checks only this model and offers to download what changed',
  'tui.models.unpinConfirm': 'Unpin the version of {name}?',
  'tui.models.versionIdShort': 'Version {versionId}',

  // pages.js: shared interaction (key hints / multi-select help / re-download choice / fact blocks)
  'tui.pages.hintMove': '↑↓ Select · Enter Confirm · Esc Back',
  'tui.pages.hintCancel': 'Ctrl+C cancels the current operation (press again in the main menu to quit)',
  'tui.pages.stillWorking': 'Still waiting… ({seconds}s elapsed, press Ctrl+C to quit)',
  'tui.pages.multiselectInstructions': 'Space toggles, a selects/deselects all, Enter confirms',
  'tui.pages.redownloadTitle': '{count} of the selected items are already downloaded. What should happen?',
  'tui.pages.redownloadSkip': 'Skip the completed ones (recommended)',
  'tui.pages.redownloadSkipDesc': 'Download only missing or changed files; saves time and traffic',
  'tui.pages.redownloadForce': 'Force re-download',
  'tui.pages.redownloadForceDesc': 'Overwrite local files and verify/download again; repairs broken files',

  // pages.js: help page (main menu → Help / shortcuts)
  'tui.help.title': 'Help / shortcuts',
  'tui.help.version': 'Version {version}',
  'tui.help.sectionGeneral': 'Lists and menus',
  'tui.help.sectionDownload': 'While downloading',
  'tui.help.generalMove': 'Move the cursor (the list scrolls along)',
  'tui.help.generalFirstLast': 'Jump to the first / last row',
  'tui.help.generalPage': 'Scroll one screen up / down',
  'tui.help.generalSearch': 'Search by keyword (matches the name and the model ID)',
  'tui.help.generalFilter': 'Cycle the type / base-model filter',
  'tui.help.generalSort': 'Cycle the sort order: default / name / size',
  'tui.help.generalToggle': 'Toggle the row under the cursor',
  'tui.help.generalAllInvert': 'Select / deselect all; invert the current list',
  'tui.help.generalQuickSelect': 'Jump to row n (with Shift it toggles instead)',
  'tui.help.generalConfirm': 'Confirm the current choice',
  'tui.help.generalBack': 'Go back one level (cancels the current operation in a menu)',
  'tui.help.generalQuit': 'Cancel the running download; press twice in the main menu to quit',
  'tui.help.generalHelp': 'Open this key reference inside a list',
  'tui.help.runSkip': 'Skip the current model (downloaded parts are kept)',
  'tui.help.runCancel': 'Cancel this download (resume it later)',
  'tui.help.footer': 'Press any key to return to the menu',

  // settings.js
  'tui.settings.site': 'Site URL (log in again after changing it)',
  'tui.settings.invalidSite': 'Must start with http(s)://',
  'tui.settings.outDir': 'Download directory (relative paths are resolved against the project root: {root})',
  'tui.settings.notEmpty': 'Cannot be empty',
  'tui.settings.chromePath': 'Chrome/Edge path (leave empty to auto-detect)',
  'tui.settings.debugPort': 'Browser debug port',
  'tui.settings.invalidPort': 'Enter a port number (e.g. 9222)',
  'tui.settings.userAgent': 'User-Agent',
  'tui.settings.jobs': 'Number of models to download at once (1 = serial)',
  'tui.settings.invalidJobs': 'Enter 1-8',
  'tui.settings.metaConcurrency': 'Metadata request concurrency',
  'tui.settings.apiRateLimit': 'Site API requests per second limit (0 = unlimited)',
  'tui.settings.invalidInteger': 'Enter an integer',
  'tui.settings.proxy': 'Proxy (empty = none), e.g. http://127.0.0.1:7890',
  'tui.settings.invalidProxy': 'Format: http://127.0.0.1:7890',
  'tui.settings.fileTypes': 'Which file types to download (comma separated)',
  'tui.settings.invalidFileTypes': 'Enter at least one type',
  'tui.settings.downloadAttempts': 'Max attempts per file',
  'tui.settings.engine': 'Download engine (aria2 requires aria2c to be installed; multiple connections are faster)',
  'tui.settings.engineCurl': 'curl (default, most reliable)',
  'tui.settings.engineAuto': 'auto (use aria2c when available)',
  'tui.settings.engineAria2': 'aria2 (forced; errors out when not installed)',
  'tui.settings.dedup': 'Cross-collection content dedup (keep a single copy of the same file)',
  'tui.settings.dedupOff': 'Off (default)',
  'tui.settings.dedupHardlink': 'Hardlink (no extra space on the same disk; note: deleting one copy keeps the other, but content edits are shared)',
  'tui.settings.dedupCopy': 'Copy (works across disks, uses extra space)',
  'tui.settings.notifyWebhook': 'Task-finished notification Webhook (empty = do not send)',
  'tui.settings.notifyToast': 'Show a system notification when a task finishes?',
  'tui.settings.language': 'Interface language',
  'tui.settings.languageAuto': 'Auto (CIVITAI_LANG / system language; English when none is available)',
  'tui.settings.headless': 'Browser window',
  'tui.settings.headlessAuto': 'Auto (visible window for login, headless afterwards)',
  'tui.settings.headlessAlways': 'Always headless (no window)',
  'tui.settings.headlessNever': 'Always show the window',
  'tui.settings.languageZh': '简体中文',
  'tui.settings.languageEn': 'English',
  'tui.settings.cancelled': 'Settings editing cancelled',
  'tui.settings.saved': 'Settings saved to config.json',
  'tui.settings.menuTitle': 'Which group of settings do you want to change?',
  'tui.settings.summaryTitle': 'Current settings',
  'tui.settings.draftUpdated': '{count} changes staged — keep editing or save them',
  'tui.settings.optional': ' (optional)',
  'tui.settings.sectionBasic': 'Basics',
  'tui.settings.sectionBasicDesc': 'Site URL, download directory, browser and interface language',
  'tui.settings.sectionDownload': 'Downloads',
  'tui.settings.sectionDownloadDesc': 'Concurrency, retries, file types, download engine and dedup',
  'tui.settings.sectionNetwork': 'Network',
  'tui.settings.sectionNetworkDesc': 'API rate limit, proxy and User-Agent',
  'tui.settings.sectionNotify': 'Notifications',
  'tui.settings.sectionNotifyDesc': 'Webhook and system notification after a task finishes',
  'tui.settings.sectionCancelled': 'Changes to "{section}" were cancelled',
  'tui.settings.confirmCurrent': '{label} (currently {value})',
  'tui.settings.saveAction': 'Save to config.json',
  'tui.settings.saveActionDesc': 'Every change is listed before it is written, so it can be reviewed',
  'tui.settings.changeTitle': '{count} changes will be written',
  'tui.settings.saveConfirm': 'Save these {count} changes?',
  'tui.settings.noChanges': 'Nothing to save',
  'tui.settings.siteChanged':
    'Site changed: the Chrome profile switches to a separate directory for the new site; please log in again (main menu → Log in / refresh login)',
};
