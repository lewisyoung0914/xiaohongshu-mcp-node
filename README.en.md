# xiaohongshu-mcp-node

**An MCP server for Xiaohongshu / RedNote written in Node.js — same protocol, same tool names and arguments as [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp), but the backend is a local Chrome/Chromium driven by puppeteer-core.**

- No Go, no compilation — it runs anywhere Chrome can run, **including ARM64 devices such as Android / Termux**
- No reverse engineering of Xiaohongshu's request signing (`x-s` / `x-s-common`): the real page does the signing, we just drive the UI
- 13 tools with the same names/parameters as the original, so it is a drop-in replacement for the official MCP server

> 中文文档：[README.md](README.md)

---

## What it is

An **MCP server (Streamable HTTP + JSON-RPC 2.0)** listening on `http://127.0.0.1:18060/mcp`.

For every `tools/call` it drives a local headless Chrome with puppeteer-core: search, read notes, comment, like, favorite and publish on the real Xiaohongshu website, then returns normalized JSON.

```
MCP client (Claude Code / Cursor / DSH plugin / any MCP client)
        │  HTTP + JSON-RPC
        ▼
server.mjs (this repo, Node)  ──puppeteer-core (CDP)──▶  local Chrome/Chromium (headless)
                                                           │
                                                           ▼
                                                    www.xiaohongshu.com
```

## How it differs from the official server

| | Official xiaohongshu-mcp | This project |
|---|---|---|
| Language / runtime | Go, prebuilt binaries (macOS arm64 / Windows x64 / Linux x64) | Node.js ≥ 20 (plain JS, nothing to build) |
| Browser | Bundled Chromium (~150 MB, downloaded on first run) | Reuses the Chrome/Chromium already on your machine |
| ARM64 / Android | No official binary, cannot run | Works (see [docs/android-termux.md](docs/android-termux.md), verified on Termux) |
| Protocol / tools | MCP, 13 tools | Identical (same names and arguments) |
| Request signing | Not needed (the page signs itself) | Same |
| Publishing | `publish_content` publishes immediately | Uploads and fills the form, then **stops at "ready to publish"**; `confirm: true` clicks publish for you |

## Features

- **13 tools**: login status, QR code, clear cookies, home feed, search, note detail, comment, reply, like, favorite, user profile, publish image note, publish video note
- **Persistent login**: cookies live in the Chromium profile directory, so restarts don't require re-scanning the QR code
- **Two ways to sign in**: QR code (`get_login_qrcode` returns a base64 image) or phone number + SMS code (`login-phone.mjs`)
- **Serialized execution**: every tool call is queued (a single browser tab), so calls never fight each other
- **Minimal browser disguise**: UA, `navigator.webdriver`, languages and plugins are patched just enough; risk-control (300012) produces a readable error
- **Safe publishing default**: image/video posts stop before the final publish click

## Quick start

### 1. Requirements

- Node.js ≥ 20
- A Chrome/Chromium installation (or point to one explicitly)

```bash
git clone <this repo> xiaohongshu-mcp-node
cd xiaohongshu-mcp-node
npm install
```

### 2. Point to a browser (optional)

If omitted, common paths are tried (`google-chrome`, `chromium`, macOS `Google Chrome.app`, …).

```bash
export XHS_BROWSER_BIN=/usr/bin/chromium            # binary, flags are added for you
# or a wrapper script that adds its own flags (e.g. Android/Termux with LD_PRELOAD)
export XHS_BROWSER_SCRIPT=$HOME/xhs-browser.sh
```

### 3. Run

```bash
node server.mjs
# xiaohongshu-mcp(node) listening on http://127.0.0.1:18060/mcp  tools=13
```

Background helpers:

```bash
scripts/xhsctl.sh start     # start in background (logs to server.log)
scripts/xhsctl.sh status    # health check
scripts/xhsctl.sh stop      # stop the server and the browser it spawned
```

### 4. Smoke test

```bash
node call.mjs check_login_status '{}'   # signed in?
node call.mjs list_feeds '{}'           # home feed (live data)
node call.mjs get_login_qrcode '{}'     # QR code for signing in
```

## Connect an MCP client

Endpoint: `http://127.0.0.1:18060/mcp` (HTTP transport, not stdio).

**Claude Code**

```bash
claude mcp add --transport http xiaohongshu http://127.0.0.1:18060/mcp
```

**Generic JSON config (Cursor / others)**

```json
{
  "mcpServers": {
    "xiaohongshu": {
      "url": "http://127.0.0.1:18060/mcp",
      "type": "http"
    }
  }
}
```

**DeepSeek Harness media workbench plugin**: its "Xiaohongshu" tab is built exactly against these 13 tools — just set the address to `http://127.0.0.1:18060/mcp`.

If the server runs with `AUTH_TOKEN`, clients must send `Authorization: Bearer <token>`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `18060` | MCP server port |
| `AUTH_TOKEN` | empty | When set, requires `Authorization: Bearer <token>` |
| `XHS_BROWSER_BIN` | auto-detect | Browser binary (headless flags added automatically) |
| `XHS_BROWSER_SCRIPT` | empty | Wrapper script that adds its own flags (highest priority) |
| `XHS_CDP_PORT` | `9222` | Browser debugging port |
| `XHS_PROFILE` | `~/xhs-profile` | Browser user-data directory (login state lives here) |
| `XHS_TMP_DIR` | `<home>/xhs-upload` | Temp directory for images downloaded before publishing |
| `XHS_UA` | Windows Chrome 131 | User agent used by pages |

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `check_login_status` | — | Whether signed in, plus nickname |
| `get_login_qrcode` | — | `{ qrcode: "data:image/png;base64,...", timeout }` |
| `delete_cookies` | — | Clear cookies (sign out) |
| `list_feeds` | — | Home feed |
| `search_feeds` | `keyword`; `filters.sort_by / note_type / publish_time` | Search (requires login) |
| `get_feed_detail` | `feed_id`, `xsec_token`; `load_all_comments`, `limit` | Note detail + comments |
| `post_comment_to_feed` | `feed_id`, `xsec_token`, `content` | Post a comment (requires login) |
| `reply_comment_in_feed` | same + `comment_id` / `user_id` | Reply to a comment (requires login) |
| `like_feed` | `feed_id`, `xsec_token`, `unlike?` | Like / unlike (requires login) |
| `favorite_feed` | `feed_id`, `xsec_token`, `unfavorite?` | Favorite / unfavorite (requires login) |
| `user_profile` | `user_id`, `xsec_token?` | User profile + notes |
| `publish_content` | `title`, `content`, `images[]`, `tags[]`, `visibility`, `is_original`, `schedule_at`, `confirm?` | Publish an image note |
| `publish_with_video` | `title`, `content`, `video`, `tags[]`, `visibility`, `schedule_at`, `confirm?` | Publish a video note |

`feed_id` / `xsec_token` come from the output of `list_feeds`, `search_feeds` or `user_profile`.

## Signing in

**QR code** (needs another phone with the Xiaohongshu app):

```bash
node call.mjs get_login_qrcode '{}'   # base64 PNG – open it or save it as a file
```

**Phone number + SMS code** (no second device needed):

```bash
node login-phone.mjs 13800138000          # send the code
node login-phone.mjs 13800138000 123456   # submit it
node call.mjs check_login_status '{}'
```

Cookies are stored in `XHS_PROFILE`, so `scripts/xhsctl.sh restart` keeps you signed in.

## Publishing

```bash
# Image note: uploads images and fills the form, stops before publishing
node call.mjs publish_content '{"title":"Title","content":"Body","images":["https://example.com/a.jpg"]}'

# Video note: absolute path on this machine
node call.mjs publish_with_video '{"title":"Title","content":"Body","video":"/path/to/clip.mp4"}'
```

- By default it **does not** click the final "Publish" button — review it in the creator center and publish manually; pass `"confirm": true` to let the server click it.
- Images can be http(s) URLs (downloaded first) or local file paths.
- `schedule_at` is currently advisory only (set it in the creator center).
- Visibility / original declaration are clicked by matching visible text and may break if the page changes.

## Troubleshooting

- **`找不到浏览器` / no browser found**: set `XHS_BROWSER_BIN` or `XHS_BROWSER_SCRIPT`.
- **`小红书风控拦截（300012）`**: requests too frequent or the IP is flagged — wait a few minutes, avoid concurrency.
- **"sign in first" errors**: sign in (`get_login_qrcode` or `login-phone.mjs`).
- **QR code expired**: request a new one.
- **`用户主页没抓到`**: usually rate limiting; retry after a while (one retry is built in).
- **Page structure changed**: the selectors live in `lib/xhs.mjs` (`scrapeNotes`, `fetchDetail`, `publishContent`).

## Limitations

- Xiaohongshu risk control (300012) will block automated traffic; the disguise here is minimal and **circumvention is not promised**. Heavy use gets rate limited.
- Search, comments, likes, favorites and publishing require a signed-in account; without login you only get the home feed and public note details.
- DOM selectors depend on page structure and may need updates after a redesign.
- The browser runs single-process (`--single-process --no-zygote` for Android compatibility), so concurrency is limited; the server serializes all tool calls.
- Automating Xiaohongshu carries account risk. Use it responsibly — no spam, no scraping private data, no violations of the platform's terms.

## Android / Termux

The official server has no Linux ARM64 binary, but this Node version runs on Android: use the Chromium available in Termux plus a small `LD_PRELOAD` shim that fixes the hard-coded resource paths of the Android build.
Full walkthrough, including measured results and pitfalls: [docs/android-termux.md](docs/android-termux.md).

## Credits

- [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) — protocol, tool design and argument semantics
- [puppeteer](https://pptr.dev/) — browser automation

## License

MIT