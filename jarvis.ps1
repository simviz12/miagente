# Abre JARVIS como una app: arranca el cerebro y la cara (con acceso total)
# si no estan corriendo, y abre la interfaz en una ventana propia de Edge,
# sin pestanas ni barra de direcciones.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$url = 'http://localhost:5173'

function Test-Port($port) {
  try {
    # 'localhost', no 127.0.0.1: Vite escucha solo en ::1 (IPv6) y este
    # constructor prueba ambas familias de direcciones.
    $c = New-Object Net.Sockets.TcpClient('localhost', $port)
    $c.Close()
    return $true
  } catch { return $false }
}

# Arranca el servidor en una ventana minimizada. Cerrar esa ventana apaga JARVIS.
if (-not (Test-Port 8787)) {
  Start-Process powershell -WorkingDirectory $root -WindowStyle Minimized -ArgumentList @(
    '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle = 'JARVIS (cierra esta ventana para apagarlo)'; node scripts/start.mjs --writes"
  )
}

# Espera a que la cara este lista (hasta 60 s).
for ($i = 0; $i -lt 120 -and -not (Test-Port 5173); $i++) { Start-Sleep -Milliseconds 500 }

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# Perfil propio, para que el permiso del microfono quede guardado solo para JARVIS.
$profileDir = Join-Path $env:LOCALAPPDATA 'jarvis-app'
Start-Process $edge -ArgumentList @("--app=$url", "--user-data-dir=$profileDir", '--start-maximized')
