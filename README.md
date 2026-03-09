# Copilot as Service

Expose GitHub Copilot as an OpenAI-compatible HTTP API server on `localhost:3000`, so external tools (OpenClaw, scripts, etc.) can use Copilot programmatically.

## Features

- 🚀 **OpenAI-compatible API** — drop-in replacement for `api.openai.com/v1`
- 🤖 **Uses your existing Copilot subscription** — no extra API keys
- 🔄 **Streaming support** — real-time token streaming
- 🔒 **Optional auth token** — protect the local API
- 📊 **Status bar indicator** — see server status at a glance

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List available Copilot models |
| POST | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |
| GET | `/health` | Health check |

## Usage

### With OpenClaw

In your OpenClaw config:
```json
{
  "models": {
    "providers": {
      "copilot-proxy": {
        "baseUrl": "http://localhost:3000/v1",
        "apiKey": "n/a",
        "api": "openai-completions",
        "authHeader": false
      }
    }
  }
}
```

### With curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotAsService.port` | `3000` | Server port |
| `copilotAsService.host` | `127.0.0.1` | Bind host |
| `copilotAsService.autoStart` | `true` | Start on VS Code launch |
| `copilotAsService.authToken` | `""` | Bearer token (empty = no auth) |
| `copilotAsService.defaultModel` | `copilot-gpt-4o` | Default model |

## Requirements

- VS Code 1.90+
- GitHub Copilot extension installed and signed in

## Changelog

- See [CHANGELOG.md](./CHANGELOG.md) for release notes.
