// 手机号 + 短信验证码登录（屏幕上没有第二台设备扫码时用这个）
// 用法：node login-phone.mjs 13800138000           → 发验证码
//       node login-phone.mjs 13800138000 123456    → 提交验证码
import { ensurePage, goto } from './lib/browser.mjs'
const [phone, code] = process.argv.slice(2)
if (!/^\d{6,}$/.test(phone ?? '')) {
  console.error('用法: node login-phone.mjs <手机号> [验证码]')
  process.exit(1)
}
const page = await ensurePage()
await goto(page, 'https://www.xiaohongshu.com/explore', { selector: 'section.note-item', wait: 2500 })
if (!(await page.$('.login-container'))) {
  await page.evaluate(() => {
    const btn = document.querySelector('.login-btn, #login-btn')
    if (btn) btn.click()
  })
  await new Promise(r => setTimeout(r, 1500))
}
const filled = await page.evaluate((value) => {
  const input = document.querySelector('.login-container input[placeholder*="手机号"], input[placeholder*="手机号"]')
  if (!input) return false
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, phone)
if (!filled) { console.error('没找到手机号输入框'); process.exit(2) }
if (!code) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.login-container button, button, span')].find(el => /获取验证码/.test(el.textContent ?? ''))
    if (!btn) return false
    btn.click()
    return true
  })
  console.log(clicked ? '已点「获取验证码」，收到短信后运行：node login-phone.mjs <手机号> <验证码>' : '没找到「获取验证码」按钮')
  process.exit(clicked ? 0 : 3)
}
const submitted = await page.evaluate((value) => {
  const input = document.querySelector('.login-container input[placeholder*="验证码"], input[placeholder*="验证码"]')
  if (!input) return false
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const btn = [...document.querySelectorAll('.login-container button, button')].find(el => el.innerText?.trim() === '登录')
  btn?.click()
  return true
}, code)
await new Promise(r => setTimeout(r, 4000))
console.log(submitted ? '已提交验证码，检查登录状态：node call.mjs check_login_status "{}"' : '没找到验证码输入框')
