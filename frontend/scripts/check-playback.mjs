import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'

const base = process.argv[2] ?? 'http://127.0.0.1:5173'
const scenarios = await (await fetch(`${base}/api/scenarios`)).json()
const scenario = scenarios.find((s) => s.pack_id === 'toronto') ?? scenarios.at(-1)
assert.ok(scenario, 'Browser checks need a city pack and scenario; all run data is mocked')
const run = {
  run_id: 'playback-fixture', scenario_id: scenario.scenario_id, plan_id: 'baseline', seed: 1,
  status: 'completed', engine_version: 'fixture', progress: 1, run_dir: '', error: null,
  warnings: [], metrics: null, manifest_hash: 'fixture', created_at: '',
}
const tracks = { car: {
  entity_id: 'car', kind: 'car', breaks: [],
  samples: Array.from({ length: 121 }, (_, t) => [t, -79.38 + t * 0.00005, 43.64, 90, 4]),
} }
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })

try {
  for (const path of ['/world', '/', '/mapbox']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => {
      const detail = error.stack || error.message || String(error)
      if (!errors.includes(detail)) errors.push(detail)
    })
    let submitted = false
    let polls = 0
    await page.route('**/api/**', (route) => route.request().method() === 'GET' ? route.continue() : route.abort())
    await page.route('**/api/runs**', async (route) => {
      const request = route.request()
      const pathname = new URL(request.url()).pathname
      let json
      if (pathname === '/api/runs') {
        if (request.method() === 'POST') {
          submitted = true
          json = { ...run, status: 'queued' }
        } else {
          json = path !== '/world' ? [run] : !submitted ? [] : [{ ...run, status: polls++ === 0 ? 'queued' : 'completed' }]
        }
      } else {
        const resource = pathname.split('/').at(-1)
        const resources = { tracks, events: [], occupancy: {}, stop_queue: {}, compile: null }
        json = Object.hasOwn(resources, resource) ? resources[resource] : run
      }
      await route.fulfill({ json })
    })
    await page.goto(`${base}${path}`)
    await expect(page.getByRole('button', { name: 'Pause simulation', exact: true })).toBeEnabled({ timeout: 120000 })
    await expect(page.getByRole('button', { name: '1×', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.clock .wall')).toHaveText(/^\d{2}:\d{2}:\d{2}$/)
    await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0)
    await expect(page.getByPlaceholder('Describe an intervention', { exact: false })).toHaveCount(0)
    await expect(page.getByTitle('Custom', { exact: true })).toHaveCount(0)
    const time = () => page.evaluate(() => window.__cityshift.store.getState().t)
    const initial = await time()
    await expect.poll(time).toBeGreaterThan(initial + 0.5)

    await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
    const paused = await time()
    await page.waitForTimeout(400)
    assert.equal(await time(), paused)
    await page.getByRole('button', { name: '2×', exact: true }).click()
    await expect(page.getByRole('button', { name: '2×', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Resume simulation', exact: true })).toBeEnabled()
    assert.equal(await time(), paused)
    await page.getByRole('button', { name: 'Resume simulation', exact: true }).click()
    const start = await page.evaluate(() => ({ t: window.__cityshift.store.getState().t, now: performance.now() }))
    await page.waitForTimeout(1000)
    const end = await page.evaluate(() => ({ t: window.__cityshift.store.getState().t, now: performance.now() }))
    const rate = (end.t - start.t) / ((end.now - start.now) / 1000)
    assert.ok(rate > 1.6 && rate < 2.4, `Expected 2x playback, observed ${rate}`)

    await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
    for (const speed of [4, 8, 1]) {
      await page.getByRole('button', { name: `${speed}×`, exact: true }).click()
      await expect(page.getByRole('button', { name: `${speed}×`, exact: true })).toHaveAttribute('aria-pressed', 'true')
    }
    await page.getByRole('button', { name: 'Restart simulation', exact: true }).click()
    assert.equal(await time(), 0)
    await page.getByRole('slider', { name: 'Simulation time', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await time(), 1)
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Pause simulation', exact: true })).toBeEnabled()

    await page.locator('.scenario-name').click()
    await expect(page.locator('.scenario-drawer')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0)
    await page.locator('.scenario-drawer').getByRole('button', { name: 'Close', exact: true }).click()
    const cameras = page.getByRole('navigation', { name: 'Camera', exact: true })
    await expect(cameras).toBeVisible()
    if (path === '/mapbox' && await page.locator('.map-notice').isVisible()) {
      await expect(page.locator('.map-notice')).toContainText('Connect Mapbox to load the 3D city')
      await expect(page.locator('.world canvas')).toHaveCount(0)
      for (const name of ['City', 'District', 'Corridor', 'Agent', 'Incident']) await expect(cameras.getByRole('button', { name, exact: true })).toBeDisabled()
      assert.deepEqual(errors, [])
      console.log('/mapbox: playback, removed controls, and missing-token notice passed; configured map rendering requires a token')
      await page.close()
      continue
    }
    if (path !== '/mapbox') {
      if (path === '/world') assert.ok(submitted, 'A fresh scenario should automatically prepare its first run')
      await page.waitForFunction(() => !!window.__cityshift?.babylon, null, { timeout: 120000 })
      await expect.poll(() => page.evaluate(() => window.__cityshift.babylon.simT)).toBeGreaterThan(1)
      await expect.poll(() => page.evaluate(() => window.__cityshift.babylon.traffic.stats.cars)).toBeGreaterThan(0)
    } else {
      const frames = await page.evaluate(() => window.__cityshift.stats.layerRebuilds)
      await expect.poll(() => page.evaluate(() => window.__cityshift.stats.layerRebuilds)).toBeGreaterThan(frames)
    }
    await expect.poll(() => page.evaluate(() => window.__cityshift.map()?.cameraLocked)).toBe(false)
    const cameraPose = () => page.evaluate(() => {
      const map = window.__cityshift.map()
      return { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
    })
    const insideCity = () => page.evaluate(() => {
      const bridge = window.__cityshift
      const world = bridge.babylon
      const map = bridge.map()
      const corners = [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]]
      if (world) {
        const [x0, z0, x1, z1] = world.world.crs.bounds_world
        const cam = world.camera.cam
        const Vector = cam.position.constructor
        const identity = cam.getViewMatrix().constructor.IdentityReadOnly
        return corners.every(([x, y]) => {
          const a = Vector.Unproject(new Vector(x, y, 0), innerWidth, innerHeight, identity, cam.getViewMatrix(), cam.getProjectionMatrix())
          const b = Vector.Unproject(new Vector(x, y, 0.5), innerWidth, innerHeight, identity, cam.getViewMatrix(), cam.getProjectionMatrix())
          const direction = b.subtract(a)
          const point = a.add(direction.scale(-a.y / direction.y))
          return point.x > x0 && point.x < x1 && point.z > z0 && point.z < z1
        })
      }
      const [west, south, east, north] = bridge.store.getState().pack.bbox
      return corners.every((point) => {
        const p = map.unproject(point)
        return p.lng > west && p.lng < east && p.lat > south && p.lat < north
      })
    })
    const waitForCamera = () => expect.poll(() => page.evaluate(() => window.__cityshift.map().isMoving())).toBe(false)
    await expect(cameras.getByRole('button', { name: 'City', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
    const beforeZoom = await cameraPose()
    await page.mouse.move(720, 400)
    await page.mouse.wheel(0, -240)
    await expect.poll(async () => Math.abs((await cameraPose()).zoom - beforeZoom.zoom)).toBeGreaterThan(0.01)
    await waitForCamera()
    for (const button of ['left', 'right']) {
      const beforeDrag = await cameraPose()
      await page.mouse.move(720, 400)
      await page.mouse.down({ button })
      await page.mouse.move(880, 460, { steps: 12 })
      await page.mouse.up({ button })
      await waitForCamera()
      const afterDrag = await cameraPose()
      assert.notDeepEqual(afterDrag, beforeDrag, `${button}-drag did not move the camera on ${path}`)
      if (path !== '/mapbox') {
        if (button === 'left') assert.notEqual(afterDrag.bearing, beforeDrag.bearing, 'Left-drag should orbit the city')
        else assert.notDeepEqual(afterDrag.center, beforeDrag.center, 'Right-drag should pan the city')
      }
    }
    await page.locator('.world canvas').first().focus()
    const beforeArrow = await time()
    await page.keyboard.press('ArrowRight')
    assert.equal(await time(), beforeArrow, 'Camera navigation must not scrub the simulation clock')
    await cameras.getByRole('button', { name: 'City', exact: true }).click()
    await waitForCamera()
    const carPoint = await page.evaluate(() => {
      const t = window.__cityshift.store.getState().t
      return window.__cityshift.map().project([-79.38 + t * 0.00005, 43.64])
    })
    await page.mouse.click(carPoint.x, carPoint.y)
    await expect.poll(() => page.evaluate(() => window.__cityshift.store.getState().selection?.id)).toBe('car')
    await expect(page.getByRole('button', { name: 'Follow', exact: true })).toBeVisible()
    await page.locator('.bubble').getByRole('button', { name: 'Close', exact: true }).click()
    if (path === '/world' && process.env.CAMERA_SCREENSHOT) await page.screenshot({ path: process.env.CAMERA_SCREENSHOT })
    const presetTime = await time()
    for (const name of ['District', 'Corridor', 'Agent', 'Incident', 'City']) {
      const before = await cameraPose()
      const button = cameras.getByRole('button', { name, exact: true })
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await waitForCamera()
      assert.notDeepEqual(await cameraPose(), before, `${name} did not change the camera on ${path}`)
      assert.ok(await insideCity(), `${name} exposes unrendered city edges on ${path}`)
      assert.equal(await time(), presetTime, `${name} changed the paused simulation clock`)
      await expect(page.getByRole('button', { name: 'Resume simulation', exact: true })).toBeEnabled()
    }
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('3')
    await expect(cameras.getByRole('button', { name: 'Corridor', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await waitForCamera()
    await page.getByRole('slider', { name: 'Simulation time', exact: true }).focus()
    await page.keyboard.press('2')
    await expect(cameras.getByRole('button', { name: 'Corridor', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => document.activeElement?.blur())
    const beforeResize = await cameraPose()
    for (const width of [1440, 768, 390, 3440]) {
      await page.setViewportSize({ width, height: 900 })
      const fits = await page.locator('.dock').evaluate((dock) => {
        const bounds = dock.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && dock.scrollWidth <= dock.clientWidth
      })
      assert.ok(fits, `Playback controls overflow at ${width}px on ${path}`)
      await page.waitForTimeout(100)
      assert.deepEqual(await cameraPose(), beforeResize, `Resizing should not reset the free camera at ${width}px on ${path}`)
      await expect(cameras.getByRole('button', { name: 'Corridor', exact: true })).toHaveAttribute('aria-pressed', 'true')
    }
    assert.deepEqual(errors, [])
    console.log(`${path}: playback, camera presets, free zoom/orbit/pan, click selection, and responsive dock passed`)
    await page.close()
  }
  if (process.env.CITYSHIFT_LIVE_REPLAY === '1') await checkLivePlayback(browser, base)
} finally {
  await browser.close()
}

async function checkLivePlayback(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', (route) => route.request().method() === 'GET' ? route.continue() : route.abort())
  await page.goto(`${base}/`)
  await page.waitForFunction(() => window.__cityshift?.store?.getState().primaryRunId && window.__cityshift?.babylon, null, { timeout: 120000 })
  const snapshot = () => page.evaluate(() => {
    const bridge = window.__cityshift
    const state = bridge.store.getState()
    const world = bridge.babylon
    const replay = state.replays[state.primaryRunId]
    const positions = {}
    for (const id of Object.keys(replay.tracks)) {
      const pose = world.traffic.poseOf(id)
      if (!pose) continue
      const point = bridge.map().projectWorld(pose.x, 1, pose.z)
      if (point.x > 80 && point.x < innerWidth - 100 && point.y > 70 && point.y < innerHeight - 140) positions[id] = pose
    }
    return { t: state.t, playing: state.playing, run: state.primaryRunId, activityStart: replay.activityStart, positions, renderedCars: world.scene.getMeshByName('car-body')?.thinInstanceCount ?? 0 }
  })
  const movedCars = (a, b) => Object.entries(a.positions).filter(([id, p]) => p.kind === 'car' && b.positions[id] && Math.hypot(p.x - b.positions[id].x, p.z - b.positions[id].z) > 1).length
  await expect.poll(async () => (await snapshot()).renderedCars).toBeGreaterThan(0)
  const before = await snapshot()
  assert.ok(before.playing && before.t >= before.activityStart)
  await page.waitForTimeout(2500)
  const after = await snapshot()
  assert.ok(movedCars(before, after) > 0, 'The real replay must show cars moving inside the default camera, not just a ticking clock')
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
  await page.waitForTimeout(100)
  const paused = await snapshot()
  await page.waitForTimeout(500)
  const held = await snapshot()
  assert.equal(held.t, paused.t)
  assert.deepEqual(held.positions, paused.positions)
  await page.getByRole('button', { name: 'Restart simulation', exact: true }).click()
  assert.equal((await snapshot()).t, 0)
  if (before.activityStart > 0) {
    await page.getByRole('button', { name: 'Jump to active traffic', exact: true }).click()
    const active = await snapshot()
    assert.equal(active.t, before.activityStart)
    assert.equal(active.playing, false)
  }
  await page.getByRole('button', { name: 'Resume simulation', exact: true }).click()
  await page.waitForTimeout(200)
  const resumed = await snapshot()
  await page.waitForTimeout(2000)
  assert.ok(movedCars(resumed, await snapshot()) > 0, 'Cars must move after resuming the real replay')
  assert.deepEqual(errors, [])
  console.log(`Live ${before.run}: ${movedCars(before, after)} visible cars moved; autoplay starts at +${before.activityStart}s; pause, resume, rewind, and activity jump passed`)
  await page.close()
}
