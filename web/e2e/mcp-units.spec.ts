import { test, expect } from "@playwright/test";
import { checkRateLimit } from "../src/lib/mcp/gate";
import {
  clampMcpPage,
  McpInvalidInput,
  MCP_DEFAULT_PAGE_SIZE,
  MCP_MAX_PAGE_SIZE,
} from "../src/lib/mcp/limits";

test("checkRateLimit allows when limiter is absent", async () => {
  expect(await checkRateLimit(null, "ip")).toBe(true);
});

test("checkRateLimit blocks when the limiter denies", async () => {
  const limiter = { limit: async () => ({ success: false }) };
  expect(await checkRateLimit(limiter, "ip")).toBe(false);
});

test("checkRateLimit allows when the limiter permits", async () => {
  const limiter = { limit: async () => ({ success: true }) };
  expect(await checkRateLimit(limiter, "ip")).toBe(true);
});

test("checkRateLimit fails open when the limiter throws", async () => {
  const limiter = {
    limit: async () => {
      throw new Error("binding unavailable");
    },
  };
  expect(await checkRateLimit(limiter, "ip")).toBe(true);
});

test("clampMcpPage caps pageMaxSize at the MCP ceiling", () => {
  expect(clampMcpPage(0, 9999).pageMaxSize).toBe(MCP_MAX_PAGE_SIZE);
});

test("clampMcpPage defaults pageMaxSize when absent", () => {
  expect(clampMcpPage(0, undefined).pageMaxSize).toBe(MCP_DEFAULT_PAGE_SIZE);
});

test("clampMcpPage passes through valid input", () => {
  expect(clampMcpPage(5, 10)).toEqual({ pageOffset: 5, pageMaxSize: 10 });
});

test("clampMcpPage rejects an over-cap offset", () => {
  expect(() => clampMcpPage(201, 10)).toThrow(McpInvalidInput);
});

test("clampMcpPage rejects a negative offset", () => {
  expect(() => clampMcpPage(-1, 10)).toThrow(McpInvalidInput);
});
