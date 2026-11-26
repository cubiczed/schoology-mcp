import * as cheerio from "cheerio";

function cleanText($el: cheerio.Cheerio<any>): string {
  const clone = $el.clone();
  clone.find("script, style, .visually-hidden").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

function cleanMultiline($el: cheerio.Cheerio<any>): string {
  const clone = $el.clone();
  clone.find("script, style, .visually-hidden").remove();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absUrl(baseUrl: string, href?: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("#") || href.startsWith("javascript:")) return undefined;
  return `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
}

export interface Course {
  sectionId: string;
  title: string;
  section: string;
  courseCode: string;
  school: string;
  instructors?: string[];
  url: string;
}

export function parseCourses(html: string, baseUrl: string): Course[] {
  const $ = cheerio.load(html);
  const courses: Course[] = [];
  const seen = new Set<string>();

  $("li.course-item, .course-item").each((_, el) => {
    const $item = $(el);
    const title = cleanText($item.find(".course-title").first());
    const courseCode = cleanText($item.find(".course-code").first());
    const school = cleanText($item.find(".school-name").first());

    $item.find('.section-item a[href^="/course/"]').each((__, link) => {
      const $link = $(link);
      const href = $link.attr("href") || "";
      const match = href.match(/\/course\/(\d+)/);
      if (!match) return;
      const sectionId = match[1];
      if (seen.has(sectionId)) return;
      seen.add(sectionId);
      const section = cleanText($link);
      courses.push({
        sectionId,
        title: title || `Course ${sectionId}`,
        section,
        courseCode,
        school,
        url: `${baseUrl}/course/${sectionId}`,
      });
    });
  });

  return courses;
}

export interface UpcomingItem {
  title: string;
  type: string;
  course: string;
  dueDate: string;
  dueTimestamp?: number;
  url?: string;
  assignmentId?: string;
}

export function parseUpcoming(html: string, baseUrl: string): UpcomingItem[] {
  const $ = cheerio.load(html);
  const items: UpcomingItem[] = [];
  let currentDate = "";

  $(".upcoming-list > div").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("date-header")) {
      currentDate = cleanText($el.find(".upcoming-date-title"));
      return;
    }
    if (!$el.hasClass("upcoming-event")) return;

    const $link = $el.find(".event-title a").first();
    const title = cleanText($link) || cleanText($el.find(".event-title"));
    const href = $link.attr("href");
    const url = absUrl(baseUrl, href);
    const asgMatch = href?.match(/\/assignment\/(\d+)/);

    const tooltip = $el.find(".infotip").attr("aria-label") || "";
    const iconHidden = $el.find(".mini-icon .visually-hidden").text().replace(/\.$/, "").trim();
    const tsRaw = $el.attr("data-start");
    const dueTimestamp = tsRaw ? Number(tsRaw) : undefined;
    const dueTime = cleanText($el.find(".upcoming-time"));

    items.push({
      title,
      type: iconHidden || "Event",
      course: tooltip.trim(),
      dueDate: dueTime ? `${currentDate} ${dueTime}`.trim() : currentDate,
      dueTimestamp: Number.isFinite(dueTimestamp) ? dueTimestamp : undefined,
      url,
      assignmentId: asgMatch?.[1],
    });
  });

  return items;
}

export interface GradeItem {
  id: string;
  title: string;
  category: string;
  period: string;
  dueDate?: string;
  grade: string;
  maxPoints?: string;
  comment?: string;
  url?: string;
}

export interface CourseGrades {
  sectionId: string;
  courseTitle: string;
  overallGrade: string;
  periods: { name: string; grade: string }[];
  items?: GradeItem[];
}

export function parseGrades(
  html: string,
  baseUrl: string,
  options: { sectionId?: string; includeItems?: boolean } = {}
): CourseGrades[] {
  const $ = cheerio.load(html);
  const results: CourseGrades[] = [];

  $(".gradebook-course").each((_, courseEl) => {
    const $course = $(courseEl);
    const courseRow = $course.find("tr.report-row.course-row").first();
    const sectionId = courseRow.attr("data-id") || "";
    if (options.sectionId && sectionId !== options.sectionId) return;

    const courseTitle = cleanText($course.find(".gradebook-course-title").first());
    const overallGrade =
      cleanText(courseRow.find("td.grade-column")) ||
      cleanText($course.find(".course-grade-value, .awarded-grade").first()) ||
      "N/A";

    const periods: { name: string; grade: string }[] = [];
    const idToTitle = new Map<string, string>();
    const idToParent = new Map<string, string>();
    const items: GradeItem[] = [];

    $course.find("tr.report-row").each((__, rowEl) => {
      const $row = $(rowEl);
      const id = $row.attr("data-id") || "";
      const parentId = $row.attr("data-parent-id") || "";
      const titleText = cleanText($row.find("th.title-column .title").first()) || cleanText($row.find("th.title-column"));
      const gradeText = cleanText($row.find("td.grade-column"));
      const commentText = cleanText($row.find("td.comment-column"));

      if (id) {
        idToTitle.set(id, titleText);
        if (parentId) idToParent.set(id, parentId);
      }

      if ($row.hasClass("period-row")) {
        periods.push({ name: titleText, grade: gradeText });
      } else if ($row.hasClass("item-row") && options.includeItems) {
        const $link = $row.find("th.title-column a").first();
        const itemTitle = cleanText($link) || titleText;
        const url = absUrl(baseUrl, $link.attr("href"));
        const dueDate = cleanText($row.find(".due-date")) || undefined;
        const awarded = cleanText($row.find(".awarded-grade, .rounded-grade").first());
        const maxPts = cleanText($row.find(".max-grade").first()).replace(/^\/\s*/, "") || undefined;

        const catTitle = idToTitle.get(parentId) || "";
        const periodId = idToParent.get(parentId) || "";
        const periodTitle = idToTitle.get(periodId) || "";

        items.push({
          id: id.replace(/^I-/, ""),
          title: itemTitle,
          category: catTitle,
          period: periodTitle,
          dueDate,
          grade: awarded || gradeText,
          maxPoints: maxPts,
          comment: commentText || undefined,
          url,
        });
      }
    });

    results.push({
      sectionId,
      courseTitle,
      overallGrade,
      periods,
      ...(options.includeItems ? { items } : {}),
    });
  });

  return results;
}

export interface MaterialItem {
  id: string;
  kind: "folder" | "assignment" | "page" | "link" | "file" | "discussion" | "assessment" | "other";
  title: string;
  description?: string;
  folderId?: string;
  assignmentId?: string;
  url?: string;
}

export function parseMaterials(html: string, baseUrl: string): MaterialItem[] {
  const $ = cheerio.load(html);
  const items: MaterialItem[] = [];

  $("#folder-contents-table > tbody > tr, #folder-contents-table tr").each((_, el) => {
    const $row = $(el);
    const rowId = $row.attr("id") || "";
    if (!rowId.startsWith("f-") && !rowId.startsWith("n-")) return;

    if (rowId.startsWith("f-") || $row.hasClass("material-row-folder")) {
      const folderId = rowId.replace(/^f-/, "");
      const $link = $row.find(".folder-title a").first();
      const title = cleanText($link) || cleanText($row.find(".folder-title"));
      const description = cleanText($row.find(".folder-description")) || undefined;
      items.push({
        id: folderId,
        kind: "folder",
        title,
        description,
        folderId,
        url: absUrl(baseUrl, $link.attr("href")),
      });
      return;
    }

    const itemId = rowId.replace(/^n-/, "");
    const $link = $row.find(".item-title a").first();
    const title = cleanText($link) || cleanText($row.find(".item-title"));
    const href = $link.attr("href") || "";
    const description = cleanText($row.find(".item-body")) || undefined;
    const cls = $row.attr("class") || "";

    let kind: MaterialItem["kind"] = "other";
    if (cls.includes("type-assignment") || href.includes("/assignment/")) kind = "assignment";
    else if (cls.includes("type-page") || href.includes("/page/")) kind = "page";
    else if (cls.includes("type-discussion") || href.includes("/discussion/")) kind = "discussion";
    else if (cls.includes("type-document") || href.includes("/materials/gp/")) kind = "file";
    else if (cls.includes("type-link") || href.includes("/materials/link/")) kind = "link";
    else if (cls.includes("type-assessment") || href.includes("/assessment")) kind = "assessment";

    const asgMatch = href.match(/\/assignment\/(\d+)/);
    items.push({
      id: itemId,
      kind,
      title,
      description: description ? description.slice(0, 300) : undefined,
      assignmentId: asgMatch?.[1],
      url: absUrl(baseUrl, href),
    });
  });

  return items;
}

export interface AssignmentDetail {
  id: string;
  title: string;
  course?: string;
  dueDate?: string;
  description: string;
  attachments: { title: string; url?: string }[];
  submissionStatus?: string;
  url: string;
}

export function parseAssignment(html: string, assignmentId: string, baseUrl: string): AssignmentDetail {
  const $ = cheerio.load(html);
  const title = cleanText($(".page-title").first()) || cleanText($("h1").first());
  const course = cleanText($(".course-title a, #header-course-title").first()) || undefined;
  const description = cleanMultiline($(".info-body").first());

  const dueCandidates = [
    cleanText($(".assignment-details .due-date")),
    cleanText($(".grading-due")),
    cleanText($(".info-container .due")),
  ].filter(Boolean);
  let dueDate = dueCandidates[0];
  if (!dueDate) {
    const bodyText = cleanText($("#main-inner"));
    const m = bodyText.match(/Due:\s*([^\n|]+?)(?:\s{2,}|$)/i);
    if (m) dueDate = m[1].trim();
  }

  const attachments: { title: string; url?: string }[] = [];
  $(".attachments-file, .attachments-link").each((_, el) => {
    const $att = $(el);
    const $a = $att.find("a").first();
    const attTitle = cleanText($a) || cleanText($att);
    const url = absUrl(baseUrl, $a.attr("href"));
    if (attTitle || url) {
      attachments.push({ title: attTitle || url || "Attachment", url });
    }
  });

  const submissionStatus =
    cleanText($("#right-column-inner .dropbox-submissions, #right-column-inner .submissions-list, #right-column-inner")) ||
    undefined;

  return {
    id: assignmentId,
    title,
    course,
    dueDate,
    description,
    attachments,
    submissionStatus: submissionStatus ? submissionStatus.slice(0, 300) : undefined,
    url: `${baseUrl}/assignment/${assignmentId}`,
  };
}

export interface FeedUpdate {
  author: string;
  course?: string;
  timestamp?: string;
  body: string;
  attachments: { title: string; url?: string }[];
}

export function parseFeed(html: string, baseUrl: string): FeedUpdate[] {
  const $ = cheerio.load(html);
  const updates: FeedUpdate[] = [];

  $(".s-edge-feed > li, ul.s-edge-feed > li").each((_, el) => {
    const $li = $(el);
    if ($li.hasClass("s-edge-feed-more-link") || $li.find(".s-edge-feed-more-link").length > 0 && $li.find(".update-body").length === 0) {
      return;
    }

    const author =
      cleanText($li.find(".long-username, .update-sentence-inner a").first()) ||
      cleanText($li.find(".edge-sentence a").first());
    const sentenceLinks = $li.find(".update-sentence-inner a, .edge-sentence a");
    const course = sentenceLinks.length > 1 ? cleanText($(sentenceLinks[1])) : undefined;
    const timestamp =
      cleanText($li.find(".small.gray, .edge-time, .created").first()) || undefined;
    const body =
      cleanMultiline($li.find(".update-body").first()) ||
      cleanText($li.find(".edge-main-wrapper").first());

    if (!author && !body) return;

    const attachments: { title: string; url?: string }[] = [];
    $li.find(".attachments-file a, .attachments-link a").each((__, a) => {
      const $a = $(a);
      const title = cleanText($a);
      const url = absUrl(baseUrl, $a.attr("href"));
      if (title || url) attachments.push({ title: title || url || "Attachment", url });
    });

    updates.push({
      author,
      course,
      timestamp,
      body: body.slice(0, 1200),
      attachments,
    });
  });

  return updates;
}

export interface PageContent {
  title: string;
  url: string;
  body: string;
  links: { text: string; url: string }[];
}

export function parseGenericPage(html: string, finalUrl: string, baseUrl: string): PageContent {
  const $ = cheerio.load(html);
  const title = cleanText($(".page-title").first()) || cleanText($("h1, h2").first()) || cleanText($("title").first());
  const $main = $("#content-wrapper, #main-inner, #center-inner").first();
  const $target = $main.length ? $main : $("body");

  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  $target.find("a[href]").each((_, a) => {
    const $a = $(a);
    const url = absUrl(baseUrl, $a.attr("href"));
    const text = cleanText($a);
    if (url && text && !seen.has(url)) {
      seen.add(url);
      links.push({ text, url });
    }
  });

  return {
    title,
    url: finalUrl,
    body: cleanMultiline($target).slice(0, 8000),
    links: links.slice(0, 40),
  };
}
