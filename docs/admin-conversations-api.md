# ربط لوحة الأدمن بواجهة المحادثات (Admin Conversations API)

دليل للفرونت إند (لوحة الأدمن) لربط شاشة المحادثات: العرض، التحكم بالحالة،
**إرسال رسائل الموظف البشري**، و**تصفير المحادثة**. كل العقود هنا مأخوذة من
`ConversationsAdminController` و`ConversationControlService` و`auth.controller`.

> التوثيق التفاعلي (Scalar) متاح أثناء التشغيل على `GET /docs` (المواصفات على
> `GET /docs/openapi.json`) — استعمله كمرجع حيّ مكمّل لهذا الملف.

---

## نظرة عامة

- **Base URL:** `http://localhost:3000` للتطوير (المنفذ من `PORT`، الافتراضي `3000`).
  **لا يوجد global prefix** — المسارات تبدأ من الجذر مباشرةً (`/admin/...`, `/auth/...`).
- **المصادقة:** كل مسارات `/admin/*` محمية بـ **JWT (Bearer)** + دور **`admin` أو `editor`**.
- **CORS:** مفعّل. في غير الإنتاج أي أصل `localhost`/`127.0.0.1` مسموح (Vite على 5173/5174…
  يعمل بلا إعداد). في الإنتاج اضبط `CORS_ORIGINS` (مفصولة بفواصل). التوكن يُرسَل في
  ترويسة `Authorization` (وليس ككوكي).
- **التحقق:** الأجسام تُتحقّق بـ Zod `.strict()` — أي مفتاح غير معروف يُرفض بـ `400`.

---

## 1) المصادقة (الحصول على التوكن)

```http
POST /auth/login
Content-Type: application/json

{ "email": "admin@masafashion.com", "password": "••••••••" }
```

الردّ `200`:

```json
{
  "accessToken": "eyJhbGciOi...",
  "user": { "id": "uuid", "email": "admin@masafashion.com", "name": "Admin", "role": "admin" }
}
```

ثم أرفق التوكن مع كل طلب أدمن:

```
Authorization: Bearer <accessToken>
```

أخطاء: `401` بيانات دخول خاطئة.

---

## 2) نموذج حالة المحادثة `ai_state` (اقرأه أولًا — يحكم كل شيء)

لكل محادثة عمود `ai_state` بثلاث قيم، وهو **مصدر الحقيقة** لمن يردّ على الزبون:

| الحالة | المعنى | هل يردّ الـAI؟ | هل يقدر الموظف يرسل رسائل؟ |
|--------|--------|----------------|-----------------------------|
| `bot` | الوكيل الذكي يردّ تلقائيًا | نعم | **لا** (لازم تخرجها من `bot` أولًا) |
| `human` | محوّلة لموظف بشري | لا (صامت) | **نعم** |
| `paused` | موقوفة مؤقتًا (بمدّة أو دائم) | لا (صامت) | **نعم** |

الانتقالات:
- `pause` / `handoff` / `assign` (بقيمة غير null) → تُخرج المحادثة من `bot`.
- `resume` → ترجعها `bot` (وتمسح الإيقاف).
- التصفير (`reset`) **لا يغيّر** `ai_state`.

> القاعدة العملية للفرونت إند: زرّ «إرسال رسالة» في شاشة الموظف يكون **مفعّلًا فقط
> عندما `ai_state !== 'bot'`**. إن كانت `bot`، اعرض زرّ «استلام المحادثة» (handoff) أولًا.

---

## 3) قائمة المحادثات

```http
GET /admin/conversations?state=human&assignedTo=agent@x.com&q=2539&limit=50&offset=0&orderBy=desc
Authorization: Bearer <token>
```

كل المعاملات اختيارية: `state` (`bot|human|paused`)، `assignedTo`، `q` (بحث بالـpsid)،
`limit` (موجب)، `offset` (≥0)، `orderBy` (`asc|desc`).

الردّ `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "customer": "25396291006657774",
      "aiState": "human",
      "assignedTo": "agent@x.com",
      "handoffReason": "Customer wants custom size",
      "lastMessagePreview": "تمام بستنى التوصيل",
      "lastMessageAt": "2026-06-24T12:01:00.000Z",
      "unreadCount": 0,
      "escalated": true
    }
  ],
  "total": 1, "limit": 50, "offset": 0
}
```

ملاحظات: `customer` هو معرّف الزبون (PSID). `escalated` = هناك `handoffReason`.
`unreadCount` دائمًا `0` حاليًا (تتبّع غير المقروء مؤجَّل).

---

## 4) محادثة واحدة + رسائلها

```http
GET /admin/conversations/:id
Authorization: Bearer <token>
```

الردّ `200` (التواريخ ISO strings):

```json
{
  "conversation": {
    "id": "uuid", "psid": "2539...", "aiState": "human",
    "assignedTo": "agent@x.com", "handoffReason": "…", "humanSummary": null,
    "pausedUntil": null, "createdAt": "2026-06-20T09:00:00.000Z"
  },
  "messages": [
    { "id": "uuid", "role": "customer", "content": "بدي عباية", "imageUrl": null, "createdAt": "…" },
    { "id": "uuid", "role": "agent", "content": "هلا والله 🖤", "imageUrl": null, "createdAt": "…" },
    { "id": "uuid", "role": "human", "content": "معك خدمة العملاء", "imageUrl": null, "createdAt": "…" }
  ]
}
```

`role` ∈ `customer | agent | human` (الزبونة / الوكيل الذكي / الموظف البشري).
أخطاء: `404` لا توجد محادثة بهذا المعرّف.

---

## 5) التحكم بالحالة (pause / resume / handoff / assign)

كلها تُعيد سجلّ المحادثة المحدَّث (`200`). `:id` لازم يكون UUID صالح وإلا `400`.

### استلام المحادثة (تحويل لموظف) — `handoff`
```http
POST /admin/conversations/:id/handoff
Authorization: Bearer <token>
Content-Type: application/json

{ "reason": "Customer wants custom size" }      // reason اختياري
```
يضبط `ai_state=human` ويُسكت الـAI. **هذا ما تستدعيه قبل أن يبدأ الموظف بالردّ.**

### إيقاف مؤقّت — `pause`
```http
POST /admin/conversations/:id/pause
{ "reason": "Customer upset", "durationMinutes": 60 }   // كلاهما اختياري؛ durationMinutes ≤ 1440
```
`ai_state=paused`. مع `durationMinutes` يرجع الـAI تلقائيًا بعد المدّة؛ بدونها الإيقاف دائم حتى `resume`.

### استئناف — `resume`
```http
POST /admin/conversations/:id/resume
{ "summary": "Customer agreed to size 2" }      // summary اختياري
```
`ai_state=bot`. الـ`summary` (إن وُجد) يُحقَن مرّة واحدة في سياق الوكيل في الدور التالي ليكمل بوعي.

### الإسناد — `assign`
```http
PATCH /admin/conversations/:id/assignment
{ "assignedTo": "agent@masafashion.com" }       // string → يضبط human؛ null → يُلغي الإسناد فقط
```

---

## 6) ★ إرسال رسالة من الموظف البشري (إجابة سؤالك)

> **النقطة المطلوبة:** `POST /admin/conversations/:id/messages`

```http
POST /admin/conversations/:id/messages
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: 0b1c...   // اختياري لكن موصى به (انظر أدناه)

{ "text": "طلبك جاهز، بنوصّلك بكرا 🖤" }
```

الردّ `201`:

```json
{
  "message": {
    "id": "uuid", "conversationId": "uuid", "role": "human",
    "content": "طلبك جاهز، بنوصّلك بكرا 🖤", "imageUrl": null,
    "externalId": "0b1c...", "createdAt": "2026-06-24T12:05:00.000Z"
  },
  "delivered": true
}
```

**الشروط والسلوك (مهم للفرونت):**

1. **البوابة:** يجب أن تكون `ai_state !== 'bot'`. إذا كانت `bot` ترجع **`400`** برسالة
   «Cannot send a human message while the AI is active…». الحل: استدعِ `/handoff` (أو `/pause`)
   أولًا، ثم أرسل.
2. **`delivered`:** يُحفظ صفّ الرسالة دائمًا (حتى لو فشل الإرسال).
   - `true` = أُرسلت للزبون عبر Messenger.
   - `false` = إمّا فشل إرسال Messenger (تُحفظ محليًا وتقدر تعيد المحاولة)، أو كانت **تكرارًا**
     (idempotent no-op) فأرجعت الرسالة الموجودة دون إعادة إرسال.
3. **Idempotency:** مرّر ترويسة `Idempotency-Key` فريدة لكل رسالة يكتبها الموظف (مثلًا UUID
   تولّده عند الضغط على «إرسال»). تكرار نفس المفتاح لا يُعيد الإرسال — يحميك من النقر المزدوج
   وإعادة المحاولة الشبكية. بدون المفتاح يُحسب مفتاح من (المحادثة + النص + نافذة 60 ثانية).
4. **نافذة Messenger:** تُرسَل بوسم `HUMAN_AGENT` الذي يسمح بالردّ خارج نافذة الـ24 ساعة
   حتى **7 أيام** من آخر رسالة للزبون. بعدها قد يرفض Messenger الإرسال (`delivered=false`).

**التدفّق الكامل في الفرونت إند:**

```text
1. الموظف يفتح محادثة aiState='bot'
2. يضغط «استلام المحادثة»  → POST /:id/handoff        (تصبح human)
3. يكتب ويرسل              → POST /:id/messages         (يتكرر لكل رسالة)
4. عند الانتهاء «إرجاع للـAI» → POST /:id/resume         (تعود bot)
```

مثال `fetch`:

```ts
async function sendHumanMessage(id: string, text: string, token: string) {
  const res = await fetch(`${BASE_URL}/admin/conversations/${id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await res.json();          // غالبًا 400 (الحالة bot) أو 404
  return res.json() as Promise<{ message: { id: string; content: string }; delivered: boolean }>;
}
```

---

## 7) تصفير المحادثة (الميزة الجديدة) — `reset`

```http
POST /admin/conversations/:id/reset
Authorization: Bearer <token>
```

لا يحتاج جسمًا. الردّ `200`:

```json
{ "id": "uuid", "deletedMessages": 42 }
```

**تصفير كامل (لا رجعة فيه):** يمسح ذاكرة الوكيل العاملة (الاسم/المقاس/الألوان) + سجل
رسائل الوكيل الداخلي + سياق المحادثة، **ويحذف نهائيًا** كل رسائل المحادثة (فتظهر فارغة).
يبقى صفّ المحادثة و`ai_state` والإسناد وسجل التدقيق.

> **في الفرونت:** اطلب تأكيدًا صريحًا قبل الاستدعاء («سيُحذف سجل المحادثة نهائيًا»).
> بعد النجاح أعد تحميل الـthread (سيكون فارغًا).

---

## 8) الأخطاء (مغلّف موحَّد)

كل الأخطاء تمرّ عبر فلتر موحَّد وتُعاد بهذا الشكل:

```json
{
  "timestamp": "2026-06-24T12:05:00.000Z",
  "path": "/admin/conversations/<id>/messages",
  "error": { "statusCode": 400, "message": "Cannot send a human message while the AI is active…", "error": "Bad Request" }
}
```

اقرأ الرسالة من `body.error.message` (عندما يكون `error` كائنًا). الرموز المتوقّعة:

| الرمز | المتى |
|------|-------|
| `400` | جسم غير صالح (Zod)، `:id` ليس UUID، أو إرسال رسالة بشرية والحالة `bot` |
| `401` | توكن مفقود/غير صالح |
| `403` | دور غير كافٍ (ليس `admin`/`editor`) |
| `404` | لا توجد محادثة بهذا المعرّف |

---

## 9) عميل TypeScript مختصر جاهز

```ts
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra };
}

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: authHeaders(token, init.headers as Record<string, string>) });
  if (!res.ok) throw await res.json();
  return res.json() as Promise<T>;
}

export const ConversationsApi = {
  list: (t: string, q = '') => api(`/admin/conversations${q}`, t),
  thread: (t: string, id: string) => api(`/admin/conversations/${id}`, t),

  handoff: (t: string, id: string, reason?: string) =>
    api(`/admin/conversations/${id}/handoff`, t, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
  pause: (t: string, id: string, body: { reason?: string; durationMinutes?: number } = {}) =>
    api(`/admin/conversations/${id}/pause`, t, { method: 'POST', body: JSON.stringify(body) }),
  resume: (t: string, id: string, summary?: string) =>
    api(`/admin/conversations/${id}/resume`, t, { method: 'POST', body: JSON.stringify(summary ? { summary } : {}) }),
  assign: (t: string, id: string, assignedTo: string | null) =>
    api(`/admin/conversations/${id}/assignment`, t, { method: 'PATCH', body: JSON.stringify({ assignedTo }) }),

  sendMessage: (t: string, id: string, text: string) =>
    api<{ message: { id: string; content: string }; delivered: boolean }>(
      `/admin/conversations/${id}/messages`, t,
      { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ text }) },
    ),

  reset: (t: string, id: string) =>
    api<{ id: string; deletedMessages: number }>(`/admin/conversations/${id}/reset`, t, { method: 'POST' }),
};
```

---

### مرجع سريع للمسارات

| الإجراء | المسار | الجسم | الردّ |
|--------|--------|-------|------|
| تسجيل دخول | `POST /auth/login` | `{ email, password }` | `{ accessToken, user }` |
| قائمة | `GET /admin/conversations` | — (query) | `{ items, total, limit, offset }` |
| محادثة + رسائل | `GET /admin/conversations/:id` | — | `{ conversation, messages }` |
| استلام (تحويل) | `POST /admin/conversations/:id/handoff` | `{ reason? }` | المحادثة |
| إيقاف | `POST /admin/conversations/:id/pause` | `{ reason?, durationMinutes? }` | المحادثة |
| استئناف | `POST /admin/conversations/:id/resume` | `{ summary? }` | المحادثة |
| إسناد | `PATCH /admin/conversations/:id/assignment` | `{ assignedTo: string\|null }` | المحادثة |
| **إرسال رسالة موظف** | `POST /admin/conversations/:id/messages` | `{ text }` (+ `Idempotency-Key`) | `{ message, delivered }` |
| **تصفير** | `POST /admin/conversations/:id/reset` | — | `{ id, deletedMessages }` |
