// 小红书页面操作层：全部通过真实浏览器 DOM 完成，不碰签名算法。
// 一条铁律：所有操作串行（ensurePage 每个调用复用同一页），避免互相打架。
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { blockedByRisk, ensurePage, goto, UA } from './browser.mjs'

const BASE = 'https://www.xiaohongshu.com'
const wait = ms => new Promise(r => setTimeout(r, ms))

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const log = (...args) => console.error('[xhs]', ...args)

/** 把 "1.2万" 这种计数转成数字，解析不了就原样返回。 */
export function parseCount(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return 0
  const m = /^([\d.]+)\s*(万|w|W|亿)?/.exec(raw)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') return Math.round(n * 10000)
  if (m[2] === '亿') return Math.round(n * 100000000)
  return Math.round(n)
}

/** 从笔记卡片的 href 里取 id 与 xsec_token。 */
export function parseNoteHref(href) {
  const text = String(href ?? '')
  const id = /\/explore\/([0-9a-zA-Z]+)/.exec(text)?.[1] ?? ''
  const token = /[?&]xsec_token=([^&]+)/.exec(text)?.[1] ?? ''
  return { id, token: decodeURIComponent(token) }
}

export function noteHref(id, token) {
  return token
    ? `${BASE}/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search`
    : `${BASE}/explore/${id}`
}

/** 抓当前页面上的笔记列表。 */
export async function scrapeNotes(page, limit = 24) {
  return page.evaluate((max) => {
    const rows = [...document.querySelectorAll('section.note-item')].slice(0, max).map((sec) => {
      const q = (s) => sec.querySelector(s)
      const coverA = q('a.cover')
      const href = coverA?.getAttribute('href') ?? ''
      const idMatch = /\/explore\/([0-9a-zA-Z]+)/.exec(href)
      const tokenMatch = /[?&]xsec_token=([^&]+)/.exec(href)
      const img = coverA?.querySelector('img')
      return {
        note_id: idMatch ? idMatch[1] : sec.getAttribute('data-note-id') ?? '',
        xsec_token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : '',
        title: (q('.footer .title')?.innerText ?? '').trim(),
        author: (q('.footer .author')?.innerText ?? '').trim(),
        liked_count: (q('.like-wrapper .count')?.innerText ?? '').trim(),
        cover: img?.getAttribute('src') ?? '',
        video: Boolean(q('.play-icon')),
      }
    })
    return rows
  }, limit)
}

/** 确保浏览器停在某个可用页面（风控页时退回家页再试）。 */
export async function ensureHome(page) {
  if (!page.url().startsWith(BASE) || blockedByRisk(page)) {
    await goto(page, `${BASE}/explore`, { selector: 'section.note-item', wait: 2500 })
  }
  return page
}

/** 登录状态：侧栏有没有用户入口 / 登录按钮。 */
export async function loginState(page) {
  await ensureHome(page)
  const state = await page.evaluate(() => {
    const text = document.body.innerText ?? ''
    const hasLoginBtn = Boolean(document.querySelector('#login-btn, .login-btn'))
    const loginModal = Boolean(document.querySelector('.login-container'))
    const sideUser = document.querySelector('.side-bar .user .link-wrapper, .side-bar .user img')
    const nick = document.querySelector('.side-bar .user .name, .side-bar .user .nickname')?.innerText?.trim() ?? ''
    const avatar = document.querySelector('.side-bar .user img')?.getAttribute('src') ?? ''
    return { hasLoginBtn, loginModal, hasSideUser: Boolean(sideUser), nick, avatar, textLen: text.length }
  })
  const loggedIn = Boolean(state.hasSideUser && !state.hasLoginBtn) && !state.loginModal
  return { logged_in: loggedIn, nickname: state.nick || null, raw: state }
}

/** 打开登录弹窗并取二维码（data:image/png;base64） */
export async function loginQrcode(page) {
  await ensureHome(page)
  if (!(await page.$('.login-container'))) {
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.login-btn, #login-btn, .side-bar .login-btn')
      if (btn) { btn.click(); return true }
      const any = [...document.querySelectorAll('button, div, span')].find(el => el.textContent?.trim() === '登录')
      if (any) { any.click(); return true }
      return false
    })
    if (clicked) await wait(1500)
  }
  const result = await page.evaluate(() => {
    const img = document.querySelector('.login-container img.qrcode-img, .qrcode-img, .login-container .qrcode img')
    if (img) return { qrcode: img.getAttribute('src') ?? '', kind: 'img' }
    const canvas = document.querySelector('.login-container canvas')
    if (canvas) return { qrcode: canvas.toDataURL('image/png'), kind: 'canvas' }
    return { qrcode: '', kind: '' }
  })
  if (!result.qrcode) throw fail('没拿到登录二维码：登录弹窗没出现（可能已经登录）', 409)
  return { qrcode: result.qrcode, timeout: 180, message: '用小红书 App 扫码，扫码后在手机上确认登录' }
}

/** 清掉浏览器 cookie（退出登录）。 */
export async function deleteCookies(page) {
  const client = await page.createCDPSession()
  await client.send('Network.clearBrowserCookies')
  await client.send('Network.clearBrowserCache')
  await client.detach()
  await goto(page, `${BASE}/explore`, { wait: 2000 })
  return { success: true, message: 'cookies 已删除，需要重新扫码登录' }
}

/** 首页推荐。 */
export async function fetchFeeds(page) {
  await ensureHome(page)
  const items = await scrapeNotes(page, 24)
  if (!items.length) throw fail('首页没有抓到笔记，可能被限流，稍后再试', 429)
  return { items, count: items.length }
}

/** 搜索结果。 */
export async function searchFeeds(page, { keyword, filters = {} } = {}) {
  const q = String(keyword ?? '').trim()
  if (!q) throw fail('keyword 不能为空')
  const params = new URLSearchParams({ keyword: q, source: 'web_explore_feed' })
  const typeMap = { 视频: 'video', 图文: 'normal' }
  if (typeMap[filters.note_type]) params.set('type', typeMap[filters.note_type])
  const sortMap = { 最新: 'time_descending', 最多点赞: 'popularity_descending', 最多评论: 'comment_descending', 最多收藏: 'collect_descending' }
  if (sortMap[filters.sort_by]) params.set('sort', sortMap[filters.sort_by])
  await goto(page, `${BASE}/search_result?${params}`, { selector: 'section.note-item', wait: 3500 })
  const items = await scrapeNotes(page, 24)
  if (!items.length) {
    const state = await loginState(page)
    throw fail(state.logged_in ? '没有搜到结果，换个关键词试试' : '搜索需要先登录小红书（用 get_login_qrcode 扫码）', 401)
  }
  return { keyword: q, items, count: items.length }
}

/** 打开笔记详情页并抓正文/互动/评论。 */
export async function fetchDetail(page, { feed_id, xsec_token, load_all_comments = false, limit = 20 } = {}) {
  const id = String(feed_id ?? '').trim()
  if (!id) throw fail('feed_id 不能为空')
  await goto(page, noteHref(id, xsec_token), { wait: 3000 })
  // 滚动一下把评论区加载出来
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {})
  if (load_all_comments) {
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {})
      await wait(500)
    }
  }
  const maxComments = load_all_comments ? Math.min(Number(limit) || 20, 50) : 10
  const detail = await page.evaluate((max) => {
    const q = (s) => document.querySelector(s)
    const txt = (s) => (q(s)?.innerText ?? '').trim()
    const comments = [...document.querySelectorAll('.comment-item')].slice(0, max).map((el) => ({
      id: el.getAttribute('data-comment-id') ?? el.id ?? '',
      user: (el.querySelector('.author .name, .user-name, .name')?.innerText ?? '').trim(),
      content: (el.querySelector('.content, .note-text')?.innerText ?? '').trim(),
      likes: (el.querySelector('.like .count, .count')?.innerText ?? '').trim(),
      is_author: Boolean(el.querySelector('.author-tag, .is-author')),
    }))
    const images = [...document.querySelectorAll('.swiper-slide img, .note-slider img, .slider-container img, .media-container img')]
      .map((img) => img.getAttribute('src') ?? '')
      .filter((src) => /^https?:/.test(src))
    return {
      note: {
        note_id: (location.pathname.match(/\/explore\/([0-9a-zA-Z]+)/) ?? [])[1] ?? '',
        title: txt('#detail-title') || txt('.note-content .title'),
        desc: txt('#detail-desc') || txt('.note-content .desc'),
        author: txt('.author-container .username') || txt('.author-wrapper .name') || txt('.author-container .name'),
        user_id: (q('.author-container a[href*="/user/profile/"]')?.getAttribute('href') ?? '').match(/profile\/([0-9a-zA-Z]+)/)?.[1] ?? '',
        liked_count: txt('.interact-container .like-wrapper .count') || txt('.like-wrapper .count'),
        collected_count: txt('.interact-container .collect-wrapper .count') || txt('.collect-wrapper .count'),
        comment_count: txt('.interact-container .chat-wrapper .count') || txt('.chat-wrapper .count'),
        comments,
        image_list: [...new Set(images)].slice(0, 12),
        video: Boolean(q('.player-container, video')),
      },
      url: location.href,
    }
  }, maxComments)
  if (!detail.note.title && !detail.note.desc) {
    const state = await loginState(page)
    throw fail(state.logged_in ? '笔记详情没抓到（可能已删除或需要登录）' : '看笔记详情需要先登录（用 get_login_qrcode 扫码）', 401)
  }
  return detail
}

/** 点赞 / 取消点赞 */
export async function likeFeed(page, { feed_id, xsec_token, unlike = false } = {}) {
  return toggleInteract(page, { feed_id, xsec_token }, '.like-wrapper, .interact-container .like-wrapper', unlike, '点赞')
}

/** 收藏 / 取消收藏 */
export async function favoriteFeed(page, { feed_id, xsec_token, unfavorite = false } = {}) {
  return toggleInteract(page, { feed_id, xsec_token }, '.collect-wrapper, .interact-container .collect-wrapper', unfavorite, '收藏')
}

async function toggleInteract(page, { feed_id, xsec_token }, selector, undo, label) {
  if (!feed_id) throw fail('feed_id 不能为空')
  await goto(page, noteHref(feed_id, xsec_token), { wait: 2500 })
  const before = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return { found: Boolean(el), active: el ? el.className.includes('active') : false }
  }, selector)
  if (!before.found) throw fail(`没找到${label}按钮（可能未登录或页面结构变了）`, 409)
  if (before.active !== undo) {
    await page.click(selector, { delay: 30 }).catch(async () => {
      await page.evaluate((sel) => document.querySelector(sel)?.click(), selector)
    })
    await wait(1200)
  }
  const after = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return { active: el ? el.className.includes('active') : false }
  }, selector)
  const expected = !undo
  if (after.active !== expected) throw fail(`${label}操作没生效（可能被限流）`, 429)
  return { success: true, [undo ? 'unliked' : 'liked']: expected, note_id: feed_id }
}

/** 发评论 */
export async function postComment(page, { feed_id, xsec_token, content } = {}) {
  const text = String(content ?? '').trim()
  if (!feed_id) throw fail('feed_id 不能为空')
  if (!text) throw fail('content 不能为空')
  await goto(page, noteHref(feed_id, xsec_token), { wait: 2500 })
  const ok = await page.evaluate(async (value) => {
    const input = document.querySelector('.comment-input textarea, .comment-input input, #content-textarea, textarea.comment-textarea')
    if (!input) return false
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = document.querySelector('.comment-input .submit, .comment-submit, .btn.submit, button.submit')
    if (submit) { submit.click(); return true }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
    return true
  }, text)
  if (!ok) throw fail('没找到评论输入框（可能未登录）', 401)
  await wait(2000)
  return { success: true, content: text, note_id: feed_id }
}

/** 回复评论 */
export async function replyComment(page, { feed_id, xsec_token, content, comment_id, user_id } = {}) {
  const text = String(content ?? '').trim()
  if (!text) throw fail('content 不能为空')
  if (!feed_id) throw fail('feed_id 不能为空')
  await goto(page, noteHref(feed_id, xsec_token), { wait: 2500 })
  const ok = await page.evaluate(({ value, cid, uid }) => {
    const items = [...document.querySelectorAll('.comment-item')]
    const target = items.find(el => (cid && (el.getAttribute('data-comment-id') === cid || el.id === cid)) || (uid && el.innerHTML.includes(uid))) ?? items[0]
    if (!target) return false
    const replyBtn = [...target.querySelectorAll('button, span, div')].find(el => /回复/.test(el.textContent ?? ''))
    if (replyBtn) replyBtn.click()
    const input = target.querySelector('textarea') ?? document.querySelector('.comment-input textarea, #content-textarea')
    if (!input) return false
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector('.submit, button.submit')?.click()
    return true
  }, { value: text, cid: comment_id ?? '', uid: user_id ?? '' })
  if (!ok) throw fail('没找到要回复的评论或输入框', 401)
  await wait(1800)
  return { success: true, content: text, note_id: feed_id }
}

/** 用户主页 */
export async function userProfile(page, { user_id, xsec_token } = {}) {
  const id = String(user_id ?? '').trim()
  if (!id) throw fail('user_id 不能为空')
  const url = `${BASE}/user/profile/${id}${xsec_token ? `?xsec_token=${encodeURIComponent(xsec_token)}&xsec_source=pc_note` : ''}`
  await goto(page, url, { wait: 3000 })
  const scrapeProfile = () => page.evaluate(() => {
    const txt = (s) => (document.querySelector(s)?.innerText ?? '').trim()
    return {
      user_id: (location.pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/) ?? [])[1] ?? '',
      nickname: txt('.user-name') || txt('.info .name') || txt('.user-nickname'),
      desc: txt('.user-desc') || txt('.info .desc'),
      fans: txt('.user-interactions .fans .count, .data-info .fans .count, .info .fans .count, .user-data .fans'),
      follows: txt('.user-interactions .follows .count, .data-info .follows .count, .info .follows .count, .user-data .follows'),
      liked: txt('.user-interactions .liked .count, .data-info .liked .count, .info .liked .count, .user-data .liked'),
      notes: [...document.querySelectorAll('section.note-item')].slice(0, 24).map((sec) => {
        const a = sec.querySelector('a.cover')
        const href = a?.getAttribute('href') ?? ''
        // 个人主页的卡片链接有 /explore/<id>、/user/profile/<uid>/<noteId>、/discovery/item/<id> 几种写法
        const anchor = [...sec.querySelectorAll('a[href]')].map(el => el.getAttribute('href') ?? '').find(h => /\/explore\/|\/discovery\/item\/|\/user\/profile\/[0-9a-zA-Z]+\/[0-9a-zA-Z]+/.test(h)) ?? href
        const idFromHref = (/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(anchor) ?? [])[1]
          ?? (/\/user\/profile\/[0-9a-zA-Z]+\/([0-9a-zA-Z]+)/.exec(anchor) ?? [])[1]
        return {
          note_id: idFromHref ?? sec.getAttribute('data-note-id') ?? '',
          xsec_token: decodeURIComponent((/[?&]xsec_token=([^&]+)/.exec(anchor) ?? [])[1] ?? ''),
          title: (sec.querySelector('.footer .title')?.innerText ?? '').trim(),
          cover: a?.querySelector('img')?.getAttribute('src') ?? '',
        }
      }),
    }
  })
  let profile = await scrapeProfile()
  if (!profile.nickname && !profile.notes.length) {
    // 页面偶尔加载慢或被限速，等一会再来一次
    await new Promise(r => setTimeout(r, 2500))
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 2500))
    profile = await scrapeProfile()
  }
  if (!profile.nickname && !profile.notes.length) throw fail('用户主页没抓到（可能被限流或需要登录）', 429)
  return profile
}

const TEMP_DIR = process.env.XHS_TMP_DIR || '/data/data/com.dsharnessmobile.shell/files/home/xhs-upload'

async function downloadImages(urls, downloaded = []) {
  await mkdir(TEMP_DIR, { recursive: true })
  const files = []
  for (const [index, url] of urls.entries()) {
    // 本机绝对路径直接用（MCP 和文件在同一台设备上）
    if (/^\//.test(url)) {
      try {
        await stat(url)
      } catch {
        throw fail(`本机文件不存在：${url}`)
      }
      files.push(url)
      continue
    }
    if (!/^https?:\/\//.test(url)) throw fail(`图片地址不合法：${url}`)
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.xiaohongshu.com/' } })
    if (!res.ok) throw fail(`下载图片失败（${res.status}）：${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (/\/(jpe?g|png|webp|gif)/i.exec(url)?.[1] ?? 'jpg').toLowerCase()
    const file = join(TEMP_DIR, `xhs-${Date.now()}-${index}.${ext}`)
    await writeFile(file, buf)
    files.push(file)
    downloaded.push(file)
  }
  return files
}

/** 发布图文：走创作中心网页版。 */
export async function publishContent(page, { title, content, images = [], tags = [], visibility = '公开可见', is_original = false, schedule_at } = {}) {
  const t = String(title ?? '').trim()
  const body = String(content ?? '').trim()
  const list = Array.isArray(images) ? images.filter(Boolean) : []
  if (!t) throw fail('title 不能为空')
  if (!body) throw fail('content 不能为空')
  if (!list.length) throw fail('images 至少要一张')
  const downloaded = []
  const files = await downloadImages(list, downloaded)
  const tagText = tags.map(tag => `#${String(tag).replace(/^#/, '')}`).join(' ')
  const fullBody = tagText ? `${body}\n${tagText}` : body

  await goto(page, 'https://creator.xiaohongshu.com/publish/publish?source=official', { wait: 3500 })
  if (!page.url().includes('creator.xiaohongshu.com')) throw fail('创作中心需要登录（先用 get_login_qrcode 扫码）', 401)
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.creator-tab, .tab, [class*="tab"]')].map(el => el.innerText?.trim()).filter(Boolean).slice(0, 12))
  log('creator tabs:', tabs.join(' / '))
  // 切到「上传图文」
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.creator-tab, .tab, [class*="tab"]')].find(el => /图文/.test(el.innerText ?? ''))
    tab?.click()
  })
  await wait(1500)
  const input = await page.$('input[type=file]')
  if (!input) throw fail('没找到上传图片的输入框（创作中心结构可能变了）', 409)
  await input.uploadFile(...files)
  await wait(4000)
  // 图片已经交给创作中心，临时下载件可以删了（用户自己的本机路径不会进 downloaded）
  for (const file of downloaded) {
    await rm(file, { force: true }).catch(() => {})
  }
  // 标题 + 正文（创作中心是可编辑 div，用键盘输入）
  const filled = await page.evaluate(({ title, body }) => {
    const titleEl = document.querySelector('.d-text input, .title input, input[placeholder*="标题"]')
    const bodyEl = document.querySelector('.ql-editor, .d-text .ql-editor, [contenteditable="true"]')
    if (titleEl) { titleEl.focus(); titleEl.value = title; titleEl.dispatchEvent(new Event('input', { bubbles: true })) }
    if (bodyEl) { bodyEl.focus(); bodyEl.innerText = body; bodyEl.dispatchEvent(new Event('input', { bubbles: true })) }
    return { title: Boolean(titleEl), body: Boolean(bodyEl) }
  }, { title: t, body: fullBody })
  log('填充结果:', JSON.stringify(filled))
  if (!filled.title || !filled.body) throw fail('没找到标题/正文输入框（创作中心结构可能变了）', 409)
  await wait(1000)
  // 可见范围 / 原创 / 定时发布：按文案找控件
  if (visibility && visibility !== '公开可见') {
    await page.evaluate((v) => {
      const el = [...document.querySelectorAll('label, span, div')].find(el => el.textContent?.trim() === v)
      el?.click()
    }, visibility).catch(() => {})
  }
  if (is_original) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('label, span, div')].find(el => /原创/.test(el.textContent ?? ''))
      el?.click()
    }).catch(() => {})
  }
  if (schedule_at) log('注意：定时发布需要在创作中心手动设置', schedule_at)

  // 不自动点发布，留给人确认（MCP 调用方可以自行决定是否再调 publish_confirm）
  return {
    success: true,
    stage: 'ready_to_publish',
    note: '内容已上传并填好，到浏览器里确认后点「发布」即完成（自动点发布有误发风险，默认不代劳）',
    files: files.length,
    body_length: fullBody.length,
  }
}

/** 真正点发布（可选，需再次确认） */
export async function confirmPublish(page) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(el => el.innerText?.trim() === '发布' && !el.disabled)
    if (!btn) return false
    btn.click()
    return true
  })
  if (!clicked) throw fail('没找到可点的「发布」按钮', 409)
  await wait(4000)
  return { success: true, message: '已点发布，请在小红书确认笔记是否出现' }
}

export { ensurePage, goto, blockedByRisk }