# Full-screen recorder for the PoC demo (primary monitor, 30 fps, H.264 MP4).
# Usage (PowerShell):   .\scripts\record-demo.ps1
#   optional mic:        .\scripts\record-demo.ps1 -Mic "Microphone Array (Realtek(R) Audio)"
#   list mic names:      .\scripts\record-demo.ps1 -ListMics
# Stop recording: click this PowerShell window and press  q
# Requires: python -m pip install --user imageio-ffmpeg   (ships an ffmpeg binary)
param(
  [string]$Mic = '',
  [switch]$ListMics,
  [int]$Seconds = 0,   # optional fixed length; 0 = until you press q
  [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)

$ff = python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if (-not $ff -or -not (Test-Path $ff)) { throw 'ffmpeg not found. Run: python -m pip install --user imageio-ffmpeg' }

if ($ListMics) { & $ff -hide_banner -list_devices true -f dshow -i dummy 2>&1 | Select-String '\(audio\)'; return }

# Read real pixels, not DPI-scaled ones (at 150% scaling a 1920x1200 screen reports 1280x800,
# which would record only part of the screen).
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win32.Dpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $b.Width - ($b.Width % 2); $h = $b.Height - ($b.Height % 2)
$out = Join-Path $OutDir ("Fin-MeshMesh-Demo-{0}.mp4" -f (Get-Date -Format 'yyyyMMdd-HHmm'))

$video = @('-f','gdigrab','-framerate','30','-draw_mouse','1','-offset_x',"$($b.X)",'-offset_y',"$($b.Y)",'-video_size',"${w}x${h}",'-i','desktop')
$audio = @(); $amap = @()
if ($Mic) { $audio = @('-f','dshow','-i',"audio=$Mic"); $amap = @('-c:a','aac','-b:a','128k') }

Write-Host "Recording primary screen (${w}x${h}) to:`n  $out`nPress q in this window to stop." -ForegroundColor Green
$limit = @(); if ($Seconds -gt 0) { $limit = @('-t', "$Seconds") }
& $ff -hide_banner -loglevel error @video @audio @limit -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p @amap $out
Write-Host "Saved: $out" -ForegroundColor Green
