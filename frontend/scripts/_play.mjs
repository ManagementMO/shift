import { chromium } from '@playwright/test'
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:5173/world')
await page.waitForFunction(() => window.__cityshift?.babylon && window.__cityshift.store.getState().pack, null, { timeout: 120000 })
for (let i = 0; i < 12; i++) {
  const s = await page.evaluate(() => { const v = window.__cityshift.live.controller.getSnapshot(); const st = v.primary?.state; const b = document.querySelector('.god-chrome__play'); return { t: Math.round(v.t), playing: v.playing, busy: v.busy, err: v.error, status: st?.status, avail: st?.available_until_s, time_s: st?.time_s, btn: b?.getAttribute('aria-label'), disabled: b?.disabled } })
  console.log(i * 3 + 's', JSON.stringify(s))
  if (s.playing && s.t > 5) break
  await page.waitForTimeout(3000)
}
const before = await page.evaluate(() => window.__cityshift.live.controller.getSnapshot().playing)
await page.locator('.god-chrome__play').click({ force: true }).catch((e) => console.log('click failed:', e.message.split('\n')[0]))
await page.waitForTimeout(2500)
console.log('toggle:', before, '->', JSON.stringify(await page.evaluate(() => { const v = window.__cityshift.live.controller.getSnapshot(); return { playing: v.playing, busy: v.busy, err: v.error, t: Math.round(v.t) } })))
await browser.close()
