# Compiles the tray launcher (Medicus Vitae.exe) with the C# compiler that ships with
# Windows, then creates Desktop and Start menu shortcuts (replacing the old Cortex ones).
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $app 'Medicus Vitae.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path "$PSScriptRoot\medicus.ico")) { & "$PSScriptRoot\make-icons.ps1" }
& $csc /nologo /target:winexe /optimize+ "/out:$exe" "/win32icon:$PSScriptRoot\medicus.ico" /r:System.Windows.Forms.dll /r:System.Drawing.dll "$PSScriptRoot\MedicusTray.cs"
if ($LASTEXITCODE -ne 0) { throw 'Compiling the tray app failed.' }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
	$old = Join-Path $dir 'Cortex.lnk'
	if (Test-Path $old) { Remove-Item $old -Force; Write-Output "Removed old shortcut: $old" }
	$lnk = $shell.CreateShortcut((Join-Path $dir 'Medicus Vitae.lnk'))
	$lnk.TargetPath = $exe
	$lnk.WorkingDirectory = $app
	$lnk.IconLocation = "$exe,0"
	$lnk.Description = 'Medicus Vitae: MCAT study app'
	$lnk.Save()
	Write-Output "Shortcut: $(Join-Path $dir 'Medicus Vitae.lnk')"
}
# The old launcher, if it isn't running any more.
$oldExe = Join-Path $app 'Cortex.exe'
if (Test-Path $oldExe) {
	try { Remove-Item $oldExe -Force -ErrorAction Stop; Write-Output 'Removed the old Cortex.exe' }
	catch { Write-Output 'Cortex.exe is still running; delete it after quitting it (it is no longer used).' }
}
Write-Output "Built $exe"
