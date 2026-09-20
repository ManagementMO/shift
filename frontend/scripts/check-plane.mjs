import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5188')
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use an isolated local demo server')
const health = await fetch(new URL('/api/health', base)).then(r => r.json())
assert.equal(health.storage?.backend, 'json', 'This check must not use Atlas')
const out = new URL('../../visual-reviews/', import.meta.url)
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(60000)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
const errors = [], writes = []
page.on('pageerror', e => errors.push(e.message))
page.on('request', r => { if (r.url().includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
const input = page.getByRole('textbox', { name: 'Tell the city what happens' })
const send = async text => { await input.fill(text); await input.press('Enter') }
const screenshot = name => page.screenshot({ path: new URL(name, out).pathname })

try {
  await page.goto(new URL('/world', base).href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__cityshift?.babylon && !document.querySelector('.bworld-veil'), null, { timeout: 120000 })
  await page.evaluate(() => window.__cityshift.babylon.assetsReady)
  if (await page.getByRole('button', { name: 'Resume simulation', exact: true }).count()) await page.getByRole('button', { name: 'Resume simulation', exact: true }).click()
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
  await page.waitForFunction(() => !window.__cityshift.store.getState().playing)
  await page.getByRole('button', { name: 'Map layers', exact: true }).click()
  await page.getByLabel('Shadows', { exact: true }).uncheck()
  await page.waitForFunction(() => !window.__cityshift.babylon.scene.shadowsEnabled)
  const firstWrite = writes.length
  await send('Ask the agents to show a PLANE flying over the city')
  await page.waitForFunction(() => window.__cityshift.babylon.plane.active && window.__cityshift.babylon.scene.shadowsEnabled)
  assert.equal(await page.getByRole('dialog', { name: 'Agents & swarms' }).count(), 0)
  assert.equal(await page.locator('.gp-toast').count(), 0)
  await page.waitForFunction(() => !window.__cityshift.babylon.camera.flying)
  const before = await page.evaluate(() => window.__cityshift.babylon.scene.getTransformNodeByName('plane-flyover').position.asArray())
  await page.waitForTimeout(1800)
  const moving = await page.evaluate(() => {
    const w = window.__cityshift.babylon
    return { position: w.scene.getTransformNodeByName('plane-flyover').position.asArray(), playing: window.__cityshift.store.getState().playing,
      meshes: w.scene.meshes.filter(m => m.name.startsWith('plane-')).length,
      casters: w.shadows.getShadowMap().renderList.filter(m => m.name.startsWith('plane-')).length }
  })
  assert.equal(moving.playing, false)
  assert.equal(moving.meshes, 4)
  assert.equal(moving.casters, 4)
  assert(Math.hypot(...moving.position.map((n, i) => n - before[i])) > 20, 'The plane must fly even with SUMO paused')
  assert.deepEqual(writes.slice(firstWrite), [], 'Plane commands must not call the backend')

  await page.evaluate(() => {
    const w = window.__cityshift.babylon
    w.engine.stopRenderLoop()
    window.__planeCheckDelta = w.engine.getDeltaTime.bind(w.engine)
    w.engine.getDeltaTime = () => 0
    for (let i = 0; i < 100; i++) w.plane.update(0.1)
    w.scene.render()
  })
  const withShadow = await screenshot('plane-flyover.png')
  const aircraftBounds = await page.evaluate(() => {
    const w = window.__cityshift.babylon
    const root = w.scene.getTransformNodeByName('plane-flyover')
    const V = root.position.constructor
    const viewport = w.camera.cam.viewport.toGlobal(w.engine.getRenderWidth(), w.engine.getRenderHeight())
    const meshes = w.scene.meshes.filter(m => m.name.startsWith('plane-'))
    const points = []
    for (const mesh of meshes) {
      const vertices = mesh.getVerticesData('position')
      for (let i = 0; i < vertices.length; i += 3) points.push(V.Project(V.FromArray(vertices, i), mesh.getWorldMatrix(), w.scene.getTransformMatrix(), viewport))
    }
    for (const mesh of meshes) w.shadows.removeShadowCaster(mesh, false)
    w.invalidateShadows()
    w.scene.render()
    return [Math.min(...points.map(p => p.x)) - 8, Math.min(...points.map(p => p.y)) - 8, Math.max(...points.map(p => p.x)) + 8, Math.max(...points.map(p => p.y)) + 8]
  })
  const withoutShadow = await screenshot('plane-no-shadow-reference.png')
  const shadowPixels = await page.evaluate(async ({ before, after, aircraft }) => {
    const pixels = async data => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return { width: image.width, data: ctx.getImageData(0, 0, image.width, image.height).data }
    }
    const a = await pixels(before), b = await pixels(after)
    let changed = 0
    for (let i = 0; i < a.data.length; i += 4) {
      const x = i / 4 % a.width, y = Math.floor(i / 4 / a.width)
      if (x >= aircraft[0] && x <= aircraft[2] && y >= aircraft[1] && y <= aircraft[3]) continue
      const brighter = b.data[i] + b.data[i + 1] + b.data[i + 2] - a.data[i] - a.data[i + 1] - a.data[i + 2]
      if (brighter > 30) changed++
    }
    return changed
  }, { before: withShadow.toString('base64'), after: withoutShadow.toString('base64'), aircraft: aircraftBounds })
  assert(shadowPixels > 50, `Expected a visible shadow on the city, not just on the aircraft: ${shadowPixels} pixels`)
  console.log(`Plane shadow verified on ${shadowPixels} city pixels outside the aircraft`)

  await page.evaluate(() => {
    const w = window.__cityshift.babylon
    for (let i = 0; i < 300; i++) w.plane.update(0.1)
    w.engine.getDeltaTime = window.__planeCheckDelta
    delete window.__planeCheckDelta
    w.engine.runRenderLoop(() => w.scene.render())
  })
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.plane.active), false)
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.scene.meshes.filter(m => m.name.startsWith('plane-')).length), 0)
  await send('a plane')
  await send('another airplane')
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.scene.meshes.filter(m => m.name.startsWith('plane-')).length), 4)
  await page.getByRole('tab', { name: 'Events', exact: true }).click()
  await page.getByRole('button', { name: /Normal Conditions/ }).click()
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.plane.active), false)
  await send('a planet')
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.plane.active), false)

  for (const [width, height] of [[1280, 600], [390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height })
    await send('a plane over the city')
    await page.waitForFunction(() => !window.__cityshift.babylon.camera.flying)
    const box = await input.boundingBox()
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Command UI must not overflow')
    const projected = await page.evaluate(() => {
      const w = window.__cityshift.babylon
      for (let i = 0; i < 100; i++) w.plane.update(0.1)
      w.scene.render()
      const position = w.scene.getTransformNodeByName('plane-flyover').position
      return window.__cityshift.map().projectWorld(position.x, position.y, position.z)
    })
    assert(projected.x > 0 && projected.x < width && projected.y > 90 && projected.y < height - 100, `Aircraft must be visible at ${width}x${height}: ${JSON.stringify(projected)}`)
    await screenshot(`plane-${width}x${height}.png`)
  }
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__cityshift?.babylon)
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.plane.active), false)
  assert.deepEqual(errors, [])
  console.log('Plane command, paused playback, actual shadow, repeat/cleanup, responsive layouts, and reload passed')
} catch (error) {
  console.error('Browser errors:', errors)
  console.error('Page state:', await page.locator('body').innerText().catch(() => 'unavailable'))
  await screenshot('plane-check-failure.png').catch(() => {})
  throw error
} finally {
  await browser.close()
}
