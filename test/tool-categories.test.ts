import { describe, expect, test } from "bun:test";
import { categorizeTool, isMcpTool, parseMcpTool, toolDisplayName } from "../src/tool-categories.ts";

// These mirror cc-lens (Arindam200/cc-lens) so argus parses tools and MCP servers identically.
describe("categorizeTool", () => {
  test("classifies built-ins by category", () => {
    expect(categorizeTool("Read")).toBe("file-io");
    expect(categorizeTool("Edit")).toBe("file-io");
    expect(categorizeTool("Bash")).toBe("shell");
    expect(categorizeTool("Task")).toBe("agent");
    expect(categorizeTool("WebSearch")).toBe("web");
    expect(categorizeTool("ExitPlanMode")).toBe("planning");
    expect(categorizeTool("TodoWrite")).toBe("todo");
    expect(categorizeTool("Skill")).toBe("skill");
    expect(categorizeTool("ToolSearch")).toBe("skill");
    expect(categorizeTool("read_file")).toBe("file-io");
    expect(categorizeTool("run_shell_command")).toBe("shell");
    expect(categorizeTool("invoke_agent")).toBe("agent");
    expect(categorizeTool("google_web_search")).toBe("web");
    expect(categorizeTool("update_topic")).toBe("planning");
    expect(categorizeTool("activate_skill")).toBe("skill");
  });

  test("any mcp__ tool is the mcp category", () => {
    expect(categorizeTool("mcp__fathom__search_meetings")).toBe("mcp");
  });

  test("unknown tools fall back to other", () => {
    expect(categorizeTool("SomeCustomTool")).toBe("other");
    expect(categorizeTool("exec_command")).toBe("other");
  });
});

describe("parseMcpTool", () => {
  test("splits server and tool", () => {
    expect(parseMcpTool("mcp__fathom__search_meetings")).toEqual({
      server: "fathom",
      tool: "search_meetings",
    });
  });

  test("keeps __ inside the tool segment (slice(2).join)", () => {
    expect(parseMcpTool("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
  });

  test("returns null for non-mcp and malformed (<3 segments) names", () => {
    expect(parseMcpTool("Bash")).toBeNull();
    expect(parseMcpTool("mcp__onlyserver")).toBeNull(); // no tool segment
  });
});

describe("isMcpTool / toolDisplayName", () => {
  test("isMcpTool matches the mcp__ prefix only", () => {
    expect(isMcpTool("mcp__x__y")).toBe(true);
    expect(isMcpTool("Bash")).toBe(false);
  });

  test("toolDisplayName renders server · tool for mcp, raw otherwise", () => {
    expect(toolDisplayName("mcp__fathom__search_meetings")).toBe("fathom · search_meetings");
    expect(toolDisplayName("Bash")).toBe("Bash");
  });
});
