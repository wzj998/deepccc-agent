import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const privacyState = vi.hoisted(() => ({ dir: "" }));

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "deepccc-permissions-test-"));
  privacyState.dir = dir;
  return {
    ...actual,
    DEEPCCC_HOME: dir,
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  generateText: aiMocks.generateText,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../raw-stream-log.js", () => ({
  createRawStreamLog: vi.fn().mockResolvedValue(null),
}));

import {
  PermissionGate,
  appendAllowRule,
  getAllowRules,
  isDangerousCommand,
  matchRule,
  reloadAllowRules,
  type PermissionAnswer,
} from "../permissions.js";
import { createBuiltinFileTools } from "../file-tools.js";
import { ChatSession } from "../index.js";

const streamTextMock = aiMocks.streamText;
const generateTextMock = aiMocks.generateText;

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

/** 从最近一次 streamText 调用中取出 tools.run_command 的 execute */
function lastRunCommandExecute(): (input: { command: string }, opts?: unknown) => Promise<unknown> {
  const call = streamTextMock.mock.calls.at(-1)?.[0] as { tools?: Record<string, { execute?: unknown }> };
  const execute = call?.tools?.run_command?.execute as ((input: { command: string }, opts?: unknown) => Promise<unknown>) | undefined;
  if (!execute) throw new Error("streamText was not called with tools.run_command.execute");
  return execute;
}

const ALLOW_FILE = () => join(privacyState.dir, "allow.json");
const WORK_DIR = () => join(privacyState.dir, "work");

function writeRules(content: string): void {
  writeFileSync(ALLOW_FILE(), content, "utf-8");
}

beforeEach(() => {
  try {
    rmSync(ALLOW_FILE(), { force: true });
  } catch {}
  try {
    rmSync(WORK_DIR(), { recursive: true, force: true });
  } catch {}
  mkdirSync(WORK_DIR(), { recursive: true });
  reloadAllowRules();
  streamTextMock.mockReset();
  generateTextMock.mockReset();
});

afterEach(() => {
  try {
    rmSync(ALLOW_FILE(), { force: true });
  } catch {}
  reloadAllowRules();
});

afterAll(() => {
  try {
    rmSync(privacyState.dir, { recursive: true, force: true });
  } catch {}
});

describe("isDangerousCommand", () => {
  it("flags destructive commands", () => {
    const dangerous = [
      "rm -rf node_modules",
      "rm -fr /tmp/x",
      "git push --force origin main",
      "git push -f origin main",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "del /s /q C:\\temp",
      "erase /s x",
      "rmdir /s /q C:\\x",
      "format C:",
      "diskpart",
      "shutdown /s",
      "reboot",
      "mkfs.ext4 /dev/sdb1",
      "dd if=/dev/zero of=/dev/sda",
      "sudo rm -rf /",
      "Remove-Item -Recurse -Force C:\\x",
      "drop table users",
      "truncate table logs",
      "npm publish",
      "npm uninstall -g foo",
      "pip uninstall foo",
      ":(){ :|:& };:",
    ];
    for (const cmd of dangerous) {
      expect(isDangerousCommand(cmd), cmd).toBe(true);
    }
  });

  it("does not flag normal commands", () => {
    const safe = [
      "git status",
      "git push origin dev",
      "npm test",
      "npm run build",
      "ls -la",
      "rm README.md", // 无 -r/-f 的普通 rm
      "echo hello",
      "node -v",
      "git pull origin main",
    ];
    for (const cmd of safe) {
      expect(isDangerousCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("allow.json rule loading", () => {
  it("returns empty rules when file is missing", () => {
    expect(getAllowRules()).toEqual({ allow: [], deny: [] });
  });

  it("parses allow and deny lists", () => {
    writeRules(JSON.stringify({ allow: ["run_command:git status*"], deny: ["run_command:rm -rf *"] }));
    reloadAllowRules();
    expect(getAllowRules()).toEqual({
      allow: ["run_command:git status*"],
      deny: ["run_command:rm -rf *"],
    });
  });

  it("accepts UTF-8 BOM", () => {
    writeRules(`\uFEFF${JSON.stringify({ allow: ["*:ls*"] })}`);
    reloadAllowRules();
    expect(getAllowRules().allow).toEqual(["*:ls*"]);
  });

  it("ignores non-string entries and non-array fields", () => {
    writeRules(JSON.stringify({ allow: ["ok", 42, ""], deny: "nope" }));
    reloadAllowRules();
    expect(getAllowRules()).toEqual({ allow: ["ok"], deny: [] });
  });

  it("returns empty rules for malformed JSON", () => {
    writeRules("not json");
    reloadAllowRules();
    expect(getAllowRules()).toEqual({ allow: [], deny: [] });
  });

  it("hot reloads file changes", () => {
    writeRules(JSON.stringify({ allow: ["run_command:git status*"] }));
    reloadAllowRules();
    expect(getAllowRules().allow).toEqual(["run_command:git status*"]);

    writeRules(JSON.stringify({ allow: ["run_command:npm test*"] }));
    expect(getAllowRules().allow).toEqual(["run_command:npm test*"]);
  });

  it("appendAllowRule persists and reloads", () => {
    appendAllowRule("run_command:rm -rf /tmp/cache*");
    expect(existsSync(ALLOW_FILE())).toBe(true);
    const saved = JSON.parse(readFileSync(ALLOW_FILE(), "utf-8"));
    expect(saved.allow).toContain("run_command:rm -rf /tmp/cache*");
    expect(getAllowRules().allow).toContain("run_command:rm -rf /tmp/cache*");

    // 幂等：重复追加不重复
    appendAllowRule("run_command:rm -rf /tmp/cache*");
    const saved2 = JSON.parse(readFileSync(ALLOW_FILE(), "utf-8"));
    expect(saved2.allow.filter((r: string) => r === "run_command:rm -rf /tmp/cache*")).toHaveLength(1);
  });
});

describe("matchRule", () => {
  it("matches exact tool and wildcard pattern", () => {
    expect(matchRule("run_command:git status*", "run_command:git status --short")).toBe(true);
    expect(matchRule("run_command:git status*", "run_command:git push")).toBe(false);
  });

  it("supports *: tool wildcard", () => {
    expect(matchRule("*:ls*", "run_command:ls -la")).toBe(true);
    expect(matchRule("*:ls*", "read_file:ls-notes.txt")).toBe(true);
  });

  it("treats other special characters literally", () => {
    expect(matchRule("edit_file:C:\\Users\\a b\\x*.ts", "edit_file:C:\\Users\\a b\\x1.ts")).toBe(true);
    expect(matchRule("edit_file:C:\\Users\\a b\\x*.ts", "edit_file:C:\\Users\\a b\\y1.ts")).toBe(false);
    expect(matchRule("run_command:npm test", "run_command:npm test extra")).toBe(false);
  });

  it("rejects rules without colon", () => {
    expect(matchRule("npm test", "run_command:npm test")).toBe(false);
  });
});

async function runGate(
  gate: PermissionGate,
  req: { tool: string; action: string; reason: "high-risk" | "rule"; detail?: string },
): Promise<"allow" | "deny"> {
  return gate.check({ detail: req.detail ?? `${req.tool}: ${req.action}`, ...req });
}

describe("PermissionGate", () => {
  it("bypass mode allows everything including deny rules", async () => {
    writeRules(JSON.stringify({ deny: ["run_command:rm -rf *"] }));
    reloadAllowRules();
    const gate = new PermissionGate("bypass");
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf /", reason: "high-risk" })).toBe("allow");
    expect(await runGate(gate, { tool: "edit_file", action: "C:\\x", reason: "rule" })).toBe("allow");
  });

  it("deny rule wins over allow rule and high-risk", async () => {
    writeRules(JSON.stringify({ allow: ["run_command:rm -rf /tmp*"], deny: ["run_command:rm -rf /tmp/forbidden*"] }));
    reloadAllowRules();
    const gate = new PermissionGate("ask");
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf /tmp/forbidden/x", reason: "high-risk" })).toBe("deny");
  });

  it("allow rule allows high-risk commands without asking resolver", async () => {
    writeRules(JSON.stringify({ allow: ["run_command:git push --force*"] }));
    reloadAllowRules();
    const resolver = vi.fn();
    const gate = new PermissionGate("ask", resolver as never);
    expect(await runGate(gate, { tool: "run_command", action: "git push --force origin main", reason: "high-risk" })).toBe("allow");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("ask mode allows non-high-risk operations without asking", async () => {
    const resolver = vi.fn();
    const gate = new PermissionGate("ask", resolver as never);
    expect(await runGate(gate, { tool: "run_command", action: "npm test", reason: "rule" })).toBe("allow");
    expect(await runGate(gate, { tool: "edit_file", action: "src/a.ts", reason: "rule" })).toBe("allow");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("ask mode denies high-risk when no resolver (non-interactive)", async () => {
    const gate = new PermissionGate("ask");
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf node_modules", reason: "high-risk" })).toBe("deny");
  });

  it("ask mode follows resolver allow / deny", async () => {
    let answer: PermissionAnswer = "allow";
    const gate = new PermissionGate("ask", async () => answer);
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf node_modules", reason: "high-risk" })).toBe("allow");

    answer = "deny";
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf node_modules", reason: "high-risk" })).toBe("deny");
  });

  it("allow-always persists the rule", async () => {
    const gate = new PermissionGate("ask", async () => "allow-always");
    expect(await runGate(gate, { tool: "run_command", action: "git reset --hard HEAD", reason: "high-risk" })).toBe("allow");
    expect(existsSync(ALLOW_FILE())).toBe(true);
    const saved = JSON.parse(readFileSync(ALLOW_FILE(), "utf-8"));
    expect(saved.allow).toContain("run_command:git reset --hard HEAD");

    // 规则已持久化 → 新 gate 直接放行，不再询问
    const resolver = vi.fn();
    const gate2 = new PermissionGate("ask", resolver as never);
    expect(await runGate(gate2, { tool: "run_command", action: "git reset --hard HEAD", reason: "high-risk" })).toBe("allow");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("allow-session allows all subsequent operations", async () => {
    let answered = false;
    const gate = new PermissionGate("ask", async () => {
      if (!answered) {
        answered = true;
        return "allow-session";
      }
      throw new Error("should not ask again");
    });
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf a", reason: "high-risk" })).toBe("allow");
    expect(await runGate(gate, { tool: "run_command", action: "rm -rf b", reason: "high-risk" })).toBe("allow");
    expect(await runGate(gate, { tool: "run_command", action: "del /s /q c", reason: "high-risk" })).toBe("allow");
  });
});

describe("file-tools permission integration", () => {
  it("run_command high-risk is denied by default without a gate resolver", async () => {
    const dir = WORK_DIR();
    const tools = createBuiltinFileTools(dir, { permissionGate: new PermissionGate("ask") });
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<unknown>;
    };
    await expect(tool.execute({ command: "rm -rf node_modules" }, { abortSignal: undefined })).rejects.toThrow(/权限拒绝/);
  });

  it("run_command non-high-risk executes without asking", async () => {
    const dir = WORK_DIR();
    const tools = createBuiltinFileTools(dir, { permissionGate: new PermissionGate("ask") });
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<{ exitCode: number | null; stdout: string }>;
    };
    const result = await tool.execute({ command: "node -e \"console.log('ok-1')\"" }, { abortSignal: undefined });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok-1");
  });

  it("bypass gate lets high-risk run_command execute", async () => {
    const dir = WORK_DIR();
    const tools = createBuiltinFileTools(dir, { permissionGate: new PermissionGate("bypass") });
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<{ exitCode: number | null }>;
    };
    const result = await tool.execute({ command: "node -e \"console.log('bypass-ok')\"" }, { abortSignal: undefined });
    expect(result.exitCode).toBe(0);
  });

  it("deny rule blocks edit_file", async () => {
    writeRules(JSON.stringify({ deny: ["edit_file:node_modules/**"] }));
    reloadAllowRules();
    const dir = WORK_DIR();
    const tools = createBuiltinFileTools(dir, { permissionGate: new PermissionGate("ask") });
    const tool = tools.edit_file as unknown as {
      execute: (input: { path: string; edits: unknown[] }) => Promise<unknown>;
    };
    await expect(
      tool.execute({ path: join(dir, "node_modules", "x.js"), edits: [{ oldText: "a", newText: "b" }] }),
    ).rejects.toThrow(/权限拒绝/);
  });

  it("no gate keeps original behavior (backward compatibility)", async () => {
    const dir = WORK_DIR();
    const tools = createBuiltinFileTools(dir);
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<{ exitCode: number | null }>;
    };
    const result = await tool.execute({ command: "node -e \"console.log('no-gate')\"" }, { abortSignal: undefined });
    expect(result.exitCode).toBe(0);
  });
});

describe("ChatSession permission integration", () => {
  it("permissionMode bypass lets high-risk run_command execute", async () => {
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-bypass", permissionMode: "bypass" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    const result = (await lastRunCommandExecute()({ command: "node -e \"console.log('ok')\"" }, { abortSignal: undefined })) as { exitCode: number };
    expect(result.exitCode).toBe(0);
  });

  it("ask mode without resolver denies high-risk run_command", async () => {
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-ask-no-resolver" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    await expect(
      lastRunCommandExecute()({ command: "rm -rf node_modules" }, { abortSignal: undefined }),
    ).rejects.toThrow(/权限拒绝/);
  });

  it("ask mode with resolver calls the resolver and follows deny", async () => {
    const resolver = vi.fn().mockResolvedValue("deny");
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-ask-resolver", permissionResolver: resolver },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    await expect(
      lastRunCommandExecute()({ command: "rm -rf node_modules" }, { abortSignal: undefined }),
    ).rejects.toThrow(/权限拒绝/);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toMatchObject({ tool: "run_command", action: "rm -rf node_modules" });
  });

  it("ask mode with resolver allow executes the command", async () => {
    const resolver = vi.fn().mockResolvedValue("allow");
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-ask-allow", permissionResolver: resolver },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    const result = (await lastRunCommandExecute()({ command: "node -e \"console.log('ok')\"" }, { abortSignal: undefined })) as { exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(resolver).not.toHaveBeenCalled(); // 低危命令不询问
  });
});
