<#
.SYNOPSIS
  桑多涅（dsh-sandrone）一键安装：插件 + 克隆语音模型 + 推理运行时。

.DESCRIPTION
  做五件事：
    1. 还原 / 下载两个权重，校验 SHA-256；
    2. 定位本机的 GPT-SoVITS 推理引擎；没有就从 Release 下载便携运行时（约 8.3 GB）；
    3. 把插件装进 DSH 的 desktop profile；
    4. 把 GPT-SoVITS 目录写进 profile 配置；
    5. 打印下一步。

  只写 DSH 自己的目录和本仓库目录，不会修改你已有的 GPT-SoVITS 目录。

.PARAMETER GptSoVitsDir
  已有 GPT-SoVITS 整合包目录（含 api_v2.py 与 runtime\python.exe）。给了就不下载运行时。

.PARAMETER Profile
  DSH profile 名，默认 desktop（或环境变量 DSH_PROFILE）。

.PARAMETER SkipRuntime
  只装插件和模型，不下载运行时。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -GptSoVitsDir "E:\GPT-SoVITS-v2pro-20250604"
#>
param(
    [string]$GptSoVitsDir = "",
    [string]$Profile = "",
    [switch]$SkipWeights,
    [switch]$SkipRuntime,
    [string]$ReleaseBase = "",
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}
function Write-Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }

function Get-Sha256([string]$path) { return (Get-FileHash $path -Algorithm SHA256).Hash }

function Invoke-Download([string]$url, [string]$dest, [string]$sha256) {
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) {
        if ($sha256 -eq "" -or (Get-Sha256 $dest) -eq $sha256) {
            Write-Ok "已存在：$(Split-Path $dest -Leaf)"
            return
        }
        Remove-Item $dest -Force
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curl) { throw "找不到 curl.exe（Windows 10 1803+ 自带）" }
    Write-Host "    下载 $url"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $curlArgs = @("-L", "--fail", "--retry", "5", "--retry-delay", "5", "-s", "-S", "-C", "-", "-o", $dest, $url)
    $proxyValue = $Proxy
    if ([string]::IsNullOrWhiteSpace($proxyValue)) { $proxyValue = $env:DSH_SANDRONE_PROXY }
    if (-not [string]::IsNullOrWhiteSpace($proxyValue)) { $curlArgs = @("--proxy", $proxyValue) + $curlArgs }
    & curl.exe @curlArgs 2>&1 | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($code -ne 0) { throw "下载失败（curl exit=$code）：$url" }
    if ($sha256 -ne "" -and (Get-Sha256 $dest) -ne $sha256) { throw "校验失败：$dest" }
}

function Join-Parts([string[]]$parts, [string]$dest, [string]$sha256) {
    $partial = "$dest.partial"
    if (Test-Path $partial) { Remove-Item $partial -Force }
    $stream = [System.IO.File]::Create($partial)
    try {
        foreach ($part in $parts) {
            if (-not (Test-Path $part)) { throw "缺少分卷：$part" }
            $bytes = [System.IO.File]::ReadAllBytes($part)
            $stream.Write($bytes, 0, $bytes.Length)
        }
    }
    finally { $stream.Close() }
    if ($sha256 -ne "" -and (Get-Sha256 $partial) -ne $sha256) {
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        throw "合并后校验失败：$dest"
    }
    Move-Item -Force $partial $dest
}

$RepoRoot = $PSScriptRoot
$PluginSrc = Join-Path $RepoRoot "dsh-sandrone"
$ModelsDir = Join-Path $RepoRoot "models"

Write-Host ""
Write-Host "桑多涅 · dsh-sandrone 安装程序" -ForegroundColor Magenta
Write-Host "仓库目录：$RepoRoot"

if (-not (Test-Path (Join-Path $PluginSrc "package.json"))) {
    throw "找不到插件目录：$PluginSrc（请在仓库根目录运行本脚本）"
}

$manifestPath = Join-Path $ModelsDir "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "找不到清单：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ReleaseBase -eq "" -and $null -ne $manifest.release) { $ReleaseBase = [string]$manifest.release.base }
if ($ReleaseBase -eq "") { throw "没有下载地址（manifest.release.base 为空）" }
$ReleaseBase = $ReleaseBase.TrimEnd("/")

# ── 1. DSH 家目录与 profile ───────────────────────────────────────────────
Write-Step "定位 DeepSeek Harness"

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
if (-not (Test-Path $DshHome)) { throw "找不到 DSH 家目录：$DshHome。请先启动一次 DeepSeek Harness。" }

$ProfileName = $Profile
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = $env:DSH_PROFILE }
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = "desktop" }

$ProfilesDir = Join-Path $DshHome "profiles"
$ProfileDir = Join-Path $ProfilesDir $ProfileName
if (-not (Test-Path $ProfileDir)) {
    $available = @()
    if (Test-Path $ProfilesDir) { $available = Get-ChildItem $ProfilesDir -Directory | Select-Object -ExpandProperty Name }
    throw "找不到 profile「$ProfileName」。现有：$($available -join ', ')。可用 -Profile 指定。"
}
Write-Ok "DSH 家目录：$DshHome"
Write-Ok "profile：$ProfileName"

# ── 2. 权重 ───────────────────────────────────────────────────────────────
if (-not $SkipWeights) {
    Write-Step "准备语音模型"
    $weightsDir = Join-Path $PluginSrc "assets\weights"
    New-Item -ItemType Directory -Force -Path $weightsDir | Out-Null

    foreach ($weight in $manifest.weights) {
        $target = Join-Path $RepoRoot $weight.target
        $targetDir = Split-Path $target -Parent
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

        if ((Test-Path $target) -and ((Get-Item $target).Length -eq [int64]$weight.size) -and
            ((Get-Sha256 $target) -eq $weight.sha256)) {
            Write-Ok "$($weight.label)：已存在，跳过"
            continue
        }

        $parts = @()
        foreach ($part in $weight.parts) { $parts += (Join-Path $ModelsDir $part) }
        $haveParts = $true
        foreach ($part in $parts) { if (-not (Test-Path $part)) { $haveParts = $false } }

        if ($haveParts) {
            Join-Parts $parts $target $weight.sha256
            Write-Ok "$($weight.label)：分卷已合并"
        }
        else {
            Invoke-Download "$ReleaseBase/$($weight.asset)" $target $weight.sha256
            Write-Ok "$($weight.label)：已下载"
        }
    }
}

# ── 3. 运行时 ─────────────────────────────────────────────────────────────
Write-Step "准备 GPT-SoVITS 推理引擎"

function Test-GptDir([string]$dir) {
    if ([string]::IsNullOrWhiteSpace($dir)) { return $false }
    return (Test-Path (Join-Path $dir "api_v2.py")) -and
           (Test-Path (Join-Path $dir "runtime\python.exe")) -and
           (Test-Path (Join-Path $dir "GPT_SoVITS\configs\tts_infer.yaml"))
}

$found = $null
if (-not [string]::IsNullOrWhiteSpace($GptSoVitsDir)) {
    if (Test-GptDir $GptSoVitsDir) { $found = (Resolve-Path $GptSoVitsDir).Path }
    else { Write-Warn "指定的目录不是有效的 GPT-SoVITS：$GptSoVitsDir" }
}

if ($null -eq $found) {
    $patchPath = Join-Path $ProfileDir "cordis.patch.yml"
    if (Test-Path $patchPath) {
        $m = [regex]::Match((Get-Content $patchPath -Raw -Encoding UTF8), "(?m)^\s*gptDir:\s*'?([^'\r\n]+)'?\s*$")
        if ($m.Success) {
            $candidate = $m.Groups[1].Value.Trim()
            if (Test-GptDir $candidate) { $found = $candidate }
        }
    }
}

if ($null -eq $found) {
    foreach ($root in @($env:USERPROFILE, "D:\", "C:\", "E:\", "F:\")) {
        if (-not (Test-Path $root)) { continue }
        foreach ($dir in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "GPT-SoVITS*" })) {
            if (Test-GptDir $dir.FullName) { $found = $dir.FullName; break }
        }
        if ($null -ne $found) { break }
    }
}

$PortableRuntime = Join-Path $DshHome "sandrone\runtime"
if ($null -eq $found -and (Test-GptDir $PortableRuntime)) { $found = $PortableRuntime }

if ($null -eq $found) {
    if ($SkipRuntime) {
        Write-Warn "没有运行时，且指定了 -SkipRuntime。语音不会出声。"
    }
    elseif ($null -eq $manifest.runtime) {
        Write-Warn "清单里没有运行时信息，跳过下载。"
    }
    else {
        Write-Host "    本机没有 GPT-SoVITS，下载便携运行时（约 8.3 GB，只含推理）"
        New-Item -ItemType Directory -Force -Path $PortableRuntime | Out-Null
        $downloaded = @()
        foreach ($part in $manifest.runtime.parts) {
            $dest = Join-Path $PortableRuntime $part.name
            Invoke-Download "$ReleaseBase/$($part.name)" $dest $part.sha256
            $downloaded += $dest
        }
        $archive = Join-Path $PortableRuntime "sandrone-runtime.tar"
        Write-Host "    合并分卷"
        Join-Parts $downloaded $archive $manifest.runtime.sha256
        Write-Host "    解压"
        & tar.exe -xf $archive -C $PortableRuntime
        if ($LASTEXITCODE -ne 0) { throw "解压失败（tar exit=$LASTEXITCODE）" }
        Remove-Item $archive -Force
        foreach ($part in $manifest.runtime.parts) {
            Remove-Item (Join-Path $PortableRuntime $part.name) -Force -ErrorAction SilentlyContinue
        }
        if (Test-GptDir $PortableRuntime) { $found = $PortableRuntime }
        else { throw "运行时解压后结构不对：$PortableRuntime" }
    }
}

$GptDir = ""
if ($null -ne $found) {
    $GptDir = $found
    Write-Ok "GPT-SoVITS：$GptDir"
}

# ── 4. 安装插件 ───────────────────────────────────────────────────────────
Write-Step "安装插件到 DSH profile"

$nodeModules = Join-Path $ProfileDir "node_modules"
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
$pluginTarget = Join-Path $nodeModules "dsh-sandrone"

if (Test-Path $pluginTarget) {
    $item = Get-Item $pluginTarget -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $pluginTarget -Recurse -Force }
}

robocopy $PluginSrc $pluginTarget /MIR /NFL /NDL /NJH /NJS /XD .git node_modules | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制插件失败（robocopy exit=$LASTEXITCODE）" }
Write-Ok "插件已就位：$pluginTarget"

# ── 5. profile 配置 ───────────────────────────────────────────────────────
Write-Step "更新 profile 配置"

$pkgPath = Join-Path $ProfileDir "package.json"
if (-not (Test-Path $pkgPath)) { throw "找不到 profile 的 package.json：$pkgPath" }
Copy-Item $pkgPath "$pkgPath.bak-sandrone" -Force

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pluginSpec = "file:" + ($PluginSrc -replace "\\", "/")

if ($null -eq $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$pkg.dependencies | Add-Member -NotePropertyName "dsh-sandrone" -NotePropertyValue $pluginSpec -Force
if ($null -eq $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if ($null -eq $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains "dsh-sandrone") { $bundles += "dsh-sandrone" }
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
$pkg | ConvertTo-Json -Depth 32 | Set-Content -Path $pkgPath -Encoding UTF8
Write-Ok "package.json：已加入依赖与 bundle"

$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
if (-not (Test-Path $patchPath)) { New-Item -ItemType File -Path $patchPath -Force | Out-Null }
$patchText = Get-Content $patchPath -Raw -Encoding UTF8

if ($patchText -match "(?m)^\s*-\s*id:\s*sandrone\s*$") {
    Write-Ok "cordis.patch.yml：已有 sandrone 条目（在设置页里改参数即可）"
}
else {
    $block = @()
    $block += ""
    $block += "# ── 桑多涅：模型与 GPT-SoVITS 目录（由 install.ps1 写入）─────────────"
    $block += "- id: sandrone"
    $block += "  name: dsh-sandrone"
    $block += "  config:"
    if ($GptDir -ne "") { $block += "    gptDir: '$GptDir'" }
    $block += "    apiUrl: http://127.0.0.1:9880"
    $block += "    enabled: true"
    $block += "    autoSpeak: true"
    if ($GptDir -eq "") {
        $block += "    # ⚠️ 还没有运行时：把 gptDir 改成实际路径，或重跑 .\install.ps1"
    }
    Add-Content -Path $patchPath -Value $block -Encoding UTF8
    Write-Ok "cordis.patch.yml：已写入 sandrone 条目"
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 完全退出并重新启动 DeepSeek Harness（关掉再开，不是刷新页面）。"
Write-Host "  2. 新建会话 → 预设选「桑多涅」。"
Write-Host "  3. 回复结束后她就会开口；按钮、音量、语气在 设置 →「桑多涅」。"
Write-Host ""
if ($GptDir -eq "") {
    Write-Host "提醒：还没有可用的推理运行时，语音不会出声。" -ForegroundColor Yellow
    Write-Host "      重跑 .\install.ps1，或在设置页里填 gptDir。" -ForegroundColor Yellow
}
Write-Host "模型位置： $PluginSrc\assets\weights"
Write-Host "插件位置： $pluginTarget"
