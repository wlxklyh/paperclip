# Windows 四岗位工作台运维

这套工作台使用 Paperclip 管理跨项目任务，Claw3D 展示真实活动，官方 Codex CLI 执行任务。产品经理、开发工程师、IT 管家、AI 工作流工程师按任务需要参与；复核是流程阶段，不增加固定检查岗位。IT 首版只做只读盘点、诊断和方案。

本文覆盖 Paperclip 的本机配置、启动和停止。Claw3D 使用自己的启动流程。两个项目分别维护自己的 fork；Codex 使用官方发行版，不使用既有 Codex fork。

## 目录与状态

默认工作区为 `E:\LYH\agent-workbench`；脚本通过自身位置推导它，也可显式传入 `-WorkspaceRoot`。

| 路径，相对工作区 | 用途 |
| --- | --- |
| `sources/paperclip`、`sources/claw3d` | 两个源代码仓库 |
| `runtime/paperclip/instances/default/config.json` | 此实例的运行配置 |
| `runtime/paperclip/instances/default/.env` | Agent JWT 与工具动作签名密钥，不应输出或提交 |
| `runtime/paperclip/instances/default/secrets/master.key` | 本地加密密钥，必须随实例备份保留 |
| `runtime/paperclip/instances/default/db` | 内嵌 PostgreSQL 数据 |
| `runtime/paperclip/instances/default/data/storage` | 上传的产物、附件 |
| `runtime/paperclip/instances/default/data/backups` | 数据库逻辑备份 |
| `runtime/paperclip/instances/default/workbench-control.json` | 当前服务的本机控制记录，含控制令牌，不应公开 |
| `config/workbench.json` | bootstrap 保存的公司、岗位和项目 ID |
| `projects` | 项目工作目录 |

配置、密钥、数据库和工作台 manifest 都位于源代码仓库之外。限制这些目录的 NTFS 访问权限；Node 的 `0600` 文件模式不能代替 Windows ACL。不要把密钥文件、控制记录或数据库打包进公开 fork。

## 首次安装：源码、依赖和官方 Codex

安装 Node.js 24.11+（含 npm）、Git for Windows（含 Bash）、Corepack 和 PowerShell 7。使用普通用户的专用 PowerShell 窗口；后面的环境变量只影响这个窗口。工作台改动需要已保存到自己的 fork 分支；首次在另一台电脑安装前，先确认该分支包含本文及 `scripts/workbench`，不能只克隆上游默认分支。

以下命令只用于尚未存在的 checkout。已有 checkout 进入该目录继续，不覆盖已有工作：

```powershell
$ErrorActionPreference = 'Stop'
$workbenchRoot = 'E:\LYH\agent-workbench'
$repoRoot = Join-Path $workbenchRoot 'sources\paperclip'
if (Test-Path -LiteralPath $repoRoot) { throw 'Checkout already exists; use the existing checkout' }
git clone --branch custom/main https://github.com/wlxklyh/paperclip.git $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Clone failed; confirm the workbench branch is published' }
Set-Location -LiteralPath $repoRoot
git remote add upstream https://github.com/paperclipai/paperclip.git
if ($LASTEXITCODE -ne 0) { throw 'Upstream setup failed' }
```

在 Paperclip 仓库根目录准备依赖。先确认 `node --version`、`git --version`、`corepack --version` 可执行；Corepack 使用仓库 `packageManager` 指定的 pnpm 版本，shim 只安装到工作区：

```powershell
$workbenchRoot = 'E:\LYH\agent-workbench'
$toolRoot = Join-Path $workbenchRoot 'runtime\bin'
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
corepack enable --install-directory $toolRoot pnpm
if ($LASTEXITCODE -ne 0) { throw 'Local pnpm setup failed' }
$env:PATH = "$toolRoot;$env:PATH"
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source
$gitBash = @((Join-Path (Split-Path $gitExe) '../bin/bash.exe'),
  (Join-Path (Split-Path $gitExe) 'bash.exe')) |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $gitBash) { throw 'Git for Windows Bash is required' }
$env:npm_config_script_shell = [IO.Path]::GetFullPath($gitBash)
corepack pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; do not initialize or start' }
```

官方 Codex CLI 可按[官方安装说明](https://developers.openai.com/codex/cli)安装；也可使用已安装的官方发行版。不要把桌面附带的 `codex.exe` 和 npm 的 `codex.cmd` 视为同一个版本。用 `Get-Command codex.exe,codex.cmd -All -ErrorAction SilentlyContinue` 找到候选项，再明确选择一个绝对路径；后面的检查和 bootstrap 始终使用这个路径：

```powershell
$codexPath = 'C:\absolute\path\to\codex.exe' # 替换为选定的官方可执行文件
if (-not (Test-Path -LiteralPath $codexPath)) { throw 'Select an installed official Codex executable' }
& $codexPath --version
if ($LASTEXITCODE -ne 0) { throw 'Codex executable check failed' }
& $codexPath login status
if ($LASTEXITCODE -ne 0) { throw 'Complete Codex login before creating agents' }
```

尚未登录时，由操作者运行 `& $codexPath login` 并完成[官方浏览器登录流程](https://developers.openai.com/codex/auth)，然后再次检查状态。认证可存储在文件或操作系统凭据存储；当前 Paperclip adapter 需要它能读取的认证来源，单独显示 CLI 已登录不等于 adapter 已就绪。若凭据只在 keyring 中，按官方认证文档选择适合该运行账户的凭据保存方式，再检查 Paperclip 的认证就绪结果；不打印或复制 `auth.json` 到源码，不把所有 Agent 的 `CODEX_HOME` 指向同一全局目录。首次真实任务的证据要记录选定路径、CLI 版本和实际执行结果。

## 仅初始化配置

完成以上依赖安装后，在 Paperclip 仓库根目录执行：

```powershell
& .\scripts\workbench\initialize-workbench.ps1 -WorkspaceRoot 'E:\LYH\agent-workbench'
```

此命令只创建缺失的实例配置和密钥，不启动服务、不连接数据库、不创建公司或岗位。它通过上游 `paperclipConfigSchema` 验证配置，通过 `describeLocalInstancePaths` 生成实例路径，并复用 `ensureAgentJwtSecret`、`ensureToolActionSigningSecret`、`ensureLocalSecretsKeyFile`。输出只有路径和是否创建的状态，不含密钥。

重复运行保留有效的 `config.json` 原始内容以及已有密钥；损坏配置、跨实例路径或端口不一致会报错，不自动覆盖。已有 PostgreSQL 数据但本地加密主密钥丢失时，初始化也会拒绝继续，必须恢复原密钥，不能生成新密钥替代。创建配置使用独立暂存文件和不覆盖的发布操作，同一实例的初始化使用进程拥有的互斥锁。继承自其它终端配置的密钥不会写入这个实例；已有实例 `.env` 是密钥来源。

默认新配置为 `local_trusted/private`、loopback、HTTP 3100、PostgreSQL 54329、关闭遥测。现有的 `authenticated/private` loopback 配置也会保留。端口定制必须前后一致：

```powershell
& .\scripts\workbench\initialize-workbench.ps1 `
  -WorkspaceRoot 'E:\LYH\agent-workbench-auth-test' -Port 3115 -DatabasePort 54330
```

不要用 `onboard --yes` 代替此步骤：本版本上游会接着尝试启动服务。

## 全新实例：先迁移，再选择 Windows CLI 执行方式

已有工作台已完成这些设置时，直接进入“启动与停止”。不要在已有 Native Runner 任务的实例上套用首次安装设置。

全新 Windows 实例需要先完成数据库迁移，再运行 `server/scripts/workbench-configure.ts`，最后启动 HTTP 服务。原因是原生 Runner 的实验开关保存在数据库，默认值不能由一个新 `config.json` 代替。这里使用官方 Codex CLI 的 legacy adapter，首次配置将关闭 `enableNativeRunner` 与 `enableOpenAiDot`，不安装 Rust Runner。

在专门的 PowerShell 窗口中执行以下步骤，完成后关闭窗口；这里的环境变量只影响该窗口及其子进程。执行期间此实例应处于停止状态：

```powershell
$workbenchRoot = 'E:\LYH\agent-workbench'
$instanceRoot = Join-Path $workbenchRoot 'runtime\paperclip\instances\default'
$toolRoot = Join-Path $workbenchRoot 'runtime\bin'
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
corepack enable --install-directory $toolRoot pnpm
if ($LASTEXITCODE -ne 0) { throw 'Local pnpm setup failed' }
$env:PATH = "$toolRoot;$env:PATH"
$env:PAPERCLIP_HOME = Join-Path $workbenchRoot 'runtime\paperclip'
$env:PAPERCLIP_INSTANCE_ID = 'default'
$env:PAPERCLIP_CONFIG = Join-Path $instanceRoot 'config.json'
$env:PAPERCLIP_DISABLE_CWD_ENV_FILE = 'true'
Remove-Item Env:DATABASE_URL,Env:DATABASE_MIGRATION_URL -ErrorAction SilentlyContinue

corepack pnpm db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migrations failed; do not continue' }
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/scripts/workbench-configure.ts
if ($LASTEXITCODE -ne 0) { throw 'Windows CLI instance configuration failed; do not continue' }
```

这两个步骤可能临时启动并关闭自己拥有的内嵌数据库，不启动 Paperclip HTTP 服务。配置 helper 会拒绝含原生 Runner Agent 或历史运行的实例，防止把已有执行环境直接改成首次安装默认值。不要删除数据库锁文件来绕过错误。

## 启动与停止

启动默认执行与上游 dev runner 相同的 Runner TypeScript、Plugin SDK 构建准备，然后直接启动拥有 `startServer()` 的 Node 进程。首次启动或更新源码后使用：

```powershell
& .\scripts\workbench\run-paperclip.ps1 -WorkspaceRoot 'E:\LYH\agent-workbench'
```

该命令前台运行。已经完成构建、源码和依赖未变化时，重启可加 `-SkipBuild`。启动器先验证已有控制进程；同一个实例已运行时不会再启动一份。HTTP 端口被其它服务占用时会拒绝启动，不静默改用另一端口。

另一个终端中停止：

```powershell
& .\scripts\workbench\stop-paperclip.ps1 -WorkspaceRoot 'E:\LYH\agent-workbench'
```

停止请求通过本机 named pipe 和随机令牌送给服务拥有者。拥有者等待 Paperclip 原生 `shutdown()`，由上游完成任务收尾、连接池关闭和它拥有的 PostgreSQL 停止，然后返回结果并退出。停止请求最多等待 120 秒；超时或控制通道失效会报错，不回退到按端口或模糊 PID 杀进程。不要以 pnpm 包装进程退出作为 Paperclip 已停止的证据。

重启是先完成停止、再运行启动脚本，不是并行启动第二份。自定义实例的停止也要传相同工作区和 API 端口：

```powershell
& .\scripts\workbench\stop-paperclip.ps1 `
  -WorkspaceRoot 'E:\LYH\agent-workbench-auth-test' -Port 3115
& .\scripts\workbench\run-paperclip.ps1 `
  -WorkspaceRoot 'E:\LYH\agent-workbench-auth-test' -Port 3115 -DatabasePort 54330 -SkipBuild
```

`workbench-control.json` 的存在本身不是健康证据。可通过下面的只读命令检查控制通道和 HTTP 健康；不要打印控制文件：

```powershell
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/scripts/workbench-server.ts `
  status 'E:\LYH\agent-workbench\runtime\paperclip' 3100
Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -NoProxy
```

上例使用 PowerShell 7 的 `-NoProxy`，避免系统代理把本机健康请求转成 502。使用其它客户端时，同样为 loopback 请求绕过代理。

若记录中的进程仍存在但控制通道不可用，脚本会停止操作。先查明实际 Node 进程、启动参数、实例路径与监听端口，再进行定向恢复。不要批量结束所有 Node/PostgreSQL，也不要删除 `db` 或重建公司来“修复”启动。

## 创建四岗位和两个验证项目

服务健康后，使用官方 Codex 可执行文件的绝对路径运行 bootstrap。以下路径需要替换为本机实际安装路径：

```powershell
node .\scripts\workbench\bootstrap.mjs --root 'E:\LYH\agent-workbench' `
  --url 'http://127.0.0.1:3100' --codex $codexPath --windows-sandbox unelevated
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap failed; inspect the reported difference before retrying' }
```

本机示例显式选择 `unelevated`，适用于 elevated 设置无法完成且管理策略允许该回退的环境；其隔离边界见下文。具备已配置 elevated 沙箱的机器可改为 `--windows-sandbox elevated`。新岗位会使用 `workspace-write`、`approval_policy="never"` 且不开启 sandbox bypass；这不修改全局 Codex 配置。

bootstrap 保存并复用 `config/workbench.json` 中的 ID，不应删除这个文件来重复创建对象。它为当前本机 trusted 实例创建岗位与项目，不启动任务，也不证明 Codex 已登录或实际交付成功。已有岗位不会自动更新沙箱参数或其它定制配置：重复传入 `--windows-sandbox` 也不会改写既有角色。对已有岗位，在 Paperclip 中核对并明确更新该岗位的 adapter 参数，保留其它配置，再触发原任务；可执行文件、engine 或显式指定的 model 不一致则 bootstrap 会报错。

Windows 上还需要允许创建文件符号链接。上游为 Codex 准备技能目录时使用 `fs.symlink`；如果报 `EPERM`，真实任务可能在 Codex 执行前就失败。需要操作者启用 Windows 开发者模式，或由管理员配置相应权限，再重新验证。工作台脚本不会自行修改系统设置，也不能把这种准备失败记成任务已执行。具体人工操作任务 ID 只保留在私人实例和验收证据中。

恢复准备失败的任务时，先确认原 run 已结束，再从原任务触发继续执行；保留原 task ID、失败记录和项目产物。不要删除 manifest、重建岗位或重新复制同一任务来绕过失败。恢复人工等待则先处理该任务上的有效人工卡，再观察新的 run；不能把改状态为 `done` 当作已经执行或批准。

bootstrap 使用本机 trusted board 语义。独立的人审验收实例应改为 `authenticated/private`，通过正常注册和 bootstrap/claim 建立明确标注的测试身份，再建立测试公司；不要让此 bootstrap 的 `local-board` 语义代签真实用户事项。测试实例配置与数据根不得与主工作台共用。

## 每日人工待办的使用约定与验收目标

日常检查以任务和产物为入口。以下是工作台的使用约定与验收目标，不表示所有字段、真实 Codex 执行或人工审核路径都已验收通过。只有真正需要人决策、补输入或处理异常的事项进入人工队列，普通 Agent 复核与 `in_review` 状态不能自动算成人审。已授权事项不重复审批。

- 人工卡应能追到项目、任务、产物确定版本、待决问题、推荐项、阻塞影响，以及处理后的流向。仅在任务确有明确期限时显示截止时间，不编造期限或处理时长；尚未实现的展示字段不作为现有功能承诺。
- 接受、退回和搁置有明确后续；产物变更后旧审批不能作用于新版本。长等待结束当前 Agent 回合，恢复时读取持久化的任务与决定。
- 真实发布、删除或部署等工具动作要经过对应执行授权；“任务完成已审核”不能替代具体工具副作用审批。
- Claw3D 动画必须对应真实运行、等待、失败与完成事件；从 Agent 能追到任务、活动记录和可打开的产物。测试数据、测试身份与实际待办分开标注。

首次上线与影响调度、授权或恢复的更新后，至少验证两个项目的真实任务与交付，以及未审不执行、版本失效、拒绝不执行、决定后恢复、等待释放资源、重启保留。脚本解析通过或界面能打开都不足以证明这些行为。

## 备份、上游更新与回退

数据库逻辑备份使用上游命令，并显式选中实例。该命令需要数据库正在运行，不会替你启动内嵌 PostgreSQL；在维护停机前执行：

```powershell
corepack pnpm paperclipai db:backup --data-dir 'E:\LYH\agent-workbench\runtime\paperclip'
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed; do not update' }
```

数据库备份不包含附件、项目文件和本地加密密钥。完整恢复还需要实例配置、`.env`、`secrets/master.key`、`data/storage`、项目目录与 `config/workbench.json`。这些内容按私人数据备份；不要依赖复制正在写入的 PostgreSQL 数据目录作为一致备份。

Paperclip 与 Claw3D 分别从各自 `upstream` 获取更新，分别保留回退点。下面只操作 Paperclip；它假定工作区使用本文默认端口、已完成 bootstrap，且项目目录都在此工作区内。外部项目目录要另外备份。更新窗口暂停派发新任务，等待当前任务结束，并停止其它会写入这些项目目录的程序。本文命令不会自动提交或丢弃源码改动。

在仓库根目录、已准备好本地 pnpm 与 Git Bash 的 PowerShell 窗口执行。先要求工作树干净，再停机制作包含密钥、附件、manifest 和项目文件的私人冷备份；Windows 自带的 `tar.exe` 保留符号链接，不通过链接遍历到外部目录：

```powershell
$ErrorActionPreference = 'Stop'
$workbenchRoot = [IO.Path]::GetFullPath('E:\LYH\agent-workbench')
if (git status --porcelain) { throw 'Save and review all source changes before updating' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$rollbackRef = "workbench-before-update-$stamp"
$sourceBranch = git branch --show-current
git tag $rollbackRef HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not create rollback ref' }

& .\scripts\workbench\stop-paperclip.ps1 -WorkspaceRoot $workbenchRoot
if (Get-NetTCPConnection -State Listen -LocalPort 3100,54329 -ErrorAction SilentlyContinue) {
  throw 'Owned API or database has not stopped; do not copy live data'
}
$snapshot = Join-Path $workbenchRoot "backups\update-$stamp"
if (Test-Path -LiteralPath $snapshot) { throw 'Choose a new snapshot directory' }
New-Item -ItemType Directory -Path $snapshot | Out-Null
tar.exe -cf (Join-Path $snapshot 'state.tar') -C $workbenchRoot runtime/paperclip config projects
if ($LASTEXITCODE -ne 0) { throw 'Cold snapshot failed; do not update' }
@{ workspaceRoot = $workbenchRoot; sourceBranch = $sourceBranch; rollbackRef = $rollbackRef; stamp = $stamp } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $snapshot 'restore.json') -Encoding utf8

git fetch upstream --prune
if ($LASTEXITCODE -ne 0) { throw 'Upstream fetch failed' }
git remote set-head upstream --auto
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve upstream default branch' }
$upstreamRef = git symbolic-ref --short refs/remotes/upstream/HEAD
git log --oneline "HEAD..$upstreamRef"
git diff --stat "HEAD...$upstreamRef"
```

检查本次上游变动，尤其是配置 schema、数据库迁移、Codex adapter、授权与恢复路径；确认要合入后继续。不要假定上游默认分支叫 `main`，也不要让自动更新直接覆盖定制文件：

```powershell
git merge --no-ff --no-edit $upstreamRef
if ($LASTEXITCODE -ne 0) { throw 'Resolve the merge or run git merge --abort; do not start yet' }
corepack pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& .\scripts\workbench\run-paperclip.ps1 -WorkspaceRoot $workbenchRoot
```

更新后的首次启动不能用 `-SkipBuild`。启动器会应用当前源码所需的数据库迁移，因此回退代码时必须考虑对应数据版本；不要重复运行首次安装的 `workbench-configure.ts` 来覆盖现有实例。合入冲突阶段且尚未启动时，`git merge --abort` 会回到合并前状态，备份继续保留。

若更新后的实例已经启动或尝试迁移，按以下步骤回到完整回退点。选择本次更新生成的备份目录；先完成停机，再切到新回退分支，把更新后的数据移入工作区内的保留目录，最后恢复冷备份。恢复会回到备份时间，更新后新产生的任务与产物只保留在该保留目录中，之后需单独核对，不能悄悄丢弃：

```powershell
$ErrorActionPreference = 'Stop'
$workbenchRoot = [IO.Path]::GetFullPath('E:\LYH\agent-workbench')
$snapshot = Join-Path $workbenchRoot 'backups\update-YYYYMMDD-HHMMSS' # 替换为本次备份
$restore = Get-Content -LiteralPath (Join-Path $snapshot 'restore.json') -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($restore.workspaceRoot) -ne $workbenchRoot) {
  throw 'This snapshot belongs to another workspace'
}
if (-not (Test-Path -LiteralPath (Join-Path $snapshot 'state.tar'))) { throw 'Missing snapshot archive' }
if (git status --porcelain) { throw 'Save or resolve source changes before rollback' }
& .\scripts\workbench\stop-paperclip.ps1 -WorkspaceRoot $workbenchRoot
if (Get-NetTCPConnection -State Listen -LocalPort 3100,54329 -ErrorAction SilentlyContinue) {
  throw 'API or database is still listening; do not restore'
}
git switch -c "rollback/$($restore.stamp)" $restore.rollbackRef
if ($LASTEXITCODE -ne 0) { throw 'Could not switch to rollback ref; nothing was restored' }
$savedState = Join-Path $workbenchRoot "rollback-saved-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (Test-Path -LiteralPath $savedState) { throw 'Choose a new saved-state directory' }
New-Item -ItemType Directory -Path $savedState | Out-Null
foreach ($relative in @('runtime\paperclip', 'config', 'projects')) {
  $target = [IO.Path]::GetFullPath((Join-Path $workbenchRoot $relative))
  if (-not $target.StartsWith($workbenchRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Restore target escaped the workspace'
  }
  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination (Join-Path $savedState (Split-Path $target -Leaf))
  }
}
tar.exe -xf (Join-Path $snapshot 'state.tar') -C $workbenchRoot
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; keep service stopped and retain both data copies' }
corepack pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency restoration failed' }
& .\scripts\workbench\run-paperclip.ps1 -WorkspaceRoot $workbenchRoot
```

这会保留更新失败的源码分支、备份和更新后的数据副本，不使用 `reset --hard` 或递归删除。对自定义端口的实例，必须同时替换启停参数与监听端口检查。恢复后检查健康、原公司与岗位 ID、项目任务、人审卡、产物版本及续跑结果，再恢复派发；备份成功或端口恢复并不等于业务数据与执行都正确。

## 验证范围与 Windows 执行限制

文件符号链接权限通过后，还要验证 Codex 自身的 Windows 沙箱启动。若出现 `ShellExecuteExW` setup helper `1223` 或 `orchestrator_helper_launch_canceled`，记录为执行环境失败，停止无意义重试；不要用 `danger-full-access` 绕过。按[官方 Windows 沙箱说明](https://learn.chatgpt.com/docs/windows/windows-sandbox)选择并验证适用方案。受限的 unelevated 模式网络隔离较弱且不支持 deny-read 规则，不能把它描述成与 elevated 模式同等隔离。

本机已对 unelevated 做过窄范围探针：官方 CLI 使用 `--include-managed-config --permission-profile :workspace`，工作目录内写入成功，所测目录外写入返回 `EPERM`。这只证明该次探针的文件写入边界，不证明完整网络隔离、所有目录规则或全部真实任务已验收。应另行记录真实 Agent 任务的产物、交接、失败恢复与进程退出结果；私人证据不提交到公开源码。

Windows 还需检查完整运行目录长度，包括 SQLite 派生的 `-wal`、`-shm` 文件；`thread_history` 打开失败不能仅靠重试解决。当前短目录方案保留公司、Agent 与授权版本隔离，不删除旧会话目录；自定义很长的工作区路径仍需单独检查。目录布局变更后旧 Codex session 可能无法直接续接，应验证同一任务从持久化交接信息恢复，不能宣称旧 session 已无缝迁移。任何此类修复都需再次验证真实执行和恢复。

本机控制协议的针对性测试命令如下。测试使用独立临时目录和真实 Windows named pipe，应用关闭函数由受控测试实现，不连接工作台数据库：

```powershell
node --import ./server/node_modules/tsx/dist/loader.mjs --test ./server/scripts/workbench-server.test.ts
```

这些测试覆盖错误令牌拒绝、重复启动拒绝、等待关闭完成再确认、端口占用拒绝。真实 Paperclip 与 PostgreSQL 的启动、停止、重启及 Agent 恢复仍需单独运行验收，并记录观察结果。

Windows provider 停止采用独立的进程树验证：仅接受本次服务通过 `runChildProcess` 实际启动并登记的根进程，核对父进程与创建时间，持有进程句柄，再调用绝对路径 `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`。超时、显式取消和终态后的回收均等待已观察子树退出；不会按名称或整个服务器批量结束进程。访问拒绝、进程代际不符、根进程过早消失或验证超时均报错并保留失败状态，不能当作已停止。一次停止的验证 helper 最多运行 20 秒，完整服务停机还可能包含多个运行实例的收尾。

该保证限于“根进程仍存活时发起停止”的已登记 provider。它不是 Windows Job Object；自然提前退出并留下脱离标准流的子孙、通过其它服务代理启动的逃逸进程、重启前留下且未登记的历史进程，不在当前子树证明范围内。普通开发服务沿用原来的停止路径，不能借用 provider 测试宣称它们的所有子孙均已回收。工作台关闭前会检查本次 provider 的未完成或失败停止记录，但这不等于对机器上所有历史进程的清空证明。

独立短时测试命令如下；只创建测试自己的 Node → cmd → Node 进程树及无关 canary，不启动、停止或连接工作台实例。失败时测试进程也有自行退出期限：

```powershell
corepack pnpm exec vitest run server/src/services/windows-provider-process-stop.test.ts packages/adapter-utils/src/server-utils.test.ts --maxWorkers 1
corepack pnpm --filter @paperclipai/adapter-utils typecheck
```

测试覆盖真实子树的超时、显式停止、终态回收，验证无关进程仍存活、根进程先 close 时仍等待清理证明，以及代际不符时拒绝结束进程并保留失败记录。它们不代替“真实官方 Codex 运行中停止 → API、数据库与所观察 Codex 子树退出 → 重启后任务保留并可恢复”的实例验收。POSIX 信号与进程组用例在 Windows 上跳过；本改动保留 POSIX 原来的 SIGTERM/SIGKILL 升级行为。

## 本机验收记录（2026-10-25）

实测版本为 Node.js 24.12.0、Git 2.51.0.windows.1、Corepack 0.34.5、仓库 pnpm 9.15.4、官方 Codex 0.162.0-alpha.17.2。两个 fork 的提交号及私人证据索引保存在工作区内、源码目录之外的 `evidence/acceptance-status.json`；没有修改 Codex 源码。

- 四个岗位在两个隔离项目中实际执行：产品经理拆分和验收，开发工程师交付离线 CLI（35 项测试通过），IT 管家交付限定范围的只读报告，工作流工程师交付重复运行流程（19 个评估场景）。沙箱拒绝的 IT 查询如实记录为失败。
- 明确标注的返工任务经过四次真实 Codex 执行，保留初稿、独立退回、修改稿和再次通过的决定；13 项交叉核对通过，控制器没有代签、手动完成或唤醒后续阶段。
- 官方 Codex 实际运行中发起正常停机，确认观察到的 Codex、PowerShell、Node 子树及 API、数据库监听均退出；重启后同一任务自动重试，从持久检查点完成且仅生成一份恢复产物。此结果证明任务级恢复，不证明旧 Codex session 迁移、崩溃或逃逸子进程回收。
- 人审使用独立实例、明确标注的 TEST 身份和真实 process adapter：验证 Agent 不能自批、拒绝、旧版本失效、等待释放名额、重启保留、接受当前版本后恢复，以及受控本地动作的再次授权检查。工作进程是确定性测试夹具；它不证明任意 shell 或外部服务已具备通用授权拦截。
- Windows provider 与 adapter-utils 针对性测试 139 项：133 通过、6 项 POSIX 用例跳过；named-pipe 生命周期另有 2 项通过，运行目录 4 项、插件链接 7 项、账号与技能隔离 3 项通过。相关包类型检查通过。Claw3D 的 10 项针对性测试、类型检查和限定范围 lint 通过，已检查真实状态、产物链接、人工入口和窄屏布局。

完整仓库检查没有全绿：递归类型检查缺少 Rust `cargo`，根测试脚本在 Windows 上遇到 `pnpm` 启动 `ENOENT`，完整构建遇到 Windows 盘符 ESM 路径问题。Codex adapter 全量为 576 项（531 通过、44 失败、1 跳过）；未修改基线为 572 项（527 通过、同名 44 失败、1 跳过），最终停止逻辑改动后复跑的失败集合仍完全一致。新增用例通过，不把已有失败掩盖为通过。

Claw3D 每 8 秒读取真实快照；动画不等于逐工具调用的直播。首次加载曾出现 WebGL 上下文丢失，点击“重新载入 3D”可恢复，普通任务界面仍可用。上游更新和冷备份回滚步骤已提供，本轮没有实际执行一次上游升级。
