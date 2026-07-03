# deepccc

`deepccc` is a lightweight local coding agent optimized for DeepSeek and compatible with other OpenAI-compatible model APIs.

It provides an interactive terminal agent, JSONL streaming mode for integrations, local file tools, command execution, project instruction injection, and persistent context.

## Install

```bash
npm install -g deepccc
```

Requirements:

- Node.js >= 20
- An API key for DeepSeek or another OpenAI-compatible model provider

## Configuration

The fastest setup is environment variables:

```bash
export DEEPCCC_API_KEY="sk-..."
export DEEPCCC_BASE_URL="https://api.deepseek.com/v1"
export DEEPCCC_MODEL="deepseek-v4-pro"
```

Windows PowerShell:

```powershell
$env:DEEPCCC_API_KEY="sk-..."
$env:DEEPCCC_BASE_URL="https://api.deepseek.com/v1"
$env:DEEPCCC_MODEL="deepseek-v4-pro"
```

`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL` are also accepted as aliases.

You can also create `~/.deepccc/config.json`:

```json
{
  "apiKey": "sk-...",
  "baseURL": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-pro",
  "rawStreamLogs": {
    "enabled": false,
    "maxBytesPerTurn": 1048576,
    "retentionDays": 7,
    "keepCompleted": false
  }
}
```

## Interactive CLI

Start an interactive session in the current directory:

```bash
deepccc
```

Use a different model or OpenAI-compatible endpoint:

```bash
deepccc --base-url https://api.openai.com/v1 --api-key "$OPENAI_API_KEY" --model gpt-4.1
```

Set the working directory:

```bash
deepccc --cwd /path/to/project
```

Resume the latest session for the working directory:

```bash
deepccc --resume
```

Set a tool-step limit when you want a hard cap:

```bash
deepccc --max-steps 20
```

By default, deepccc lets the model continue tool loops until the model finishes naturally.

## JSONL Streaming

One-shot JSONL mode is intended for scripts and integrations:

```bash
deepccc --stream-json --prompt "Inspect this repository and summarize the test command."
```

You can also pipe the prompt through stdin:

```bash
echo "Run the tests and explain failures" | deepccc --stream-json
```

Events are emitted as JSON lines:

```jsonl
{"type":"start","session_id":"session-...","mode":"new","cwd":"/repo","model":"deepseek-v4-pro"}
{"type":"text_delta","text":"...","accumulated":"..."}
{"type":"tool_call","id":"call_...","name":"read_file","input":{"path":"package.json"}}
{"type":"tool_result","tool_call_id":"call_...","name":"read_file","content":{},"is_error":false}
{"type":"done","text":"..."}
```

## Project Instructions

When a session starts, deepccc reads these files from the current working directory if present:

- `AGENTS.md`
- `AGENTS.local.md`
- `CLAUDE.md`
- `CLAUDE.local.md`

They are injected as project guidance below the fixed system prompt.

## Tools

deepccc can:

- read files with line ranges
- list directories
- search code with ripgrep
- edit, create, delete, move files
- apply unified diffs
- run non-interactive shell commands with timeout and captured stdout/stderr

Non-zero command exits are returned as structured results so the model can inspect failures and continue.

## License

Apache-2.0
