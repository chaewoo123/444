# 국가법령정보 OPEN API 조회 스크립트 (스마트도시계획 3주차)
# - OC(신청자 ID)는 같은 폴더의 oc.txt 에서 읽는다. 화면·파일 어디에도 출력하지 않는다.
# - 모든 응답 원문은 raw\ 폴더에 조회 시각과 함께 그대로 저장한다 (검증 로그의 '원문' 칸 근거).
#
# 사용 예)
#   .\law_api.ps1 -Api lawSearch  -Target law   -Query "국토의 계획 및 이용에 관한 법률"
#   .\law_api.ps1 -Api lawService -Target law   -MST 284013 -JO 007800
#   .\law_api.ps1 -Api lawSearch  -Target ordin -Query "천안시 도시계획 조례"
#   .\law_api.ps1 -Api lawService -Target ordin -MST <자치법규일련번호>
param(
    [Parameter(Mandatory)][ValidateSet('lawSearch','lawService')][string]$Api,
    [Parameter(Mandatory)][ValidateSet('law','ordin')][string]$Target,
    [string]$Query,
    [string]$MST,
    [string]$JO,
    [string]$Tag = ''
)

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ocFile = Join-Path $here 'oc.txt'
if (-not (Test-Path $ocFile)) { throw "oc.txt 가 없습니다. 같은 폴더에 OC 값 한 줄만 적어 저장해 주세요." }
# oc.txt 가 폴더로 만들어진 경우 그 안의 .txt 파일 하나를 읽는다
if ((Get-Item $ocFile).PSIsContainer) {
    $inner = @(Get-ChildItem $ocFile -File -Filter *.txt)
    if ($inner.Count -ne 1) { throw "oc.txt 폴더 안에 .txt 파일이 정확히 하나 있어야 합니다 (현재 $($inner.Count)개)." }
    $ocFile = $inner[0].FullName
}
$oc = (Get-Content $ocFile -Raw -Encoding UTF8)
if ($null -eq $oc -or $oc.Trim() -eq '') { throw "OC 값이 비어 있습니다. 요청을 보내지 않고 중단합니다." }
$oc = $oc.Trim()

$params = [ordered]@{ OC = $oc; target = $Target; type = 'JSON' }
if ($Query) { $params.query = $Query; $params.display = '20' }
if ($MST)   { $params.MST = $MST }
if ($JO)    { $params.JO  = $JO }

$qs  = ($params.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join '&'
$url = "https://www.law.go.kr/DRF/$Api.do?$qs"

$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$fetchedAt = Get-Date
try {
    $body = $wc.DownloadString($url)
} catch {
    $body = "HTTP_ERROR: $($_.Exception.Message)"
}

# 저장용 요청 기록 — OC 는 가림 (응답 본문의 상세링크에도 OC 가 들어 있으므로 본문까지 가림)
$safeUrl = $url -replace 'OC=[^&]*', 'OC=***'
$body    = $body.Replace($oc, '***')
$stamp   = $fetchedAt.ToString('yyyyMMdd_HHmmss')
$name    = "{0}_{1}_{2}{3}.json" -f $stamp, $Api, $Target, ($(if ($Tag) { "_$Tag" } else { '' }))
$out     = Join-Path $here "raw\$name"

$record = [ordered]@{
    request   = $safeUrl
    fetchedAt = $fetchedAt.ToString('yyyy-MM-dd HH:mm:ss')
    body      = $body
}
($record | ConvertTo-Json -Depth 3) | Out-File -FilePath $out -Encoding utf8

"saved: raw\$name"
"request: $safeUrl"
"length: $($body.Length)"
$body.Substring(0, [Math]::Min(1500, $body.Length))
