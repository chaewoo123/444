# raw\ 의 OSM 데이터로 가설 도면(map.svg)을 그린다 — 지도 타일을 쓰지 않으므로 재현 가능하고 저작권 문제 없음
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Load($pattern) { $f = Get-ChildItem "$here\raw" -Filter $pattern | Sort-Object Name | Select-Object -Last 1; [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json }
$poi = Load '*overpass_부성지구.json'; $geo = Load '*overpass_부성가로_간선.json'; $rail = Load '*overpass_경부선.json'

# 도면 범위와 투영 (좁은 범위라 등장방형 + cos(위도) 보정)
$lat0 = 36.8445; $lon0 = 127.1500; $halfM = 950          # 중심과 반폭(m)
$SW = 640; $SH = 640; $s = $SW / (2 * $halfM)                # px per m
$mLat = 111320; $mLon = 111320 * [math]::Cos($lat0 * [math]::PI / 180)
function X($lon) { [math]::Round($SW / 2 + ($lon - $lon0) * $mLon * $s, 1) }
function Y($lat) { [math]::Round($SH / 2 - ($lat - $lat0) * $mLat * $s, 1) }
function Path($geom) { 'M' + (($geom | ForEach-Object { "$(X $_.lon),$(Y $_.lat)" }) -join ' L') }

$school = @{ lat = 36.84876; lon = 127.15201 }
$south  = @{ lat = 36.84285; lon = 127.14881 }            # H2 대체 중심 후보: 이름 없는 공원 way/598567634
$r400 = 400 * $s; $r250 = 250 * $s

$sb = New-Object System.Text.StringBuilder
function A($t) { [void]$sb.AppendLine($t) }
A "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 $SW $SH' role='img' aria-label='부성지구 400m 가설 도면'>"
A "<rect width='$SW' height='$SH' fill='var(--map-bg)'/>"
# 부성 가로 (경계 안/밖 구분 없이 그림, 경계 밖 1~8길은 도면 범위 밖)
foreach ($way in $geo.elements | Where-Object { $_.tags.name -like '부성*' }) { A "<path d='$(Path $way.geometry)' fill='none' stroke='var(--street)' stroke-width='1.6'/>" }
# 간선
foreach ($way in $geo.elements | Where-Object { $_.tags.highway -match '^(motorway|trunk|primary|secondary)$' -and $_.tags.name -notlike '부성*' }) { A "<path d='$(Path $way.geometry)' fill='none' stroke='var(--arterial)' stroke-width='4' stroke-linecap='round'/>" }
# 경부선
foreach ($way in $rail.elements) { A "<path d='$(Path $way.geometry)' fill='none' stroke='var(--rail)' stroke-width='3' stroke-dasharray='8 5'/>" }
# 400m 원 (H) / 250m 원 (H2 근린분구 규모)
A "<circle cx='$(X $school.lon)' cy='$(Y $school.lat)' r='$r400' fill='var(--c400-fill)' stroke='var(--c400)' stroke-width='2'/>"
A "<circle cx='$(X $south.lon)' cy='$(Y $south.lat)' r='$r250' fill='none' stroke='var(--c250)' stroke-width='2' stroke-dasharray='6 4'/>"
# 공원·학교
foreach ($e in $poi.elements) {
    $lat = if ($e.lat) { $e.lat } else { $e.center.lat }; $lon = if ($e.lon) { $e.lon } else { $e.center.lon }
    if ($e.tags.leisure -eq 'park') { A "<rect x='$((X $lon) - 6)' y='$((Y $lat) - 6)' width='12' height='12' rx='2' fill='var(--park)'/>" }
    if ($e.tags.amenity -eq 'school') {
        $isElem = $e.tags.name -like '*초등학교'
        A "<circle cx='$(X $lon)' cy='$(Y $lat)' r='$(if ($isElem) { 7 } else { 5 })' fill='$(if ($isElem) { 'var(--school)' } else { 'var(--school2)' })'/>"
        $short = $e.tags.name -replace '^천안', '' -replace '등학교$', ''
        A "<text x='$((X $lon) + 9)' y='$((Y $lat) + 4)' class='lb'>$short</text>"
    }
}
# 라벨
A "<text x='$((X $school.lon) + 9)' y='$((Y $school.lat) - 10)' class='lb strong'>H 중심 · 400m</text>"
A "<text x='$((X $south.lon) - 70)' y='$((Y $south.lat) + $r250 + 16)' class='lb c250'>H2 후보 · 250m</text>"
A "<text x='$((X 127.1452))' y='$((Y 36.8505))' class='lb rail'>경부선</text>"
A "<text x='$((X 127.1558))' y='$((Y 36.8450))' class='lb art'>천안대로</text>"
A "<text x='$((X 127.1515))' y='$((Y 36.8372))' class='lb art'>삼성대로</text>"
# 축척·방위
$bar = 200 * $s
A "<g transform='translate(20,$($SH - 28))'><rect width='$bar' height='6' fill='var(--ink)'/><text x='0' y='-6' class='lb'>0</text><text x='$($bar - 22)' y='-6' class='lb'>200 m</text></g>"
A "<g transform='translate($($SW - 34),40)'><path d='M0,-18 L7,4 L0,-2 L-7,4 Z' fill='var(--ink)'/><text x='-4' y='20' class='lb'>N</text></g>"
A "</svg>"
[IO.File]::WriteAllText("$here\map.svg", $sb.ToString(), (New-Object Text.UTF8Encoding $false))
"written: map.svg"
