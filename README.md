# xiaohongshu-mcp-node

**用 Node.js 实现的 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)：协议、工具名、参数都一致，后端换成「本机 Chrome/Chromium + puppeteer-core 操作网页」。**

- 不需要 Go，不需要编译，**能跑在任何装得动 Chrome 的机器上**（包括 Android / Termux 这类 ARM64 环境）
- 不碰小红书的签名算法（不需要逆向 `x-s` / `x-s-common`），页面结构变了改选择器，签名变了不受影响
- 13 个工具与官方版同名同参，可以直接替换官方 MCP 服务，工作台/客户端配置不用改

> English: [README.en.md](README.en.md)

---

## 它是什么

一个 **MCP 服务（Streamable HTTP + JSON-RPC 2.0）**，监听 `http://127.0.0.1:18060/mcp`。
收到 `tools/call` 之后，它用 puppeteer-core 驱动一个本地 headless Chrome，在真实的小红书网页上完成搜索、看笔记、评论、点赞、收藏、发布等操作，再把结果整理成 JSON 返回。

```
MCP 客户端（Claude Code / Cursor / DSH 插件 / 任何 MCP 客户端）
        │  HTTP + JSON-RPC
        ▼
server.mjs（本仓库，Node）  ──puppeteer-core(CDP)──▶  本机 Chrome/Chromium（headless）
                                                          │
                                                          ▼
                                                   www.xiaohongshu.com
```

## 和官方版的区别

| 项 | 官方 xiaohongshu-mcp | 本项目 |
|---|---|---|
| 语言 / 运行时 | Go，预编译二进制（macOS arm64 / Windows x64 / Linux x64） | Node.js ≥ 20（纯 JS，无编译） |
| 浏览器 | 内置 Chromium（首次运行自动下载，约 150MB） | 复用你机器上的 Chrome/Chromium |
| ARM64 / Android | 无官方二进制，跑不了 | 可以（见 [docs/android-termux.md](docs/android-termux.md)，Termux 实测通过） |
| 协议 / 工具 | MCP，13 个工具 | 一致（同名同参数），可直接替换 |
| 签名算法 | 不需要（浏览器里由页面自己签） | 同样不需要 |
| 发布 | `publish_content` 直接发 | 默认**只上传+填好、停在待发布**，`confirm: true` 才自动点发布（防误发） |

## 特性

- **13 个工具**：登录状态、二维码、清 cookie、首页推荐、搜索、笔记详情、发评论、回复评论、点赞、收藏、用户主页、发图文、发视频
- **登录态持久化**：登录信息存在 Chromium 的 profile 目录，重启服务不用重新扫码
- **两种登录方式**：扫码（`get_login_qrcode` 返回 base64 图片）或手机号 + 短信验证码（`login-phone.mjs`）
- **全流程串行**：所有工具调用排队执行（浏览器只有一个标签页），避免互相打架
- **基础人味伪装**：UA、`navigator.webdriver`、语言、插件等做最小必要处理；被风控（300012）会返回可读的错误
- **发布安全默认**：图文/视频默认停在"待发布"，人确认后再点发布

## 快速开始

### 1. 准备

- Node.js ≥ 20
- 一个 Chrome / Chromium（本机已装即可；也可以指定路径）

```bash
git clone <本仓库地址> xiaohongshu-mcp-node
cd xiaohongshu-mcp-node
npm install
```

### 2. 指定浏览器（可选）

不指定时会自动找常见路径（`google-chrome`、`chromium`、macOS 的 `Google Chrome.app` 等）。找不到就显式给：

```bash
export XHS_BROWSER_BIN=/usr/bin/chromium            # 直接给二进制
# 或：用一个自己加参数的启动脚本（Android/Termux 这种需要 LD_PRELOAD 的场景）
export XHS_BROWSER_SCRIPT=$HOME/xhs-browser.sh
```

### 3. 启动

```bash
node server.mjs
# xiaohongshu-mcp(node) listening on http://127.0.0.1:18060/mcp  tools=13
```

后台运行 + 常用操作：

```bash
scripts/xhsctl.sh start     # 后台启动（日志 server.log）
scripts/xhsctl.sh status    # 健康检查
scripts/xhsctl.sh stop      # 停止（连同它拉起的浏览器）
```

### 4. 验证

```bash
node call.mjs check_login_status '{}'   # 是否登录
node call.mjs list_feeds '{}'           # 抓首页推荐（真实数据）
node call.mjs get_login_qrcode '{}'     # 拿登录二维码
```

## 接入 MCP 客户端

服务地址：`http://127.0.0.1:18060/mcp`（HTTP 传输，不是 stdio）。

**Claude Code**

```bash
claude mcp add --transport http xiaohongshu http://127.0.0.1:18060/mcp
```

**通用 JSON 配置（Cursor / 其它客户端）**

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

**DeepSeek Harness 的自媒体工作台插件**：插件里「小红书」tab 就是对着这套 13 个工具做的，地址填 `http://127.0.0.1:18060/mcp` 即可。

如果服务设了 `AUTH_TOKEN`，客户端要带 `Authorization: Bearer <token>`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_PORT` | `18060` | MCP 服务端口 |
| `AUTH_TOKEN` | 空 | 非空时要求 `Authorization: Bearer <token>` |
| `XHS_BROWSER_BIN` | 自动探测 | 浏览器二进制路径（自动加 headless 等参数） |
| `XHS_BROWSER_SCRIPT` | 空 | 自己加参数的启动脚本（优先级最高） |
| `XHS_CDP_PORT` | `9222` | 浏览器调试端口 |
| `XHS_PROFILE` | `~/xhs-profile` | 浏览器用户目录（登录态存在这里） |
| `XHS_TMP_DIR` | `<home>/xhs-upload` | 发布时下载图片的临时目录 |
| `XHS_UA` | Windows Chrome 131 | 页面 UA |

## 工具列表

| 工具 | 参数 | 说明 |
|---|---|---|
| `check_login_status` | — | 是否已登录、昵称 |
| `get_login_qrcode` | — | 返回 `{ qrcode: "data:image/png;base64,...", timeout }` |
| `delete_cookies` | — | 清 cookie（退出登录） |
| `list_feeds` | — | 首页推荐列表 |
| `search_feeds` | `keyword`；`filters.sort_by / note_type / publish_time` | 搜索（需登录） |
| `get_feed_detail` | `feed_id`, `xsec_token`；`load_all_comments`, `limit` | 笔记详情 + 评论 |
| `post_comment_to_feed` | `feed_id`, `xsec_token`, `content` | 发评论（需登录） |
| `reply_comment_in_feed` | 同上 + `comment_id`/`user_id` | 回复评论（需登录） |
| `like_feed` | `feed_id`, `xsec_token`, `unlike?` | 点赞/取消（需登录） |
| `favorite_feed` | `feed_id`, `xsec_token`, `unfavorite?` | 收藏/取消（需登录） |
| `user_profile` | `user_id`, `xsec_token?` | 用户主页 + 笔记列表 |
| `publish_content` | `title`, `content`, `images[]`, `tags[]`, `visibility`, `is_original`, `schedule_at`, `confirm?` | 发图文 |
| `publish_with_video` | `title`, `content`, `video`, `tags[]`, `visibility`, `schedule_at`, `confirm?` | 发视频 |

`feed_id` / `xsec_token` 从 `list_feeds`、`search_feeds`、`user_profile` 的返回里拿。

## 登录

**扫码**（需要另一台装了小红书 App 的手机）：

```bash
node call.mjs get_login_qrcode '{}'   # 拿 base64，粘到浏览器里看，或者存成 png
```

**手机号 + 短信验证码**（同一台设备就能完成）：

```bash
node login-phone.mjs 13800138000          # 发验证码
node login-phone.mjs 13800138000 123456   # 提交
node call.mjs check_login_status '{}'
```

登录后 cookie 存在 `XHS_PROFILE` 目录，`scripts/xhsctl.sh restart` 不会丢。

## 发布

```bash
# 图文：默认只上传 + 填好标题正文，停在待发布
node call.mjs publish_content '{"title":"标题","content":"正文","images":["https://example.com/a.jpg"]}'

# 视频：给本机绝对路径
node call.mjs publish_with_video '{"title":"标题","content":"正文","video":"/path/to/clip.mp4"}'
```

- 默认**不会**替你点「发布」，到创作中心确认后再点；确认无误可以传 `"confirm": true` 自动点。
- 图片既可以是 http(s) 链接（服务会先下载），也可以是本机文件路径。
- 定时发布 `schedule_at` 目前只做提示（需要在创作中心手动设置）。
- 可见范围、原创声明会尝试按文案点击，页面结构变了可能会失效。

## 常见问题

- **`找不到浏览器`**：设置 `XHS_BROWSER_BIN` 或 `XHS_BROWSER_SCRIPT`。
- **`小红书风控拦截（300012）`**：请求太密或 IP 被标记，等几分钟再试；不要并发打。
- **`看笔记详情需要先登录` / `搜索需要先登录`**：先登录。
- **登录二维码过期**：重新调 `get_login_qrcode`；或者在 tab 里点「重新连接」再取。
- **`用户主页没抓到`**：通常是限流，等一会再试（代码里已经带一次重试）。
- **页面结构变了**：改 `lib/xhs.mjs` 里对应的选择器（都集中在 `scrapeNotes` / `fetchDetail` / `publishContent` 几个函数里）。

## 已知限制

- 小红书风控（300012）会拦自动化请求；本项目只做最小伪装，**不承诺规避风控**，高频使用会被限流。
- 搜索、评论、点赞、收藏、发布都需要登录；未登录只能看首页和公开笔记详情。
- DOM 选择器依赖页面结构，小红书改版可能需要跟着改。
- 浏览器单进程运行（`--single-process --no-zygote` 为了兼容 Android），并发能力有限，服务内部已串行化。
- 自动化操作小红书存在账号风险，请自行评估，不要用于刷量、爬取隐私数据等违规用途。

## Android / Termux

官方没有 Linux ARM64 二进制，但这个 Node 版可以在 Android 上跑：用 Termux 里能装的 Chromium，加一个 `LD_PRELOAD` 垫片修正 Android 构建里写死的资源路径。
完整步骤（含实测记录与踩坑）：[docs/android-termux.md](docs/android-termux.md)。

## 致谢

- [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)：协议、工具设计、参数语义都来自它
- [puppeteer](https://pptr.dev/)：浏览器自动化

## License

MIT