import { test, expect, type APIRequestContext } from "@playwright/test";

const ENDPOINT = "/api/mcp";

async function rpc(request: APIRequestContext, body: unknown) {
  const res = await request.post(ENDPOINT, {
    data: body,
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status(), body: await res.json() };
}

function call(name: string, args: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Parse the single text-content payload of a tools/call result. */
function payload(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

test("initialize returns capabilities, serverInfo, and instructions", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(body.result.capabilities.tools).toBeDefined();
  expect(body.result.serverInfo.name).toBe("uh-course-search");
  expect(typeof body.result.instructions).toBe("string");
  expect(body.result.protocolVersion).toBeTruthy();
});

test("tools/list returns the six search tools", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(
    ["get_course", "get_instructor", "get_section", "list_filters", "list_terms", "search_sections"]
  );
});

test("list_terms includes the seeded term 202710", async ({ request }) => {
  const { body } = await rpc(request, call("list_terms"));
  const terms = payload(body.result);
  expect(terms.some((t: { code: string }) => t.code === "202710")).toBe(true);
});

test("search_sections returns all seeded ICS sections", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", subject: "ICS" }));
  const data = payload(body.result);
  expect(data.totalCount).toBe(7);
  expect(data.returnedCount).toBe(7);
  expect(data.sections).toHaveLength(7);
  expect(data.hint).toBeUndefined();
});

test("search_sections clamps pageMaxSize to the MCP ceiling", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", pageMaxSize: 9999 }));
  expect(payload(body.result).pageMaxSize).toBe(50);
});

test("search_sections rejects an over-cap pageOffset with -32602", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", { term: "202710", pageOffset: 9999 }));
  expect(body.error.code).toBe(-32602);
});

test("search_sections requires term (-32602)", async ({ request }) => {
  const { body } = await rpc(request, call("search_sections", {}));
  expect(body.error.code).toBe(-32602);
});

test("get_course returns catalog facts for a seeded course", async ({ request }) => {
  const { body } = await rpc(
    request,
    call("get_course", {
      term: "202710",
      campus: "University of Hawaii at Manoa",
      subject: "ICS",
      courseNumber: "111",
    })
  );
  expect(payload(body.result).collegeName).toBe("College of Natural Sciences");
});

test("get_section returns the seeded cross-list detail", async ({ request }) => {
  const { body } = await rpc(request, call("get_section", { term: "202710", crn: "10005" }));
  const detail = payload(body.result);
  expect(detail.crossListCrns).toContain("10004");
});

test("get_instructor returns the seeded contact card", async ({ request }) => {
  const { body } = await rpc(request, call("get_instructor", { bannerId: "9001" }));
  expect(payload(body.result).displayName).toBe("Jane Instructor");
});

test("an unknown tool returns an isError result", async ({ request }) => {
  const { body } = await rpc(request, call("does_not_exist"));
  expect(body.result.isError).toBe(true);
});

test("an unknown method returns -32601", async ({ request }) => {
  const { body } = await rpc(request, { jsonrpc: "2.0", id: 1, method: "no/such/method" });
  expect(body.error.code).toBe(-32601);
});

test("GET /api/mcp is 405", async ({ request }) => {
  const res = await request.get(ENDPOINT);
  expect(res.status()).toBe(405);
});
