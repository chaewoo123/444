# raw\ 폴더의 법령 조문 응답(JSON)을 사람이 읽는 텍스트로 모은다 → 원문_조문모음.txt
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sb = New-Object System.Text.StringBuilder

function Add-Line($s) { [void]$sb.AppendLine($s) }
function Flat($v) { if ($null -eq $v) { '' } elseif ($v -is [array]) { ($v | ForEach-Object { Flat $_ }) -join ' ' } else { "$v" } }

foreach ($f in Get-ChildItem "$here\raw" -Filter '*lawService_law_*.json' | Sort-Object Name) {
    $rec  = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $body = $rec.body | ConvertFrom-Json
    $info = $body.법령.기본정보
    $jo   = ([regex]::Match($rec.request, 'JO=(\d+)')).Groups[1].Value
    Add-Line ('=' * 80)
    Add-Line "[요청 JO=$jo] $($info.법령명_한글) | 법령ID $($info.법령ID) | MST $(([regex]::Match($rec.request, 'MST=(\d+)')).Groups[1].Value) | 시행 $($info.시행일자) | 조회 $($rec.fetchedAt)"
    Add-Line "원본 파일: raw\$($f.Name)"
    Add-Line ('-' * 80)
    foreach ($u in @($body.법령.조문.조문단위)) {
        if ($u.조문여부 -ne '조문') { Add-Line "(장·절 제목) $(Flat $u.조문내용)"; continue }
        Add-Line (Flat $u.조문내용)
        foreach ($h in @($u.항)) {
            if ($h.항내용) { Add-Line (Flat $h.항내용) }
            foreach ($ho in @($h.호)) {
                if ($ho.호내용) { Add-Line ('   ' + (Flat $ho.호내용)) }
                foreach ($m in @($ho.목)) { if ($m.목내용) { Add-Line ('      ' + (Flat $m.목내용)) } }
            }
        }
    }
}
[IO.File]::WriteAllText("$here\원문_조문모음.txt", $sb.ToString(), (New-Object Text.UTF8Encoding $true))
"written: 원문_조문모음.txt ($($sb.Length) chars)"
