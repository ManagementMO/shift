import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5198')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use a local frontend only.')
const worldResponse = await fetch(new URL('/api/packs/toronto/world', base))
assert(worldResponse.ok, 'The local frontend must serve an existing Toronto world pack.')
const worldData = await worldResponse.json()
const landmark = worldData.landmarks.find(l => l.kind === 'cn_tower') ?? worldData.venue
const center = { x: landmark.x, z: landmark.z }
const counts = { total: 2, not_departed: 0, walking: 2, waiting: 0, riding: 0, driving: 0, arrived: 0, unroutable: 0 }
const session = {
  session_id: 'live-orbital-test', pack_id: 'toronto', network_fingerprint: worldData.network_fingerprint,
  config: { pack_id: 'toronto', seed: 7, initial_population: 2, fleet_size: 0, horizon_s: 3600, temperature_c: 20, car_share: 0 },
  parent_session_id: null, fork_s: null, time_s: 9, available_until_s: 9, horizon_s: 3600,
  status: 'paused', revision: 0, temperature_c: 20, counts, commands: [], entity_count: 2, engine_version: 'Browser fixture', error: null,
}
const metadata = { entities: [{ index: 0, id: 'inside-laser', kind: 'person', depart_s: 0 }, { index: 1, id: 'outside-laser', kind: 'person', depart_s: 0 }], routes: [], fleet: [] }
function frames(start) {
  const bytes = Buffer.alloc(10 * 96)
  for (let frame = 0; frame < 10; frame++) {
    const offset = frame * 96
    bytes.writeUInt32LE(0x31465343, offset)
    bytes.writeUInt32LE(start + frame, offset + 4)
    bytes.writeUInt32LE(2, offset + 8)
    Object.values(counts).forEach((value, i) => bytes.writeUInt32LE(value, offset + 12 + i * 4))
    bytes.writeFloatLE(20, offset + 44)
    for (let i = 0; i < 2; i++) {
      const p = offset + 48 + i * 24
      bytes.writeUInt32LE(i, p)
      bytes.writeFloatLE(center.x + (i ? 650 : 15), p + 4)
      bytes.writeFloatLE(center.z + 15, p + 8)
      bytes.writeFloatLE(0, p + 12)
      bytes.writeFloatLE(0, p + 16)
      bytes.writeUInt8(1, p + 20)
      bytes.writeUInt8(1, p + 21)
    }
  }
  return bytes
}

const out = new URL('../../visual-reviews/', import.meta.url)
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 600 }, deviceScaleFactor: 1, hasTouch: true })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
const unexpectedWrites = []
await page.route('**/api/**', async route => {
  const request = route.request()
  const path = new URL(request.url()).pathname
  if (path.startsWith('/api/live')) {
    if (path.endsWith('/metadata')) return route.fulfill({ json: metadata })
    if (path.includes('/frames/')) return route.fulfill({ body: frames(Number(path.split('/').at(-1))), contentType: 'application/octet-stream' })
    if (path === '/api/live' && request.method() === 'GET') return route.fulfill({ json: [session] })
    if (path.endsWith('/commands') || path.endsWith('/preview')) unexpectedWrites.push(path)
    return route.fulfill({ json: session })
  }
  if (request.method() !== 'GET') {
    unexpectedWrites.push(path)
    return route.fulfill({ status: 400, json: { detail: 'This renderer check never changes backend data.' } })
  }
  return route.continue()
})

async function fits(selector) {
  await page.locator(selector).evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
  const box = await page.locator(selector).boundingBox()
  const viewport = page.viewportSize()
  assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${selector} must fit ${viewport.width}×${viewport.height}`)
  for (const footer of ['.god-chrome__dock', '.god-chrome__command-zone']) {
    const other = await page.locator(footer).boundingBox()
    assert(!other || box.x >= other.x + other.width || other.x >= box.x + box.width || box.y >= other.y + other.height || other.y >= box.y + box.height, `${selector} must not cover ${footer}`)
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow')
}
const screenshot = name => page.screenshot({ path: new URL(`orbital-${name}.png`, out).pathname })

try {
  await page.goto(new URL('/world?panel=events', base).href, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !document.querySelector('.bworld-veil, .gp-busy-cover'), null, { timeout: 120000 })
  await page.evaluate(center => {
    window.__cityshift.pause()
    const ws = window.__cityshift.babylon
    ws.camera.apply({ target: [center.x, center.z], radius: 1550, heading: -25, elevation: 48 })
  }, center)
  await page.locator('.gp-event-menu button').filter({ hasText: 'Orbital Laser' }).click()
  await page.getByRole('spinbutton', { name: 'Affected radius in metres' }).fill('200')
  await fits('.gp-event-config')
  await screenshot('config-desktop')
  await page.getByRole('button', { name: 'Choose target', exact: true }).click()
  assert(await page.getByRole('button', { name: 'Fire orbital laser', exact: true }).isDisabled())
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.keys.enabled), false)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.keys.enabled), true)
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.camera.cam.inputs.attachedToElement), true)
  await page.getByRole('button', { name: 'Choose target', exact: true }).click()
  await page.mouse.click(640, 300)
  assert.equal(await page.getByRole('button', { name: 'Fire orbital laser', exact: true }).isEnabled(), true)
  const cameraRadius = await page.evaluate(() => window.__cityshift.babylon.camera.cam.radius)
  await page.mouse.wheel(0, -120)
  await page.waitForFunction(() => document.querySelector('input[aria-label="Laser radius"]')?.value === '225')
  await page.keyboard.press(']')
  assert.equal(await page.getByRole('slider', { name: 'Laser radius' }).inputValue(), '250')
  await page.keyboard.press('[')
  await page.keyboard.press('[')
  assert.equal(await page.getByRole('slider', { name: 'Laser radius' }).inputValue(), '200')
  assert.equal(await page.evaluate(() => window.__cityshift.babylon.camera.cam.radius), cameraRadius)
  await screenshot('target-desktop')
  await page.evaluate(async center => {
    const ws = window.__cityshift.babylon
    await ws.orbital.prepare()
    const stateModule = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/gods-plan/state.ts')
    if (!stateModule) throw new Error('The live UI event-state module was not loaded.')
    const { useGodVisuals } = await import(stateModule.name)
    const update = ws.orbital.update.bind(ws.orbital)
    window.__orbitalCheck = { samples: [], ids: ws.buildings.inCircle(center.x, center.z, 200), store: useGodVisuals, phase: 0, restore: () => { ws.orbital.update = update; window.__orbitalCheck.phase = null } }
    ws.orbital.update = now => {
      const strike = useGodVisuals.getState().lasers.at(-1)?.strike
      update(strike ? strike.firedAt + window.__orbitalCheck.phase : now)
    }
    ws.scene.onAfterRenderObservable.add(() => {
      const strike = useGodVisuals.getState().lasers.at(-1)?.strike
      if (!strike) return
      const age = window.__orbitalCheck.phase ?? performance.now() / 1000 - strike.firedAt
      if (age > 3) return
      const beam = ws.scene.meshes.find(m => m.name.startsWith('orbital-beam-') && m.isEnabled())
      window.__orbitalCheck.samples.push({
        age, beam: !!beam, bottom: beam ? beam.position.y - beam.scaling.y / 2 : null,
        width: beam ? beam.scaling.x / (strike.radius * 1.06) : null,
        innerCleared: ws.orbital.clearedAt(strike.x + strike.radius * 0.2, strike.z),
        outerCleared: ws.orbital.clearedAt(strike.x + strike.radius * 0.8, strike.z),
      })
    })
  }, center)
  await page.getByRole('button', { name: 'Fire orbital laser', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__orbitalCheck.store.getState().lasers.length), 1, 'Firing through the UI registers a strike')
  for (const [phase, image] of [[0.16, null], [0.56, 'central-beam'], [1.18, 'expanding-beam'], [1.72, 'beam'], [2.6, null]]) {
    await page.evaluate(phase => { window.__orbitalCheck.phase = phase }, phase)
    await page.waitForFunction(phase => window.__orbitalCheck.samples.some(sample => sample.age === phase), phase)
    if (image) await screenshot(image)
  }
  await page.evaluate(() => window.__orbitalCheck.restore())
  await page.getByText('Strike complete — area cleared', { exact: true }).waitFor()
  await screenshot('cleared')
  const result = await page.evaluate(() => {
    const ws = window.__cityshift.babylon
    const check = window.__orbitalCheck
    return {
      hidden: check.ids.filter(id => ws.city.isHidden(id)).length, total: check.ids.length,
      inside: ws.traffic.poseOf('inside-laser'), outside: ws.traffic.poseOf('outside-laser'),
      keys: ws.keys.enabled, pointer: ws.camera.cam.inputs.attachedToElement,
      playing: window.__cityshift.store.getState().playing,
      samples: check.samples,
    }
  })
  assert(result.total > 0 && result.hidden === result.total, 'Every struck building and landmark is gone')
  assert.equal(result.inside, null)
  assert(result.outside, 'Travelers outside the radius remain')
  assert(result.keys && result.pointer, 'Camera controls restored after firing')
  assert.equal(result.playing, false, 'The beam works while playback stays paused')
  assert(result.samples.some(s => s.beam && s.bottom > 1), 'The column descends from the sky')
  assert(result.samples.some(s => s.beam && s.bottom < 1), 'The column reaches the ground')
  assert(result.samples.some(s => s.age >= 0.4 && s.age < 0.72 && s.beam && s.width <= 0.06 && !s.innerCleared), 'A narrow central beam lands before expansion starts')
  assert(result.samples.some(s => s.beam && s.width > 0.25 && s.width < 0.75 && s.innerCleared && !s.outerCleared), 'The beam and clearing expand outwards together')
  assert(result.samples.some(s => s.beam && s.width > 0.99 && s.outerCleared), 'The beam reaches the selected radius before fading')
  assert(result.samples.some(s => s.age >= 2.4 && !s.beam), 'The column is released after 2.4 seconds')
  console.log(JSON.stringify({ clearedBuildings: result.hidden, verifiedStages: ['descent', 'central beam', 'radial expansion', 'full radius', 'fade'] }))
  await page.getByRole('button', { name: 'Restore area', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__orbitalCheck.ids.some(id => window.__cityshift.babylon.city.isHidden(id))), false)
  await page.waitForFunction(() => !!window.__cityshift.babylon.traffic.poseOf('inside-laser'))
  await screenshot('restored')
  const timing = await page.evaluate(async center => {
    const ws = window.__cityshift.babylon, store = window.__orbitalCheck.store
    const baseline = [], firing = []
    let active = false
    const observer = ws.scene.onAfterRenderObservable.add(() => (active ? firing : baseline).push(performance.now()))
    await new Promise(resolve => setTimeout(resolve, 600))
    active = true
    store.getState().addLaser({ strike: { id: 'timing-check', ...center, radius: 200, firedAt: performance.now() / 1000 }, area: 'Toronto' })
    await new Promise(resolve => setTimeout(resolve, 2400))
    ws.scene.onAfterRenderObservable.remove(observer)
    store.getState().removeLaser('timing-check')
    const summary = samples => {
      const gaps = samples.slice(1).map((value, i) => value - samples[i])
      return { frames: samples.length, meanMs: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), longestMs: Math.round(Math.max(...gaps)) }
    }
    return { baseline: summary(baseline), laser: summary(firing) }
  }, center)
  console.log(JSON.stringify({ renderTimingWithoutScreenshots: timing }))

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport)
    await page.locator('.gp-event-menu button').filter({ hasText: 'Orbital Laser' }).click()
    await fits('.gp-event-config')
    await fits('.gp-laser-config .gp-event-config-actions')
    await screenshot(`config-${viewport.width}`)
    await page.getByRole('button', { name: 'Choose target', exact: true }).click()
    await fits('.gp-laser-targeting')
    if (viewport.width === 320) {
      assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName), 'CANVAS', 'The phone targeting panel must leave the map centre tappable')
      await page.touchscreen.tap(viewport.width / 2, viewport.height / 2)
    } else await page.getByRole('button', { name: 'Target view centre', exact: true }).click()
    assert(await page.getByRole('button', { name: 'Fire orbital laser', exact: true }).isEnabled())
    await screenshot(`target-${viewport.width}`)
    await page.getByRole('button', { name: 'Fire orbital laser', exact: true }).click()
    await page.getByText('Strike complete — area cleared', { exact: true }).waitFor()
    await fits('.gp-laser-result')
    await fits('.gp-laser-result .gp-laser-actions')
    await screenshot(`result-${viewport.width}`)
    await page.getByRole('button', { name: 'Restore area', exact: true }).click()
  }
  assert.deepEqual(unexpectedWrites, [], 'No saved-city edits or live event commands were submitted')
  assert.deepEqual(errors, [], 'No browser or shader errors')
  console.log('Orbital laser browser check passed: targeting, sky beam, clearing, restoration, and three viewport sizes.')
} catch (error) {
  await screenshot('failure').catch(() => {})
  console.error(errors.slice(0, 10))
  throw error
} finally {
  await browser.close()
}
