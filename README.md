# deepccc

`deepccc` 是一个轻量级本地编程 Agent，针对 DeepSeek 使用体验做了优化，同时支持其他 OpenAI-compatible 模型接口。

它提供交互式命令行、JSONL 流式输出、本地文件工具、命令执行、项目提示词自动注入和持久化上下文。

## 当前状态

代码已经开源在 GitHub：

https://github.com/wzj998/deepccc-agent

npm 包名规划为 `deepccc`。如果 npm 包已经发布，可以直接全局安装：

```bash
npm install -g deepccc
```

如果还没有发布，可以从源码运行：

```bash
git clone https://github.com/wzj998/deepccc-agent.git
cd deepccc-agent
npm install
npm run build
node bin/deepccc.mjs --help
```

运行要求：

- Node.js >= 20
- DeepSeek 或其他 OpenAI-compatible 模型服务的 API Key

## 配置

最快的方式是使用环境变量：

```bash
export DEEPCCC_API_KEY="sk-..."
export DEEPCCC_BASE_URL="https://api.deepseek.com/v1"
export DEEPCCC_MODEL="deepseek-v4-pro"
```

Windows PowerShell：

```powershell
$env:DEEPCCC_API_KEY="sk-..."
$env:DEEPCCC_BASE_URL="https://api.deepseek.com/v1"
$env:DEEPCCC_MODEL="deepseek-v4-pro"
```

也兼容这些 DeepSeek 别名：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_MODEL`

也可以创建 `~/.deepccc/config.json`：

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

## 命令行交互

在当前目录启动一个交互式 Agent：

```bash
deepccc
```

指定其他模型或 OpenAI-compatible 接口：

```bash
deepccc --base-url https://api.openai.com/v1 --api-key "$OPENAI_API_KEY" --model gpt-4.1
```

指定工作目录：

```bash
deepccc --cwd /path/to/project
```

恢复当前工作目录最近一次会话：

```bash
deepccc --resume
```

设置工具调用步数上限：

```bash
deepccc --max-steps 20
```

默认情况下，`deepccc` 不设置固定步数上限，会让模型自然完成工具循环。

## JSONL 流式输出

JSONL 模式适合脚本、服务端集成或其他上层系统调用：

```bash
deepccc --stream-json --prompt "检查这个仓库并总结测试命令"
```

也可以从 stdin 传入提示词：

```bash
echo "运行测试并解释失败原因" | deepccc --stream-json
```

输出是逐行 JSON：

```jsonl
{"type":"start","session_id":"session-...","mode":"new","cwd":"/repo","model":"deepseek-v4-pro"}
{"type":"text_delta","text":"...","accumulated":"..."}
{"type":"tool_call","id":"call_...","name":"read_file","input":{"path":"package.json"}}
{"type":"tool_result","tool_call_id":"call_...","name":"read_file","content":{},"is_error":false}
{"type":"done","text":"..."}
```

## 在 ChatCCC 中使用

ChatCCC 公有仓库：

https://github.com/wzj998/ChatCCC

在 ChatCCC 会话里可以使用隐藏指令创建 `deepccc` Agent 会话：

```text
/new ccc
```

这种方式适合已经在 ChatCCC 里协作的场景：ChatCCC 负责会话入口和消息通道，`deepccc` 负责本地编程 Agent 能力，包括读取项目提示词、运行命令、编辑文件和输出流式结果。

## 项目提示词自动注入

会话启动时，`deepccc` 会从当前工作目录读取这些文件，如果存在就注入为项目级提示词：

- `AGENTS.md`
- `AGENTS.local.md`
- `CLAUDE.md`
- `CLAUDE.local.md`

这些内容会放在固定系统提示词之后，作为项目指导使用。

## 内置工具

`deepccc` 可以让模型调用这些本地工具：

- 按行读取文件
- 列目录
- 用 ripgrep 搜索代码
- 编辑、创建、删除、移动文件
- 应用 unified diff patch
- 运行非交互式 shell 命令，并返回 stdout、stderr、exitCode 和超时状态

命令返回非零退出码时不会直接被当成工具异常；模型可以读取结构化结果，继续判断下一步。

## License

Apache-2.0
