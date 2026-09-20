import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:8147'
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${base}/world?pack=hazard-preview`)
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !!window.__cityshift.store.getState().scenarioId, null, { timeout: 120000 })
  await page.locator('.rail button[title="Weather events"]').click()
  const kinds = page.locator('.weather-kinds button')
  await kinds.first().waitFor()
  assert.equal(await kinds.count(), 2)
  assert.equal(await kinds.filter({ hasText: 'Fire' }).count(), 0)
  assert.equal(await kinds.filter({ hasText: 'Rain' }).count(), 1)
  assert.equal(await kinds.filter({ hasText: 'Storm' }).count(), 1)
  assert.equal(await page.evaluate(() => window.__cityshift.store.getState().beginFireStroke), undefined)
  console.log(JSON.stringify({ ok: true, fireAuthoringRemoved: true, kinds: ['rain', 'storm'] }))
} finally {
  await browser.close()
}
