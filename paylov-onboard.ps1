# =============================================================================
# Paylov onboarding — yangi onboarding tokendan to'liq credentials oladi.
# Bir martalik, shuning uchun chiqqan qiymatlarni darhol saqlang.
# Foydalanish:
#   PowerShell -ExecutionPolicy Bypass -File paylov-onboard.ps1
# yoki double-click PAYLOV-ONBOARD.bat
# =============================================================================

$ErrorActionPreference = 'Stop'
$BASE = 'https://dev.gw.paylov.uz'   # sandbox; production'da gw.paylov.uz qiling

Write-Host ""
Write-Host "Paylov onboarding" -ForegroundColor Cyan
Write-Host "=================" -ForegroundColor Cyan
Write-Host "BASE_URL: $BASE"
Write-Host ""

$token = Read-Host -Prompt "Yangi onboarding tokenni kiriting (Paylov support yuborgan)"
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "Token bo'sh. Chiqdim." -ForegroundColor Red
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
$token = $token.Trim()

# ---- STEP 1: VERIFY ---------------------------------------------------------
Write-Host ""
Write-Host "Step 1: tokenni tekshirish..." -ForegroundColor Yellow
try {
    $r1 = Invoke-RestMethod -Uri "$BASE/merchant/onboarding/?token=$token" -Method Get -ErrorAction Stop
    Write-Host "  OK: $($r1 | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    $msg = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Host "  XATO: $msg" -ForegroundColor Red
    Write-Host "  Token noto'g'ri yoki muddati o'tgan. Paylov support'idan yangisini so'rang." -ForegroundColor Red
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}

# ---- STEP 2: SET USERNAME + PASSWORD (BIR MARTALIK!) ------------------------
$username = 'escro_api'
$rngBytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rngBytes)
$password = ([BitConverter]::ToString($rngBytes) -replace '-','').ToLower()

Write-Host ""
Write-Host "Step 2: credentials yaratish (BU OQIM BIR MARTALIK)" -ForegroundColor Yellow
Write-Host "  username = $username"
Write-Host "  password = $password"

$body = @{ username = $username; password = $password } | ConvertTo-Json -Compress
try {
    $r2 = Invoke-RestMethod -Uri "$BASE/merchant/onboarding/?token=$token" -Method Post -ContentType 'application/json' -Body $body -ErrorAction Stop
} catch {
    $msg = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Host "  XATO: $msg" -ForegroundColor Red
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}

if (-not $r2.consumer_key -or -not $r2.consumer_secret) {
    Write-Host "  Kutilmagan javob: $($r2 | ConvertTo-Json -Compress)" -ForegroundColor Red
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}

# ---- SAVE -------------------------------------------------------------------
$now = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $PSScriptRoot "PAYLOV-CREDENTIALS-$now.json"
$out = [ordered]@{
    timestamp        = (Get-Date).ToString('o')
    base_url         = $BASE
    onboarding_token = $token
    consumer_key     = $r2.consumer_key
    consumer_secret  = $r2.consumer_secret
    username         = $username
    password         = $password
    raw_response     = $r2
}
$out | ConvertTo-Json -Depth 5 | Set-Content -Path $file -Encoding utf8

# ---- VERIFY: TRY TO OBTAIN ACCESS TOKEN -------------------------------------
Write-Host ""
Write-Host "Step 3: yangi credentials bilan access_token sinab ko'rish..." -ForegroundColor Yellow
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($r2.consumer_key):$($r2.consumer_secret)"))
$tokenBody = @{ grant_type = 'password'; username = $username; password = $password } | ConvertTo-Json -Compress
try {
    $r3 = Invoke-RestMethod -Uri "$BASE/merchant/oauth2/token/" -Method Post `
        -Headers @{ Authorization = "Basic $basic" } `
        -ContentType 'application/json' -Body $tokenBody -ErrorAction Stop
    if ($r3.access_token) {
        $maskedAt = $r3.access_token.Substring(0, [Math]::Min(20, $r3.access_token.Length)) + '...'
        Write-Host "  OK: access_token olindi ($maskedAt), expires_in=$($r3.expires_in)s" -ForegroundColor Green
    } else {
        Write-Host "  Javob keldi, lekin access_token yo'q: $($r3 | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
} catch {
    $msg = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Host "  XATO: $msg" -ForegroundColor Red
}

# ---- OUTPUT -----------------------------------------------------------------
Write-Host ""
Write-Host "===================== CREDENTIALS =====================" -ForegroundColor Green
Write-Host "PAYLOV_BASE_URL        = $BASE"
Write-Host "PAYLOV_CONSUMER_KEY    = $($r2.consumer_key)"
Write-Host "PAYLOV_CONSUMER_SECRET = $($r2.consumer_secret)"
Write-Host "PAYLOV_USERNAME        = $username"
Write-Host "PAYLOV_PASSWORD        = $password"
Write-Host "=======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Saqlandi: $file" -ForegroundColor Cyan
Write-Host ""
Write-Host "Bu 4 qiymatni Claude'ga yuboring — server .env'ga qo'yib restart qiladi." -ForegroundColor Yellow
Write-Host ""
Read-Host "Yopish uchun Enter bosing"
