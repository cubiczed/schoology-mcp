# schoology-mcp

A lightweight, browserless [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for Schoology.

Most student Schoology accounts cannot generate OAuth API keys at `/api`. `schoology-mcp` solves this by authenticating directly through Schoology's standard web login form, maintaining an in-memory session cookie (with automatic re-login on expiry), and parsing Schoology's internal JSON/AJAX endpoints and HTML pages with Node `fetch` + `cheerio`.

No headless browser, no background daemon, and works with any MCP-compatible harness (**Claude Code**, **OpenAI Codex**, **Antigravity**, **Cursor**, **Claude Desktop**, etc.).

## Features

- **Browserless and fast:** Pure Node.js (`fetch` + `cheerio`), starts in milliseconds over stdio, and stops automatically when your MCP client exits.
- **Works with any standard Schoology instance:** Configurable with any `SCHOOLOGY_BASE_URL` (e.g. `https://app.schoology.com` or `https://your-school.schoology.com`), `SCHOOLOGY_USERNAME`, and `SCHOOLOGY_PASSWORD`.
- **Automatic session management:** Logs in lazily on the first tool call and automatically re-authenticates if the session expires.
- **8 read-only MCP tools:**
  | Tool | Description |
  | --- | --- |
  | `list_courses` | List all enrolled courses with section IDs, course codes, instructors, and URLs |
  | `get_upcoming` | Fetch upcoming submissions, overdue submissions, and/or upcoming events (`kind`: `all` \| `upcoming` \| `overdue` \| `events`) |
  | `get_calendar` | Fetch calendar events and assignment due dates for a date range (`start_date`, `end_date`) |
  | `get_grades` | Fetch overall grades by course and grading period, plus optional per-assignment grade rows (`section_id`, `include_items`) |
  | `get_course_materials` | List folders and items (assignments, pages, files, links, discussions) inside a course or subfolder (`section_id`, `folder_id`) |
  | `get_assignment` | Fetch assignment instructions, due date, attachments, and submission status (`assignment_id`) |
  | `get_updates` | Fetch recent announcements from the home activity feed or a specific course (`section_id`, `page`) |
  | `get_page` | Extract readable text and links from any page or discussion path/URL on your Schoology instance |

> **Note on SSO:** This server supports Schoology instances that use standard Schoology username/password login forms (`#s-user-login-form`). Instances that redirect exclusively to external SSO providers (Google, Microsoft, Clever, ClassLink) are not currently supported.

## Installation

Requires **Node.js 18+**.

```bash
git clone https://github.com/cubiczed/schoology-mcp.git
cd schoology-mcp
npm install
npm run build
```

## Configuration

Set the following environment variables either in your MCP client config (recommended) or in a local `.env` file in the repo root (see [`.env.example`](.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `SCHOOLOGY_BASE_URL` | No (default: `https://app.schoology.com`) | Your Schoology URL, e.g. `https://your-school.schoology.com` |
| `SCHOOLOGY_USERNAME` | Yes | Your Schoology username or email |
| `SCHOOLOGY_PASSWORD` | Yes | Your Schoology password |
| `SCHOOLOGY_SCHOOL_NID` | No | Optional school NID if logging in via `app.schoology.com` |

## Harness Setup

Replace `/absolute/path/to/schoology-mcp` with the path where you cloned the repo.

### Claude Code

```bash
claude mcp add schoology \
  -e SCHOOLOGY_BASE_URL=https://your-school.schoology.com \
  -e SCHOOLOGY_USERNAME=your-username \
  -e SCHOOLOGY_PASSWORD=your-password \
  -- node /absolute/path/to/schoology-mcp/dist/index.js
```

### OpenAI Codex CLI

```bash
codex mcp add schoology \
  --env SCHOOLOGY_BASE_URL=https://your-school.schoology.com \
  --env SCHOOLOGY_USERNAME=your-username \
  --env SCHOOLOGY_PASSWORD=your-password \
  -- node /absolute/path/to/schoology-mcp/dist/index.js
```

Or add directly to `~/.codex/config.toml`:

```toml
[mcp_servers.schoology]
command = "node"
args = ["/absolute/path/to/schoology-mcp/dist/index.js"]

[mcp_servers.schoology.env]
SCHOOLOGY_BASE_URL = "https://your-school.schoology.com"
SCHOOLOGY_USERNAME = "your-username"
SCHOOLOGY_PASSWORD = "your-password"
```

### Antigravity / Cursor / Claude Desktop

Add to your MCP config file (e.g. `~/.gemini/config/mcp_config.json`, `~/.cursor/mcp.json`, or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "schoology": {
      "command": "node",
      "args": ["/absolute/path/to/schoology-mcp/dist/index.js"],
      "env": {
        "SCHOOLOGY_BASE_URL": "https://your-school.schoology.com",
        "SCHOOLOGY_USERNAME": "your-username",
        "SCHOOLOGY_PASSWORD": "your-password"
      }
    }
  }
}
```

*(On macOS, if your MCP client does not inherit Homebrew's `PATH`, use the full path to `node`, such as `/opt/homebrew/bin/node`.)*

## Security

- Credentials are only sent to your configured `SCHOOLOGY_BASE_URL` over HTTPS and are never logged.
- Session cookies are kept strictly in memory for the lifetime of the stdio process.
- `.env` is listed in `.gitignore` so local credentials are never committed.

## License

MIT
