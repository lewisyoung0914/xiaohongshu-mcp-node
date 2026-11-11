// 一个和 xiaohongshu-mcp 同协议的 MCP 服务（Streamable HTTP + JSON-RPC 2.0），
// 后端不是 Go + rod，而是本地 Chromium + puppeteer-core，直接操作小红书网页。
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensurePage } from './lib/browser.mjs'
import {
  confirmPublish, deleteCookies, favoriteFeed, fetchDetail, fetchFeeds, likeFeed, loginQrcode,
  loginState, postComment, publishContent, publishVideo, replyComment, searchFeeds, userProfile,
} from './lib/xhs.mjs'

const PORT = Number(process.env.MCP_PORT || 18060)
const TOKEN = process.env.AUTH_TOKEN || ''
const VERSION = '0.1.0-node'
const PROTOCOL = '2025-06-18'

const TOOLS = [
  {
    name: 'check_login_status',
    description: '检查小红书登录状态',
    inputSchema: { type: 'object', properties: {} },
    run: async ({ page }) => loginState(page),
  },
  {
    name: 'get_login_qrcode',
    description: '获取登录二维码，返回 base64 图片和超时时间',
    inputSchema: { type: 'object', properties: {} },
    run: async ({ page }) => loginQrcode(page),
  },
  {
    name: 'delete_cookies',
    description: '删除 cookies 文件，重置登录状态，删除后需要重新登录',
    inputSchema: { type: 'object', properties: {} },
    run: async ({ page }) => deleteCookies(page),
  },
  {
    name: 'list_feeds',
    description: '获取小红书首页推荐列表',
    inputSchema: { type: 'object', properties: {} },
    run: async ({ page }) => fetchFeeds(page),
  },
  {
    name: 'search_feeds',
    description: '搜索小红书内容',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        filters: {
          type: 'object',
          description: '筛选：sort_by 综合/最新/最多点赞/最多评论/最多收藏；note_type 不限/视频/图文；publish_time 不限/一天内/一周内/半年内',
          properties: {
            sort_by: { type: 'string' },
            note_type: { type: 'string' },
            publish_time: { type: 'string' },
            search_scope: { type: 'string' },
            location: { type: 'string' },
          },
        },
      },
      required: ['keyword'],
    },
    run: async ({ page, args }) => searchFeeds(page, { keyword: args.keyword, filters: args.filters }),
  },
  {
    name: 'get_feed_detail',
    description: '获取帖子详情，包括互动数据和评论',
    inputSchema: {
      type: 'object',
      properties: {
        feed_id: { type: 'string' },
        xsec_token: { type: 'string' },
        load_all_comments: { type: 'boolean' },
        limit: { type: 'number' },
        click_more_replies: { type: 'boolean' },
        reply_limit: { type: 'number' },
        scroll_speed: { type: 'string' },
      },
      required: ['feed_id', 'xsec_token'],
    },
    run: async ({ page, args }) => fetchDetail(page, args),
  },
  {
    name: 'post_comment_to_feed',
    description: '发表评论到小红书帖子',
    inputSchema: {
      type: 'object',
      properties: { feed_id: { type: 'string' }, xsec_token: { type: 'string' }, content: { type: 'string' } },
      required: ['feed_id', 'xsec_token', 'content'],
    },
    run: async ({ page, args }) => postComment(page, args),
  },
  {
    name: 'reply_comment_in_feed',
    description: '回复笔记下的指定评论',
    inputSchema: {
      type: 'object',
      properties: {
        feed_id: { type: 'string' }, xsec_token: { type: 'string' }, content: { type: 'string' },
        comment_id: { type: 'string' }, user_id: { type: 'string' },
      },
      required: ['feed_id', 'xsec_token', 'content'],
    },
    run: async ({ page, args }) => replyComment(page, args),
  },
  {
    name: 'like_feed',
    description: '点赞/取消点赞',
    inputSchema: {
      type: 'object',
      properties: { feed_id: { type: 'string' }, xsec_token: { type: 'string' }, unlike: { type: 'boolean' } },
      required: ['feed_id', 'xsec_token'],
    },
    run: async ({ page, args }) => likeFeed(page, args),
  },
  {
    name: 'favorite_feed',
    description: '收藏/取消收藏',
    inputSchema: {
      type: 'object',
      properties: { feed_id: { type: 'string' }, xsec_token: { type: 'string' }, unfavorite: { type: 'boolean' } },
      required: ['feed_id', 'xsec_token'],
    },
    run: async ({ page, args }) => favoriteFeed(page, args),
  },
  {
    name: 'user_profile',
    description: '获取用户个人主页信息',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' }, xsec_token: { type: 'string' } },
      required: ['user_id', 'xsec_token'],
    },
    run: async ({ page, args }) => userProfile(page, args),
  },
  {
    name: 'publish_content',
    description: '发布图文内容到小红书（上传图片并填好标题正文，默认停在「待发布」由人确认）',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, content: { type: 'string' },
        images: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        visibility: { type: 'string' }, is_original: { type: 'boolean' }, schedule_at: { type: 'string' },
        confirm: { type: 'boolean', description: 'true = 直接点「发布」，默认 false 只填好' },
      },
      required: ['title', 'content', 'images'],
    },
    run: async ({ page, args }) => {
      const result = await publishContent(page, args)
      if (args.confirm) return { ...result, ...(await confirmPublish(page)) }
      return result
    },
  },
  {
    name: 'publish_with_video',
    description: '发布视频内容（把本机可访问的视频文件路径上传，默认停在「待发布」）',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, content: { type: 'string' }, video: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        visibility: { type: 'string' }, schedule_at: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['title', 'content', 'video'],
    },
    run: async ({ page, args }) => {

      const result = await publishVideo(page, args)
      if (args.confirm) return { ...result, ...(await confirmPublish(page)) }
      return result
    },
  },
]

// 工具级短缓存：同样的搜索/首页在 TTL 内直接复用，避免重复整页导航
const CACHE = new Map()
const CACHE_TTL = Number(process.env.XHS_CACHE_TTL ?? 20000)
const CACHEABLE = new Set(['list_feeds', 'search_feeds'])

let chain = Promise.resolve()
/** 所有工具调用串行执行：浏览器只有一个标签页。 */
function serialize(task) {
  const run = chain.then(task, task)
  chain = run.catch(() => {})
  return run
}

async function callTool(name, args) {
  const tool = TOOLS.find(row => row.name === name)
  if (!tool) throw Object.assign(new Error(`未知工具 ${name}`), { status: 400 })
  const payload = args ?? {}
  const cacheKey = `${name}:${JSON.stringify(payload)}`
  if (CACHEABLE.has(name) && CACHE_TTL > 0) {
    const hit = CACHE.get(cacheKey)
    if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true }
  }
  const result = await serialize(async () => {
    const page = await ensurePage()
    return tool.run({ page, args: payload })
  })
  if (CACHEABLE.has(name) && CACHE_TTL > 0) CACHE.set(cacheKey, { expires: Date.now() + CACHE_TTL, value: result })
  return result
}

function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

async function handleRpc(message) {
  const { method, params, id } = message
  if (method === 'initialize') {
    return { result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'xiaohongshu-mcp', version: VERSION } } }
  }
  if (method === 'tools/list') return { result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
  if (method === 'tools/call') {
    const name = params?.name
    try {
      const payload = await callTool(name, params?.arguments ?? {})
      return { result: textResult(payload) }
    } catch (err) {
      console.error('[mcp] tool error', name, err.message)
      return { result: textResult({ error: err.message, tool: name }, true) }
    }
  }
  if (method === 'ping') return { result: {} }
  if (method && method.startsWith('notifications/')) return null
  return { error: { code: -32601, message: `Method not found: ${method}` } }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
}
const UPLOAD_DIR = process.env.XHS_UPLOAD_DIR || '/data/data/com.dsharnessmobile.shell/files/home/xhs-upload'
const IMG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// 上传目录的保留策略：超过 3 天或总量超过 200MB 就删旧的（图片代理本身不落盘，这里只管发布用的本机文件）
const UPLOAD_MAX_AGE_MS = Number(process.env.XHS_UPLOAD_MAX_AGE_DAYS || 3) * 86400000
const UPLOAD_MAX_BYTES = Number(process.env.XHS_UPLOAD_MAX_BYTES || 200 * 1024 * 1024)

/** 清理上传目录：先删过期的，再按最旧优先删到总量上限以内。 */
async function pruneUploads() {
  let names = []
  try {
    names = await readdir(UPLOAD_DIR)
  } catch {
    return
  }
  const rows = []
  let total = 0
  for (const name of names) {
    const file = join(UPLOAD_DIR, name)
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      rows.push({ file, size: info.size, mtime: info.mtimeMs })
      total += info.size
    } catch {}
  }
  const now = Date.now()
  const stale = rows.filter(row => now - row.mtime > UPLOAD_MAX_AGE_MS)
  for (const row of stale) {
    await unlink(row.file).catch(() => {})
    total -= row.size
  }
  if (total > UPLOAD_MAX_BYTES) {
    const fresh = rows.filter(row => !stale.includes(row)).sort((a, b) => a.mtime - b.mtime)
    for (const row of fresh) {
      if (total <= UPLOAD_MAX_BYTES) break
      await unlink(row.file).catch(() => {})
      total -= row.size
    }
  }
}

/** 小红书 CDN 有防盗链，浏览器直连会 403：这里带 Referer 代取，再吐给工作台。 */
async function proxyImage(res, target, req) {
  if (!/^https?:\/\//.test(String(target ?? ''))) {
    res.writeHead(400, CORS).end('bad url')
    return
  }
  try {
    // 视频要支持 Range，否则浏览器拖动进度条会失败
    const range = req?.headers?.range
    const upstream = await fetch(target, {
      headers: {
        referer: 'https://www.xiaohongshu.com/',
        'user-agent': IMG_UA,
        accept: 'image/avif,image/webp,image/*,video/*,*/*',
        ...(range ? { range } : {}),
      },
      signal: AbortSignal.timeout(30000),
    })
    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(502, CORS).end(`upstream ${upstream.status}`)
      return
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    const headers = {
      ...CORS,
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': 'public, max-age=3600',
      'accept-ranges': 'bytes',
      'content-length': buf.length,
    }
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) headers['content-range'] = contentRange
    res.writeHead(upstream.status === 206 ? 206 : 200, headers).end(buf)
  } catch (err) {
    res.writeHead(502, CORS).end(`fetch failed: ${err.message}`)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end()
    return
  }
  if (url.pathname === '/img') {
    await proxyImage(res, url.searchParams.get('u'), req)
    return
  }
  if (url.pathname === '/upload' && req.method === 'POST') {
    // 本机文件上传：收到原始字节存成文件，返回绝对路径（发布时直接给 MCP 用）
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const buf = Buffer.concat(chunks)
    if (!buf.length) {
      res.writeHead(400, CORS).end('empty body')
      return
    }
    const type = String(req.headers['content-type'] ?? 'application/octet-stream')
    const extByType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
    const ext = extByType[type.split(';')[0]] ?? (/\.([a-z0-9]+)$/i.exec(String(req.headers['x-filename'] ?? ''))?.[1] ?? 'bin')
    await mkdir(UPLOAD_DIR, { recursive: true })
    await pruneUploads()
    const name = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`
    const file = join(UPLOAD_DIR, name)
    await writeFile(file, buf)
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ path: file, name, size: buf.length, src: `/local/${name}` }))
    return
  }
  if (url.pathname.startsWith('/local/') && req.method === 'GET') {
    // 预览用：把刚上传的文件吐回去
    const name = url.pathname.slice('/local/'.length)
    if (!/^[\w.-]+$/.test(name)) {
      res.writeHead(400, CORS).end()
      return
    }
    try {
      const buf = await readFile(join(UPLOAD_DIR, name))
      const ext = name.split('.').pop() ?? ''
      const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }
      res.writeHead(200, { ...CORS, 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'public, max-age=600' }).end(buf)
    } catch {
      res.writeHead(404, CORS).end()
    }
    return
  }
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'xiaohongshu-mcp', version: VERSION, tools: TOOLS.length }))
    return
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end()
    return
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let message
  try {
    message = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    res.writeHead(400).end()
    return
  }
  if (!message) {
    res.writeHead(400).end()
    return
  }
  const headers = { ...CORS, 'content-type': 'application/json' }
  if (message.method === 'initialize') headers['mcp-session-id'] = randomUUID()

  if (!message.id) {
    // 通知（notifications/initialized 等）直接 202
    await handleRpc(message).catch(() => {})
    res.writeHead(202).end()
    return
  }
  const outcome = await handleRpc(message)
  const payload = outcome.error
    ? { jsonrpc: '2.0', id: message.id, error: outcome.error }
    : { jsonrpc: '2.0', id: message.id, result: outcome.result }
  if (String(req.headers.accept ?? '').includes('text/event-stream')) {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    return
  }
  res.writeHead(200, headers).end(JSON.stringify(payload))
})

pruneUploads().catch(() => {})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`xiaohongshu-mcp(node) listening on http://127.0.0.1:${PORT}/mcp  tools=${TOOLS.length}${TOKEN ? ' (token required)' : ''}`)
  // 预热：提前把浏览器和首页拉起来，别让第一次工具调用等浏览器启动
  ;(async () => {
    try {
      const page = await ensurePage()
      const { goto } = await import('./lib/xhs.mjs')
      await goto(page, 'https://www.xiaohongshu.com/explore', { wait: 500, timeout: 45000 })
      console.log('[warmup] 浏览器与首页就绪')
    } catch (err) {
      console.error('[warmup] 预热失败（不影响使用）:', err.message)
    }
  })()
})

// 退出时收尾
process.on('SIGINT', () => server.close(() => process.exit(0)))
process.on('SIGTERM', () => server.close(() => process.exit(0)))