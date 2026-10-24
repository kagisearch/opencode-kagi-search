# opencode-kagi-search

Kagi Search and Extract tools for OpenCode

## Requirements

Set `KAGI_API_KEY` in your shell before starting OpenCode.

## Install

### OpenCode

Install the package:

```bash
npm install -g opencode-kagi-search
```

Add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-kagi-search"]
}
```

Local checkout:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-kagi-search"]
}
```

## Websearch provider

The plugin registers Kagi as an OpenCode websearch provider, so the built-in `websearch` tool can route queries through Kagi alongside the bundled providers.

Select it globally with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-kagi-search"],
  "websearch": { "provider": "kagi" }
}
```

Or ask the plugin to set it as the default provider itself (useful when you want Kagi everywhere without extra config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-kagi-search", "options": { "defaultProvider": true } }
  ]
}
```

If `KAGI_API_KEY` is not set, the plugin still loads; Kagi calls return a descriptive error until the key is provided.

## Tools

### `kagi_search`
- Calls `POST https://kagi.com/api/v1/search`
- Input: full passthrough search request object (requires `query`)
- Returns: normalized JSON envelope with `ok`, `data` or `error`, and `meta`

### `kagi_extract`
- Calls `POST https://kagi.com/api/v1/extract`
- Input: full passthrough extract request object (requires `pages`, max 10)
- Returns: normalized JSON envelope with `ok`, `data` or `error`, and `meta`

## Error Model

Non-2xx responses are normalized as:

```json
{
  "ok": false,
  "error": {
    "status": 429,
    "tool": "kagi_search",
    "endpoint": "/search",
    "retriable": true,
    "message": "Kagi API request failed with status 429",
    "body": { "error": "..." }
  },
  "meta": {
    "ok": false,
    "duration_ms": 123,
    "retries_used": 1
  }
}
```

Retry applies to `429` and `5xx` only.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Publish

Make sure you are logged in to npm first:

```bash
npm whoami
```

Build and verify the package locally:

```bash
npm install
npm run typecheck
npm run build
```

Bump the version you want to release:

```bash
npm version patch
```

Publish to npm:

```bash
npm publish
```
