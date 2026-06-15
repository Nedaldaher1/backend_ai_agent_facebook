# core/logger

Logging is currently handled by Fastify's built-in pino logger, enabled in
`main.ts` via `new FastifyAdapter({ logger: true })`.

When a custom Nest `LoggerService` (request-id correlation, structured fields,
log levels per environment) is needed, add it here as a `LoggerModule` and pass
it to `app.useLogger(...)` in `main.ts`.
