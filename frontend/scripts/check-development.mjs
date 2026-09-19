import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const base = process.argv[2] ?? 'http://127.0.0.1:18171'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Use an isolated local server')
process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL('../../var/playwright', import.meta.url).pathname
const { chromium } = await import('playwright')
const out = new URL(`../../visual-reviews/development-${Date.now()}/`, import.meta.url).pathname
mkdirSync(out, { recursive: true })

async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  const data = await response.json()
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`)
  return data
}

const health = await api('/api/health')
assert.equal(health.storage.backend, 'json', 'This regression refuses to write test scenarios to Atlas')
const pack = await api('/api/packs/toronto')
const parent = await api('/api/scenarios/flagship', { pack_id: pack.pack_id, seed: 911, cohort_size: 20, horizon_s: 1200 })
const parentDemand = await api(`/api/scenarios/${parent.scenario_id}/demand`)
const beforeCount = (await api('/api/scenarios')).length
const name = `Map test apartments ${Date.now()}`
const spec = {
  name, land_use: 'residential', position: pack.venue_lonlat, footprint_m: [36, 26], height_m: 30,
  capacity: 12, people_per_unit: 1, trip_rate: 1, car_share: 1, walk_limit_m: 1500,
  zone_shares: Object.fromEntries(pack.zones.map((z) => [z.zone_id, z.share])),
  first_wave: { start_s: 0, end_s: 60, profile: 'uniform' }, return_wave: null, seed: 7,
}
let placement = null
const candidates = [...pack.stops.filter((s) => s.stop_id.startsWith('SB_')), ...pack.stops].slice(0, 24)
for (const stop of candidates) {
  const position = [stop.lon, stop.lat + 0.00025]
  const response = await fetch(`${base}/api/scenarios/${parent.scenario_id}/developments/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...spec, position }),
    signal: AbortSignal.timeout(60000),
  })
  if (response.ok) { placement = position; break }
}
assert.ok(placement, 'No validated test placement found beside the candidate stops')
console.log(JSON.stringify({ phase: 'fixture-ready', parent: parent.scenario_id, placement }))

const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] : [] })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(45000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const ready = async () => {
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !document.querySelector('.bworld-veil'), null, { timeout: 120000 })
  await page.waitForTimeout(1000)
}
const positionCamera = async (position) => {
  await page.evaluate((center) => window.__cityshift.map().jumpTo({ center, zoom: 17.4, pitch: 50, bearing: 0 }), position)
  await page.waitForTimeout(700)
}
const openAndPlace = async () => {
  await page.locator('.railbtn[title="Development"]').click()
  await positionCamera(placement)
  const point = await page.evaluate((position) => window.__cityshift.map().project(position), placement)
  const canvas = await page.locator('.world-solo canvas').boundingBox()
  await page.mouse.click(canvas.x + point.x, canvas.y + point.y)
  await page.waitForFunction(() => window.__cityshift.store.getState().developmentPlaced)
  assert.equal(await page.locator('.development-pin.draft').count(), 1)
}
const fillAssumptions = async () => {
  await page.getByLabel('Development name', { exact: true }).fill(name)
  await page.getByLabel('Capacity (units)', { exact: true }).fill('12')
  await page.getByLabel('People per unit', { exact: true }).fill('1')
  await page.getByLabel('Participation (%)', { exact: true }).fill('100')
  await page.getByLabel('Car share (%)', { exact: true }).fill('100')
  await page.getByLabel('Departures end (s)', { exact: true }).fill('60')
}
const preview = async () => {
  await page.getByRole('button', { name: 'Preview development', exact: true }).click()
  await page.waitForFunction(() => !!window.__cityshift.store.getState().developmentPreview, null, { timeout: 120000 })
  const proposal = await page.evaluate(() => window.__cityshift.store.getState().developmentPreview)
  assert.equal(proposal.added_trips, 12)
  assert.equal(proposal.incumbent_trips, 20)
  assert.equal(proposal.outbound_trips, 12)
  return proposal
}

try {
  await page.goto(base, { waitUntil: 'load' })
  await ready()
  await page.evaluate(async (sid) => { await window.__cityshift.store.getState().selectScenario(sid) }, parent.scenario_id)
  await openAndPlace()
  await page.getByRole('button', { name: 'Offices', exact: true }).click()
  assert.equal(await page.getByLabel('Capacity (employees)', { exact: true }).inputValue(), '200')
  await page.getByRole('button', { name: 'School', exact: true }).click()
  assert.equal(await page.getByLabel('Arrival-bound trips end (s)', { exact: true }).inputValue(), '300')
  await page.getByRole('button', { name: 'Apartments', exact: true }).click()
  await fillAssumptions()
  await preview()
  assert.equal((await api('/api/scenarios')).length, beforeCount)
  await page.getByRole('button', { name: 'Cancel placement', exact: true }).click()
  assert.equal(await page.locator('.development-pin.draft').count(), 0)
  assert.equal((await api('/api/scenarios')).length, beforeCount)
  console.log(JSON.stringify({ phase: 'cancel-verified' }))

  await openAndPlace()
  await fillAssumptions()
  const proposal = await preview()
  await page.screenshot({ path: `${out}preview.png` })
  await page.getByRole('button', { name: 'Confirm development', exact: true }).click()
  await page.waitForFunction((sid) => window.__cityshift.store.getState().scenarioId !== sid && !window.__cityshift.store.getState().building, parent.scenario_id, { timeout: 180000 })
  const childId = await page.evaluate(() => window.__cityshift.store.getState().scenarioId)
  const child = await api(`/api/scenarios/${childId}`)
  assert.equal(child.parent_scenario_id, parent.scenario_id)
  assert.deepEqual(child.developments[0].spec, proposal.development.spec)
  const childDemand = await api(`/api/scenarios/${childId}/demand`)
  assert.equal(childDemand.travelers.length, parentDemand.travelers.length + 12)
  assert.deepEqual(childDemand.travelers.slice(0, parentDemand.travelers.length), parentDemand.travelers)
  assert.deepEqual(await api(`/api/scenarios/${parent.scenario_id}`), parent)
  assert.deepEqual(await api(`/api/packs/${pack.pack_id}`), pack)
  assert.match(await page.locator('.scenario-name').innerText(), /Branch/)
  const buildingOnScreen = async (label) => {
    await page.waitForFunction(() => !window.__cityshift.babylon.camera.flying, null, { timeout: 15000 })
    const box = await page.evaluate(([lon, lat]) => {
      const d = window.__cityshift, ws = d.babylon, map = d.map()
      const s = d.store.getState(), spec = s.scenarios.find((x) => x.scenario_id === s.scenarioId).developments.at(-1).spec
      const [x, z] = ws.frame.lonLatToWorld(lon, lat), [w, depth] = spec.footprint_m
      const corners = [-1, 1].flatMap((dx) => [-1, 1].flatMap((dz) => [0, spec.height_m].map((y) => map.projectWorld(x + dx * w / 2, y, z + dz * depth / 2))))
      const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y)
      return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), zoom: map.getZoom(), mode: s.cameraMode }
    }, placement)
    assert.ok(box.minX > 0 && box.maxX < 1440 && box.minY > 0 && box.maxY < 960, `${label}: building outside viewport ${JSON.stringify(box)}`)
    assert.ok(box.width > 110 && box.height > 110, `${label}: building too small to see ${JSON.stringify(box)}`)
    assert.equal(box.mode, 'development', label)
    return box
  }
  console.log(JSON.stringify({ phase: 'after-confirm-framing', ...(await buildingOnScreen('after confirm')) }))
  assert.equal(await page.locator('.development-pin.selected').count(), 1)
  await page.getByText('Persistent scenario development', { exact: true }).waitFor()
  await page.screenshot({ path: `${out}after-confirm.png` })
  await page.reload({ waitUntil: 'load' })
  await ready()
  assert.equal(await page.evaluate(() => window.__cityshift.store.getState().scenarioId), childId)
  console.log(JSON.stringify({ phase: 'after-reload-framing', ...(await buildingOnScreen('after reload')) }))
  await page.getByRole('button', { name: 'City', exact: true }).click()
  await page.waitForFunction(() => !window.__cityshift.babylon.camera.flying && window.__cityshift.map().getZoom() < 15.5, null, { timeout: 15000 })
  await page.getByRole('button', { name: 'Development', exact: true }).click()
  console.log(JSON.stringify({ phase: 'development-camera-button', ...(await buildingOnScreen('camera button')) }))
  await page.getByRole('button', { name: `Inspect ${name}`, exact: true }).click()
  await page.getByText('Persistent scenario development', { exact: true }).waitFor()
  await page.screenshot({ path: `${out}saved.png` })
  console.log(JSON.stringify({ phase: 'persistence-verified', child: childId }))

  const measured = []
  for (const sid of [parent.scenario_id, childId]) {
    let run = await api('/api/runs', { scenario_id: sid, plan_id: 'baseline', seed: 1 })
    const deadline = Date.now() + 300000
    while (run.status === 'running' || run.status === 'queued') {
      assert.ok(Date.now() < deadline, 'SUMO run timed out')
      await delay(1000)
      run = await api(`/api/runs/${run.run_id}`)
    }
    assert.equal(run.status, 'completed', run.error)
    measured.push(run)
  }
  assert.equal(measured[0].metrics.cohort_size, 20)
  assert.equal(measured[1].metrics.cohort_size, 32)
  await page.evaluate(async (primary) => {
    const store = window.__cityshift.store.getState()
    store.setTool(null)
    await store.refreshRuns()
    await store.openRun(primary, 'primary')
    store.setLens(null)
    window.__cityshift.seek(20)
  }, measured[1].run_id)
  await page.locator('.scenario-name').click()
  await page.getByRole('button', { name: 'Compare parent', exact: true }).click()
  await page.locator('.scenario-drawer button[aria-label="Close"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.bworld-canvas').length === 2 && !document.querySelector('.bworld-veil'), null, { timeout: 120000 })
  await positionCamera([placement[0] - 0.00048, placement[1]])
  assert.equal(await page.locator('.world-left .development-pin').count(), 0)
  assert.equal(await page.locator('.world-right .development-pin:not(.draft)').count(), 1)
  await page.screenshot({ path: `${out}comparison-map.png` })
  await page.getByRole('button', { name: 'Lens', exact: true }).click()
  await page.getByRole('button', { name: 'Transport', exact: true }).click()
  await page.getByText('Existing, unchanged trips · 20 matched', { exact: true }).waitFor()
  await page.getByText('Additional / unmatched trips — view', { exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.locator('.lens .fleetcard').count(), 0)
  assert.equal(await page.locator('.dock .delta').count(), 0, 'Unequal populations must not display raw live-count improvement badges')
  await page.getByText('Shuttles and stop queues · 0 vehicles, 0 stops', { exact: true }).waitFor()
  const cohorts = await Promise.all(measured.map((run) => api(`/api/runs/${run.run_id}/cohort`)))
  const incumbentIds = new Set(parentDemand.travelers.map((trip) => trip.person_id))
  const expectedExisting = Object.keys(cohorts[1].arrived).filter((id) => incumbentIds.has(id)).length
  const expectedAdded = Object.keys(cohorts[1].arrived).filter((id) => !incumbentIds.has(id)).length
  const groups = await page.locator('.population-summary').allTextContents()
  assert.ok(groups.some((text) => text.includes('Existing trips — view') && text.includes(`completed ${expectedExisting}/20`)))
  assert.ok(groups.some((text) => text.includes('Additional / unmatched trips — view') && text.includes(`completed ${expectedAdded}/12`)))
  await page.screenshot({ path: `${out}comparison.png` })
  assert.deepEqual(errors, [], 'Browser JavaScript errors')
  console.log(JSON.stringify({ phase: 'complete', screenshots: out, runs: measured.map((r) => ({ id: r.run_id, scenario: r.scenario_id, metrics: r.metrics })) }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${out}failure.png` }).catch(() => {})
  console.error(JSON.stringify({ screenshots: out, browserErrors: errors }))
  throw error
} finally {
  await browser.close()
}
