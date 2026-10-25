<#
.SYNOPSIS
  桑多涅（dsh-sandrone）一键安装：把插件 + 克隆语音模型装进本机的 DeepSeek Harness。

.DESCRIPTION
  做四件事：
    1. 把 models/ 下的分卷还原成两个权重，校验 SHA-256；
    2. 定位本机的 GPT-SoVITS 整合包（推理引擎，不随仓库分发）；
    3. 把插件装进 DSH 的 desktop profile；
    4. 把 GPT-SoVITS 目录写进 profile 配置。

  默认只写 DSH 自己的 profile 目录，不会修改 GPT-SoVITS 目录里的任何文件。

.PARAMETER GptSoVitsDir
  GPT-SoVITS 整合包目录（里面有 api_v2.py 和 runtime\python.exe）。
  不填时自动探测：已安装配置 → 常见路径。

.PARAMETER Profile
  DSH profile 名，默认 desktop（或环境变量 DSH_PROFILE）。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -GptSoVitsDir "E:\GPT-SoVITS-v2pro-20250604"
#>
param(
    [string]$GptSoVitsDir = "",
    [string]$Profile = "",
    [switch]$SkipWeights
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Ok([string]$text) {
    Write-Host "    $text" -ForegroundColor Green
}

function Write-Warn([string]$text) {
    Write-Host "    $text" -ForegroundColor Yellow
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

# ── 1. DSH 家目录与 profile ───────────────────────────────────────────────
Write-Step "定位 DeepSeek Harness"

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = Join-Path $env:USERPROFILE ".dsh"
}
if (-not (Test-Path $DshHome)) {
    throw "找不到 DSH 家目录：$DshHome。请先启动一次 DeepSeek Harness。"
}

$ProfileName = $Profile
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = $env:DSH_PROFILE }
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = "desktop" }

$ProfilesDir = Join-Path $DshHome "profiles"
$ProfileDir = Join-Path $ProfilesDir $ProfileName
if (-not (Test-Path $ProfileDir)) {
    $available = @()
    if (Test-Path $ProfilesDir) {
        $available = Get-ChildItem $ProfilesDir -Directory | Select-Object -ExpandProperty Name
    }
    throw "找不到 profile「$ProfileName」（$ProfileDir）。现有 profile：$($available -join ', ')。可用 -Profile 指定。"
}

Write-Ok "DSH 家目录：$DshHome"
Write-Ok "profile：$ProfileName（$ProfileDir）"

# ── 2. 还原模型分卷 ───────────────────────────────────────────────────────
if (-not $SkipWeights) {
    Write-Step "还原语音模型（分卷 → 完整权重）"

    $manifestPath = Join-Path $ModelsDir "manifest.json"
    if (-not (Test-Path $manifestPath)) { throw "找不到模型清单：$manifestPath" }
    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

    foreach ($weight in $manifest.weights) {
        $target = Join-Path $RepoRoot $weight.target
        $targetDir = Split-Path $target -Parent
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

        if ((Test-Path $target) -and ((Get-Item $target).Length -eq [int64]$weight.size)) {
            $existing = (Get-FileHash $target -Algorithm SHA256).Hash
            if ($existing -eq $weight.sha256) {
                Write-Ok "$($weight.label)：已存在且校验通过，跳过"
                continue
            }
        }

        $partial = "$target.partial"
        if (Test-Path $partial) { Remove-Item $partial -Force }
        $stream = [System.IO.File]::Create($partial)
        try {
            foreach ($part in $weight.parts) {
                $partPath = Join-Path $ModelsDir $part
                if (-not (Test-Path $partPath)) { throw "缺少分卷：$partPath" }
                $bytes = [System.IO.File]::ReadAllBytes($partPath)
                $stream.Write($bytes, 0, $bytes.Length)
            }
        }
        finally {
            $stream.Close()
        }

        $actual = (Get-FileHash $partial -Algorithm SHA256).Hash
        if ($actual -ne $weight.sha256) {
            Remove-Item $partial -Force -ErrorAction SilentlyContinue
            throw "$($weight.label) 校验失败（分卷可能损坏或不完整）：$actual"
        }
        Move-Item -Force $partial $target
        Write-Ok "$($weight.label)：已还原（$([math]::Round($weight.size / 1MB)) MB，SHA-256 通过）"
    }
}

# ── 3. 定位 GPT-SoVITS 整合包 ─────────────────────────────────────────────
Write-Step "定位 GPT-SoVITS 推理引擎"

function Test-GptDir([string]$dir) {
    if ([string]::IsNullOrWhiteSpace($dir)) { return $false }
    return (Test-Path (Join-Path $dir "api_v2.py")) -and
           (Test-Path (Join-Path $dir "runtime\python.exe")) -and
           (Test-Path (Join-Path $dir "GPT_SoVITS\configs\tts_infer.yaml"))
}

$found = $null

if (-not [string]::IsNullOrWhiteSpace($GptSoVitsDir)) {
    if (Test-GptDir $GptSoVitsDir) { $found = (Resolve-Path $GptSoVitsDir).Path }
    else { Write-Warn "指定的目录不是有效的 GPT-SoVITS 整合包：$GptSoVitsDir" }
}

# 上一轮安装写进 profile 的 gptDir
if ($null -eq $found) {
    $patchPath = Join-Path $ProfileDir "cordis.patch.yml"
    if (Test-Path $patchPath) {
        $patchText = Get-Content $patchPath -Raw -Encoding UTF8
        $m = [regex]::Match($patchText, "(?m)^\s*gptDir:\s*'?([^'\r\n]+)'?\s*$")
        if ($m.Success) {
            $candidate = $m.Groups[1].Value.Trim()
            if (Test-GptDir $candidate) { $found = $candidate }
        }
    }
}

# 常见路径扫描
if ($null -eq $found) {
    $roots = @($env:USERPROFILE, "D:\", "C:\", "E:\", "F:\")
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $dirs = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like "GPT-SoVITS*" }
        foreach ($dir in $dirs) {
            if (Test-GptDir $dir.FullName) { $found = $dir.FullName; break }
        }
        if ($null -ne $found) { break }
    }
}

if ($null -eq $found) {
    Write-Warn "没有找到 GPT-SoVITS 整合包。"
    Write-Host ""
    Write-Host "  这个仓库只分发「插件 + 桑多涅的克隆语音模型」（约 320 MB）。" -ForegroundColor Yellow
    Write-Host "  真正跑模型要的推理引擎（GPT-SoVITS 整合包，含 Python 运行时和底模，10 GB 以上）" -ForegroundColor Yellow
    Write-Host "  放不进 Git 仓库，需要单独准备一份：" -ForegroundColor Yellow
    Write-Host "    · 官方 Releases： https://github.com/RVC-Boss/GPT-SoVITS/releases" -ForegroundColor Yellow
    Write-Host "    · 官方网盘（夸克）：https://drive.uc.cn/s/482dcfa346a94" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  下载后解压到任意目录，然后重跑： .\install.ps1 -GptSoVitsDir '解压出来的目录'" -ForegroundColor Yellow
    $GptDir = ""
}
else {
    $GptDir = $found
    Write-Ok "GPT-SoVITS：$GptDir"
}

# ── 4. 安装插件到 profile ─────────────────────────────────────────────────
Write-Step "安装插件到 DSH profile"

$nodeModules = Join-Path $ProfileDir "node_modules"
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
$pluginTarget = Join-Path $nodeModules "dsh-sandrone"

if (Test-Path $pluginTarget) {
    $item = Get-Item $pluginTarget -Force
    if ($item.LinkType) {
        # 旧版本以符号链接/目录联接装进去的，先断开再复制，避免写穿到别处
        (Get-Item $pluginTarget -Force).Delete()
    }
    else {
        Remove-Item $pluginTarget -Recurse -Force
    }
}

robocopy $PluginSrc $pluginTarget /MIR /NFL /NDL /NJH /NJS /XD .git node_modules | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制插件失败（robocopy exit=$LASTEXITCODE）" }
Write-Ok "插件已就位：$pluginTarget"

# ── 5. 让 profile 认得这个包 ──────────────────────────────────────────────
Write-Step "更新 profile 配置"

$pkgPath = Join-Path $ProfileDir "package.json"
if (-not (Test-Path $pkgPath)) { throw "找不到 profile 的 package.json：$pkgPath" }
Copy-Item $pkgPath "$pkgPath.bak-sandrone" -Force

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pluginSpec = "file:" + ($PluginSrc -replace "\\", "/")

if ($null -eq $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$pkg.dependencies | Add-Member -NotePropertyName "dsh-sandrone" -NotePropertyValue $pluginSpec -Force

if ($null -eq $pkg.dsh) {
    $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if ($null -eq $pkg.dsh.profile) {
    $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains "dsh-sandrone") { $bundles += "dsh-sandrone" }
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

$json = $pkg | ConvertTo-Json -Depth 32
Set-Content -Path $pkgPath -Value $json -Encoding UTF8
Write-Ok "package.json：已加入依赖与 bundle"

$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
if (-not (Test-Path $patchPath)) { New-Item -ItemType File -Path $patchPath -Force | Out-Null }
$patchText = Get-Content $patchPath -Raw -Encoding UTF8

if ($patchText -match "(?m)^\s*-\s*id:\s*sandrone\s*$") {
    Write-Ok "cordis.patch.yml：已有 sandrone 条目（设置页里改参数即可）"
}
else {
    $block = @()

    $block += ""
    $block += "# ── 桑多涅：模型与 GPT-SoVITS 目录（由 install.ps1 写入）─────────────"
    $block += "- id: sandrone"
    $block += "  name: dsh-sandrone"
    $block += "  config:"
    if ($GptDir -ne "") {
        $block += "    gptDir: '$GptDir'"
    }
    $block += "    apiUrl: http://127.0.0.1:9880"
    $block += "    enabled: true"
    $block += "    autoSpeak: true"
    if ($GptDir -eq "") {
        $block += "    # ⚠️ 没找到 GPT-SoVITS：把 gptDir 改成整合包的实际路径，或者重跑"
        $block += "    #    .\install.ps1 -GptSoVitsDir 'D:\你的\GPT-SoVITS-xxx'"
    }
    Add-Content -Path $patchPath -Value $block -Encoding UTF8
    Write-Ok "cordis.patch.yml：已写入 sandrone 条目"
}

# ── 6. 完事 ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 完全退出并重新启动 DeepSeek Harness（不是刷新页面，是关掉再开）。"
Write-Host "  2. 新建会话 → 预设选「桑多涅」。"
Write-Host "  3. 回复结束后她就会开口；按钮和音量在 设置 →「桑多涅」。"
Write-Host ""
if ($GptDir -eq "") {
    Write-Host "提醒：还没找到 GPT-SoVITS 整合包，语音不会出声。" -ForegroundColor Yellow
    Write-Host "      装好后重跑 .\install.ps1 -GptSoVitsDir '路径'，或在设置页里填 gptDir。" -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "模型位置： $PluginSrc\assets\weights"
Write-Host "插件位置： $pluginTarget"
