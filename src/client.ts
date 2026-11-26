import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";

export interface SchoologyConfig {
  baseUrl: string;
  username: string;
  password: string;
  schoolNid?: string;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  text: string;
  contentType: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let dotEnvLoaded = false;

/**
 * Lightweight .env loader (no external dependency). Only sets keys not already in process.env.
 */
export function loadDotEnv(cwd = process.cwd()): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  const candidates = [
    path.join(cwd, ".env"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    break;
  }
}

export function normalizeBaseUrl(raw?: string): string {
  const value = (raw || "https://app.schoology.com").trim();
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export function getConfigFromEnv(): SchoologyConfig {
  loadDotEnv();
  const baseUrl = normalizeBaseUrl(process.env.SCHOOLOGY_BASE_URL);
  const username = (process.env.SCHOOLOGY_USERNAME || "").trim();
  const password = process.env.SCHOOLOGY_PASSWORD || "";
  const schoolNid = (process.env.SCHOOLOGY_SCHOOL_NID || "").trim() || undefined;

  if (!username || !password) {
    throw new Error(
      "Missing Schoology credentials. Set SCHOOLOGY_BASE_URL, SCHOOLOGY_USERNAME, and SCHOOLOGY_PASSWORD environment variables (or add them to a .env file)."
    );
  }
  return { baseUrl, username, password, schoolNid };
}

export class SchoologyClient {
  private resolvedConfig: SchoologyConfig | null = null;
  private readonly configProvider: () => SchoologyConfig;
  private readonly cookies = new Map<string, string>();
  private loggedIn = false;
  private uid: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(configOrProvider: SchoologyConfig | (() => SchoologyConfig) = getConfigFromEnv) {
    if (typeof configOrProvider === "function") {
      this.configProvider = configOrProvider;
    } else {
      const normalized = {
        ...configOrProvider,
        baseUrl: normalizeBaseUrl(configOrProvider.baseUrl),
      };
      this.resolvedConfig = normalized;
      this.configProvider = () => normalized;
    }
  }

  private get config(): SchoologyConfig {
    if (!this.resolvedConfig) {
      const cfg = this.configProvider();
      this.resolvedConfig = {
        ...cfg,
        baseUrl: normalizeBaseUrl(cfg.baseUrl),
      };
    }
    return this.resolvedConfig;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private storeCookies(res: Response): void {
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "deleted" || value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async fetchFollow(
    urlOrPath: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
    maxRedirects = 8
  ): Promise<FetchResult> {
    let current = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${this.config.baseUrl}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
    let method = opts.method || "GET";
    let body = opts.body;
    const headers: Record<string, string> = { ...(opts.headers || {}) };

    for (let i = 0; i < maxRedirects; i++) {
      const reqHeaders: Record<string, string> = {
        "User-Agent": USER_AGENT,
        ...headers,
      };
      const ch = this.cookieHeader();
      if (ch) reqHeaders["Cookie"] = ch;

      const res = await fetch(current, {
        method,
        headers: reqHeaders,
        body,
        redirect: "manual",
      });
      this.storeCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          current = new URL(loc, current).toString();
          if (res.status === 301 || res.status === 302 || res.status === 303) {
            method = "GET";
            body = undefined;
            delete headers["Content-Type"];
          }
          continue;
        }
      }

      const text = await res.text();
      return {
        status: res.status,
        finalUrl: current,
        text,
        contentType: res.headers.get("content-type") || "",
      };
    }

    throw new Error(`Too many redirects fetching ${urlOrPath}`);
  }

  async ensureLoggedIn(force = false): Promise<void> {
    if (this.loggedIn && !force) return;
    if (this.loginPromise && !force) return this.loginPromise;

    this.loginPromise = this.performLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async performLogin(): Promise<void> {
    const cfg = this.config;
    this.cookies.clear();
    this.loggedIn = false;

    const entryPath = cfg.schoolNid
      ? `/login?&school=${encodeURIComponent(cfg.schoolNid)}`
      : "/";
    let loginPage = await this.fetchFollow(entryPath);

    // Detect external SSO redirect (e.g., Google, Microsoft, Clever, ClassLink)
    const expectedHost = new URL(cfg.baseUrl).hostname;
    const landedHost = new URL(loginPage.finalUrl).hostname;
    if (landedHost !== expectedHost && !landedHost.endsWith(".schoology.com")) {
      throw new Error(
        `Schoology instance redirected to external SSO host (${landedHost}). This server supports standard Schoology username/password login forms only.`
      );
    }

    let $ = cheerio.load(loginPage.text);
    let form = $("#s-user-login-form");

    // Fallback to /login directly if / did not redirect to the login form (e.g. app.schoology.com)
    if (form.length === 0 && !loginPage.finalUrl.includes("/login")) {
      loginPage = await this.fetchFollow("/login");
      $ = cheerio.load(loginPage.text);
      form = $("#s-user-login-form");
    }

    if (form.length === 0) {
      throw new Error(
        `Could not find Schoology login form (#s-user-login-form) at ${loginPage.finalUrl}. Check SCHOOLOGY_BASE_URL.`
      );
    }

    const action = form.attr("action") || "/login";
    const schoolNid = cfg.schoolNid || String(form.find('input[name="school_nid"]').val() || "");
    const formBuildId = String(form.find('input[name="form_build_id"]').val() || "");
    const formId = String(form.find('input[name="form_id"]').val() || "s_user_login_form");

    const params = new URLSearchParams();
    params.set("mail", cfg.username);
    params.set("pass", cfg.password);
    params.set("school_nid", schoolNid);
    params.set("form_build_id", formBuildId);
    params.set("form_id", formId);
    params.set("op", "Log in");

    const result = await this.fetchFollow(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (result.finalUrl.includes("/login") || result.status >= 400) {
      const $err = cheerio.load(result.text);
      const errMsg = $err(".messages.error").text().replace(/\s+/g, " ").trim();
      throw new Error(
        `Schoology login failed (status ${result.status})${errMsg ? `: ${errMsg}` : ""}. Check SCHOOLOGY_BASE_URL, SCHOOLOGY_USERNAME, and SCHOOLOGY_PASSWORD.`
      );
    }

    this.loggedIn = true;
    this.extractUid(result.text);
  }

  private extractUid(html: string): void {
    const match =
      html.match(/"uid"\s*:\s*"?(\d+)"?/) ||
      html.match(/\/calendar\/(\d+)\//) ||
      html.match(/\/user\/(\d+)/);
    if (match?.[1]) {
      this.uid = match[1];
    }
  }

  async getUid(): Promise<string> {
    await this.ensureLoggedIn();
    if (this.uid) return this.uid;
    const cal = await this.request("/user-calendar");
    const match = cal.finalUrl.match(/\/calendar\/(\d+)/);
    if (match?.[1]) {
      this.uid = match[1];
      return this.uid;
    }
    throw new Error("Could not determine Schoology user ID (uid).");
  }

  async request(pathOrUrl: string): Promise<FetchResult> {
    await this.ensureLoggedIn();
    let res = await this.fetchFollow(pathOrUrl);

    // Retry once if session expired and redirected to /login
    if (res.finalUrl.includes("/login") || res.status === 401 || res.status === 403) {
      await this.ensureLoggedIn(true);
      res = await this.fetchFollow(pathOrUrl);
    }

    if (res.status >= 400) {
      throw new Error(`Schoology request failed (${res.status}) for ${pathOrUrl}`);
    }
    return res;
  }

  async requestJson<T = unknown>(pathOrUrl: string): Promise<T> {
    const res = await this.request(pathOrUrl);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new Error(
        `Expected JSON from ${pathOrUrl}, got content-type "${res.contentType}" (snippet: ${res.text.slice(0, 120)})`
      );
    }
  }
}
