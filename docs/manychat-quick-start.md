# ربط ManyChat بالـ Backend — دليل سريع

> ملخّص عملي لطريقة ربط ManyChat بسيرفر وكيل Masa Fashion (تطوير محلي).
> الدليل الكامل (شكل ردّ Dynamic Block، نافذة الـ 24 ساعة في Send API،
> قائمة ما قبل الإنتاج): [`manychat-setup.md`](./manychat-setup.md).

---

## ما الذي يجعل الـ Backend عامًّا (public)؟

السيرفر يعمل محليًا على `http://localhost:3000`، وManyChat يحتاج رابط **HTTPS عام**
ليصل إليه. الحل في التطوير هو **Cloudflare Tunnel (`cloudflared`)**، وهو مُجهّز
كسكربت جاهز في `package.json`:

```bash
bun run tunnel        # = cloudflared tunnel --url http://localhost:3000
```

يطبع رابطًا مثل `https://abc123.trycloudflare.com` — **مؤقّت ويتغيّر كل مرة** تشغّل
النفق، فهو للتطوير فقط.

> ⚠️ `cloudflared` ليس مثبّتًا افتراضيًا. للتثبيت على WSL/Linux:
> ```bash
> curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
> sudo dpkg -i /tmp/cloudflared.deb
> ```

> **للإنتاج:** استخدم دومينًا ثابتًا (HTTPS) بدل النفق، وضعه في `PUBLIC_BASE_URL`.

---

## الخطوات (تطوير)

1. **شغّل السيرفر:** `bun run start:dev` (على `:3000`).
2. **شغّل النفق** (ترمنال ثانٍ): `bun run tunnel` → انسخ رابط HTTPS.
3. **حدّث `.env`:** `PUBLIC_BASE_URL=https://abc123.trycloudflare.com` ثم **أعد تشغيل** السيرفر.
4. **أنشئ بلوك External Request في ManyChat** (التفاصيل أدناه).
5. **أضف fallback block** في ManyChat (رسالة اعتذار) تحسّبًا لتعطّل النفق/السيرفر.

---

## إعداد بلوك External Request في ManyChat

| الحقل | القيمة |
|---|---|
| Method | `POST` |
| URL | `{PUBLIC_BASE_URL}/webhook/manychat/async` (موصى به) أو `/webhook/manychat` |
| Header | `x-manychat-secret` = قيمة `WEBHOOK_SHARED_SECRET` |
| Body | نوعه `JSON` (القالب أدناه) |

**قالب الـ Body (JSON):**

```json
{
  "contactId": "‹System Field: Contact Id›",
  "text": "‹System Field: Last Text Input›",
  "lastImageUrl": "‹Custom Field: masa_last_image_url›",
  "adRef": "‹Custom Field: masa_ad_ref›",
  "name": "‹System Field: Full Name›",
  "channel": "messenger"
}
```

> ⚠️ أدرج كل قيمة بين `‹ ›` من **زر اختيار الحقول** داخل ManyChat — **لا تكتبها حرفيًّا**.
> القيمة `channel` وحدها نص ثابت (`"messenger"` أو `"whatsapp"`).

**خريطة الحقول** (اسم الحقل عندنا ← مصدره في ManyChat):

| حقلنا | مصدره في ManyChat | إلزامي؟ |
|---|---|---|
| `contactId` | **System Field → Contact Id** (معرّف المشترك، ثابت) | ✅ |
| `text` | **System Field → Last Text Input** (نص رسالة الزبون) | ✅ |
| `lastImageUrl` | **Custom Field تُنشئه أنت** — لا يوجد حقل نظام للصورة (القسم أدناه) | ⬜ |
| `adRef` | **Custom Field تُنشئه أنت** — لا يوجد `{{ref}}` جاهز (القسم أدناه) | ⬜ |
| `name` | **System Field → Full Name** (اسم فيسبوك) | ⬜ |
| `channel` | نص ثابت في الـ flow (`messenger` افتراضيًّا) | ⬜ |
| `messageId` | (اختياري) معرّف رسالة إن وفّره الـ flow — مفتاح idempotency | ⬜ |

> 🔑 الحقول الثلاثة الموجودة في قائمتك (Contact Id / Last Text Input / Full Name) هي
> **System Fields** جاهزة. أما `lastImageUrl` و `adRef` فلا وجود لهما كحقول نظام —
> لذلك لا تجدهما في الـ picker، ويجب أن **تُنشئهما يدويًّا** (الخطوات التالية).

---

## إنشاء الحقلين `lastImageUrl` و `adRef` (مهم)

ManyChat لا يوفّر merge field جاهزًا لا لآخر صورة ولا لـ ref الإعلان. الحل المعتمد:
**Custom User Field من نوع Text تُعبّئه أنت**، ثم تربطه في الـ body.

### أ. حقل آخر صورة — `masa_last_image_url`

لا يوجد `{{last_image_url}}` (هي feature request مفتوح في مجتمع ManyChat). الطريقة:

1. **Settings → Custom Fields → New Field** → النوع **Text** → الاسم `masa_last_image_url`.
2. في الـ flow أضف خطوة **User Input** تطلب من الزبونة إرسال الصورة، واحفظ الرد في
   `masa_last_image_url`. **حيلة مهمة:** اضبط نوع الالتقاط على **Text** (لا "Image") —
   عندها يخزّن ManyChat **رابط** الصورة كنص داخل الحقل.
3. اربط `lastImageUrl` بهذا الحقل في الـ body (كما في القالب أعلاه).

- **بدون صورة:** يبقى الحقل فارغًا فيرسل ManyChat `""`. الـ backend **يحوّل `""` تلقائيًّا
  إلى "بدون صورة"** (تقوية في الـ DTO)، فالرسائل النصية لا تنكسر — يمكنك ترك الحقل
  في الـ body دائمًا بأمان.
- **تنبيه:** روابط صور ManyChat **مؤقّتة (~أسبوع)**؛ لا مشكلة عندنا لأن الـ backend يجلب
  الصورة ويعيد رفعها (R2) أثناء المحادثة نفسها.

### ب. حقل ref الإعلان — `masa_ad_ref`

لا يوجد `{{ref}}` جاهز؛ التقط الـ ref حسب نقطة الدخول:

1. **Settings → Custom Fields → New Field** → النوع **Text** → الاسم `masa_ad_ref`.
2. **رابط m.me:** Growth Tools → **Messenger Ref URL** → تبويب **Setup**: عبّئ
   **Custom Ref Parameter** (مثلًا `masa-promo`)، وفعّل **Save payload to a Custom User
   Field** ثم اختر `masa_ad_ref`. (تقدر تمرّر داتا إضافية بعد `--`: `?ref=masa-promo--src123`.)
3. **إعلان Click-to-Messenger:** استخدم **Facebook Ads trigger** بنفس المبدأ —
   احفظ الـ payload في `masa_ad_ref`.
4. اربط `adRef` بهذا الحقل في الـ body.

> كلا الحقلين **اختياريان** في الـ backend — الوكيل يعمل بدونهما؛ هما تحسينان
> (بحث بالصورة + نسب الإعلان)، لا شرط للتشغيل الأساسي.

> المسار ثابت بلا أي prefix — نقطة الاستقبال هي `/webhook/manychat` حرفيًّا.

---

## أي مسار تختار: sync أم async؟

| | `sync` `/webhook/manychat` | `async` `/webhook/manychat/async` (موصى به) |
|---|---|---|
| الرد | يرجع مباشرة في استجابة HTTP كـ Dynamic Block | يرجع `202` فورًا، ثم يُسلَّم عبر Send API |
| يحتاج `MANYCHAT_API_TOKEN`؟ | ❌ لا | ✅ نعم (وإلا لن يصل الرد للزبون) |
| مهلة ManyChat (10 ثوانٍ) | قد تتجاوزها مع الصور/الاستعلامات البطيئة | يتجنّبها تمامًا |
| إعداد ManyChat | اضبط نوع الردّ على **Dynamic Block** | أضف خطوة **Send Message** بعد الـ External Request |

> 💡 لأسرع اختبار الآن **بدون توكن**، استخدم `sync` — الرد يرجع داخل استجابة HTTP مباشرة.

---

## مفاتيح `.env` المطلوبة

| المفتاح | لماذا | كيف تحصل عليه |
|---|---|---|
| `PUBLIC_BASE_URL` | رابط النفق (dev) أو الدومين (prod) | من مخرجات `bun run tunnel` |
| `WEBHOOK_SHARED_SECRET` | يصادق الطلبات الواردة عبر هيدر `x-manychat-secret` | `openssl rand -hex 24` — وضع **نفس القيمة** في هيدر ManyChat |
| `MANYCHAT_API_TOKEN` | لتسليم ردود مسار `async` عبر Send API | ManyChat → Settings → API → Create API Key |

**سلوك `WEBHOOK_SHARED_SECRET`:**
- **dev** (`NODE_ENV != production`): إذا كان فارغًا، الحارس يسجّل تحذيرًا واحدًا **ويسمح** بالمرور (لتسهيل التطوير).
- **prod**: إذا كان فارغًا، **كل** طلب webhook يُرفض بـ `401` (fail closed).

---

## تحقّق محلي قبل لمس ManyChat

تأكّد أن نقطة الـ webhook ترد، بدون ManyChat أصلًا:

```bash
curl -X POST http://localhost:3000/webhook/manychat \
  -H 'content-type: application/json' \
  -d '{"contactId":"test-1","text":"مرحبا، بدي عباية سوداء","channel":"messenger"}'
```

مسار `sync` **لا يرجع 5xx أبدًا**: يرجع Dynamic Block صالحًا، أو رسالة عربية
احتياطية إن فشل الـ agent داخليًا — فهو اختبار ممتاز لصحّة التوصيل.
