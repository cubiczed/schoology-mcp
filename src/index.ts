#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { z } from "zod";
import { getConfigFromEnv, SchoologyClient } from "./client.js";
import {
  parseAssignment,
  parseCourses,
  parseFeed,
  parseGenericPage,
  parseGrades,
  parseMaterials,
  parseUpcoming,
} from "./parsers.js";

const client = new SchoologyClient(getConfigFromEnv);

const server = new McpServer({
  name: "schoology-mcp",
  version: "0.1.0",
});

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// 1. list_courses
server.tool(
  "list_courses",
  "List all enrolled Schoology courses with section IDs, course codes, instructors, and URLs.",
  {},
  async () => {
    try {
      const res = await client.request("/courses");
      const courses = parseCourses(res.text, client.baseUrl);

      if (courses.length > 0) {
        try {
          const ids = courses.map((c) => c.sectionId).join(",");
          const adminJson = await client.requestJson<{
            data?: Record<string, Array<{ name_first_formatted?: string; name_last?: string }>>;
          }>(`/course/administrators_info?course_nids=${ids}`);

          for (const c of courses) {
            const admins = adminJson.data?.[c.sectionId];
            if (Array.isArray(admins) && admins.length > 0) {
              c.instructors = admins
                .map((a) => `${a.name_first_formatted || ""} ${a.name_last || ""}`.replace(/\s+/g, " ").trim())
                .filter(Boolean);
            }
          }
        } catch {
          // Instructor lookup is best-effort
        }
      }

      return jsonResult({ count: courses.length, courses });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 2. get_upcoming
server.tool(
  "get_upcoming",
  "Get upcoming submissions, overdue submissions, and/or upcoming calendar events from the Schoology home sidebar.",
  {
    kind: z
      .enum(["all", "upcoming", "overdue", "events"])
      .default("all")
      .describe("Which list to fetch: 'upcoming' submissions, 'overdue' submissions, 'events', or 'all'."),
  },
  async ({ kind }) => {
    try {
      const out: Record<string, unknown> = {};
      const jobs: Array<Promise<void>> = [];

      if (kind === "all" || kind === "upcoming") {
        jobs.push(
          client
            .requestJson<{ html?: string }>("/home/upcoming_submissions_ajax")
            .then((d) => {
              out.upcoming_submissions = parseUpcoming(d.html || "", client.baseUrl);
            })
        );
      }
      if (kind === "all" || kind === "overdue") {
        jobs.push(
          client
            .requestJson<{ html?: string }>("/home/overdue_submissions_ajax")
            .then((d) => {
              out.overdue_submissions = parseUpcoming(d.html || "", client.baseUrl);
            })
        );
      }
      if (kind === "all" || kind === "events") {
        jobs.push(
          client
            .requestJson<{ html?: string }>("/home/upcoming_ajax")
            .then((d) => {
              out.upcoming_events = parseUpcoming(d.html || "", client.baseUrl);
            })
        );
      }

      await Promise.all(jobs);
      return jsonResult(out);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 3. get_calendar
server.tool(
  "get_calendar",
  "Get Schoology calendar events and assignment due dates for a date range.",
  {
    start_date: z
      .string()
      .optional()
      .describe("Start date in YYYY-MM-DD format (defaults to 7 days ago)."),
    end_date: z
      .string()
      .optional()
      .describe("End date in YYYY-MM-DD format (defaults to 30 days from now)."),
  },
  async ({ start_date, end_date }) => {
    try {
      const uid = await client.getUid();
      const now = Date.now();
      const startMs = start_date ? Date.parse(start_date) : now - 7 * 86400_000;
      const endMs = end_date ? Date.parse(end_date) + 86399_000 : now + 30 * 86400_000;
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw new Error("Invalid start_date or end_date. Use YYYY-MM-DD.");
      }

      const d = new Date(startMs);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const startSec = Math.floor(startMs / 1000);
      const endSec = Math.floor(endMs / 1000);

      const raw = await client.requestJson<
        Array<{
          title?: string;
          realm?: string;
          realm_id?: string;
          start?: string;
          end?: string;
          e_type?: string;
          content_id?: string;
          content_title?: string;
          body?: string;
        }>
      >(`/calendar/${uid}/${ym}?ajax=1&start=${startSec}&end=${endSec}`);

      const events = (Array.isArray(raw) ? raw : []).map((ev) => {
        const $t = cheerio.load(ev.title || "");
        const title = $t.text().replace(/\s+/g, " ").trim();
        const href = $t("a").attr("href");
        const $b = cheerio.load(ev.body || "");
        const description = $b.text().replace(/\s+/g, " ").trim().slice(0, 500);
        return {
          title,
          type: ev.e_type || "event",
          course: ev.content_title || undefined,
          sectionId: ev.realm === "course" ? ev.realm_id : undefined,
          start: ev.start,
          end: ev.end || undefined,
          itemId: ev.content_id,
          url: href ? `${client.baseUrl}${href.startsWith("/") ? "" : "/"}${href}` : undefined,
          description: description || undefined,
        };
      });

      return jsonResult({ count: events.length, events });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 4. get_grades
server.tool(
  "get_grades",
  "Get Schoology grades for all courses or a specific course section ID.",
  {
    section_id: z
      .string()
      .optional()
      .describe("Optional course section ID (from list_courses). Omit for all courses."),
    include_items: z
      .boolean()
      .optional()
      .describe("Include individual graded/ungraded assignment rows. Defaults to true when section_id is set, false otherwise."),
  },
  async ({ section_id, include_items }) => {
    try {
      const wantItems = include_items ?? Boolean(section_id);
      const path = section_id ? `/course/${section_id}/student_grades` : "/grades/grades";
      const res = await client.request(path);
      const grades = parseGrades(res.text, client.baseUrl, {
        sectionId: section_id,
        includeItems: wantItems,
      });
      return jsonResult({ count: grades.length, courses: grades });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 5. get_course_materials
server.tool(
  "get_course_materials",
  "List folders and materials (pages, files, links, assignments, discussions) inside a Schoology course or subfolder.",
  {
    section_id: z.string().describe("Course section ID (from list_courses)."),
    folder_id: z.string().optional().describe("Optional folder ID to list items inside a subfolder."),
  },
  async ({ section_id, folder_id }) => {
    try {
      const path = folder_id
        ? `/course/${section_id}/materials?f=${encodeURIComponent(folder_id)}`
        : `/course/${section_id}/materials`;
      const res = await client.request(path);
      const items = parseMaterials(res.text, client.baseUrl);
      return jsonResult({ sectionId: section_id, folderId: folder_id || null, count: items.length, items });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 6. get_assignment
server.tool(
  "get_assignment",
  "Get full details of a Schoology assignment including description, due date, attachments, and submission status.",
  {
    assignment_id: z.string().describe("Assignment ID (numeric ID from /assignment/<id>)."),
  },
  async ({ assignment_id }) => {
    try {
      const res = await client.request(`/assignment/${encodeURIComponent(assignment_id)}`);
      const detail = parseAssignment(res.text, assignment_id, client.baseUrl);
      return jsonResult(detail);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 7. get_updates
server.tool(
  "get_updates",
  "Get recent announcements/updates from the Schoology home activity feed or a specific course.",
  {
    section_id: z
      .string()
      .optional()
      .describe("Optional course section ID. Omit to fetch the home activity feed across all courses."),
    page: z.number().int().min(0).default(0).describe("Zero-based page number for pagination (home feed)."),
  },
  async ({ section_id, page }) => {
    try {
      if (section_id) {
        const res = await client.request(`/course/${encodeURIComponent(section_id)}/updates`);
        const updates = parseFeed(res.text, client.baseUrl);
        return jsonResult({ sectionId: section_id, count: updates.length, updates });
      }
      const data = await client.requestJson<{ output?: string }>(`/home/feed?page=${page}`);
      const updates = parseFeed(data.output || "", client.baseUrl);
      return jsonResult({ page, count: updates.length, updates });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// 8. get_page
server.tool(
  "get_page",
  "Fetch and extract readable text and links from a Schoology page, discussion, or material URL/path.",
  {
    path_or_url: z
      .string()
      .describe("Relative Schoology path (e.g. '/page/1234567890') or full URL on your Schoology instance."),
  },
  async ({ path_or_url }) => {
    try {
      if (path_or_url.startsWith("http") && !path_or_url.startsWith(client.baseUrl)) {
        throw new Error(`URL must be on ${client.baseUrl}`);
      }
      const res = await client.request(path_or_url);
      const page = parseGenericPage(res.text, res.finalUrl, client.baseUrl);
      return jsonResult(page);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in schoology-mcp:", err);
  process.exit(1);
});
