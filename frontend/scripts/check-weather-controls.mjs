import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:8147'
assert.equal((await fetch(`${base}/api/health`).then((r) => r.json())).storage?.database, 'cityshift_browser_test')
const out = new URL('../test-results/weather-controls/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(30000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error' && /shader|compil.*effect|GL_INVALID/i.test(message.text())) errors.push(message.text()) })
let removals = 0
page.on('request', (request) => { if (request.url().includes('/remove/preview')) removals++ })
const shot = (name) => page.screenshot({ path: `${out}${name}.png` })
const state = () => page.evaluate(() => {
  const s = window.__cityshift.store.getState()
  return { sid: s.scenarioId, t: s.t, info: s.hazardInfoId, sketch: s.hazardSketch, ghost: s.ghost, error: s.error, scenario: s.scenarios.find((x) => x.scenario_id === s.scenarioId) }
})
const meshNames = () => page.evaluate(() => window.__cityshift.babylon.scene.meshes.filter((m) => /^hazard-(rain|storm|fire)-/.test(m.name)).map((m) => m.name))
const screenOf = (c) => page.evaluate((c) => {
  const p = window.__cityshift.map().project(c), b = window.__cityshift.babylon.canvas.getBoundingClientRect()
  return { x: p.x + b.left, y: p.y + b.top }
}, c)
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const open = async (sid = 'hazard-preview-base') => {
  await page.evaluate(async (sid) => { await window.__cityshift.store.getState().selectScenario(sid); window.__cityshift.pause(); window.__cityshift.seek(100); window.__cityshift.store.getState().setTool(null) }, sid)
  await page.waitForFunction(() => window.__cityshift.babylon.world.pack_id === window.__cityshift.store.getState().pack.pack_id, null, { timeout: 120000 })
}
const tool = async (kind, radius) => {
  await page.locator('.rail button[title="Weather events"]').click()
  const panel = page.locator('.toolpanel')
  await panel.locator('.weather-kinds button').filter({ hasText: kind }).click()
  await panel.getByRole('slider', { name: 'Radius', exact: true }).fill(String(radius))
  return panel
}
const preview = () => page.waitForFunction(() => { const s = window.__cityshift.store.getState(); return !!s.ghost?.proposal })
const apply = async (panel) => {
  const old = (await state()).sid
  await panel.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.waitForFunction((sid) => { const s = window.__cityshift.store.getState(); return s.scenarioId !== sid && !s.building }, old)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.mouse.move(25, 25)
  await settle()
  return (await state()).scenario
}
const crossDelete = async (kind, scene, point) => {
  const before = removals
  await page.mouse.click(point.x, point.y)
  const cross = page.getByRole('button', { name: `Remove ${kind}`, exact: true })
  await cross.waitFor()
  assert.equal((await state()).sid, scene.scenario_id, 'Selecting an incident must not create a removal branch')
  assert.equal(removals, before)
  await page.mouse.click(point.x, point.y)
  assert.equal(removals, before, 'Repeated incident clicks only select')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.hazard-map-remove').count(), 0)
  await page.mouse.click(point.x, point.y)
  await cross.waitFor()
  const box = await cross.boundingBox()
  assert.ok(box.width <= 32 && box.height <= 32, 'The removal control must remain small')
  await shot(`${kind.toLowerCase()}-selected-cross`)
  await cross.click()
  await page.waitForFunction((sid) => { const s = window.__cityshift.store.getState(); return s.scenarioId !== sid && !s.building }, scene.scenario_id)
  assert.equal(removals, before + 1)
  assert.deepEqual((await state()).scenario.hazards, [])
  const parentCount = await page.evaluate((id) => window.__cityshift.store.getState().scenarios.find((s) => s.scenario_id === id).hazards.length, scene.scenario_id)
  assert.equal(parentCount, 1)
}

try {
  await page.goto(`${base}/world?pack=hazard-preview`)
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !!window.__cityshift.store.getState().scenarioId, null, { timeout: 120000 })
  await open()
  const center = [-79.39, 43.644]
  await page.evaluate((center) => window.__cityshift.camera({ center, zoom: 16.8, pitch: 52, bearing: -25 }, 'incident'), center)
  await page.waitForTimeout(1600)
  for (const kind of ['Rain', 'Storm']) {
    await open()
    await page.evaluate((center) => window.__cityshift.camera({ center, zoom: 16.2, pitch: 56, bearing: -25 }, 'incident'), center)
    await page.waitForTimeout(1500)
    const panel = await tool(kind, 110)
    assert.equal(await panel.locator('.weather-kinds button').count(), 2)
    assert.equal(await panel.locator('.weather-kinds button').filter({ hasText: 'Fire' }).count(), 0)
    const p = await screenOf(center)
    await page.mouse.click(p.x, p.y)
    await preview()
    const scene = await apply(panel), id = scene.hazards[0].track_id
    const geometry = await page.evaluate(([kind, id]) => {
      const s = window.__cityshift.babylon.scene
      const cloud = s.getMeshByName(`hazard-${kind}-cloud-${id}`), shadow = s.getMeshByName(`hazard-${kind}-shadow-${id}`)
      return { cloud: cloud.getTotalVertices(), shadow: shadow.getTotalVertices(), instances: cloud.thinInstanceCount, soft: cloud.material.needAlphaBlending() && shadow.material.needAlphaBlending() }
    }, [kind.toLowerCase(), id])
    assert.equal(geometry.cloud, 4)
    assert.equal(geometry.shadow, 4)
    assert.ok(geometry.instances > 40 && geometry.soft)
    const drop = await page.evaluate(([kind, id]) => {
      const m = window.__cityshift.babylon.scene.getMeshByName(`hazard-${kind}-rain-${id}`), a = m._thinInstanceDataStorage.matrixData
      const index = Array.from({ length: m.thinInstanceCount }, (_, i) => i).find((i) => a[i * 16 + 13] > 45 && a[i * 16 + 13] < 80)
      return { index, xyz: Array.from(a.slice(index * 16 + 12, index * 16 + 15)) }
    }, [kind.toLowerCase(), id])
    await page.waitForTimeout(80)
    const after = await page.evaluate(([kind, id, index]) => Array.from(window.__cityshift.babylon.scene.getMeshByName(`hazard-${kind}-rain-${id}`)._thinInstanceDataStorage.matrixData.slice(index * 16 + 12, index * 16 + 15)), [kind.toLowerCase(), id, drop.index])
    assert.equal(after[0], drop.xyz[0]); assert.equal(after[2], drop.xyz[2]); assert.ok(after[1] < drop.xyz[1], 'Rain must fall down, not drift sideways')
    await shot(`${kind.toLowerCase()}-effects`)
    const cloudPoint = await page.evaluate(([kind, id]) => {
      const ws = window.__cityshift.babylon, map = window.__cityshift.map(), m = ws.scene.getMeshByName(`hazard-${kind}-cloud-${id}`)
      const a = m._thinInstanceDataStorage.matrixData, b = ws.canvas.getBoundingClientRect()
      for (let i = 0; i < m.thinInstanceCount; i++) {
        const p = map.projectWorld(a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14])
        if (p.x > 440 && p.x < 1200 && p.y > 150 && p.y < 650) return { x: p.x + b.left, y: p.y + b.top }
      }
      return null
    }, [kind.toLowerCase(), id])
    assert.ok(cloudPoint, 'Cloud particles must have a clickable visible region')
    await crossDelete(kind, scene, cloudPoint)
  }
  assert.deepEqual(await meshNames(), [])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, fireAuthoringRemoved: true, crossOnlyRemoval: true, softCloudsAndShadows: true, verticalRain: true }))
} catch (error) {
  await shot('failure').catch(() => {})
  console.error('State:', JSON.stringify(await state().catch(() => null)).slice(0, 2500))
  console.error('Browser errors:', errors)
  throw error
} finally {
  await browser.close()
}
