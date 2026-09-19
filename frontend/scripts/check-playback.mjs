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
  for (const path of ['/world', '/']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => {
      const detail = error.stack ?? error.message
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
          json = path === '/' ? [run] : !submitted ? [] : [{ ...run, status: polls++ === 0 ? 'queued' : 'completed' }]
        }
      } else {
        const resource = pathname.split('/').at(-1)
        const resources = { tracks, events: [], occupancy: {}, stop_queue: {}, compile: null }
        json = Object.hasOwn(resources, resource) ? resources[resource] : run
      }
      await route.fulfill({ json })
    })
    await page.route('https://tiles.openfreemap.org/styles/positron', (route) => route.fulfill({ json: {
      version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#cfd8de' } }],
    } }))
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
    if (path === '/world') {
      assert.ok(submitted, 'A fresh scenario should automatically prepare its first run')
      await page.waitForFunction(() => !!window.__cityshift?.babylon, null, { timeout: 120000 })
      await expect.poll(() => page.evaluate(() => window.__cityshift.babylon.simT)).toBeGreaterThan(1)
      await expect.poll(() => page.evaluate(() => window.__cityshift.babylon.traffic.stats.cars)).toBeGreaterThan(0)
    } else {
      const frames = await page.evaluate(() => window.__cityshift.stats.layerRebuilds)
      await expect.poll(() => page.evaluate(() => window.__cityshift.stats.layerRebuilds)).toBeGreaterThan(frames)
    }
    await expect(page.getByRole('navigation', { name: 'Camera', exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__cityshift.map()?.cameraLocked)).toBe(true)
    const cameraPose = () => page.evaluate(() => {
      const map = window.__cityshift.map()
      return { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
    })
    const fixed = await cameraPose()
    await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
    await page.mouse.move(720, 400)
    await page.mouse.wheel(0, 2000)
    for (const button of ['left', 'right']) {
      await page.mouse.move(720, 400)
      await page.mouse.down({ button })
      await page.mouse.move(920, 500, { steps: 12 })
      await page.mouse.up({ button })
    }
    await page.mouse.dblclick(720, 400)
    for (const key of ['2', '3', '4', '5', '6', '=', '-', 'Shift+ArrowUp']) await page.keyboard.press(key)
    await page.evaluate(() => window.__cityshift.camera({ center: [-80, 44], zoom: 5, pitch: 80, bearing: 150 }))
    await page.waitForTimeout(500)
    assert.deepEqual(await cameraPose(), fixed, `Camera moved after input on ${path}`)
    const carPoint = await page.evaluate(() => {
      const t = window.__cityshift.store.getState().t
      return window.__cityshift.map().project([-79.38 + t * 0.00005, 43.64])
    })
    await page.mouse.click(carPoint.x, carPoint.y)
    await expect.poll(() => page.evaluate(() => window.__cityshift.store.getState().selection?.id)).toBe('car')
    await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0)
    await page.locator('.bubble').getByRole('button', { name: 'Close', exact: true }).click()
    if (path === '/world' && process.env.CAMERA_SCREENSHOT) await page.screenshot({ path: process.env.CAMERA_SCREENSHOT })
    for (const width of [1440, 768, 390, 3440]) {
      await page.setViewportSize({ width, height: 900 })
      const fits = await page.locator('.dock').evaluate((dock) => {
        const bounds = dock.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && dock.scrollWidth <= dock.clientWidth
      })
      assert.ok(fits, `Playback controls overflow at ${width}px on ${path}`)
      await page.waitForTimeout(100)
      const insideCity = await page.evaluate(() => {
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
      assert.ok(insideCity, `Camera exposes unrendered edges at ${width}px on ${path}`)
    }
    assert.deepEqual(errors, [])
    console.log(`${path}: playback, fixed camera, click selection, safe city bounds, and responsive dock passed`)
    await page.close()
  }
} finally {
  await browser.close()
}
