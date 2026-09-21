# 부성지구 400m 가설 계수 (K1~K4) — 입력은 raw\ 의 Overpass 응답, 출력은 계수결과_400m_<Scope>.csv
#   -Scope 원정의 : 사전 기록의 대상지 정의 그대로 ('부성'으로 시작하는 모든 가로)
#   -Scope 경계내 : 사전 기록의 경계(경부선 동쪽 · 천안대로 서쪽 · 삼성대로 북쪽) 안에 있는 '부성' 가로만
param([ValidateSet('원정의','경계내')][string]$Scope = '경계내')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$R400 = 400
$school = @{ name = '천안부대초등학교'; lat = 36.84876; lon = 127.15201 }   # OSM way 479720282 중심점

function Dist($la1, $lo1, $la2, $lo2) {
    $R = 6371000; $p1 = $la1 * [math]::PI / 180; $p2 = $la2 * [math]::PI / 180
    $dp = ($la2 - $la1) * [math]::PI / 180; $dl = ($lo2 - $lo1) * [math]::PI / 180
    $a = [math]::Sin($dp/2) * [math]::Sin($dp/2) + [math]::Cos($p1) * [math]::Cos($p2) * [math]::Sin($dl/2) * [math]::Sin($dl/2)
    $R * 2 * [math]::Atan2([math]::Sqrt($a), [math]::Sqrt(1 - $a))
}
# 두 선분 교차 여부 (좁은 범위라 위경도 평면 근사)
function Cross($ax,$ay,$bx,$by,$cx,$cy,$dx,$dy) {
    function O($px,$py,$qx,$qy,$rx,$ry) { [math]::Sign(($qx-$px)*($ry-$py) - ($qy-$py)*($rx-$px)) }
    $o1 = O $ax $ay $bx $by $cx $cy; $o2 = O $ax $ay $bx $by $dx $dy
    $o3 = O $cx $cy $dx $dy $ax $ay; $o4 = O $cx $cy $dx $dy $bx $by
    ($o1 -ne $o2) -and ($o3 -ne $o4)
}
function Load($pattern) {
    $f = Get-ChildItem "$here\raw" -Filter $pattern | Sort-Object Name | Select-Object -Last 1
    [pscustomobject]@{ file = $f.Name; json = ([IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json) }
}

$poi  = Load '*overpass_부성지구.json'
$geo  = Load '*overpass_부성가로_간선.json'

$streets   = @($geo.json.elements | Where-Object { $_.tags.name -like '부성*' })
$arterials = @($geo.json.elements | Where-Object { $_.tags.highway -match '^(motorway|trunk|primary|secondary)' -and $_.tags.name -notlike '부성*' })

# 경계선 노드 (남북 방향 선은 위도 기준, 동서 방향 선은 경도 기준으로 가장 가까운 노드를 찾아 비교)
$rail      = Load '*overpass_경부선.json'
$railNodes = @($rail.json.elements | ForEach-Object { $_.geometry })
$eastNodes = @($geo.json.elements | Where-Object { $_.tags.name -eq '천안대로' } | ForEach-Object { $_.geometry })
$southNodes= @($geo.json.elements | Where-Object { $_.tags.name -eq '삼성대로' } | ForEach-Object { $_.geometry })
function LonAt($nodes, $lat) { ($nodes | Sort-Object { [math]::Abs($_.lat - $lat) } | Select-Object -First 1).lon }
function LatAt($nodes, $lon) { ($nodes | Sort-Object { [math]::Abs($_.lon - $lon) } | Select-Object -First 1).lat }
function Inside($lat, $lon) {
    ($lon -gt (LonAt $railNodes $lat)) -and ($lon -lt (LonAt $eastNodes $lat)) -and ($lat -gt (LatAt $southNodes $lon))
}

# 부성 가로를 노드 사이 선분으로 쪼개 길이 가중 중심점과 각 선분 중점을 구함
$segs = foreach ($w in $streets) {
    $g = @($w.geometry)
    for ($i = 0; $i -lt $g.Count - 1; $i++) {
        $len = Dist $g[$i].lat $g[$i].lon $g[$i+1].lat $g[$i+1].lon
        [pscustomobject]@{ way = $w.id; name = $w.tags.name; len = $len
            lat = ($g[$i].lat + $g[$i+1].lat) / 2; lon = ($g[$i].lon + $g[$i+1].lon) / 2 }
    }
}
$allCount = @($segs).Count
if ($Scope -eq '경계내') { $segs = @($segs | Where-Object { Inside $_.lat $_.lon }) }
$excluded = @($streets | Where-Object { $w = $_; -not ($segs | Where-Object { $_.way -eq $w.id }) } | ForEach-Object { $_.tags.name } | Sort-Object -Unique)
$totLen = ($segs | Measure-Object len -Sum).Sum
$cLat = ($segs | ForEach-Object { $_.lat * $_.len } | Measure-Object -Sum).Sum / $totLen
$cLon = ($segs | ForEach-Object { $_.lon * $_.len } | Measure-Object -Sum).Sum / $totLen

# 시설 목록
$pts = foreach ($e in $poi.json.elements) {
    $t = $e.tags; $lat = if ($e.lat) { $e.lat } else { $e.center.lat }; $lon = if ($e.lon) { $e.lon } else { $e.center.lon }
    $kind = if ($t.amenity -eq 'school') { 'school' } elseif ($t.leisure -eq 'park') { 'park' } elseif ($t.leisure -eq 'playground') { 'playground' } else { $null }
    if ($kind) { [pscustomobject]@{ kind = $kind; name = $(if ($t.name) { $t.name } else { "(이름 없음) $($e.type)/$($e.id)" }); lat = $lat; lon = $lon } }
}

# K1: 가로망 중심점 400m 안의 초등학교
$elem = @($pts | Where-Object { $_.kind -eq 'school' -and $_.name -like '*초등학교' } | ForEach-Object {
    $_ | Add-Member -NotePropertyName d_center -NotePropertyValue ([math]::Round((Dist $cLat $cLon $_.lat $_.lon))) -PassThru })
$k1n = @($elem | Where-Object { $_.d_center -le $R400 }).Count

# K2: 부대초 400m 안의 근린공원
$parks = @($pts | Where-Object { $_.kind -eq 'park' } | ForEach-Object {
    $_ | Add-Member -NotePropertyName d_school -NotePropertyValue ([math]::Round((Dist $school.lat $school.lon $_.lat $_.lon))) -PassThru })
$k2n = @($parks | Where-Object { $_.d_school -le $R400 }).Count

# K3: 부성 가로 길이 중 부대초에서 400m 밖인 비율
$outLen = ($segs | Where-Object { (Dist $school.lat $school.lon $_.lat $_.lon) -gt $R400 } | Measure-Object len -Sum).Sum
$k3 = $outLen / $totLen

# K4: 각 부성 선분 중점 → 부대초 직선이 간선과 교차하는가
$artSegs = foreach ($w in $arterials) { $g = @($w.geometry); for ($i = 0; $i -lt $g.Count - 1; $i++) {
    [pscustomobject]@{ name = $(if ($w.tags.name) { $w.tags.name } else { "(무명 $($w.tags.highway))" }); x1 = $g[$i].lon; y1 = $g[$i].lat; x2 = $g[$i+1].lon; y2 = $g[$i+1].lat } } }
$crossLen = 0; $crossNames = @{}
foreach ($s in $segs) {
    $hit = $artSegs | Where-Object { Cross $s.lon $s.lat $school.lon $school.lat $_.x1 $_.y1 $_.x2 $_.y2 }
    if ($hit) { $crossLen += $s.len; foreach ($h in $hit) { $crossNames[$h.name] = 1 } }
}
$k4 = $crossLen / $totLen

# 출력
"범위: $Scope | 입력: $($poi.file), $($geo.file), $($rail.file)"
"부성 가로: 선분 $(@($segs).Count) / $allCount 사용, 총연장 $([math]::Round($totLen)) m"
"범위 밖으로 제외된 가로: $(if ($excluded) { $excluded -join ', ' } else { '없음' })"
"가로망 중심점(길이가중): $([math]::Round($cLat,5)), $([math]::Round($cLon,5)) / 부대초까지 $([math]::Round((Dist $cLat $cLon $school.lat $school.lon))) m"
""
"[K1] 중심점 400m 안 초등학교: $k1n 개"; $elem | Sort-Object d_center | ForEach-Object { "     $($_.name): $($_.d_center) m" }
"[K2] 부대초 400m 안 근린공원(leisure=park): $k2n 개"; $parks | Sort-Object d_school | ForEach-Object { "     $($_.name): $($_.d_school) m" }
"[K3] 부대초 400m 밖 부성 가로 비율: $([math]::Round($k3*100,1)) % ($([math]::Round($outLen)) / $([math]::Round($totLen)) m)"
"[K4] 부대초로 가는 직선이 간선을 가로지르는 부성 가로 비율: $([math]::Round($k4*100,1)) %  교차 간선: $(($crossNames.Keys | Sort-Object) -join ', ')"
""
"부성 가로 이름 목록: $((($streets | ForEach-Object { $_.tags.name }) | Sort-Object -Unique) -join ', ')"

$result = @(
    [pscustomobject]@{ 조건 = 'K1'; 기준 = '가로망 중심점 400m 안 초등학교 0개면 기각'; 값 = "$k1n 개"; 기각 = [bool]($k1n -eq 0) }
    [pscustomobject]@{ 조건 = 'K2'; 기준 = '부대초 400m 안 근린공원 0개면 기각'; 값 = "$k2n 개"; 기각 = [bool]($k2n -eq 0) }
    [pscustomobject]@{ 조건 = 'K3'; 기준 = '부대초 400m 밖 가로 비율 50% 이상이면 기각'; 값 = "$([math]::Round($k3*100,1)) %"; 기각 = [bool]($k3 -ge 0.5) }
    [pscustomobject]@{ 조건 = 'K4'; 기준 = '부대초로 가는 직선이 secondary 이상 간선을 가로지르면 기각'; 값 = "$([math]::Round($k4*100,1)) % 교차"; 기각 = [bool]($k4 -gt 0) }
)
$result | ForEach-Object { $_ | Add-Member 범위 $Scope -PassThru | Add-Member 입력파일 "$($poi.file); $($geo.file); $($rail.file)" -PassThru | Add-Member 계산일 (Get-Date -Format 'yyyy-MM-dd') -PassThru } |
    Export-Csv "$here\계수결과_400m_$Scope.csv" -NoTypeInformation -Encoding UTF8
$result | Format-Table -AutoSize
