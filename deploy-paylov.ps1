# ============================================================================
# Escro - Paylov integratsiyasi: lokal build + push + serverda deploy + test
# ============================================================================
# Foydalanish: O'ng tugma → "Run with PowerShell" yoki:
#   PowerShell -ExecutionPolicy Bypass -File deploy-paylov.ps1
# ============================================================================

$ErrorActionPreference = "Continue"

# Ranglar uchun
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK]  $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "[XATO] $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "[!]  $msg" -ForegroundColor Yellow }

# --- Sozlamalar ----------------------------------------------------------------
$RepoPath        = "D:\Escro"
$Branch          = "Paylov_integration"
$ServerIp        = "16.170.64.168"
$ServerUser      = "ubuntu"   # AWS default. Agar ec2-user kerak bo'lsa, o'zgartiring.
$PemKey          = "C:\Users\siroj\Downloads\escro-pem-key.pem"
$ServerRepoPath  = "/home/ubuntu/escro"   # Eng ehtimoliy yo'l. Skript boshqa joyni ham qidiradi.
$Pm2Process      = "escro"
$CommitMsg       = "feat(payment): complete Paylov integration - payout, webhook, audit, idempotency, tiyin handling"

Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  Escro - Paylov integratsiyasini deploy qilish" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta

# --- 0. Tekshiruvlar -----------------------------------------------------------
Write-Step "Asboblarni tekshirish (git, node, ssh)..."

$missing = @()
if (-not (Get-Command git -ErrorAction SilentlyContinue))  { $missing += "git" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "node" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue))  { $missing += "npm" }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue))  { $missing += "ssh" }
if (-not (Get-Command scp -ErrorAction SilentlyContinue))  { $missing += "scp" }

if ($missing.Count -gt 0) {
    Write-Fail "Quyidagilar topilmadi: $($missing -join ', ')"
    Write-Host "Iltimos, ularni o'rnating va qayta urunib ko'ring." -ForegroundColor Yellow
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
Write-Ok "Hamma asboblar topildi"

if (-not (Test-Path $PemKey)) {
    Write-Fail "PEM kalit topilmadi: $PemKey"
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
Write-Ok "PEM kalit topildi"

# --- 1. Lokal: git va build ----------------------------------------------------
Set-Location $RepoPath
Write-Step "Branch'ga o'tish: $Branch"
$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $Branch) {
    git checkout $Branch 2>&1 | Out-String | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Branch yo'q, yaratilyapti..."
        git checkout -b $Branch 2>&1 | Out-String | Write-Host
        if ($LASTEXITCODE -ne 0) { Write-Fail "Branch yaratib bo'lmadi"; Read-Host; exit 1 }
    }
}
Write-Ok "Branch: $Branch"

Write-Step "TypeScript build (npm run build)..."
npm run build 2>&1 | Tee-Object -Variable buildOutput | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Build muvaffaqiyatsiz! Yuqoridagi xatolarni Claude'ga yuboring."
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
Write-Ok "Build muvaffaqiyatli"

# --- 2. Git commit + push ------------------------------------------------------
Write-Step "O'zgarishlarni stage qilish..."
git add -A 2>&1 | Out-Null
$status = git status --short 2>&1 | Out-String
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Warn "O'zgarishlar yo'q (yoki barchasi commit qilingan), o'tib ketamiz..."
} else {
    Write-Host $status
    Write-Step "Commit..."
    git commit -m $CommitMsg 2>&1 | Out-String | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Commit muvaffaqiyatsiz (ehtimol o'zgarishlar yo'q), davom etamiz..."
    } else {
        Write-Ok "Commit yaratildi"
    }
}

Write-Step "GitHub'ga push..."
git push origin $Branch 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Push muvaffaqiyatsiz! Internet yoki kirish ruxsatini tekshiring."
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
Write-Ok "Push muvaffaqiyatli"

# --- 3. Serverda deploy --------------------------------------------------------
Write-Step "Serverga ulanish: $ServerUser@$ServerIp"

# PEM permission tuzatish (Windows ACL — odatda kerak emas, lekin xavfsiz qiladi)
icacls $PemKey /inheritance:r 2>&1 | Out-Null
icacls $PemKey /grant:r "$($env:USERNAME):(R)" 2>&1 | Out-Null

# Deploy script'ni serverda run qilamiz
$remoteScript = @"
set -e
echo '--- Server: repo papkani topish ---'
REPO=''
for path in $ServerRepoPath /home/ubuntu/escro /home/ubuntu/Escro /home/ubuntu/escrow /var/www/escro /opt/escro ~/escro ~/Escro; do
  if [ -d "`$path/.git" ]; then REPO=`$path; break; fi
done
if [ -z "`$REPO" ]; then
  echo "REPO TOPILMADI! Quyidagi yo'llar tekshirildi:"
  echo "  /home/ubuntu/escro, /home/ubuntu/Escro, /home/ubuntu/escrow, /var/www/escro, /opt/escro"
  echo "Topilgan papkalar:"
  ls -la /home/ubuntu/ 2>/dev/null | head -30
  exit 1
fi
echo "Repo: `$REPO"
cd `$REPO

echo '--- git fetch + checkout + pull ---'
git fetch --all
git checkout $Branch
git pull origin $Branch

echo '--- npm install (yangi dep yo'q lekin xavfsiz) ---'
npm install --no-audit --no-fund

echo '--- TypeScript build ---'
npm run build

echo '--- pm2 process nomini topish ---'
PM2_NAME='$Pm2Process'
if ! pm2 list 2>/dev/null | grep -q "`$PM2_NAME"; then
  PM2_NAME=`$(pm2 list 2>/dev/null | grep -E 'online|stopped' | awk '{print `$2}' | head -1)
fi
echo "PM2 process: `$PM2_NAME"

if [ -n "`$PM2_NAME" ]; then
  pm2 restart `$PM2_NAME --update-env
  pm2 save
else
  echo 'pm2 process topilmadi, ishga tushiramiz...'
  pm2 start dist/main.js --name escro
  pm2 save
fi

echo '--- Holatni tekshirish ---'
pm2 list
echo '--- Oxirgi log satrlari ---'
pm2 logs --lines 20 --nostream 2>/dev/null || true

echo ''
echo 'DEPLOY MUVAFFAQIYATLI!'
"@

$remoteScript | ssh -i $PemKey -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$ServerUser@$ServerIp" 'bash -s'

if ($LASTEXITCODE -ne 0) {
    Write-Fail "Server deploy'i muvaffaqiyatsiz! Yuqoridagi xatolarni Claude'ga yuboring."
    Read-Host "Yopish uchun Enter bosing"
    exit 1
}
Write-Ok "Server deploy muvaffaqiyatli"

# --- 4. Smoke test -------------------------------------------------------------
Write-Step "Smoke test: API jonli ekanligini tekshirish..."

$apiBase = "https://aws-dev.escro.uz/api"
try {
    $response = Invoke-WebRequest -Uri "$apiBase/docs" -Method GET -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Ok "Swagger UI ochildi: $apiBase/docs"
    } else {
        Write-Warn "Swagger javob berdi, lekin status: $($response.StatusCode)"
    }
} catch {
    Write-Warn "API javob bermadi: $_"
}

# Webhook signature mismatch testi (401 kutilmoqda — bu yaxshi belgi)
try {
    $body = '{"transactionId":"smoke_test","state":"held"}'
    $response = Invoke-WebRequest -Uri "$apiBase/payment/paylov/callback" `
        -Method POST -Body $body -ContentType "application/json" `
        -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    Write-Warn "Webhook 200 qaytardi (signature tekshiruvi o'chiq bo'lishi mumkin)"
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 401) {
        Write-Ok "Webhook signature tekshiruvi ishlamoqda (401 javob to'g'ri)"
    } else {
        Write-Warn "Webhook test javobi: $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  TUGADI! Paylov integratsiyasi server'da yangilandi." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Keyingi qadam: aws-dev.escro.uz/api/docs sahifasini brauzerda oching" -ForegroundColor Cyan
Write-Host ""
Read-Host "Yopish uchun Enter bosing"
