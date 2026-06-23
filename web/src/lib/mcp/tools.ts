/**
 * MCP tool registry (search-only). Each tool maps to the shared lib/api service
 * layer; handlers return raw JSON as text content. Handlers throw McpInvalidInput
 * for bad arguments (the dispatcher maps it to -32602); any other throw becomes
 * an isError tool result so the agent can recover.
 */
import { runCrnLookup, runSearch } from "@/lib/api/search";
import { runCourseCatalog } from "@/lib/api/course";
import { runSectionDetail } from "@/lib/api/section";
import { runFilterOptions } from "@/lib/api/filters";
import { fetchInstructor, fetchTerms } from "@/lib/search";
import { FILTER_KINDS, type FilterKind } from "@/lib/db/queries";
import { clampMcpPage, McpInvalidInput, MCP_MAX_PAGE_SIZE } from "./limits";
import type { McpTool, McpToolResult } from "./types";
import type { SearchParams } from "@/lib/sis/types";

export const SERVER_INFO = { name: "uh-course-search", version: "1.0.0" };

export const SERVER_INSTRUCTIONS =
  "Read-only access to University of Hawaii course data (Banner SSB9). " +
  "Term codes are 6-digit Banner codes (e.g. 202710); do not construct them by " +
  "hand — call list_terms to get valid codes with human-readable descriptions. " +
  "Campus, college, and department filters use the full DESCRIPTION string (e.g. " +
  "\"University of Hawaii at Manoa\"); get valid values from list_filters. " +
  `search_sections returns at most ${MCP_MAX_PAGE_SIZE} sections per call — narrow ` +
  "with subject/courseNumber/campus rather than paging deeply (pageOffset is " +
  "capped). Subject is optional; omit it to search all subjects in a term.";

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new McpInvalidInput(`'${name}' is required and must be a non-empty string`);
  }
  return v.trim();
}
function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

async function searchSections(args: Record<string, unknown>): Promise<McpToolResult> {
  const term = reqStr(args, "term");

  const crn = optStr(args, "crn");
  if (crn) {
    const section = await runCrnLookup(term, crn);
    return textResult({
      totalCount: section ? 1 : 0,
      returnedCount: section ? 1 : 0,
      sections: section ? [section] : [],
    });
  }

  const { pageOffset, pageMaxSize } = clampMcpPage(args.pageOffset, args.pageMaxSize);
  const attributes = Array.isArray(args.attribute)
    ? (args.attribute as unknown[])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const params: SearchParams = {
    term,
    subject: (optStr(args, "subject") ?? "").toUpperCase(),
    courseNumber: optStr(args, "courseNumber"),
    campus: optStr(args, "campus"),
    college: optStr(args, "college"),
    department: optStr(args, "department"),
    openOnly: args.openOnly === true,
    attributes,
    pageOffset,
    pageMaxSize,
    sortColumn: optStr(args, "sortColumn") ?? "subjectDescription",
    sortDirection: optStr(args, "sortDirection") ?? "asc",
  };

  const res = await runSearch(params);
  const returnedCount = res.data.length;
  const more = res.totalCount > params.pageOffset + returnedCount;
  return textResult({
    totalCount: res.totalCount,
    returnedCount,
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sections: res.data,
    ...(more
      ? {
          hint:
            `Showing ${returnedCount} of ${res.totalCount} sections. Refine your ` +
            `filters (subject, courseNumber, campus) to narrow the results.`,
        }
      : {}),
  });
}

async function getCourse(args: Record<string, unknown>): Promise<McpToolResult> {
  const catalog = await runCourseCatalog(
    reqStr(args, "term"),
    reqStr(args, "campus"),
    reqStr(args, "subject"),
    reqStr(args, "courseNumber")
  );
  if (!catalog) return errorResult("course not found");
  return textResult(catalog);
}

async function getSection(args: Record<string, unknown>): Promise<McpToolResult> {
  const detail = await runSectionDetail(reqStr(args, "term"), reqStr(args, "crn"));
  if (!detail) return errorResult("section detail not found");
  return textResult(detail);
}

async function getInstructor(args: Record<string, unknown>): Promise<McpToolResult> {
  const instructor = await fetchInstructor(reqStr(args, "bannerId"));
  if (!instructor) return errorResult("instructor not found");
  return textResult(instructor);
}

async function listTerms(): Promise<McpToolResult> {
  return textResult(await fetchTerms());
}

async function listFilters(args: Record<string, unknown>): Promise<McpToolResult> {
  const term = reqStr(args, "term");
  const kind = reqStr(args, "kind");
  if (!FILTER_KINDS.includes(kind as FilterKind)) {
    throw new McpInvalidInput(`unknown kind '${kind}' (expected one of: ${FILTER_KINDS.join(", ")})`);
  }
  const campus = optStr(args, "campus");
  const options = await runFilterOptions(term, kind as FilterKind, campus);
  return textResult({ kind, options });
}

export const TOOLS: McpTool[] = [
  {
    name: "list_terms",
    description:
      "List available UH terms (code + description + whether fully backfilled). Call this first to get valid term codes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listTerms,
  },
  {
    name: "list_filters",
    description:
      "List valid values for a filter menu within a term (subject, campus, college, department, attribute, etc.). Use the returned descriptions as filter values for search_sections.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "6-digit Banner term code (see list_terms)." },
        kind: {
          type: "string",
          enum: [...FILTER_KINDS],
          description: "Which menu to list.",
        },
        campus: {
          type: "string",
          description: "Optional campus DESCRIPTION; scopes college/department.",
        },
      },
      required: ["term", "kind"],
      additionalProperties: false,
    },
    handler: listFilters,
  },
  {
    name: "search_sections",
    description:
      `Search course sections in a term. Subject is optional (omit to search all subjects). Returns at most ${MCP_MAX_PAGE_SIZE} sections per call; narrow with filters rather than paging deeply. Pass a crn to look up one specific section. campus/college/department use full DESCRIPTION strings (see list_filters).`,
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "6-digit Banner term code (required)." },
        subject: { type: "string", description: "Subject code, e.g. ICS (optional)." },
        courseNumber: { type: "string", description: "Catalog course number, e.g. 211." },
        campus: { type: "string", description: "Campus DESCRIPTION." },
        college: { type: "string", description: "College DESCRIPTION." },
        department: { type: "string", description: "Department DESCRIPTION." },
        openOnly: { type: "boolean", description: "Only sections with open seats." },
        crn: { type: "string", description: "Look up one section by CRN (ignores other filters)." },
        attribute: {
          type: "array",
          items: { type: "string" },
          description: "Attribute codes a section must ALL carry, e.g. [\"WI\"]. Max 20.",
        },
        sortColumn: { type: "string", description: "Sort column (default subjectDescription)." },
        sortDirection: { type: "string", enum: ["asc", "desc"], description: "Default asc." },
        pageOffset: {
          type: "integer",
          minimum: 0,
          maximum: 200,
          description: "Row offset; max 200 (narrow with filters instead of deep paging).",
        },
        pageMaxSize: {
          type: "integer",
          minimum: 1,
          maximum: MCP_MAX_PAGE_SIZE,
          description: `Rows per page (default 20, max ${MCP_MAX_PAGE_SIZE}).`,
        },
      },
      required: ["term"],
      additionalProperties: false,
    },
    handler: searchSections,
  },
  {
    name: "get_course",
    description:
      "Catalog facts for one course at one campus (college, department, grading modes, credits, description/prereqs if available). Campus is required — the same course at another campus is a different entry.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        campus: { type: "string", description: "Campus DESCRIPTION." },
        subject: { type: "string" },
        courseNumber: { type: "string" },
      },
      required: ["term", "campus", "subject", "courseNumber"],
      additionalProperties: false,
    },
    handler: getCourse,
  },
  {
    name: "get_section",
    description:
      "Per-section detail for one CRN: restrictions, fees, cross-listed/linked CRNs, syllabus text.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        crn: { type: "string" },
      },
      required: ["term", "crn"],
      additionalProperties: false,
    },
    handler: getSection,
  },
  {
    name: "get_instructor",
    description:
      "Instructor contact-card facts (title, department, email) by Banner ID. Banner IDs appear in section faculty data from search_sections.",
    inputSchema: {
      type: "object",
      properties: { bannerId: { type: "string" } },
      required: ["bannerId"],
      additionalProperties: false,
    },
    handler: getInstructor,
  },
];
