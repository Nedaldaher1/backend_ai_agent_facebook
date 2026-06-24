# خطة بناء الوكيل على Mastra — مرحلة Local-First

خطة تنفيذية كاملة لبناء وكيل مبيعات Masa Fashion باستخدام **Mastra** كدماغ للـ Backend. مبدأ المرحلة الحالية: **كل شيء يعمل محلياً (localhost) إلا الذكاء الاصطناعي عبر Claude API**. نبني العقل ونختبره محلياً أولاً، وربط Meta Messenger Platform (Graph API) — webhook موقّع للداخل و Send API للخارج — يُضاف في النهاية.

> ميزة Mastra الحاسمة لهذه المرحلة: التخزين قابل للتبديل — تبدأ بـ Postgres/LibSQL محلي، ونفس الكود يتحوّل لـ Postgres سحابي في الإنتاج بتغيير سطر واحد.

---

## 1. مبدأ Local-First

| المكوّن | في المرحلة الحالية | لاحقاً (الإنتاج) |
|---|---|---|
| تطبيق Next.js + Mastra | localhost | منصة استضافة |
| قاعدة البيانات | **PostgreSQL محلي** (عبر Docker) | Postgres سحابي (نفس الكود) |
| الصور | ملفات محلية (عيّنات اختبار) | R2 / Cloudinary |
| واجهة الاختبار | **Mastra Playground** (`mastra dev`) | Meta Messenger فعلي |
| الذكاء الاصطناعي | **Claude API** ← الخدمة الخارجية الوحيدة | كما هي |
| Meta Messenger Platform | غير مربوط بعد؛ لاختبار المسار الحقيقي محلياً تستخدم **نفقاً** (cloudflared/ngrok) لأن webhook الـ Graph API يحتاج HTTPS عاماً | مربوط مباشرة بعد النشر |

---

## 2. الحزم (Packages)

```bash
# جوهر Mastra
@mastra/core        # Agent, createTool, Mastra
@mastra/memory      # Memory (الذاكرة)
@mastra/pg          # PostgresStore (أو @mastra/libsql للبدء بلا خادم)

# مزوّد النموذج (Mastra يستخدم Vercel AI SDK تحته)
@ai-sdk/anthropic   # Claude
zod                 # مخططات الأدوات

# التطبيق
next                # الـ API route + لوحة التحكم
```

---

## 3. بنية المشروع

```
masa-agent/
├── docker-compose.yml          # Postgres محلي
├── .env                        # ANTHROPIC_API_KEY, DATABASE_URL
└── src/
    ├── mastra/
    │   ├── index.ts            # تهيئة Mastra + التخزين
    │   ├── agents/
    │   │   └── sales-agent.ts  # الوكيل: instructions + model(Claude) + tools + memory
    │   └── tools/
    │       ├── search-products.ts
    │       ├── check-availability.ts
    │       ├── get-product-media.ts
    │       ├── escalate-to-human.ts
    │       └── capture-order.ts
    ├── lib/
    │   ├── vision.ts           # استخراج صفات صورة الزبون عبر Claude
    │   ├── catalog-index.ts     # خط فهرسة الكتالوج (سكربت محلي)
    │   ├── color-map.ts         # تقنين الألوان (نبيتي/عنابي → أحمر)
    │   └── db.ts                # وصول Postgres للكتالوج
    └── app/
        ├── webhook/messenger/route.ts  # webhook موقّع لـ Meta Messenger Platform (يُضاف بالنهاية)
        └── admin/                  # لوحة التحكم (المعلومات + أسلوب الرد)
```

---

## 4. القطع الأساسية في Mastra

### أ. تهيئة Mastra + التخزين المحلي

```ts
// src/mastra/index.ts
import { Mastra } from '@mastra/core'
import { PostgresStore } from '@mastra/pg'
import { salesAgent } from './agents/sales-agent'

export const mastra = new Mastra({
  agents: { salesAgent },
  // محلي الآن، نفس الكود يصير سحابياً بتغيير DATABASE_URL فقط
  storage: new PostgresStore({ connectionString: process.env.DATABASE_URL! }),
})
```

> بديل أخف بلا خادم: `import { LibSQLStore } from '@mastra/libsql'` ثم `new LibSQLStore({ url: 'file:./mastra.db' })`.

### ب. الوكيل

```ts
// src/mastra/agents/sales-agent.ts
import { Agent } from '@mastra/core/agent'
import { anthropic } from '@ai-sdk/anthropic'
import { Memory } from '@mastra/memory'
import { searchProducts, checkAvailability, getProductMedia,
         escalateToHuman, captureOrder } from '../tools'

export const salesAgent = new Agent({
  name: 'masa-sales-agent',
  instructions: `
    أنتِ مساعدة مبيعات لبراند عبايات "ماسة" في الأردن. تحدّثي باللهجة الأردنية بلطف.
    القواعد الصارمة:
    - الأسعار والتوفّر فقط من نتائج الأدوات، لا تخترعي أي رقم.
    - لو ما عندك معلومة → "بتحقق وبرجعلك" أو حوّلي لإنسان، لا تخمّني.
    - لا خصومات غير مصرّح بها.
    - عند نية الطلب: اجمعي البيانات ثم capture_order، لا تؤكّدي طلباً لا تقدري تنفّذيه.
  `,
  model: anthropic('claude-sonnet-4-6'),   // Sonnet للمحادثة، Haiku للاستخراج (أرخص)
  tools: { searchProducts, checkAvailability, getProductMedia, escalateToHuman, captureOrder },
  memory: new Memory(),   // يرث التخزين من Mastra instance
})
```

### ج. أداة (مثال — البحث بالصفات)

```ts
// src/mastra/tools/search-products.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db } from '../../lib/db'

export const searchProducts = createTool({
  id: 'search_products',
  description: 'ابحث في كتالوج العبايات بالصفات: اللون المُقنّن، النوع، السعر الأقصى، المقاس، المناسبة.',
  inputSchema: z.object({
    color: z.string().optional(),      // عائلة لون مُقنّنة: أحمر/أسود/كحلي…
    maxPrice: z.number().optional(),
    size: z.string().optional(),
    occasion: z.string().optional(),
    freeText: z.string().optional(),
  }),
  execute: async ({ context }) => db.searchProducts(context),
})
```

كل أداة = استعلام/فعل عندك. وصْفها الدقيق لـ Claude هو ما يحدّد جودة قراراته.

### د. الذاكرة (تحميل السياق)

Mastra يعزل الذاكرة بمعرّفين: **`resourceId`** للزبون (الـ PSID من Meta — `event.sender.id`) و**`threadId`** لجلسة المحادثة. تمرّرهما عند كل نداء، وMastra يحمّل التاريخ ويضغطه تلقائياً (Observational Memory):

```ts
const res = await salesAgent.generate(userText, {
  memory: { resource: psid, thread: threadId },
})
```

هذا بالضبط ما يحلّ "تحميل سياق المحادثة" بدون كود يدوي. (لاسترجاع دلالي semantic recall تضيف قاعدة متجهات لاحقاً — اختياري.)

### هـ. الرؤية (صورة الزبون)

```ts
// src/lib/vision.ts  — يأخذ صورة → Claude → صفات مُهيكلة
// يُمرَّر الناتج للوكيل كسياق، فيقرّر استدعاء search_products بهذه الصفات
```

ملاحظة: لتخزين الصور كمرفقات في الذاكرة، استخدم **input processor** لرفعها لتخزين خارجي واستبدالها برابط قبل الحفظ (في المرحلة المحلية تكفي ملفات محلية للاختبار).

---

## 5. خط فهرسة الكتالوج (مرة واحدة + عند كل منتج جديد)

`src/lib/catalog-index.ts` سكربت محلي: لكل منتج → Claude vision على صورته → صفات مُهيكلة → تقنين اللون → تخزين في Postgres.

```bash
npm run index-catalog   # شغّله على بضعة منتجات أولاً للتحقق
```

الصفات المخزّنة: `color_family` + `color_shade`، `sleeve_type`، `fabric`، `embellishment`، `occasion`، `length`، `price`، `available_sizes`، `stock_status`، `image_urls[]`، `tags[]`. خريطة مرادفات الألوان في `color-map.ts` قابلة للتعديل من لوحة التحكم.

---

## 6. الاختبار محلياً (بدون Meta Messenger)

```bash
mastra dev   # يفتح Mastra Playground المحلي
```

في الـ Playground: تحادثين الوكيل، ترفعين صورة، وتشوفين **استدعاءات الأدوات والـ traces** مباشرة — أفضل بيئة لتطوير العقل قبل أي ربط.

**Evals مدمجة:** عرّفي مجموعة من ٢٠–٣٠ سؤالاً حقيقياً + الحالات الشاذة (تضارب الإعلان، صورة خارج الكتالوج، مفاصلة سعر…) وشغّليها بعد كل تعديل لتمسكي أي تراجع.

---

## 7. webhook الـ Meta Messenger Platform (يُضاف في النهاية)

```ts
// src/app/webhook/messenger/route.ts
// 0) GET: تحقّق Meta (echo hub.challenge) ؛ POST: تحقّق توقيع X-Hub-Signature-256 ثم ACK 200
// 1) يستقبل الحدث → يستخرج { psid (sender.id), text, image_url, referral (ref/ad_id) }
// 2) (إن وُجدت صورة) vision → صفات
// 3) salesAgent.generate(text, { memory: { resource: psid, thread } })
// 4) يصيغ الرد (نص + معرض generic-template cards)
// 5) يرسله عبر Graph Send API: POST /{PAGE_ID}/messages (Bearer Page token)
```

لاختباره محلياً من غير نشر: `cloudflared tunnel` يعطيك HTTPS عاماً مؤقتاً يشير لـ localhost، تضعينه كـ Callback URL في لوحة Meta. التفاصيل الكاملة في [`messenger-setup.md`](../messenger-setup.md).

---

## 8. مراحل البناء (Roadmap)

- **Phase 0 — إعداد محلي:** Next.js + Mastra + Postgres عبر Docker + `.env` فيه `ANTHROPIC_API_KEY`.
- **Phase 1 — فهرسة الكتالوج:** استخراج صفات المنتجات بالرؤية؛ جرّبيها على بضعة منتجات.
- **Phase 2 — الوكيل + `search_products`:** اختبري "كل العبايات الحمراء" في الـ Playground.
- **Phase 3 — الذاكرة:** `resourceId/threadId`؛ اختبري تماسك السياق عبر رسائل متتابعة.
- **Phase 4 — الرؤية + بقية الأدوات:** توفّر/معرض/تصعيد/طلب + الحالات الشاذة + الحواجز.
- **Phase 5 — webhook موقّع لـ Meta Messenger Platform:** + اختبار E2E عبر نفق.
- **Phase 6 (لاحقاً) — النشر:** Postgres سحابي + تخزين صور خارجي + Redis/debounce.

---

## 9. خارج هذه المرحلة

لا نشر سحابي، لا تخزين صور خارجي، لا Redis/debounce بعد — كلها Phase 6. ركّزي الآن على دماغ الوكيل محلياً، واستغلي الـ Playground والـ Evals لإنضاجه قبل أي ربط خارجي.
