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
// Mirrors the UI's townhouse preset (frontend/src/development.ts BUILDING_KINDS.townhouse): 12 homes × 2.5 × 60% = 18 trips.
const KIND = { tile: 'Townhouses', name: 'Townhouses', confirm: 'Confirm townhouses', trips: 18 }
const totalShare = pack.zones.reduce((sum, z) => sum + z.share, 0)
const probe = {
  name: KIND.name, land_use: 'residential', position: pack.venue_lonlat, footprint_m: [48, 14], height_m: 10,
  capacity: 12, people_per_unit: 2.5, trip_rate: 0.6, car_share: 0.6, walk_limit_m: 1500,
  zone_shares: Object.fromEntries(pack.zones.map((z) => [z.zone_id, z.share / totalShare])),
  first_wave: { start_s: 0, end_s: 900, profile: 'uniform' }, return_wave: null, seed: 7,
}
let placement = null
const candidates = [...pack.stops.filter((s) => s.stop_id.startsWith('SB_')), ...pack.stops].slice(0, 24)
for (const stop of candidates) {
  const position = [stop.lon, stop.lat + 0.00025]
  const response = await fetch(`${base}/api/scenarios/${parent.scenario_id}/developments/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...probe, position }),
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
const state = () => page.evaluate(() => {
  const s = window.__cityshift.store.getState()
  return { placed: s.developmentPlaced, hover: s.developmentHover, draft: s.developmentDraft, preview: s.developmentPreview, error: s.developmentError, tool: s.tool, scenarioId: s.scenarioId, cameraMode: s.cameraMode }
})
const ready = async () => {
  await page.waitForFunction(() => !!window.__cityshift?.babylon && !document.querySelector('.bworld-veil'), null, { timeout: 120000 })
  await page.waitForTimeout(1000)
}
/** `/` is the globe landing page (the built app has no SPA fallback for `/world`); fly into Toronto from there. */
const enterCity = async () => {
  await page.goto(base, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Fly to Toronto', exact: true }).click()
  await ready()
}
const positionCamera = async (position) => {
  await page.evaluate((center) => window.__cityshift.map().jumpTo({ center, zoom: 17.4, pitch: 50, bearing: 0 }), position)
  await page.waitForTimeout(700)
}
const screenPoint = async (position) => {
  const point = await page.evaluate((p) => window.__cityshift.map().project(p), position)
  const canvas = await page.locator('.world-solo canvas').boundingBox()
  return { x: canvas.x + point.x, y: canvas.y + point.y }
}
const ghostMeshId = () => page.evaluate(() => window.__cityshift.babylon.scene.getMeshByName('development-draft')?.uniqueId ?? null)

/** Open the tool, pick a kind, aim with the cursor (ghost follows), then click to place — access is checked automatically. */
const openAimAndPlace = async () => {
  await page.locator('.railbtn[title="Development"]').click()
  await page.locator('.development-status.aim').waitFor()
  await page.getByRole('radio', { name: KIND.tile, exact: true }).click()
  assert.equal((await state()).draft.capacity, 12)
  await positionCamera(placement)
  const target = await screenPoint(placement)
  const elsewhere = await screenPoint([placement[0] - 0.0006, placement[1]])
  await page.mouse.move(elsewhere.x, elsewhere.y)
  await page.waitForFunction(() => !!window.__cityshift.store.getState().developmentHover)
  const firstHover = (await state()).hover
  const ghostBefore = await ghostMeshId()
  assert.ok(ghostBefore !== null, 'the ghost outline should exist while aiming')
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await page.waitForFunction((h) => { const s = window.__cityshift.store.getState(); return s.developmentHover && s.developmentHover[0] !== h[0] }, firstHover)
  assert.equal(await ghostMeshId(), ghostBefore, 'hovering must move the ghost, not rebuild it')
  assert.equal((await state()).placed, false)
  assert.equal(await page.locator('.development-pin.draft').count(), 0, 'no pin until placed')
  await page.mouse.click(target.x, target.y)
  await page.waitForFunction(() => window.__cityshift.store.getState().developmentPlaced)
  assert.equal(await page.locator('.development-pin.draft').count(), 1)
  await page.waitForFunction(() => !!window.__cityshift.store.getState().developmentPreview, null, { timeout: 120000 })
  await page.locator('.development-status.ready').waitFor()
  const { preview } = await state()
  assert.equal(preview.added_trips, KIND.trips)
  assert.equal(preview.incumbent_trips, 20)
  assert.equal(preview.outbound_trips, KIND.trips)
  return preview
}

try {
  await enterCity()
  await page.evaluate(async (sid) => { await window.__cityshift.store.getState().selectScenario(sid) }, parent.scenario_id)
  assert.equal(await page.getByText('Create base scenario').count(), 0)
  await openAimAndPlace()
  // Switching kind keeps the placement and re-checks access — the park is inbound, so 300 arrivals.
  await page.getByRole('radio', { name: 'Park', exact: true }).click()
  await page.waitForFunction(() => { const s = window.__cityshift.store.getState(); return s.developmentPreview?.development.spec.land_use === 'park' }, null, { timeout: 120000 })
  const parkPreview = (await state()).preview
  assert.equal(parkPreview.inbound_trips, 300)
  assert.equal(parkPreview.outbound_trips, 0)
  assert.equal((await state()).placed, true)
  await page.screenshot({ path: `${out}park-preview.png` })
  await page.getByRole('radio', { name: KIND.tile, exact: true }).click()
  await page.waitForFunction((n) => window.__cityshift.store.getState().developmentPreview?.added_trips === n, KIND.trips, { timeout: 120000 })
  assert.equal((await api('/api/scenarios')).length, beforeCount)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.locator('.development-pin.draft').count(), 0)
  assert.equal(await ghostMeshId(), null)
  assert.equal((await api('/api/scenarios')).length, beforeCount)
  console.log(JSON.stringify({ phase: 'cancel-verified' }))

  const proposal = await openAimAndPlace()
  await page.screenshot({ path: `${out}preview.png` })
  await page.getByRole('button', { name: KIND.confirm, exact: true }).click()
  await page.waitForFunction((sid) => window.__cityshift.store.getState().scenarioId !== sid && !window.__cityshift.store.getState().building, parent.scenario_id, { timeout: 180000 })
  const childId = (await state()).scenarioId
  const child = await api(`/api/scenarios/${childId}`)
  assert.equal(child.parent_scenario_id, parent.scenario_id)
  assert.deepEqual(child.developments[0].spec, proposal.development.spec)
  const childDemand = await api(`/api/scenarios/${childId}/demand`)
  assert.equal(childDemand.travelers.length, parentDemand.travelers.length + KIND.trips)
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
    assert.ok(box.width > 110 && box.height > 40, `${label}: building too small to see ${JSON.stringify(box)}`)
    assert.equal(box.mode, 'development', label)
    return box
  }
  console.log(JSON.stringify({ phase: 'after-confirm-framing', ...(await buildingOnScreen('after confirm')) }))
  await page.getByText('Saved in this scenario', { exact: true }).waitFor()
  // Once confirmed, the building blends in: no pin, no camera shortcut, and the city's own facade material.
  assert.equal(await page.locator('.development-pin').count(), 0, 'confirmed developments carry no marker')
  assert.equal(await page.getByRole('navigation', { name: 'Camera', exact: true }).getByRole('button', { name: 'Development', exact: true }).count(), 0)
  const blended = await page.evaluate((did) => {
    const scene = window.__cityshift.babylon.scene
    const walls = scene.getMeshByName(`development-${did}`)
    const neighbour = window.__cityshift.babylon.city.chunks.find((m) => m.name.startsWith('buildings-') && m.material?.name === walls?.material?.name)
    return { material: walls?.material?.name ?? null, sharedWithCity: !!neighbour, halo: !!scene.getMeshByName('development-halos'), arrows: !!scene.getMeshByName('development-intentions') }
  }, child.developments[0].development_id)
  assert.match(blended.material, /^city-/, JSON.stringify(blended))
  assert.equal(blended.sharedWithCity, true, 'the confirmed building must use a material some city block also uses')
  assert.equal(blended.halo || blended.arrows, false)
  await page.screenshot({ path: `${out}after-confirm.png` })
  await enterCity() // cold reload through the landing page
  assert.equal((await state()).scenarioId, childId)
  console.log(JSON.stringify({ phase: 'after-reload-framing', ...(await buildingOnScreen('after reload')) }))
  await page.getByText('Saved in this scenario', { exact: true }).waitFor()
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
  assert.equal(measured[1].metrics.cohort_size, 20 + KIND.trips)
  // The branch auto-runs on selection (upstream behaviour); the explicit submit above is idempotent and returns the same run.
  await page.evaluate(async (primary) => {
    const store = window.__cityshift.store.getState()
    store.setTool(null)
    await store.refreshRuns()
    await store.openRun(primary)
    store.setLens(null)
    window.__cityshift.seek(20)
  }, measured[1].run_id)
  assert.equal(await page.evaluate(() => window.__cityshift.store.getState().primaryRunId), measured[1].run_id)
  assert.equal(await page.locator('.development-pin').count(), 0)
  // Before/after lives in the Transport lens now: the parent run is fetched on demand and matched trip-by-trip.
  await page.getByRole('button', { name: 'Inspect', exact: true }).click() // upstream renamed the lens toggle
  await page.getByRole('button', { name: 'Transport', exact: true }).click()
  await page.getByText('Before this change · parent scenario', { exact: true }).waitFor()
  await page.getByText('Existing, unchanged trips · 20 matched', { exact: true }).waitFor({ timeout: 60000 })
  await page.getByText('Added trips — this branch only', { exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.locator('.lens .fleetcard').count(), 0)
  await page.getByText('Shuttles and stop queues · 0 vehicles, 0 stops', { exact: true }).waitFor()
  const cohorts = await Promise.all(measured.map((run) => api(`/api/runs/${run.run_id}/cohort`)))
  const incumbentIds = new Set(parentDemand.travelers.map((trip) => trip.person_id))
  const expectedExisting = Object.keys(cohorts[1].arrived).filter((id) => incumbentIds.has(id)).length
  const expectedAdded = Object.keys(cohorts[1].arrived).filter((id) => !incumbentIds.has(id)).length
  const groups = await page.locator('.population-summary').allTextContents()
  assert.ok(groups.some((text) => text.includes('Existing trips — this branch') && text.includes(`completed ${expectedExisting}/20`)), JSON.stringify(groups))
  assert.ok(groups.some((text) => text.includes('Added trips — this branch only') && text.includes(`completed ${expectedAdded}/${KIND.trips}`)), JSON.stringify(groups))
  await page.screenshot({ path: `${out}comparison.png` })
  console.log(JSON.stringify({ phase: 'comparison-verified' }))

  // --- delete the development by clicking it on the map: the scenario is edited in place and re-run ---
  await page.getByRole('button', { name: 'Inspect', exact: true }).click() // close the lens
  await positionCamera(placement)
  const developmentId = child.developments[0].development_id
  const top = await screenPoint(placement)
  await page.mouse.click(top.x, top.y - 8)
  await page.waitForFunction((did) => { const s = window.__cityshift.store.getState().selection; return s?.kind === 'development' && s.id === did }, developmentId)
  const card = page.locator('.building-card')
  await card.waitFor()
  assert.match(await card.innerText(), new RegExp(KIND.name))
  assert.equal(await page.evaluate(() => !!window.__cityshift.babylon.scene.getMeshByName('development-footprints')), true, 'selection outlines the building')
  await page.screenshot({ path: `${out}delete-card.png` })
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await card.getByRole('button', { name: 'Yes, delete', exact: true }).click()
  await page.waitForFunction((sid) => { const s = window.__cityshift.store.getState(); return s.scenarioId === sid && !s.deleting && (s.scenarios.find((x) => x.scenario_id === sid)?.developments?.length ?? 0) === 0 }, childId, { timeout: 60000 })
  const afterDelete = await api(`/api/scenarios/${childId}`)
  assert.equal(afterDelete.developments.length, 0)
  assert.equal(afterDelete.parent_scenario_id, parent.scenario_id)
  assert.match(afterDelete.change_set.at(-1), /^remove residential Townhouses: 18 one-way trips/)
  assert.deepEqual((await api(`/api/scenarios/${childId}/demand`)).travelers, parentDemand.travelers) // exactly the parent trips again
  const currentRuns = await api(`/api/runs?scenario_id=${encodeURIComponent(childId)}`)
  assert.ok(currentRuns.every((r) => r.run_id !== measured[1].run_id), 'the pre-delete run is no longer current')
  assert.ok(currentRuns.length >= 1, 'the edited scenario auto-runs again')
  assert.equal((await api(`/api/runs/${measured[1].run_id}`)).run_id, measured[1].run_id) // ...but stays fetchable
  assert.equal(await page.evaluate((did) => !!window.__cityshift.babylon.scene.getMeshByName(`development-${did}`), developmentId), false)
  assert.equal(await page.locator('.building-card').count(), 0)
  console.log(JSON.stringify({ phase: 'development-deleted', currentRuns: currentRuns.map((r) => r.status) }))

  // --- demolish an original city building: visual only, persisted, and the run stays current ---
  const runsBeforeDemolish = await api(`/api/runs?scenario_id=${encodeURIComponent(childId)}`)
  const target = await page.evaluate(([lon, lat]) => {
    const ws = window.__cityshift.babylon
    const [x, z] = ws.frame.lonLatToWorld(lon, lat)
    const near = ws.world.buildings.filter((b) => b.cat !== 'landmark' && !(ws.world.massing?.excluded_osm_ids ?? []).includes(b.source_id ?? b.id))
      .map((b) => ({ b, d: Math.hypot(b.ring[0] - x, b.ring[1] - z) })).sort((p, q) => p.d - q.d)
    const info = near.map((p) => ws.city.describeBuilding(p.b.source_id ?? p.b.id)).find((i) => i && i.height_m > 6)
    return info ? { ...info, position: ws.frame.worldToLonLat(info.x, info.z) } : null
  }, placement)
  assert.ok(target, 'a nearby city building to demolish')
  await page.evaluate((info) => window.__cityshift.store.getState().select({ kind: 'building', id: info.id, label: info.name || 'City building', category: info.category, height_m: info.height_m, position: info.position }), target)
  await card.waitFor()
  assert.match(await card.innerText(), new RegExp(target.id))
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await card.getByRole('button', { name: 'Yes, delete', exact: true }).click()
  await page.waitForFunction((id) => window.__cityshift.babylon.city.isHidden(id), target.id, { timeout: 60000 })
  assert.deepEqual((await api(`/api/scenarios/${childId}`)).demolished, [target.id])
  assert.deepEqual((await api(`/api/runs?scenario_id=${encodeURIComponent(childId)}`)).map((r) => r.run_id), runsBeforeDemolish.map((r) => r.run_id), 'demolition changes nothing SUMO simulates')
  await page.screenshot({ path: `${out}demolished.png` })
  await enterCity()
  assert.equal((await state()).scenarioId, childId)
  assert.equal(await page.evaluate((id) => window.__cityshift.babylon.city.isHidden(id), target.id), true, 'demolition survives a reload')
  assert.equal(await page.locator('.development-pin').count(), 0)
  console.log(JSON.stringify({ phase: 'demolition-verified', building: target.id }))
  assert.deepEqual(errors, [], 'Browser JavaScript errors')
  console.log(JSON.stringify({ phase: 'complete', screenshots: out, runs: measured.map((r) => ({ id: r.run_id, scenario: r.scenario_id, metrics: r.metrics })) }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${out}failure.png` }).catch(() => {})
  console.error(JSON.stringify({ screenshots: out, browserErrors: errors }))
  throw error
} finally {
  await browser.close()
}
