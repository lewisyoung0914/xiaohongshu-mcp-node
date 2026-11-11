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

/** 等卡片渲染到位：数量足够、并且连续一段时间不再变化（比固定 sleep 快很多）。 */
export async function waitForCards(page, { min = 6, stableFor = 500, timeout = 15000 } = {}) {
  const started = Date.now()
  let last = -1
  let lastChange = Date.now()
  while (Date.now() - started < timeout) {
    const count = await page.evaluate(() => document.querySelectorAll('section.note-item').length).catch(() => 0)
    if (count !== last) {
      last = count
      lastChange = Date.now()
    } else if (count >= min && Date.now() - lastChange >= stableFor) {
      return count
    }
    await new Promise(r => setTimeout(r, 150))
  }
  return last < 0 ? 0 : last
}

/** 只在首页（/explore）才复用；在搜索结果页时不要再拿它当"首页推荐"。 */
function isFeedPage(page) {
  const url = page.url()
  return url.includes('xiaohongshu.com/explore') || url.includes('xiaohongshu.com/')
}

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
        author: (q('.footer .author')?.innerText ?? '').split('\n')[0].trim(),
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
    const nick = (document.querySelector('.side-bar .user .user-name, .side-bar .user .name, .side-bar .user .nickname')?.innerText ?? '').trim()
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
  // 搜索结果页也属于 xiaohongshu.com，不能直接复用：必须真的在 /explore 才抓
  const onFeedPage = page.url().includes('/explore') && !blockedByRisk(page)
  if (!onFeedPage) {
    await goto(page, `${BASE}/explore`, { wait: 0, timeout: 45000 })
    await waitForCards(page, { min: 8 })
  }
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
  await goto(page, `${BASE}/search_result?${params}`, { wait: 0, timeout: 45000 })
  const cards = await waitForCards(page, { min: 8 })
  log('搜索结果卡片数', cards)
  const items = await scrapeNotes(page, 24)
  if (!items.length) {
    const state = await loginState(page)
    throw fail(state.logged_in ? '没有搜到结果，换个关键词试试' : '搜索需要先登录小红书（用 get_login_qrcode 扫码）', 401)
  }
  return { keyword: q, items, count: items.length }
}

/** 打开笔记详情页并抓正文/互动/评论/图集/视频（优先读页面内嵌的 __INITIAL_STATE__）。 */
export async function fetchDetail(page, { feed_id, xsec_token, load_all_comments = false, limit = 20 } = {}) {
  const id = String(feed_id ?? '').trim()
  if (!id) throw fail('feed_id 不能为空')
  await goto(page, noteHref(id, xsec_token), { wait: 3000 })

  // 视频/图片在 DOM 里是懒加载或 MSE blob，直接从页面初始状态取
  const readState = () => page.evaluate((noteId) => {
    const state = window.__INITIAL_STATE__
    if (!state) return null
    const map = state.note?.noteDetailMap ?? state.noteDetailMap ?? {}
    const entry = map[noteId] ?? Object.entries(map).find(([key]) => key.startsWith(String(noteId)))?.[1] ?? Object.values(map)[0]
    const n = entry?.note ?? entry
    if (!n || (!n.title && !n.desc && !n.imageList)) return null
    const stream = n.video?.media?.stream ?? n.video?.consumer ?? {}
    const firstStream = (list) => (Array.isArray(list) ? list[0] : null)
    const videoUrl = firstStream(stream.h264)?.masterUrl
      ?? firstStream(stream.h264)?.backupUrls?.[0]
      ?? firstStream(stream.h265)?.masterUrl
      ?? firstStream(stream.av1)?.masterUrl
      ?? ''
    const comments = (n.comments?.list ?? []).map(c => ({
      id: c.id ?? '',
      user: c.user?.nickname ?? c.user?.nickName ?? '',
      content: c.content ?? '',
      likes: c.likeCount ?? '',
      is_author: Boolean(String(c.showTags ?? '').includes('author')),
    })).filter(c => c.content)
    const images = (n.imageList ?? []).map(img => img.urlDefault ?? img.urlPre ?? img.url ?? '').filter(src => /^https?:/.test(src))
    return {
      note: {
        note_id: n.noteId ?? noteId,
        title: n.title ?? '',
        desc: n.desc ?? '',
        author: n.user?.nickname ?? n.user?.nickName ?? '',
        user_id: n.user?.userId ?? '',
        liked_count: n.interactInfo?.likedCount ?? '',
        collected_count: n.interactInfo?.collectedCount ?? '',
        comment_count: n.interactInfo?.commentCount ?? '',
        comments,
        image_list: images,
        video: Boolean(videoUrl),
        video_url: videoUrl,
        video_cover: images[0] ?? '',
      },
      url: location.href,
    }
  }, id)

  let detail = await readState()
  if (detail) {
    // 主评论数不够时，滚一滚评论区再读一次（小红书是滚动加载）
    const want = load_all_comments ? Math.min(Number(limit) || 20, 100) : 10
    if ((detail.note.comments.length < want) && (load_all_comments || detail.note.comments.length < 10)) {
      for (let i = 0; i < (load_all_comments ? 10 : 3); i += 1) {
        await page.evaluate(() => {
          const box = document.querySelector('.comments-container, .comments-el, .note-scroller, .comment-list')
          if (box) box.scrollBy(0, 900)
          else window.scrollBy(0, 900)
        }).catch(() => {})
        await wait(700)
        const next = await readState()
        if (next && next.note.comments.length > detail.note.comments.length) detail = next
        if (detail.note.comments.length >= want) break
      }
    }
    if (!load_all_comments && detail.note.comments.length > 10) detail.note.comments = detail.note.comments.slice(0, 10)
    return detail
  }

  // 回退：老结构走 DOM 抓取
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {})
  await wait(1200)
  const fallback = await page.evaluate((max) => {
    const q = (s) => document.querySelector(s)
    const txt = (s) => (q(s)?.innerText ?? '').trim()
    const images = [...document.querySelectorAll('.swiper-slide img, .note-slider img, .note-slider-img img, .media-container img')]
      .map(img => img.getAttribute('src') ?? '')
      .filter(src => /^https?:/.test(src))
    return {
      note: {
        note_id: (location.pathname.match(/\/explore\/([0-9a-zA-Z]+)/) ?? [])[1] ?? '',
        title: txt('#detail-title') || txt('.note-content .title'),
        desc: txt('#detail-desc') || txt('.note-content .desc'),
        author: txt('.author-container .username') || txt('.author-wrapper .name'),
        user_id: (q('.author-container a[href*="/user/profile/"]')?.getAttribute('href') ?? '').match(/profile\/([0-9a-zA-Z]+)/)?.[1] ?? '',
        liked_count: txt('.interact-container .like-wrapper .count') || txt('.like-wrapper .count'),
        collected_count: txt('.interact-container .collect-wrapper .count'),
        comment_count: txt('.interact-container .chat-wrapper .count'),
        comments: [...document.querySelectorAll('.comment-item')].slice(0, max).map(el => ({
          id: el.getAttribute('data-comment-id') ?? '',
          user: (el.querySelector('.author .name, .user-name, .name')?.innerText ?? '').trim(),
          content: (el.querySelector('.content, .note-text')?.innerText ?? '').trim(),
          likes: (el.querySelector('.like .count, .count')?.innerText ?? '').trim(),
          is_author: Boolean(el.querySelector('.author-tag, .is-author')),
        })),
        image_list: [...new Set(images)].slice(0, 12),
        video: Boolean(q('.player-container, video')),
        video_url: '',
        video_cover: images[0] ?? '',
      },
      url: location.href,
    }
  }, load_all_comments ? Math.min(Number(limit) || 20, 50) : 10)
  if (!fallback.note.title && !fallback.note.desc) {
    const state = await loginState(page)
    throw fail(state.logged_in ? '笔记详情没抓到（可能已删除或页面结构变了）' : '看笔记详情需要先登录（用 get_login_qrcode 扫码）', 401)
  }
  return fallback
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

/** 发布图文：走创作中心网页版（先切「上传图文」tab，再上传、填标题正文）。 */
export async function publishContent(page, { title, content, images = [], tags = [], visibility = '公开可见', is_original = false, schedule_at } = {}) {
  const t = String(title ?? '').trim()
  const body = String(content ?? '').trim()
  const list = Array.isArray(images) ? images.filter(Boolean) : []
  if (!t) throw fail('title 不能为空')
  if (!body) throw fail('content 不能为空')
  if (!list.length) throw fail('images 至少要一张')
  const tagText = tags.map(tag => `#${String(tag).replace(/^#/, '')}`).join(' ')
  const fullBody = tagText ? `${body} ${tagText}` : body
  const downloaded = []
  const files = await downloadImages(list, downloaded)
  const result = await fillCreatorNote(page, { mode: 'image', files, title: t, body: fullBody, visibility, is_original, schedule_at })
  for (const file of downloaded) await rm(file, { force: true }).catch(() => {})
  return result
}

/** 视频发布：切「上传视频」tab，上传后填标题正文。 */
export async function publishVideo(page, { title, content, video, tags = [], visibility = '公开可见', is_original = false, schedule_at } = {}) {
  const t = String(title ?? '').trim()
  const body = String(content ?? '').trim()
  if (!t) throw fail('title 不能为空')
  if (!body) throw fail('content 不能为空')
  if (!video || !/^\//.test(video)) throw fail('video 需要本机绝对路径')
  await stat(video).catch(() => { throw fail(`视频文件不存在：${video}`) })
  const tagText = tags.map(tag => `#${String(tag).replace(/^#/, '')}`).join(' ')
  const fullBody = tagText ? `${body} ${tagText}` : body
  return fillCreatorNote(page, { mode: 'video', files: [video], title: t, body: fullBody, visibility, is_original, schedule_at })
}

/** 创作中心共用流程：切 tab → 上传 → 填标题正文 → 可选可见范围/原创。 */
async function fillCreatorNote(page, { mode, files, title, body, visibility, is_original, schedule_at }) {
  await goto(page, 'https://creator.xiaohongshu.com/publish/publish?source=official', { wait: 3000 })
  if (!page.url().includes('creator.xiaohongshu.com')) throw fail('创作中心需要登录（先用 get_login_qrcode 扫码或 login-phone.mjs 登录）', 401)

  const tabName = mode === 'video' ? '上传视频' : '上传图文'
  const switched = await page.evaluate((name) => {
    const active = [...document.querySelectorAll('.creator-tab')].find(el => el.className.includes('active'))
    if (active && (active.innerText ?? '').includes(name.replace('上传', ''))) return true
    const target = [...document.querySelectorAll('.creator-tab .title, .creator-tab')].find(el => (el.innerText ?? '').trim() === name)
    if (!target) return false
    target.click()
    return true
  }, tabName)
  if (!switched) throw fail(`没找到「${tabName}」tab（创作中心结构可能变了）`, 409)
  await wait(2500)

  const input = await page.waitForSelector('input[type=file]', { timeout: 15000 }).catch(() => null)
  if (!input) throw fail('没找到上传文件的选择框', 409)
  await input.uploadFile(...files)

  // 等编辑器出来：标题框 + 正文（tiptap）
  // 上传后常会弹「图片可以编辑啦」教程层和话题浮层，先关掉
  await wait(1200)
  await page.evaluate(() => {
    const know = [...document.querySelectorAll('button,div,span')].find(el => (el.innerText ?? '').trim() === '我知道了')
    know?.click()
    document.body.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
  }).catch(() => {})
  await wait(600)

  const titleSelector = 'input[placeholder*="填写标题"]'
  const bodySelector = '.tiptap[contenteditable="true"], .tiptap, .editor-content [contenteditable="true"]'
  await page.waitForSelector(titleSelector, { timeout: 40000 }).catch(() => {})
  await wait(mode === 'video' ? 6000 : 4000)
  const ready = await page.evaluate(({ ts, bs }) => ({
    title: Boolean(document.querySelector(ts)),
    body: Boolean(document.querySelector(bs)),
  }), { ts: titleSelector, bs: bodySelector })
  if (!ready.title) throw fail('没等到标题输入框（图片/视频可能还在上传，或页面结构变了）', 409)

  // 标题：用原生 setter + input 事件
  await page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel)
    if (!el) return
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.blur()
  }, { sel: titleSelector, value: title })
  await wait(600)

  // 正文：tiptap 是 ProseMirror，用键盘输入最稳
  if (ready.body) {
    const bodyEl = await page.$(bodySelector)
    if (bodyEl) {
      await bodyEl.click().catch(() => {})
      await wait(300)
      await page.keyboard.type(body, { delay: 8 })
      await wait(400)
      await page.keyboard.press('Escape').catch(() => {})
      await page.evaluate(() => document.body.click()).catch(() => {})
      await wait(300)
    }
  }

  // 可见范围：点开「公开可见」下拉再选
  if (visibility && visibility !== '公开可见') {
    const picked = await page.evaluate((target) => {
      const trigger = [...document.querySelectorAll('div,span,button')].find(el => el.children.length === 0 && /^(公开可见|仅自己可见|仅互关好友可见)$/.test((el.innerText ?? '').trim()))
      trigger?.click()
      return Boolean(trigger)
    }, visibility)
    if (picked) {
      await wait(800)
      await page.evaluate((target) => {
        const option = [...document.querySelectorAll('div,span,li')].find(el => el.children.length === 0 && (el.innerText ?? '').trim() === target)
        option?.click()
      }, visibility)
      await wait(500)
    }
  }
  if (is_original) {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('div,span')].find(el => /原创声明/.test(el.innerText ?? '') && el.children.length <= 2)
      row?.click()
    }).catch(() => {})
    await wait(400)
  }
  if (schedule_at) log('定时发布：MCP 暂不代填，请在创作中心手动设（参数收到：' + schedule_at + '）')

  const titleNow = await page.evaluate((sel) => document.querySelector(sel)?.value ?? '', titleSelector)
  const bodyNow = await page.evaluate((sel) => (document.querySelector(sel)?.innerText ?? '').length, bodySelector)
  return {
    success: true,
    stage: 'ready_to_publish',
    mode,
    title_filled: titleNow.length,
    body_filled: bodyNow,
    files: files.length,
    note: '已上传并填好，停在创作中心待发布页；要直接发就传 confirm:true，或到浏览器里点「发布笔记」',
  }
}


/** 按无障碍树里的按钮名点击：创作中心底部栏在闭合 shadow DOM 里，DOM 选择器看不到。 */
async function clickButtonByAxName(page, name) {
  const client = await page.createCDPSession()
  try {
    await client.send('DOM.enable')
    await client.send('Accessibility.enable')
    const { nodes } = await client.send('Accessibility.getFullAXTree')
    const target = (nodes ?? []).find(node => !node.ignored && node.role?.value === 'button' && (node.name?.value ?? '').trim() === name)
    if (!target?.backendNodeId) return false
    const { object } = await client.send('DOM.resolveNode', { backendNodeId: target.backendNodeId })
    await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({ block: "center" }); this.click(); return true }',
      returnByValue: true,
    })
    return true
  } catch {
    return false
  } finally {
    await client.detach().catch(() => {})
  }
}

/** 真正点发布（可选，需再次确认）。创作中心底栏在闭合 shadow DOM 里，优先按无障碍树点。 */
export async function confirmPublish(page) {
  // 关掉可能挡住按钮的浮层
  await page.evaluate(() => {
    const know = [...document.querySelectorAll('button,div,span')].find(el => (el.innerText ?? '').trim() === '我知道了')
    know?.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
  }).catch(() => {})
  await wait(800)

  // 1) 无障碍树里找名为「发布」的按钮（不会误点到侧栏「发布笔记」）
  let clicked = await clickButtonByAxName(page, '发布')
  // 2) 退路：DOM 里精确文本「发布」
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(el => (el.innerText ?? '').trim() === '发布' && !el.disabled)
      if (!btn) return false
      btn.scrollIntoView({ block: 'center' })
      btn.click()
      return true
    })
  }
  // 3) 再退一步：底栏坐标（1280x900 视口里「发布」在右下）
  if (!clicked) {
    const size = page.viewport() ?? { width: 1280, height: 900 }
    await page.mouse.click(Math.round(size.width * 0.548), Math.round(size.height * 0.948))
    clicked = true
  }
  await wait(2500)

  // 可能弹出二次确认
  for (const name of ['确认发布', '确定', '发布']) {
    if (await clickButtonByAxName(page, name)) {
      await wait(2000)
      break
    }
  }
  await wait(2000)

  const state = await page.evaluate(() => ({
    url: location.href.slice(0, 100),
    text: document.body.innerText.slice(0, 200).replace(/\n/g, ' '),
  })).catch(() => ({ url: '', text: '' }))
  const published = /发布成功|已发布|投稿成功/.test(state.text) || !state.url.includes('/publish/publish')
  return {
    success: true,
    stage: published ? 'published' : 'publish_clicked',
    message: published ? '已发布，稍后到「笔记管理」确认' : '已点「发布」，请到创作中心确认是否成功',
    after: state.url,
  }
}

export { ensurePage, goto, blockedByRisk }