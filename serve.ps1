# density-dashboard 로컬 서버
# file:// 로 열면 브라우저가 보내는 Origin: null 을 Overpass API 가 거부해서 "Failed to fetch" 가 납니다.
# 이 스크립트는 현재 폴더를 http://localhost:<포트> 로 서빙해 정상 Origin 을 만들어 줍니다.
# 별도 설치(파이썬/노드) 없이 윈도우 기본 PowerShell 만으로 동작합니다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$page = 'density-dashboard.html'

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.geojson' = 'application/geo+json; charset=utf-8'
  '.csv'  = 'text/csv; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.ico'  = 'image/x-icon'
}

# 비어있는 포트 찾기 (8000 부터)
$listener = $null
foreach ($p in 8000..8020) {
  try {
    $candidate = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $candidate.Start()
    $listener = $candidate
    $port = $p
    break
  } catch {
    if ($candidate) { try { $candidate.Stop() } catch {} }
  }
}
if (-not $listener) { Write-Host '사용 가능한 포트(8000-8020)를 찾지 못했습니다.' -ForegroundColor Red; exit 1 }

$url = "http://localhost:$port/$page"
Write-Host ''
Write-Host '  권역 건축밀도 대시보드 로컬 서버' -ForegroundColor White
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ''
Write-Host '  브라우저가 자동으로 열립니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.' -ForegroundColor DarkGray
Write-Host ''

Start-Process $url

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $client.ReceiveTimeout = 5000

      # 요청 헤더 읽기 (\r\n\r\n 까지)
      $buffer = New-Object byte[] 8192
      $sb = New-Object System.Text.StringBuilder
      while ($true) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { break }
        [void]$sb.Append([System.Text.Encoding]::ASCII.GetString($buffer, 0, $read))
        if ($sb.ToString().Contains("`r`n`r`n")) { break }
        if ($sb.Length -gt 65536) { break }
      }
      $request = $sb.ToString()
      if ([string]::IsNullOrWhiteSpace($request)) { continue }

      $requestLine = ($request -split "`r`n")[0]
      $parts = $requestLine -split ' '
      $rawPath = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
      $path = ($rawPath -split '\?')[0]
      $path = [System.Uri]::UnescapeDataString($path)
      if ($path -eq '/' -or $path -eq '') { $path = "/$page" }

      $relative = $path.TrimStart('/').Replace('/', '\')
      $full = Join-Path $root $relative

      # 폴더 밖 접근 차단
      $rootFull = [System.IO.Path]::GetFullPath($root)
      $targetFull = try { [System.IO.Path]::GetFullPath($full) } catch { $null }

      $status = '200 OK'
      $body = $null
      $contentType = 'application/octet-stream'

      if ($targetFull -and $targetFull.StartsWith($rootFull) -and (Test-Path -LiteralPath $targetFull -PathType Leaf)) {
        $body = [System.IO.File]::ReadAllBytes($targetFull)
        $ext = [System.IO.Path]::GetExtension($targetFull).ToLower()
        if ($types.ContainsKey($ext)) { $contentType = $types[$ext] }
      } else {
        $status = '404 Not Found'
        $contentType = 'text/plain; charset=utf-8'
        $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
      }

      $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()

      Write-Host ("  {0}  {1}" -f $status.Split(' ')[0], $path) -ForegroundColor DarkGray
    } catch {
      # 개별 요청 오류는 서버를 멈추지 않는다
    } finally {
      try { $client.Close() } catch {}
    }
  }
} finally {
  try { $listener.Stop() } catch {}
}
