import { describe, expect, it } from "vitest";

import {
  buildSummaryPrompt,
  BuiltinContextManager,
  estimateBuiltinContextTokens,
} from "../context.js";

describe("BuiltinContextManager token-budget compaction", () => {
  it("keeps fewer recent messages when the configured count exceeds the token budget", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 300,
      keepRecentMessages: 16,
      persist: false,
    });

    for (let index = 0; index < 8; index += 1) {
      context.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:` + "x".repeat(400),
      });
    }

    const plan = context.planCompaction();

    expect(plan).not.toBeNull();
    expect(plan!.recentMessages.length).toBeLessThan(8);
    expect(plan!.recentMessages.at(-1)?.content).toContain("7:");
    expect(estimateBuiltinContextTokens("", plan!.recentMessages)).toBeLessThanOrEqual(300);
  });

  it("bounds oversized source material before sending it to the compaction model", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 100,
      keepRecentMessages: 1,
      persist: false,
    });
    context.setSummary("previous ".repeat(30_000));
    context.appendMessage({ role: "assistant", content: "a".repeat(200_000) });
    context.appendMessage({ role: "user", content: "latest request" });

    const prompt = buildSummaryPrompt(context.planCompaction()!);

    expect(prompt.length).toBeLessThan(90_000);
    expect(prompt).toContain("truncated for compaction");
  });
});
