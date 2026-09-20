import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:8147'
const health = await fetch(`${base}/api/health`).then((r) => r.json())
assert.equal(health.storage?.database, 'cityshift_browser_test', 'Apply checks only write to isolated review metadata')
const out = new URL('../test-results/weather-apply/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(30000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const snapshot = () => page.evaluate(() => {
  const s = window.__cityshift.store.getState()
  const scene = window.__cityshift.babylon.scene
  const scenario = s.scenarios.find((sc) => sc.scenario_id === s.scenarioId)
  return { sid: s.scenarioId, t: s.t, playing: s.playing, speed: s.speed, primaryRun: s.primaryRunId, error: s.error, hazards: scenario.hazards.map((h) => ({ kind: h.kind, start: h.start_s, end: h.end_s, id: h.track_id })), meshes: scene.meshes.filter((m) => /^hazard-(rain|storm|fire)-/.test(m.name)).map((m) => m.name) }
})

try {
  await page.goto(`${base}/world?pack=hazard-preview`)
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !!window.__cityshift.store.getState().scenarioId, null, { timeout: 120000 })
  for (const [index, kind] of ['rain', 'storm'].entries()) {
    await page.evaluate(async () => { await window.__cityshift.store.getState().selectScenario('hazard-preview-base'); window.__cityshift.pause() })
    await page.waitForFunction(() => window.__cityshift?.babylon?.world.pack_id === 'hazard-preview', null, { timeout: 120000 })
    const center = await page.evaluate(() => {
      const ws = window.__cityshift.babylon
      const r = ws.roads.byId.get('e_BC')
      return ws.frame.worldToLonLat((r.shape[0] + r.shape.at(-2)) / 2, (r.shape[1] + r.shape.at(-1)) / 2)
    })
    const time = 400 + index * 30
    await page.evaluate(([center, time]) => { window.__cityshift.pause(); window.__cityshift.seek(time); window.__cityshift.setSpeed(4); window.__cityshift.camera({ center, zoom: 16.7, pitch: 58, bearing: -25 }, 'incident') }, [center, time])
    await page.waitForTimeout(1500)
    if (await page.evaluate(() => window.__cityshift.store.getState().tool !== 'weather')) await page.getByRole('button', { name: 'Weather events', exact: true }).click()
    const panel = page.locator('.toolpanel')
    await panel.locator('.weather-kinds button').filter({ hasText: kind[0].toUpperCase() + kind.slice(1) }).click()
    await panel.getByRole('slider', { name: 'Radius', exact: true }).fill('90')
    const point = await page.evaluate((c) => { const p = window.__cityshift.map().project(c); const b = window.__cityshift.babylon.canvas.getBoundingClientRect(); return { x: p.x + b.left, y: p.y + b.top } }, center)
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(() => !!window.__cityshift.store.getState().ghost?.proposal)
    const preview = await page.evaluate(() => window.__cityshift.store.getState().ghost.proposal.hazard)
    assert.equal(preview.start_s, time)
    assert.equal(preview.kind, kind)
    const before = await snapshot()
    await page.evaluate(([parentId, trackId]) => {
      const ws = window.__cityshift.babylon
      window.__weatherApplyFrames = []
      window.__weatherApplyObserver = ws.scene.onAfterRenderObservable.add(() => {
        const s = window.__cityshift.store.getState()
        if (s.building || s.scenarioId === parentId) return
        window.__weatherApplyFrames.push({ t: s.t, present: ws.scene.meshes.some((m) => m.name.startsWith('hazard-') && m.name.includes(trackId)) })
      })
    }, [before.sid, preview.track_id])
    await panel.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.waitForFunction((sid) => { const s = window.__cityshift.store.getState(); return s.scenarioId !== sid && !s.building }, before.sid)
    await page.waitForTimeout(100)
    const applied = await snapshot()
    await page.waitForFunction(() => { const s = window.__cityshift.store.getState(); return !!s.primaryRunId && !s.loadingReplay }, null, { timeout: 120000 })
    await page.waitForTimeout(100)
    const replay = await snapshot()
    const frames = await page.evaluate(() => {
      window.__cityshift.babylon.scene.onAfterRenderObservable.remove(window.__weatherApplyObserver)
      return window.__weatherApplyFrames
    })
    assert.ok(frames.length > 0 && frames.every((frame) => frame.present), 'The event must remain drawn throughout the saved-scenario/replay handoff')
    console.log(JSON.stringify({ kind, before: { t: before.t, playing: before.playing, speed: before.speed }, applied, replay, visibleFrames: frames.length }))
    await page.screenshot({ path: `${out}${kind}-applied.png` })
    for (const state of [applied, replay]) {
      assert.equal(state.t, time, 'Apply and loading the child replay must preserve the timeline position')
      assert.equal(state.playing, false, 'Apply must preserve an explicit pause')
      assert.equal(state.speed, 4)
      assert.equal(state.error, null)
      assert.equal(state.hazards[0].start, preview.start_s)
      assert.equal(state.hazards[0].end, preview.end_s)
      assert.ok(state.meshes.some((name) => name.startsWith(`hazard-${kind}-`)), 'The applied weather must remain visible')
    }
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, preservedApplyTime: true, preservedReplayTime: true, kinds: ['rain', 'storm'] }))
} catch (error) {
  await page.screenshot({ path: `${out}failure.png` }).catch(() => {})
  console.error('Browser errors:', errors)
  throw error
} finally {
  await browser.close()
}
