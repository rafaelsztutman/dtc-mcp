# dtc-mcp Project Conventions

## Build & Test
```bash
npm run build    # Compile TypeScript to dist/
npm test         # Run vitest tests
npm run dev      # Watch mode for development
npm run inspect  # Open MCP Inspector for interactive testing
```

## Architecture
- Platform-specific code: `src/platforms/{platform}/`
  - `client.ts` — API client (auth, rate limiting, pagination, caching)
  - `tools.ts` — MCP tool definitions + handlers
  - `transforms.ts` — Response transformation (context optimization)
- Cross-platform tools: `src/cross-platform/`
- Shared utilities: `src/shared/`
- All API responses go through transform functions before returning

## Tech Stack
- MCP SDK v1 (`@modelcontextprotocol/sdk ^1.27.0`)
- Tool registration: `server.tool(name, description, rawZodShape, handler)`
- Zod v3 (`^3.23.8`) — raw shapes, NOT wrapped in z.object()
- Shopify: GraphQL Admin API (NOT REST)
- Shopify Auth: Dual-mode — Client Credentials Grant (Dev Dashboard apps, recommended) or static access token (legacy apps)
- Klaviyo: REST API with JSON:API format

## Context Optimization Rules
1. NEVER return raw API responses. Always transform through transforms.ts.
2. Summary tools: target ~500 tokens per response.
3. Detail tools: target ~800 tokens per response.
4. Only include fields a DTC marketer would act on.
5. Pre-aggregate server-side. Don't make the LLM do math.
6. Tool descriptions: terse, under 30 words.

## Critical: Klaviyo Rate Limits
- Standard endpoints (campaigns, flows, profiles): 10/s burst, 150/m steady
- **Reporting endpoints: 1/s burst, 2/m steady, 225/d** — cache aggressively!
- Reporting cache TTL: 10 minutes
- Conversion metric ID: cached for server lifetime

## Error Handling
- Return actionable error messages with specific env var names
- Rate limit errors: include retry-after information
- Shopify not configured: return helpful message mentioning both auth modes (Client Credentials or legacy token)
- Never dump raw error objects

## Logging
- All logging to stderr (`console.error`) — stdout is MCP transport
- Use `log(level, message, data?)` from config.ts

## Testing
- Transform functions must be unit-testable with mock data in `tests/mock-data/`
- Test edge cases: empty results, zero recipients (div/0), null fields, single item
