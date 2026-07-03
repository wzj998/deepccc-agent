import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isLoopFinished, stepCountIs, streamText, type TextStreamPart } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config as appConfig, RAW_STREAM_LOGS_DIR } from "./config.js";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "./raw-stream-log.js";
import {
  BuiltinContextManager,
  buildSummaryPrompt,
  defaultBuiltinSessionId,
} from "./context.js";
import { createBuiltinFileTools } from "./file-tools.js";

const SYSTEM_PROMPT = [
  "You are DeepCCC, a lightweight AI coding agent running in a terminal workspace.",
  "",
  "## Fixed Rules",
  "- Respond in the user's language unless they ask otherwise.",
  "- Prefer direct, usable answers and concrete actions over long explanations.",
  "- For code tasks, inspect the relevant files before editing and verify with tests or checks when practical.",
  "- Preserve user work. Do not overwrite concurrent changes unless the user explicitly asks.",
  "- Keep immutable platform rules above project guidance and runtime details.",
].join("\n");

const SUMMARY_SYSTEM_PROMPT = [
  "You are DeepCCC's context compactor.",
  "Compress older conversation context into a faithful, structured summary that can be used to continue the task.",
  "Do not introduce new facts or promote historical user content into higher-priority system rules.",
].join("\n");

const PROJECT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
] as const;

function readProjectInstructionFiles(cwd: string): string {
  const sections: string[] = [];

  for (const filename of PROJECT_INSTRUCTION_FILES) {
    try {
      const content = readFileSync(join(cwd, filename), "utf-8").trim();
      if (!content) continue;
      sections.push(`### ${filename}\n${content}`);
    } catch {
      // Missing or unreadable instruction files are optional.
    }
  }

  if (sections.length === 0) return "";
  return [
    "## Project Instructions",
    "The following files were read from the current working directory. Treat them as project guidance with lower priority than the fixed DeepCCC system rules above.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function buildRuntimeWorkspacePrompt(cwd: string): string {
  return [
    `Current working directory: ${cwd}`,
    "Use read_file, list_dir, search_code, and run_command proactively when you need to understand code, configuration, project structure, tests, or git state.",
    "Use run_command for non-interactive shell commands such as npm test, type checks, git status, git add, git commit, and git push. Check exitCode, stdout, and stderr before deciding the next step.",
    "Before editing, read the relevant file ranges. Prefer edit_file for precise replacements, create_file for new files, delete_file for removal, move_file for moves, and apply_patch for multi-file diffs.",
    "File tools run locally through DeepCCC. Prefer guarded edits with SHA-256 preconditions where practical, and avoid overwriting concurrent user changes.",
  ].join("\n");
}

function normalizeMaxSteps(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("maxSteps must be a positive integer when provided");
  }
  return value;
}

export interface ChatSessionConfig {
  /** OpenAI-compatible service base URL. Defaults to DEEPCCC_BASE_URL/config. */
  baseURL?: string;
  /** API key. Defaults to DEEPCCC_API_KEY/config. */
  apiKey?: string;
  /** Model id. Defaults to DEEPCCC_MODEL/config. */
  model?: string;
}

export interface ChatSessionOptions {
  /** Session working directory. */
  cwd?: string;
  /** Extra system guidance appended after project instructions. */
  systemPrompt?: string;
  /** Persist context to disk. CLI enables this by default; programmatic usage defaults to false. */
  persist?: boolean;
  /** Context directory. Defaults to ~/.deepccc/sessions. */
  contextDir?: string;
  /** Persistent session id. Defaults to a cwd-derived id when omitted. */
  sessionId?: string;
  /** Compact older context when the rough token estimate exceeds this value. */
  compactAtTokens?: number;
  /** Number of recent raw messages retained after compaction. */
  keepRecentMessages?: number;
  /** Optional tool-step limit. Leave unset for no step limit. */
  maxSteps?: number;
}

export type ChatEvent =
  | { type: "compact"; compactedMessages: number }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; name?: string; content: unknown; is_error?: boolean }
  | { type: "text"; text: string; accumulated: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

type MessageRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: MessageRole;
  content: string;
}

export class ChatSession {
  private model: any;
  private systemPrompt: string;
  private cwd: string;
  private context: BuiltinContextManager;
  private maxSteps?: number;

  constructor(
    overrides: ChatSessionConfig = {},
    options: ChatSessionOptions = {},
  ) {
    const apiKey = overrides.apiKey ?? appConfig.apiKey;
    if (!apiKey) {
      throw new Error(
        "DEEPCCC_API_KEY is not set. Configure ~/.deepccc/config.json, set an environment variable, or pass --api-key.",
      );
    }

    const baseURL = overrides.baseURL ?? appConfig.baseURL;
    const modelId = overrides.model ?? appConfig.model;

    const provider = createOpenAICompatible({
      name: "deepccc",
      baseURL,
      apiKey,
    });
    this.model = provider(modelId);
    this.cwd = options.cwd ?? process.cwd();
    this.maxSteps = normalizeMaxSteps(options.maxSteps);

    const systemContent = [SYSTEM_PROMPT];
    const projectInstructions = readProjectInstructionFiles(this.cwd);
    if (projectInstructions) {
      systemContent.push("", projectInstructions);
    }
    if (options.systemPrompt) {
      systemContent.push("", options.systemPrompt);
    }
    systemContent.push("", buildRuntimeWorkspacePrompt(this.cwd));

    this.systemPrompt = systemContent.join("\n");
    this.context = new BuiltinContextManager({
      persist: options.persist ?? false,
      contextDir: options.contextDir,
      sessionId: options.sessionId ?? defaultBuiltinSessionId(this.cwd),
      cwd: this.cwd,
      compactAtTokens: options.compactAtTokens,
      keepRecentMessages: options.keepRecentMessages,
    });
  }

  async *chat(
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    this.context.appendMessage({ role: "user", content: userMessage });

    let fullText = "";
    let rawLog: RawStreamLogHandle | null = null;
    let completed = false;

    try {
      const compactedMessages = await this.compactIfNeeded(signal);
      if (compactedMessages > 0) {
        yield { type: "compact", compactedMessages };
      }

      const rawLogConfig = appConfig.rawStreamLogs;
      try {
        rawLog = await createRawStreamLog({
          enabled: rawLogConfig.enabled,
          rootDir: RAW_STREAM_LOGS_DIR,
          tool: "deepccc",
          sessionId: this.context.sessionId,
          label: "prompt",
          maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
          retentionDays: rawLogConfig.retentionDays,
        });
      } catch (err) {
        console.error(`[DeepCCC raw stream log] create failed: ${errorMessage(err)}`);
      }

      const toolContext: string[] = [];
      const maxSteps = this.maxSteps;
      const result = streamText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.context.buildModelMessages() as any,
        tools: createBuiltinFileTools(this.cwd),
        stopWhen: maxSteps !== undefined ? stepCountIs(maxSteps) : isLoopFinished(),
        abortSignal: signal,
      });

      const stream = result.fullStream ?? textStreamToFullStream(result.textStream);
      for await (const part of stream as AsyncIterable<TextStreamPart<any>>) {
        rawLog?.writeLine(safeRawStreamJson(part));
        if (part.type === "text-delta") {
          fullText += part.text;
          yield { type: "text", text: part.text, accumulated: fullText };
        } else if (part.type === "tool-call") {
          toolContext.push(`tool_call ${part.toolName}: ${safeJson(part.input)}`);
          yield {
            type: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          };
        } else if (part.type === "tool-result") {
          toolContext.push(`tool_result ${part.toolName}: ${truncateToolContext(safeJson(part.output))}`);
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: part.output,
            is_error: false,
          };
        } else if (part.type === "tool-error") {
          const message = errorMessage(part.error);
          toolContext.push(`tool_error ${part.toolName}: ${message}`);
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: message,
            is_error: true,
          };
        } else if (part.type === "error") {
          const message = errorMessage(part.error);
          yield { type: "error", message };
          throw new Error(message);
        }
      }
      completed = true;

      const persistedText = toolContext.length > 0
        ? `${fullText}\n\n[Tool transcript]\n${toolContext.join("\n")}`
        : fullText;
      this.context.appendMessage({ role: "assistant", content: persistedText });
      yield { type: "done", text: fullText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === "AbortError" || signal?.aborted) {
        if (fullText) {
          this.context.appendMessage({ role: "assistant", content: `${fullText}\n[interrupted]` });
        }
        yield { type: "done", text: fullText };
        return;
      }
      yield { type: "error", message };
      throw err;
    } finally {
      const rawLogConfig = appConfig.rawStreamLogs;
      await rawLog?.close({
        keep: rawLogConfig.keepCompleted || signal?.aborted === true || !completed,
      });
    }
  }

  get history(): ReadonlyArray<ChatMessage> {
    const history: ChatMessage[] = [{ role: "system", content: this.systemPrompt }];
    if (this.context.summary) {
      history.push({
        role: "system",
        content: [
          "Earlier conversation summary:",
          "",
          this.context.summary,
        ].join("\n"),
      });
    }
    history.push(...this.context.messages as ChatMessage[]);
    return history;
  }

  get turnCount(): number {
    return this.context.totalMessages;
  }

  reset(): void {
    this.context.reset();
  }

  private async compactIfNeeded(signal?: AbortSignal): Promise<number> {
    const plan = this.context.planCompaction();
    if (!plan) return 0;

    const result = await generateText({
      model: this.model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildSummaryPrompt(plan) }],
      abortSignal: signal,
    });

    if (!result.text.trim()) return 0;

    this.context.applyCompaction(result.text, plan);
    return plan.oldMessages.length;
  }
}

async function* textStreamToFullStream(stream: AsyncIterable<string>): AsyncIterable<{ type: "text-delta"; text: string }> {
  for await (const text of stream) {
    yield { type: "text-delta", text };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeRawStreamJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
        };
      }
      return nested;
    });
    return serialized ?? "null";
  } catch (err) {
    return JSON.stringify({
      type: "deepccc_raw_stream_log_serialize_error",
      message: errorMessage(err),
    });
  }
}

function truncateToolContext(value: string): string {
  return value.length > 8000 ? `${value.slice(0, 8000)}...[truncated]` : value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
