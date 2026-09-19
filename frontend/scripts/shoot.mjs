// Screenshot loop against the live Chrome (CDP) or a headless Chromium fallback.
// usage: node scripts/shoot.mjs <name> [--url=PATH] [--t=SEC] [--play] [--click=SELECTOR]... [--key=K] [--wait=MS] [--eval=JS]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--')) ?? 'shot'
const opt = (k) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3))
const flag = (k) => args.includes(`--${k}`)
const out = new URL('../../visual-reviews/', import.meta.url).pathname
mkdirSync(out, { recursive: true })

let browser
try {
  browser = await chromium.connectOverCDP('http://localhost:29229')
} catch {
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
}
const ctx = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }))
setTimeout(() => { console.error('WATCHDOG: shot timed out'); process.exit(2) }, 150_000).unref?.()
const page = await ctx.newPage()
await page.setViewportSize({ width: 1440, height: 900 })
const logs = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`${m.type()}: ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(`http://localhost:5173${opt('url')[0] ?? '/'}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('.world canvas, .bworld-canvas') !== null, null, { timeout: 30000 })
await page.waitForFunction(() => !document.querySelector('.bworld-veil'), null, { timeout: 120000 }).catch(() => {})
// wait for tiles/buildings + replay
await page.waitForFunction(() => !document.querySelector('.status.busy'), null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(Number(opt('wait')[0] ?? 6000))
const t = opt('t')[0]
if (t !== undefined) {
  await page.evaluate((sec) => window.__cityshift?.seek(Number(sec)), t)
  await page.waitForTimeout(800)
}
for (const sel of opt('click')) {
  await page.click(sel)
  await page.waitForTimeout(600)
}
// --stack: if an eval hangs >8s, pause the JS thread over CDP and print where it is stuck.
const cdp = flag('stack') ? await ctx.newCDPSession(page) : null
if (cdp) await cdp.send('Debugger.enable')
const withStack = async (p) => {
  if (!cdp) return p
  const timer = new Promise((resolve) => setTimeout(resolve, 8000, '__timeout__'))
  const r = await Promise.race([p, timer])
  if (r !== '__timeout__') return r
  const paused = new Promise((resolve) => cdp.once('Debugger.paused', (e) => resolve(e)))
  await cdp.send('Debugger.pause')
  const e = await Promise.race([paused, new Promise((res) => setTimeout(res, 5000, null))])
  if (e) console.log('STACK:\n' + e.callFrames.slice(0, 12).map((f) => `  ${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.location.lineNumber}`).join('\n'))
  else console.log('STACK: could not pause (thread not in JS?)')
  process.exit(3)
}
for (const js of opt('eval')) {
  const r = await withStack(page.evaluate(js).catch((e) => `EVAL ERROR: ${e.message}`))
  if (r !== undefined) console.log('eval →', typeof r === 'string' ? r : JSON.stringify(r))
  await page.waitForTimeout(400)
}
if (flag('play')) {
  await page.evaluate(() => window.__cityshift?.play())
  await page.waitForTimeout(Number(opt('playfor')[0] ?? 2500))
}
for (const k of opt('key')) {
  await page.keyboard.press(k)
  await page.waitForTimeout(600)
}
await page.waitForTimeout(1200)
await page.screenshot({ path: `${out}${name}.png` })
console.log(`wrote ${out}${name}.png`)
if (logs.length) console.log(logs.slice(0, 12).join('\n'))
await page.close()
if (!browser.isConnected || browser.contexts().length === 0) await browser.close()
process.exit(0)
