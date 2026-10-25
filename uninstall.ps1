<#
.SYNOPSIS
  卸载桑多涅（dsh-sandrone）：只动 DSH profile，不删仓库、不碰 GPT-SoVITS。

.EXAMPLE
  .\uninstall.ps1
#>
param(
    [string]$Profile = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }

$ProfileName = $Profile
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = $env:DSH_PROFILE }
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = "desktop" }

$ProfileDir = Join-Path (Join-Path $DshHome "profiles") $ProfileName
if (-not (Test-Path $ProfileDir)) { throw "找不到 profile：$ProfileDir" }

Write-Step "移除插件目录"
$pluginTarget = Join-Path $ProfileDir "node_modules\dsh-sandrone"
if (Test-Path $pluginTarget) {
    $item = Get-Item $pluginTarget -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $pluginTarget -Recurse -Force }
    Write-Host "    已删除：$pluginTarget"
}
else {
    Write-Host "    本来就没有：$pluginTarget"
}

Write-Step "更新 package.json"
$pkgPath = Join-Path $ProfileDir "package.json"
if (Test-Path $pkgPath) {
    Copy-Item $pkgPath "$pkgPath.bak-unsandrone" -Force
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $pkg.dependencies) {
        $pkg.dependencies.PSObject.Properties.Remove("dsh-sandrone")
    }
    if ($null -ne $pkg.dsh -and $null -ne $pkg.dsh.profile -and $null -ne $pkg.dsh.profile.bundles) {
        $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne "dsh-sandrone" }
        $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue ([object[]]$bundles) -Force
    }
    $pkg | ConvertTo-Json -Depth 32 | Set-Content $pkgPath -Encoding UTF8
    Write-Host "    依赖与 bundle 已移除"
}

Write-Step "更新 cordis.patch.yml"
$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
if (Test-Path $patchPath) {
    $lines = Get-Content $patchPath -Encoding UTF8
    $out = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    foreach ($line in $lines) {
        if ($line -match '^\s*-\s*id:\s*sandrone\s*$') { $skipping = $true; continue }
        if ($skipping -and $line -match '^-\s') { $skipping = $false }
        if (-not $skipping) { $out.Add($line) }
    }
    Set-Content -Path $patchPath -Value $out -Encoding UTF8
    Write-Host "    sandrone 条目已移除"
}

Write-Host ""
Write-Host "卸载完成。重启 DeepSeek Harness 生效。" -ForegroundColor Green
Write-Host "仓库目录和模型都还在，随时可以重新运行 install.ps1。" -ForegroundColor Gray
