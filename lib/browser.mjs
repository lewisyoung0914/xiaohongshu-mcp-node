// 浏览器管理：拉起一个本机 Chrome/Chromium（headless），连 CDP，做最基本的人味伪装。
//
// 两种接法：
//   1) XHS_BROWSER_SCRIPT=/path/to/wrapper.sh   —— 脚本自己负责加参数（适合 Android/Termux 这种要加 LD_PRELOAD 的环境）
//   2) XHS_BROWSER_BIN=/path/to/chrome          —— 直接给浏览器二进制，本模块负责加参数
// 都不给时按常见路径自动找（google-chrome / chromium / Chromium.app 等）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import puppeteer from 'puppeteer-core'

const HOME = process.env.HOME || process.cwd()
const PORT = Number(process.env.XHS_CDP_PORT || 9222)
const PROFILE = process.env.XHS_PROFILE || join(HOME, 'xhs-profile')
const UA = process.env.XHS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const VIEWPORT = { width: 1280, height: 900 }

const COMMON_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--disable-background-networking',
  '--disable-blink-features=AutomationControlled',
  '--lang=zh-CN',
]

const FALLBACK_BROWSERS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]

let browserPromise = null
let pagePromise = null

async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function resolveLaunch() {
  const script = process.env.XHS_BROWSER_SCRIPT
  if (script) return { cmd: script, args: [], kind: 'script' }
  const bin = process.env.XHS_BROWSER_BIN || process.env.CHROME_PATH
  if (bin) return { cmd: bin, args: COMMON_FLAGS, kind: 'bin' }
  const found = FALLBACK_BROWSERS.find(path => existsSync(path))
  if (found) return { cmd: found, args: COMMON_FLAGS, kind: 'bin' }
  // 再顺着 PATH 找一遍
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    for (const dir of String(process.env.PATH || '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return { cmd: candidate, args: COMMON_FLAGS, kind: 'bin' }
    }
  }
  throw new Error('找不到浏览器：请设置 XHS_BROWSER_BIN 或 XHS_BROWSER_SCRIPT（见 README）')
}

async function launch() {
  mkdirSync(PROFILE, { recursive: true })
  const { cmd, args } = resolveLaunch()
  const extra = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`]
  const child = spawn(cmd, [...args, ...extra], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 400))
    if (await cdpAlive()) return
  }
  throw new Error(`浏览器启动超时（${cmd}）：检查 --remote-debugging-port=${PORT} 是否被占用`)
}

/** 连上（或先拉起）浏览器。 */
export async function ensureBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      if (!(await cdpAlive())) await launch()
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: VIEWPORT })
      browser.on('disconnected', () => { browserPromise = null; pagePromise = null })
      return browser
    })()
  }
  return browserPromise
}

/** 取一个已经伪装好的页面（复用同一个标签页，保持登录态）。 */
export async function ensurePage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await ensureBrowser()
      const pages = await browser.pages()
      const page = pages[0] ?? await browser.newPage()
      await prepare(page)
      page.on('close', () => { pagePromise = null })
      return page
    })()
  }
  return pagePromise
}

async function prepare(page) {
  await page.setUserAgent(UA)
  await page.setViewport(VIEWPORT)
  await page.setExtraHTTPHeaders({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' })
  await page.evaluateOnNewDocument(() => {
    // 最基本的自动化痕迹清理：webdriver、语言、插件
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    window.chrome = window.chrome || { runtime: {} }
  })
}

/** 页面被风控拦了没有（安全限制页）。 */
export function blockedByRisk(page) {
  return page.url().includes('website-login/error') || page.url().includes('error_code=300012')
}

export async function goto(page, url, { wait = 2500, selector = null, timeout = 45000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
  if (selector) {
    await page.waitForSelector(selector, { timeout: 20000 }).catch(() => {})
  }
  await new Promise(r => setTimeout(r, wait))
  if (blockedByRisk(page)) throw Object.assign(new Error('小红书风控拦截（300012）：当前网络或自动化特征被判定有风险，稍后再试或换个网络'), { status: 429 })
  return page
}

export { UA, PROFILE, PORT }