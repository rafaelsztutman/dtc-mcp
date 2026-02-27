# Contributing to dtc-mcp

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/rafaelsztutman/dtc-mcp.git
cd dtc-mcp
npm install
cp .env.example .env    # Fill in your API credentials
npm run build
npm test
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build && npm test` — all tests must pass
4. Submit a pull request

## Project Structure

```
src/
  platforms/
    klaviyo/       # Klaviyo API client, tools, transforms
    shopify/       # Shopify API client, tools, transforms
  cross-platform/  # Tools that combine Klaviyo + Shopify data
  shared/          # Cache, pagination, error handling, types
```

## Key Conventions

- **Context optimization** — never return raw API responses. All data goes through transform functions in `transforms.ts` that strip unnecessary fields and pre-aggregate metrics.
- **Tool descriptions** — keep them terse, under 30 words.
- **Response size** — summary tools target ~500 tokens, detail tools ~800 tokens.
- **Logging** — use `console.error` (stderr), never `console.log` (stdout is the MCP transport).
- **Error messages** — return actionable messages with specific env var names, never raw error objects.
- **Tests** — add tests for new transform functions in `tests/transforms.test.ts` using mock data.

## Adding a New Tool

1. Add the API call to the platform's `client.ts`
2. Add a transform function in `transforms.ts`
3. Add type definitions in `src/shared/types.ts`
4. Register the tool in `tools.ts` using `server.tool(name, description, zodShape, handler)`
5. Add tests with mock data

## What We're Looking For

- New analytics tools for Klaviyo or Shopify
- Support for additional e-commerce platforms
- Performance improvements
- Better error handling and edge cases
- Documentation improvements

## Questions?

Open an issue — we're happy to help you get started.
