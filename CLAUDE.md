# CLAUDE.md — Masa Fashion AI Agent (Backend)

This file guides Claude Code when working in this repository. Read it fully before making any change.

---

## 1. Project goal

We are building the **backend for an AI sales agent** that answers customer messages on the Masa Fashion (abaya brand) Facebook page. The agent must:

- Reply to customers in Jordanian Arabic, in the brand's voice.
- Search the product catalog by attributes (color, size, fabric, occasion) and by customer-sent images.
- Hold conversation context across messages and recognize the ad a customer came from.
- Never invent prices or availability — only state facts retrieved from the database.
- Capture cash-on-delivery (COD) order drafts and hand off to a human when needed.

This repository is the **backend only**. The admin panel (Next.js) and the Facebook integration (Meta Messenger Platform / Graph API) are separate concerns. The backend exposes a REST API and houses the AI agent logic (Mastra). The database is the single source of truth that the agent reads from and the admin panel writes to.

---

## 2. Tech stack

- **Runtime / package manager:** Bun
- **Framework:** NestJS with the **Fastify** adapter (not Express)
- **ORM:** Drizzle ORM
- **Database:** PostgreSQL (local during development, via WSL)
- **AI orchestration:** Mastra, using Google Gemini (3.5 Flash) via OpenRouter
- **Validation:** zod and class-validator
- **Module system:** ESM (`module: nodenext`). Path aliases are rewritten at build time with `tsc-alias` — never assume `tsconfig-paths` works here.

When you need current product or library facts (NestJS, Mastra, Drizzle, Bun, OpenRouter), verify against official docs rather than relying on memory.

---

## 2b. Commands

Package manager is **Bun**, but `package.json` scripts shell out to the Nest CLI / Jest. Run them via Bun:

```bash
bun install                 # install deps
bun run start:dev           # watch-mode dev server (http://0.0.0.0:3000)
bun run start:prod          # run compiled dist/main
bun run build               # nest build → tsc + tsc-alias into dist/
bun run lint                # eslint --fix over {src,apps,libs,test}/**/*.ts
bun run format              # prettier --write

bun run test                # all unit tests (Jest, *.spec.ts under src/)
bun run test:watch          # Jest watch mode
bun run test:cov            # coverage → /coverage
bun run test:e2e            # e2e tests (test/jest-e2e.json, *.e2e-spec.ts)
bun run test path/to/file.spec.ts    # run one Jest spec file
bun run test -- -t "name of test"    # run a single test by name
```

> Testing uses **Jest** (`ts-jest`), not Vitest: specs are `*.spec.ts` under `src/`, e2e specs are `*.e2e-spec.ts` under `test/`.

## 2c. Current repository state

This is a **greenfield NestJS scaffold**, not yet the system section 1 describes. Today `src/` contains only `main.ts`, `app.module.ts`, `app.controller.ts`, `app.service.ts`. None of Drizzle, Mastra, PostgreSQL, the data-access layer, the agent, or any domain tables/modules exist yet — they are to be built. Treat sections 1–3 as the target design, not the present code.

Wiring that *is* in place:
- **Fastify adapter**: `main.ts` bootstraps via `FastifyAdapter` and listens on `0.0.0.0:3000` (the `0.0.0.0` bind matters under WSL).
- **Path alias**: import app code with `@/...` (maps to `src/*`, see `tsconfig.json`). Build-time rewrite is done by `tsc-alias`; `tsconfig-paths` is not relied on at runtime.
- **ESM**: `module`/`moduleResolution` are `nodenext`. (Note: eslint is configured `sourceType: 'commonjs'` — a mismatch to be aware of when reasoning about module behavior.)

## 3. Architecture rules

- The database schema is the contract. Control-plane tables (products, color_synonyms, agent_behavior, knowledge_entries, admin_users) are written by the admin side; the agent reads them. Runtime tables (conversations, messages, orders, order_items) are written by the agent.
- `is_published` is the publish gate: customer-facing and agent read paths must filter `is_published = true`. Admin paths may see drafts.
- Tools read the database through the data-access layer, never via raw SQL strings.
- Money uses `numeric(10,3)` for JOD; never use floating-point math on prices.
- Secrets (DATABASE_URL, OPENROUTER_API_KEY) live in environment variables, never in code.
- Color search normalizes dialect terms through `color_synonyms` (e.g. "نبيتي" → red family).

---

## 4. Specialized sub-agents

This repo defines backend sub-agents in `.claude/agents/`. Delegate to them when appropriate:

- `drizzle-schema-architect` — schema and migrations
- `backend-api-engineer` — data-access layer, controllers, services, validation
- `mastra-agent-engineer` — the agent, tools, memory, vision pipeline
- `backend-code-reviewer` — security and quality review (read-only)
- `backend-tester` — Jest tests

A typical bug-fix chain: implement with the relevant engineer, then run `backend-code-reviewer`, then `backend-tester`.

---

## 5. Git workflow — READ CAREFULLY

Git discipline is mandatory. Follow these rules exactly.

### Branch structure
- `main` — production-ready code only. Never commit directly to `main`.
- `dev` — integration branch. Feature branches merge here first.
- Feature/fix branches — one per Linear issue, branched from `dev`.

### Branch naming (this is what links Git to Linear)
Use the Linear issue ID in the branch name. The workspace team key is the prefix Linear assigns (for example `MAS`). Format:

```
<type>/<issue-id>-<short-description>
```

Examples:
```
feature/MAS-12-search-products-tool
fix/MAS-37-color-normalization-bug
chore/MAS-40-update-drizzle
```

Use `feature/`, `fix/`, `chore/`, `refactor/`, `test/`, or `docs/`. Use lowercase kebab-case for the description, 3–5 words.

### Commit messages
- Use Conventional Commits: `type(scope): summary`, e.g. `fix(catalog): normalize dialect color terms`.
- Keep the summary under ~72 characters; explain the why in the body if needed.
- Reference the Linear issue in the body when relevant: `Refs MAS-37`.

### Permission boundary — IMPORTANT
- You may: create branches, stage, commit, view diffs, view log/status, and merge into `dev` locally.
- You may NOT run `git push` unless I explicitly ask in that message. Never push automatically.
- Never force-push, never rewrite published history, never commit directly to `main`.
- Never commit `.env*`, secrets, or `node_modules`. If you see a secret about to be staged, stop and warn me.

---

## 6. Git ↔ Linear integration (ticket-driven bug fixing)

We link code to Linear issues so that working a ticket updates it automatically. The mechanism is the **issue ID in the branch name** plus **magic words in the PR/commit**.

### Standard flow for fixing a bug from a Linear ticket
When I ask you to fix a Linear issue (e.g. "fix MAS-37"):

1. **Read the ticket** via the Linear MCP: pull the title, description, priority, and labels so you understand the actual problem before touching code.
2. **Create the branch** off `dev`, named with the issue ID:
   ```
   git checkout dev
   git checkout -b fix/MAS-37-color-normalization-bug
   ```
3. **Reproduce, then fix** — find the responsible code, make the minimal correct change. Delegate to the right sub-agent.
4. **Test** — run `backend-tester` (or `bun test`) and confirm the fix; add a regression test.
5. **Commit** with a Conventional Commit and a magic word that links and closes the issue:
   ```
   git commit -m "fix(catalog): normalize dialect color terms

   Fixes MAS-37"
   ```
6. **Update the ticket** via Linear MCP: move it to "In Review" (or "Done" only after merge to `main`), and add a short comment summarizing the fix.
7. **Stop before pushing.** Tell me the branch is ready; I run `git push` and open the PR myself unless I tell you otherwise.

### Linear magic words (link + auto-close)
Include one of these followed by the issue ID in the commit body or PR description to link the issue and auto-close it on merge:

```
close / closes / closed / closing
fix / fixes / fixed / fixing
resolve / resolves / resolved / resolving
complete / completes / completed / completing
```

Example: `Fixes MAS-37` or `Closes MAS-37`.

To link without closing (e.g. partial work), reference the ID without a magic word: `Refs MAS-37` or `Part of MAS-37`.

### State transitions — keep them conservative
- Opening a PR / pushing the branch → issue moves to "In Progress" / "In Review".
- Only a merge to `main` (production) should move an issue to "Done". Do not mark issues "Done" on merges to `dev`.

---

## 7. Linear scope — stay inside our team

When using the Linear MCP, only read and write issues in **our project's team**. Never query, modify, or comment on issues belonging to any other team in the workspace. If a task references another team or an issue ID with a different prefix, stop and ask me first.

Always be explicit about the team when searching ("open bugs in our team"), and never bulk-update issues across the whole workspace.

---

## 8. Working style

- Before fixing, restate your understanding of the problem and your plan in one or two sentences.
- Make the minimal correct change; do not refactor unrelated code in a fix branch.
- After a change, run the tests and report results honestly — never silently force a test to pass.
- Explain your reasoning in Arabic if I write in Arabic; keep code, commits, branch names, and identifiers in English.
- If something is ambiguous or risky (schema change, data loss, anything touching `main` or `push`), stop and ask.
