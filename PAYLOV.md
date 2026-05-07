# Paylov integratsiya — runbook

Bu hujjat Paylov to'lov tizimi bilan bizning integratsiyamizni tushuntiradi:
qaysi endpoint qachon chaqiriladi, nima bir martalik, nima doimiy ishlaydi va
production'ga o'tishda nima qilish kerak.

Manba: <https://developer.paylov.uz/uz/subscribe/authorization>.

---

## 0. Tezkor xulosa

| Bosqich | Chastota | Qachon | Kim chaqiradi |
|---------|----------|--------|---------------|
| Onboarding | **bir martalik** | Paylov hisobini ochish | qo'lda + 2 ta API chaqiruv |
| Merchant configuration | **bir martalik** | onboarding'dan keyin | qo'lda Paylov support'ga |
| OAuth2 password grant | **bir martalik** + qayta tiklashda | server start, refresh muvaffaqiyatsiz bo'lsa | backend (`fetchToken`) |
| OAuth2 refresh grant | **har 1 soatda** | access_token muddati tugashi yaqin | backend (`fetchToken`) |
| Card create | har bir karta uchun | mijoz karta qo'shganda | `POST /api/payment/cards/create` |
| Card confirm | har bir karta uchun | mijoz OTP kiritganda | `POST /api/payment/cards/confirm` |
| Hold create | har bir shartnoma uchun | mijoz pulni bloklaganida | `POST /api/payment/escrow/hold` |
| Hold charge | shartnoma yakunlanganda | admin tasdiqlaganda | `POST /api/payment/escrow/fulfill` |
| Hold dismiss | shartnoma bekor bo'lganda | admin bekor qilganda | `POST /api/payment/escrow/cancel` |
| A2C payout | ijrochiga to'lov | charge'dan keyin | `POST /api/payment/escrow/payout` |
| Webhook | har bir Paylov state o'zgarishida | doimiy | Paylov → bizga POST |

---

## 1. Onboarding (BIR MARTALIK — endi kerak emas)

Onboarding — Paylov merchant hisobini birinchi marta yaratish jarayoni. Bu
flow allaqachon o'tkazilgan, faqat hisob aktivasiyasi kutilmoqda.

### Bosqich 1.1 — Onboarding token tekshirish

```http
GET {PAYLOV_BASE_URL}/merchant/onboarding/?token=<ONBOARDING_TOKEN>
```

`ONBOARDING_TOKEN` — Paylov support yuboradigan bir martalik token.

Muvaffaqiyat: `200 {"status":"ok"}`

### Bosqich 1.2 — Username + password o'rnatish

```http
POST {PAYLOV_BASE_URL}/merchant/onboarding/?token=<ONBOARDING_TOKEN>
Content-Type: application/json

{"username": "escro_api", "password": "<8+ belgili kuchli parol>"}
```

Javob:

```json
{
  "consumer_key": "app_...",
  "consumer_secret": "...",
  "username": "escro_api"
}
```

> **Diqqat:** `consumer_secret` faqat **bir marta** ko'rsatiladi. Shu yerda
> saqlamasangiz, butun onboarding'ni qaytadan boshlashga to'g'ri keladi.

Bu bosqichni `D:\Escro_Project\backend\PAYLOV-ONBOARD.bat` skripti
avtomatlashtirgan — natija `PAYLOV-CREDENTIALS-<vaqt>.json` faylga yoziladi.

### Parol talablari (Section 2 docs)

- Kamida 8 belgi
- Kichik harf (a-z) + katta harf (A-Z) + raqam (0-9) + maxsus belgi (`!@#$%^&*`)

---

## 2. Merchant configuration (BIR MARTALIK — qo'lda)

Onboarding API'dan tashqari Paylov support'ga **qo'lda** quyidagilarni
yuborasiz (Telegram `@paylov_uz1` yoki email):

| Element | Bizning qiymat |
|---------|----------------|
| Tashkilot nomi | _Paylov support'ga taqdim eting_ |
| Merchant nomi | _Paylov support'ga taqdim eting_ |
| Merchant kategoriyasi | "Online Services" (16 turdan biri) |
| Logo | PNG formatda, transparent fon |
| Min summa | 500 so'm |
| Max summa | 100,000,000 so'm |
| Callback URL | `https://aws-dev.escro.uz/api/payment/paylov/callback` |
| Callback Auth username | `PAYLOV_CALLBACK_USERNAME` (.env) |
| Callback Auth password | `PAYLOV_CALLBACK_PASSWORD` (.env) |

Paylov xodimlari bularni tekshirib, hisobni "active" holatiga o'tkazadi.
Shundan **keyin** OAuth2 token ishlay boshlaydi (hozirgi `invalid_grant`
xatosi shu sababli).

---

## 3. OAuth2 token (DOIMIY — avtomatik)

### Bizning kod nima qiladi

`payment.service.ts` ichida har bir Paylov chaqiruvidan oldin Axios
interceptor `getAccessToken()` ni chaqiradi:

1. **Xotira keshini tekshiradi** — agar tirik token bo'lsa, qaytaradi
2. **Redis'dan tiklaydi** (server restart'dan keyin)
3. **`PAYLOV_REFRESH_TOKEN` env'dan bootstrap** (agar qiymat berilgan bo'lsa)
4. **Refresh grant** ishlatadi (refresh_token mavjud va 7 kun ichida)
5. Yetib bormagan bo'lsa **password grant** (consumer_key/secret + username/password)

Token Paylov javobi:

```json
{
  "access_token": "...",   // 1 soat (3600s)
  "refresh_token": "...",  // 7 kun (604800s)
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_expires_in": 604800
}
```

Saqlanadigan joy: Redis kalit `paylov:token`, TTL = `refresh_expires_in`.

### .env kerakli kalitlar

```
PAYLOV_BASE_URL=https://dev.gw.paylov.uz   # production: https://gw.paylov.uz
PAYLOV_CONSUMER_KEY=app_...
PAYLOV_CONSUMER_SECRET=...
PAYLOV_USERNAME=escro_api
PAYLOV_PASSWORD=<onboarding'da o'rnatilgan parol>
PAYLOV_MERCHANT_ID=<UUID>                  # serviceId sifatida ishlatiladi
PAYLOV_REFRESH_TOKEN=<ixtiyoriy bootstrap>  # Paylov bersa, dastlabki tikla
PAYLOV_CALLBACK_USERNAME=<webhook Basic>
PAYLOV_CALLBACK_PASSWORD=<webhook Basic>
PAYLOV_MODE=live                            # ma'lumot uchun
```

### Endpoint

```http
POST {PAYLOV_BASE_URL}/merchant/oauth2/token/
Authorization: Basic base64(consumer_key:consumer_secret)
Content-Type: application/json

# Birinchi marta:
{"grant_type": "password", "username": "...", "password": "..."}

# Keyingi 7 kun davomida:
{"grant_type": "refresh_token", "refresh_token": "..."}
```

### Lifecycle

```
[Server start]
       │
       ▼
[Redis'da token bormi?] ── ha ──▶ [In-memory cache]
       │ yo'q                              │
       ▼                                   │
[PAYLOV_REFRESH_TOKEN env bormi?] ── ha ──▶│
       │ yo'q                              │
       ▼                                   │
[password grant] ─────────────▶ [Yangi token + Redis'ga yoz]
                                           │
                                           ▼
[har 1 soat] ─────▶ [refresh grant] ─▶ [Token rotation, Redis yangilanadi]
                                           │
                                           ▼
[7 kun keyin] ────▶ [refresh muvaffaqiyatsiz] ─▶ [password grant]
```

**Ahamiyatli**: `pm2 restart escrow-api` — Redis'dagi token saqlanib qoladi,
qayta password grant qilish shart emas.

---

## 4. Karta endpoint'lari (DOIMIY)

### 4.1 Karta qo'shish — `POST /api/payment/cards/create`

Frontend → bizning backend → Paylov.

**Bizning kod**: `payment.service.ts → createCard()`

**Paylov chaqiruv**:

```http
POST {PAYLOV_BASE_URL}/merchant/userCard/createUserCard/
Authorization: Bearer <access_token>

{
  "userId": "<bizning user id>",
  "cardNumber": "9860000000000000",
  "expireDate": "YYMM",        // ← MUHIM: docs YYMM talab qiladi
  "phoneNumber": "+998XXXXXXXXX",
  "serviceId": "<PAYLOV_MERCHANT_ID>"
}
```

Javob:

```json
{
  "result": {
    "cid": "<cardId>",
    "otpSentPhone": "********0000"
  }
}
```

`cid`'ni saqlaymiz va `confirm` bosqichida ishlatamiz.

### 4.2 Karta tasdiqlash — `POST /api/payment/cards/confirm`

Mijoz SMS'dan kelgan OTP'ni kiritadi.

```http
POST {PAYLOV_BASE_URL}/merchant/userCard/confirmUserCardCreate/
Authorization: Bearer <access_token>

{
  "cardId": "<cid>",
  "otp": "<sms kod>",
  "cardName": "Mening kartam",   // ixtiyoriy
  "pinfl": "..."                  // ixtiyoriy, JSHSHIR (14 raqam)
}
```

Javob: karta to'liq ma'lumotlari (vendor, balance, owner). Biz uni
`cards` jadvaliga yozamiz.

### 4.3 Karta o'chirish — `DELETE /api/payment/cards/:cardId`

```http
DELETE {PAYLOV_BASE_URL}/merchant/userCard/deleteUserCard/?userCardId=<cardId>
Authorization: Bearer <access_token>
```

Muvaffaqiyat: `{"result": true}`. Biz local DB'dan ham o'chiramiz.

### 4.4 Mening kartalarim — `GET /api/payment/cards/my`

**Lokal DB'dan** o'qiymiz (Paylov'ga so'rov yo'q). Kartalar `confirm`
bosqichida saqlangan. Tezroq va Paylov rate-limit'iga taqalmaydi.

### 4.5 Karta tafsilotlari — `GET /api/payment/cards/:cardId/status`

Real-time balance va status uchun Paylov'dan oladi:

```http
GET {PAYLOV_BASE_URL}/merchant/userCard/getCard/<cardId>/
Authorization: Bearer <access_token>
```

> **Eslatma**: `balance` _tiyin_'da qaytadi (1 so'm = 100 tiyin).

---

## 5. Escrow flow — Hold / Charge / Dismiss / Payout

Bu Escro biznes-mantig'ining markazi. Hold = pul bloklash, Charge = pulni
yechib olish, Dismiss = blokni bekor qilish, Payout = ijrochiga jo'natish.

### 5.1 Hold create — `POST /api/payment/escrow/hold`

Mijoz xaridor sifatida kontraktga pul ajratganda. Pul **yechilmaydi**, balki
**bloklanadi** (max 28 kun).

```http
POST {PAYLOV_BASE_URL}/payment/hold/create/
Authorization: Bearer <access_token>

{
  "userId": "<xaridor id>",
  "cardId": "<cardId>",
  "amount": 100000,             // tiyin'da
  "account": {},
  "time": 40320,                 // daqiqa: 28 kun
  "externalId": "escro_hold_contract_<id>",
  "serviceId": "<PAYLOV_MERCHANT_ID>"
}
```

Javob: `{"result": {"transactionId": "<uuid>"}}`. Biz uni `transactions`
jadvaliga `HELD` status bilan yozamiz.

> `externalId` — biz tomondan generatsiya qilingan idempotency kalit.
> Bir xil `externalId` bilan qayta jo'natsangiz, eski tranzaksiya
> qaytariladi (Paylov idempotent).

### 5.2 Hold charge — `POST /api/payment/escrow/fulfill` (admin)

Shartnoma muvaffaqiyatli yakunlanganda — bloklangan pulni yechib olamiz.

```http
POST {PAYLOV_BASE_URL}/payment/hold/charge/
Authorization: Bearer <access_token>

{"transactionId": "<hold tx id>", "amount": 100000}
```

Pul bizning escrow hisobimizga keladi. Status → `CHARGED`.

### 5.3 Hold dismiss — `POST /api/payment/escrow/cancel` (admin)

Shartnoma bekor bo'lganda — blokni bo'shatamiz, pul mijozga qaytadi.

```http
POST {PAYLOV_BASE_URL}/payment/hold/dismiss/
Authorization: Bearer <access_token>

{"transactionId": "<hold tx id>"}
```

Status → `DISMISSED`.

### 5.4 A2C payout — `POST /api/payment/escrow/payout` (admin)

Ijrochining kartasiga to'lov.

```http
POST {PAYLOV_BASE_URL}/merchant/a2c/performTransaction
Authorization: Bearer <access_token>

{
  "amountInTiyin": 100000,
  "userId": "<ijrochi id>",
  "cardId": "<ijrochi karta id>",
  "externalId": "escro_payout_contract_<id>",
  "serviceId": "<PAYLOV_MERCHANT_ID>"
}
```

### 5.5 Status check — `GET /api/payment/transactions/:id/status`

Hold uchun: `GET /merchant/payment/hold/status/?externalId=<id>`
A2C uchun: `GET /merchant/a2c/checkTransaction/byExternalId/<extId>/`

Bu reconciliation uchun (cron orqali ishonchsiz tranzaksiyalarni tekshirish).

### Escrow lifecycle

```
[hold create]──▶ HELD
                  │
       ┌──────────┼──────────┐
       ▼                     ▼
   [fulfill]              [cancel]
       │                     │
       ▼                     ▼
   CHARGED               DISMISSED
       │
       ▼
   [payout to executor card]
       │
       ▼
   PAID_OUT
```

---

## 6. Webhook (Paylov → bizga)

Paylov tranzaksiya state o'zgarganda bizga POST yuboradi.

```http
POST https://aws-dev.escro.uz/api/payment/paylov/callback
Authorization: Basic base64(<PAYLOV_CALLBACK_USERNAME>:<PAYLOV_CALLBACK_PASSWORD>)
```

Bizning kod (`payment.controller.ts → paylovCallback`):
1. Basic Auth tekshiradi (`timingSafeEqual` bilan)
2. Body'ni `handlePaylovCallback`'ga uzatadi
3. `transactions` jadvalida tegishli tranzaksiyani topib status'ni yangilaydi

> **Konfiguratsiya**: webhook URL'i va Basic Auth credentials Paylov merchant
> kabinetiga yoki support orqali bir martalik kiritiladi (4-bo'limga qarang).

---

## 7. Production'ga o'tish

### 7.1 .env o'zgarishi

```diff
- PAYLOV_BASE_URL=https://dev.gw.paylov.uz
+ PAYLOV_BASE_URL=https://gw.paylov.uz
- PAYLOV_MODE=live-test
+ PAYLOV_MODE=live
```

### 7.2 Yangi credentials

Sandbox va production credentials **alohida**. Production uchun yangi
onboarding token oling va `PAYLOV-ONBOARD.bat` skriptini production
URL'i bilan qaytadan ishga tushiring (skript ichidagi `$BASE`'ni o'zgartiring).

### 7.3 Webhook URL

Sandbox: `https://aws-dev.escro.uz/api/payment/paylov/callback`
Production: `https://<sizning prod domain>/api/payment/paylov/callback`

Yangi callback URL'ini Paylov support'ga jo'nating va aktivlashtirishni so'rang.

### 7.4 Token migratsiyasi

Sandbox token Redis keshida turibdi — production'ga o'tishda eski tokenni
o'chiring:

```
ssh ubuntu@<prod-host>
redis-cli DEL paylov:token
pm2 restart escrow-api
```

### 7.5 Rate limit & monitoring

- Paylov rate limit'lari hujjatlanmagan, lekin amaliyotda qattiq emas.
- Backend log'da `[PaymentService] Paylov token olindi` xabari har 1 soatda
  ko'rinishi normal.
- `[PaymentErrorHandler] Paylov API Error: ...` ko'rinsa darhol tekshiring.

---

## 8. Hozirgi muammo (2026-05-08 holatiga)

OAuth2 password grant `invalid_grant: Invalid credentials or this account
not activated` qaytarmoqda. Bu **bizning kod muammosi emas**:

- Bevosita curl bilan ham (sandbox va production'da) bir xil javob keladi
- Basic Auth qabul qilinmoqda (aks holda `invalid_client` kelar edi)
- RFC 6749 bo'yicha `invalid_grant` resource owner credentials yoki
  account holati bilan bog'liq

**Sabab**: 2-bo'limdagi merchant configuration to'liq yakunlanmagan, Paylov
xodimlari hisobni "active" holatiga o'tkazmagan.

**Yechim**: Paylov support'ga 2-bo'limdagi ma'lumotlarni jo'nating va
aktivlashtirishni so'rang. Aktivlashtirilgandan keyin bizning kod
hech qanday o'zgarishsiz ishlaydi.

---

## 9. Tezkor diagnostika komandalari

Server'da OAuth2'ni qo'lda sinash:

```bash
ssh ubuntu@16.170.64.168
cd /home/ubuntu/escrow
set -a; source .env; set +a
B64=$(printf '%s' "$PAYLOV_CONSUMER_KEY:$PAYLOV_CONSUMER_SECRET" | base64 -w0)
curl -sS -X POST "$PAYLOV_BASE_URL/merchant/oauth2/token/" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"password\",\"username\":\"$PAYLOV_USERNAME\",\"password\":\"$PAYLOV_PASSWORD\"}"
```

Redis'dagi joriy tokenni ko'rish:

```bash
redis-cli GET paylov:token
```

Backend log:

```bash
pm2 logs escrow-api --lines 100
```

---

**Hujjat oxirgi yangilangan**: 2026-05-08
**Tegishli kod**: `src/payment/payment.service.ts`, `src/payment/payment.controller.ts`
