# agent/tools

Mastra tool definitions (`createTool` + zod input/output schemas) live here —
e.g. `search-products.tool.ts`, `capture-order.tool.ts`, `get-knowledge.tool.ts`.

Rule: a tool's `execute` calls a **domain service** (ProductsService,
OrdersService, …) injected into `AgentService`. Tools never import a repository
or run SQL. This keeps the agent on the same module boundaries as the rest of
the app.
