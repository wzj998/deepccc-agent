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
- `DEEPSEEK_EFFORT`

也可以创建 `~/.deepccc/config.json`：

```json
{
  "apiKey": "sk-...",
  "baseURL": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-pro",
  "effort": "",
  "rawStreamLogs": {
    "enabled": false,
    "maxBytesPerTurn": 1048576,
    "retentionDays": 7,
    "keepCompleted": false
  }
}
```

## 隐私替换

`deepccc` 支持在展示层（终端输出 / JSONL 流式输出）把敏感信息替换为掩码值，防止用户名、路径等隐私内容出现在终端或管道输出里。创建 `~/.deepccc/privacy.json` 即可启用：

```json
{
  "enabled": true,
  "rules": {
    "weizhangjian": "wzj"
  }
}
```

- `rules` 的键按字面量替换（`split`/`join`，非正则），可配置多条规则；不配置 `enabled`/`rules` 字段时，扁平写法 `{ "weizhangjian": "wzj" }` 也兼容（等效 `enabled: true`）。
- 替换作用于模型回复文本、工具调用参数与结果、错误消息中的字符串字段；持久化上下文仍保存原文，替换仅影响展示层。
- 文件变更后自动热加载，无需重启进程。

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

设置推理强度（reasoning effort）：

```bash
deepccc --effort high
```

可选值：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（留空则不传 `reasoning_effort` 请求字段）。

## 终端过程区块

交互模式下，每轮回复渲染为固定"过程区块"：状态行（生成中/完成/已停止/异常结束）+ 折叠工具行 + 原地更新正文，不滚屏刷 JSON。生成中有心跳点号动画；完成/停止/异常后区块定型留在屏幕上。

如果终端渲染出现异常，可以强制回退为纯文本流式输出：

```bash
deepccc --plain
```

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

## Codex-style Skills 支持

`deepccc` 会扫描以下目录，把本机的 Codex 目录式 skill（`<name>/SKILL.md`，含 `name` + `description` frontmatter）索引注入系统提示词；模型在任务匹配时先用 `read_file` 读取 `SKILL.md` 全文再执行：

- `~/.codex/skills`
- `~/.agents/skills`
- `<cwd>/.codex/skills`（项目级，优先级最高）

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
