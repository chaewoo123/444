# report_template.html 의 {{...}} 자리를 CSV·SVG 로 채워 제출본.html 을 만든다 (내용을 두 번 적지 않기 위함)
param([string]$Team = '[팀명]', [string]$Repo = '[저장소 주소 — 확정 후 기입]')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function E($s) { [System.Net.WebUtility]::HtmlEncode("$s") }
function Tag($v) { switch -Regex ($v) { '^실재하지 않음$' { "<span class='tag t-bad'>$v</span>" } '^시점 불일치$' { "<span class='tag t-warn'>$v</span>" } '^일치$' { "<span class='tag t-ok'>$v</span>" } default { E $v } } }

$tpl = [IO.File]::ReadAllText("$here\report_template.html", [Text.Encoding]::UTF8)
$svg = [IO.File]::ReadAllText("$here\map.svg", [Text.Encoding]::UTF8)

# 1. 가설 — K 행 (원정의 결과엔 K4 행이 없을 수 있음)
$kA = Import-Csv "$here\계수결과_400m_원정의.csv" -Encoding UTF8
$kB = Import-Csv "$here\계수결과_400m_경계내.csv" -Encoding UTF8
function Cell($r) { if (-not $r) { return "<td class='num'>—</td>" }; $t = if ($r.기각 -eq 'True') { "<span class='tag t-bad'>기각</span>" } else { "<span class='tag t-ok'>통과</span>" }; "<td class='num'>$(E $r.값) $t</td>" }
$krows = foreach ($k in 'K1','K2','K3','K4') {
    $a = $kA | Where-Object 조건 -eq $k; $b = $kB | Where-Object 조건 -eq $k
    "<tr><td>$k</td><td>$(E ($b.기준))</td>$(Cell $a)$(Cell $b)</tr>"
}
$osm = (Get-Content (Get-ChildItem "$here\raw" -Filter '*overpass_부성지구.json' | Select-Object -Last 1).FullName -Raw -Encoding UTF8 | ConvertFrom-Json).osm3s.timestamp_osm_base

# 2. 검증 로그
$log = Import-Csv "$here\검증로그.csv" -Encoding UTF8
$logsum = foreach ($t in '조문','시점','수치') { $n = @($log | Where-Object 오류유형 -eq $t).Count; "<tr><td class='num'>$t</td><td class='num'>$n</td><td>$(if ($n -ge 1) { "<span class='tag t-ok'>충족</span>" } else { "<span class='tag t-bad'>미충족</span>" })</td></tr>" }
$logrows = foreach ($r in $log) {
    "<tr><td>$(E $r.번호)</td><td>$(E $r.출처)</td><td>$(E $r.'검증대상_주장(원문 그대로)')</td><td>$(E $r.오류유형)</td><td>$(Tag $r.판정)</td><td>$(E $r.정정값) <span class='note'>($(E $r.조항호) · $(E $r.시행일))</span></td></tr>"
}

# 3. 조례표
$ord = Import-Csv "$here\조례_21종표_천안시.csv" -Encoding UTF8
$ordrows = foreach ($r in $ord) {
    "<tr><td class='num'>$($r.번호)</td><td>$(E $r.대분류)</td><td>$(E $r.용도지역)</td><td class='num'>$($r.'건폐율_법상한(%)')</td><td class='num'>$($r.'건폐율_시행령상한(%)')</td><td class='num'><b>$($r.'건폐율_천안조례(%)')</b></td><td class='num'>$($r.'용적률_시행령범위(%)')</td><td class='num'><b>$($r.'용적률_천안조례(%)')</b></td></tr>"
}

$out = $tpl.Replace('{{MAP}}', $svg).Replace('{{KROWS}}', ($krows -join "`n")).Replace('{{OSMTIME}}', $osm).
    Replace('{{LOGSUM}}', ($logsum -join "`n")).Replace('{{LOGROWS}}', ($logrows -join "`n")).
    Replace('{{ORDROWS}}', ($ordrows -join "`n")).Replace('{{TEAM}}', (E $Team)).Replace('{{REPO}}', (E $Repo))
[IO.File]::WriteAllText("$here\제출본.html", $out, (New-Object Text.UTF8Encoding $false))
"written: 제출본.html ($($out.Length) chars) — 남은 자리표시자: $(([regex]::Matches($out, '\{\{[A-Z]+\}\}')).Count)"
