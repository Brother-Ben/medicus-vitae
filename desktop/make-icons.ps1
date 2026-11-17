# Draws the Medicus Vitae mark (teal rounded square with a white "M", the same
# shape as static/favicon.svg) and writes:
#   desktop/medicus.ico           multi-size Windows icon (16-256 px) for the tray app and shortcuts
#   static/icons/icon-192.png     web app icons (PLAT-01)
#   static/icons/icon-512.png
#   static/icons/icon-maskable-512.png
#   static/icons/apple-touch-icon.png (180 px)
# The final logo is on hold: change the shape here, in static/favicon.svg,
# src/lib/components/Logo.svelte and MakeIcon in desktop/MedicusTray.cs.
# Run: powershell -ExecutionPolicy Bypass -File desktop\make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$app = Split-Path -Parent $PSScriptRoot

# The "M", as in favicon.svg (a 64-unit square).
$M = @(@(17, 46), @(17, 19), @(22.5, 19), @(32, 34), @(41.5, 19), @(47, 19), @(47, 46), @(41, 46), @(41, 30.5), @(33.6, 42), @(30.4, 42), @(23, 30.5), @(23, 46))

function New-Mark([int]$size, [bool]$fullBleed) {
	$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$g = [System.Drawing.Graphics]::FromImage($bmp)
	$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
	$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
	$g.Clear([System.Drawing.Color]::Transparent)
	$teal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 118, 110))
	if ($fullBleed) {
		$g.FillRectangle($teal, 0, 0, $size, $size)
		$scale = 0.78
	} else {
		$r = [single]($size * 0.25)
		$path = New-Object System.Drawing.Drawing2D.GraphicsPath
		$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
		$path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
		$path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
		$path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
		$path.CloseFigure()
		$g.FillPath($teal, $path)
		$scale = 1.0
	}
	$k = $size / 64.0 * $scale
	$off = ($size - 64 * $k) / 2
	$points = New-Object 'System.Drawing.PointF[]' $M.Count
	for ($i = 0; $i -lt $M.Count; $i++) {
		$points[$i] = New-Object System.Drawing.PointF ([single]($off + $M[$i][0] * $k)), ([single]($off + $M[$i][1] * $k))
	}
	$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
	$g.FillPolygon($white, $points)
	$g.Dispose()
	return $bmp
}

function Get-PngBytes($bmp) {
	$ms = New-Object System.IO.MemoryStream
	$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	# The leading comma stops PowerShell from unrolling the array into single bytes.
	return , $ms.ToArray()
}

# Windows icon with PNG-compressed entries (supported since Windows Vista).
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) { $images.Add([byte[]](Get-PngBytes (New-Mark $s $false))) }
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
	$s = $sizes[$i]
	$dim = if ($s -ge 256) { 0 } else { $s }
	$w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
	$w.Write([uint16]1); $w.Write([uint16]32)
	$w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
	$offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'medicus.ico'), $ico.ToArray())

$icons = Join-Path $app 'static\icons'
New-Item -ItemType Directory -Force $icons | Out-Null
(New-Mark 192 $false).Save((Join-Path $icons 'icon-192.png'), [System.Drawing.Imaging.ImageFormat]::Png)
(New-Mark 512 $false).Save((Join-Path $icons 'icon-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
(New-Mark 512 $true).Save((Join-Path $icons 'icon-maskable-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
(New-Mark 180 $true).Save((Join-Path $icons 'apple-touch-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "Icons written: desktop\medicus.ico and static\icons\*.png"
