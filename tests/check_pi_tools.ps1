# pi-acp 诊断一键脚本（重启后运行）
# 1) 读插件自检日志（apply / mountTools / 每个 register 的结果）
# 2) 确认 patch 行、软链、版本
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE '.dsh\pi-acp-selftest.log'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$link = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@local\dsh-pi-acp'
$bundle = Join-Path (Split-Path $PSScriptRoot -Parent) 'index.js'

"=== selftest log ($log) ==="
if (Test-Path $log) {
  Get-Item $log | Select-Object Length, LastWriteTime | Format-List
  Get-Content $log -Encoding UTF8 | Select-Object -Last 40
} else {
  'MISSING — apply 从未执行（loader 没把插件跑起来），或 USERPROFILE 不可写'
}

"`n=== bundle ==="
Get-Item $bundle | Select-Object Length, LastWriteTime | Format-List
(Get-Content $bundle -Encoding UTF8 | Select-String -Pattern 'pi-acp-selftest|oneOf|ctx.tools !== undefined').Line

"`n=== symlink ==="
Get-Item $link | Select-Object LinkType, Target | Format-List

"`n=== patch insert ==="
Select-String -Path $patch -Pattern 'pi-acp' -Encoding UTF8 | ForEach-Object { "$($_.LineNumber): $($_.Line)" }
