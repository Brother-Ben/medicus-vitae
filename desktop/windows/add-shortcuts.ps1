# Adds "Medicus Vitae" to the Start menu and the Desktop, pointing at this copy of the app.
# Run by "Add shortcuts.cmd" in the app folder. Run it again after moving the folder.
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $app 'Medicus Vitae.exe'
if (-not (Test-Path $exe)) { throw "Medicus Vitae.exe is not in $app" }
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
	$lnk = $shell.CreateShortcut((Join-Path $dir 'Medicus Vitae.lnk'))
	$lnk.TargetPath = $exe
	$lnk.WorkingDirectory = $app
	$lnk.IconLocation = "$exe,0"
	$lnk.Description = 'Medicus Vitae: MCAT study app'
	$lnk.Save()
	Write-Output "Added: $(Join-Path $dir 'Medicus Vitae.lnk')"
}
