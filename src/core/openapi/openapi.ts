import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FastifyApiReferenceOptions } from '@scalar/fastify-api-reference';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * Name of the Bearer security scheme declared in the OpenAPI document. Apply it
 * to protected (admin/agent) routes with `@ApiBearerAuth(BEARER_AUTH_NAME)` so
 * Scalar shows them as authenticated and offers the "Authorize" flow.
 */
export const BEARER_AUTH_NAME = 'bearer';

/** Path where the Scalar UI and the raw spec are served. */
export const DOCS_ROUTE = '/docs';

/**
 * Content-Security-Policy scoped to the docs routes only. The Scalar page serves
 * its bundle from the same origin (`${DOCS_ROUTE}/js/scalar.js`) but bootstraps
 * with an inline <script> and injects inline styles, which Helmet's strict
 * default policy (`script-src 'self'`) would otherwise block, leaving a blank
 * page. The bundle uses no `eval`, so `'unsafe-eval'` is not required. The JSON
 * API keeps Helmet's strict CSP untouched.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
].join('; ');

/**
 * Build the OpenAPI document from the Nest controllers/DTOs and serve it through
 * Scalar at `${DOCS_ROUTE}` (interactive UI), with the raw spec exposed at
 * `${DOCS_ROUTE}/openapi.json` and `${DOCS_ROUTE}/openapi.yaml`.
 *
 * Request/response schemas come straight from the project's Zod / drizzle-zod
 * definitions via nestjs-zod (`createZodDto`), so the docs stay in sync with the
 * code with no duplicate schema to maintain. `cleanupOpenApiDoc` post-processes
 * the zod-generated parts into a clean OpenAPI document.
 *
 * Must run after `NestFactory.create` (controllers are registered) and before
 * `app.listen` (Fastify plugins register before the server is ready).
 */
export async function setupOpenApi(app: NestFastifyApplication): Promise<void> {
  const config = new DocumentBuilder()
    .setTitle('Masa Fashion AI Agent API')
    .setDescription(
      [
        "Backend REST API for the Masa Fashion (women's clothing brand) AI sales agent.",
        '',
        'The database is the single source of truth: control-plane data',
        '(products, knowledge, agent behavior) is written by the admin panel,',
        'while runtime data (conversations, orders) is written by the agent.',
        'Customer/agent read paths only ever return **published** records.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Bearer token for admin/agent-protected routes. Customer-facing read routes are public.',
      },
      BEARER_AUTH_NAME,
    )
    .addTag(
      'Products',
      'Customer/agent catalog search and lookup (published only).',
    )
    .addTag('Orders', 'Cash-on-delivery order drafts captured by the agent.')
    .addTag(
      'Conversations',
      'Customer conversation threads and their messages.',
    )
    .addTag('Knowledge', 'Brand knowledge-base entries the agent can cite.')
    .addTag('Agent', 'AI agent runtime, persona configuration, and tools.')
    .addTag('Admin', 'Admin-only management endpoints (require Bearer auth).')
    .addTag('Auth', 'Admin account signup, login, and current-user lookup.')
    .addTag('Health', 'Service liveness and database-connectivity probes.')
    .build();

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));

  // @scalar/fastify-api-reference is ESM-only; the app compiles to CommonJS, so
  // it must be pulled in with a dynamic import (a static import would become a
  // `require()` of an ES module and fail at runtime).
  const { default: apiReference } =
    await import('@scalar/fastify-api-reference');

  const options: FastifyApiReferenceOptions = {
    routePrefix: DOCS_ROUTE,
    hooks: {
      // Relax CSP for the docs routes only (runs after Helmet's global hook).
      // Sync done-callback form so the hook returns void (no floating promise).
      onRequest: (
        _request: FastifyRequest,
        reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ) => {
        reply.header('content-security-policy', DOCS_CSP);
        done();
      },
    },
    configuration: {
      title: 'Masa Fashion AI Agent API',
      pageTitle: 'Masa Fashion AI Agent API',
      content: document,
    },
  };

  await app.register(apiReference, options);
}
