# مشروع وكيل ماسة — ملفات التخطيط والمخططات

هذه حزمة ملفات التخطيط الكاملة لبناء وكيل مبيعات ذكي لصفحة عبايات Masa Fashion على فيسبوك (Meta Messenger Platform / Graph API + Mastra + Claude API + Next.js + PostgreSQL).

## أدلّة التشغيل (runbooks)

- **messenger-setup.md** — دليل المشغّل لربط الـ Backend بصفحة فيسبوك عبر Meta Messenger Platform (Graph API v25.0): إنشاء تطبيق Meta، إعداد الـ webhook الموقّع، توكن الصفحة، اشتراك الحقول، ونسب إعلانات Click-to-Messenger.
- **handoff-design.md** — تصميم التحكم بالمحادثة والتحويل لإنسان (نموذج حالة `ai_state` داخل الـ Backend).


## الخطط (plans/)

- **custom-ai-agent-deep-plan.md** — التخطيط العميق للوكيل: نمط الأدوات (Tool Use)، الستاك، البحث البصري عن المنتجات، الذاكرة، سياق الإعلان، وخريطة الحالات الشاذة الكاملة (١٩ حالة).
- **mastra-build-plan.md** — خطة البناء على Mastra بمنطق local-first: الحزم، بنية المشروع، كود Mastra الدقيق، الاختبار عبر الـ Playground، والمراحل.
- **backend-frontend-plan.md** — خطة طبقة التحكم: مخطط قاعدة البيانات (Drizzle/Postgres)، طبقات الـ backend، شاشات لوحة التحكم، وعقد القراءة مع الوكيل.

## المخططات (diagrams/)

- **masa-ai-agent-workflow.mermaid** — سير العمل العام (Meta Messenger Platform ↔ Backend ↔ Claude).
- **01-local-architecture.mermaid** — معمارية المرحلة المحلية (Claude API هو الخارجي الوحيد).
- **02-mastra-agent-composition.mermaid** — تركيب وكيل Mastra (Agent + Memory + Tools + Model).
- **03-message-flow.mermaid** — مسار معالجة الرسالة لحظياً.
- **04-catalog-indexing.mermaid** — خط فهرسة الكتالوج (استخراج صفات بالرؤية).
- **05-build-roadmap.mermaid** — خريطة مراحل البناء.
- **06-database-erd.mermaid** — مخطط ERD لطبقة التحكم.
- **07-control-plane.mermaid** — من يكتب (أنت) ومن يقرأ (الوكيل).
- **08-admin-screens.mermaid** — خريطة شاشات لوحة التحكم.
- **database-tables.mermaid** — جداول القاعدة بكامل الأعمدة (نص أسود على خلفية بيضاء).
- **database-full-erd.mermaid** — ERD كامل يوصّل كل الجداول (مع جداول الوقت الفعلي).
- **system-workflow.mermaid** — سير العمل مع تحديد القراءة/الكتابة لكل جدول.

> لعرض ملفات .mermaid: الصقها في https://mermaid.live أو افتحها في أي محرّر يدعم Mermaid.

## المهام (tasks/)

- **masa-linear-tasks.csv** — ٣٣ مهمة جاهزة للاستيراد في Linear، مقسّمة عبر التسميات (Backend / Frontend / AI Agent)، بعناوين وأوصاف إنجليزية واضحة.
