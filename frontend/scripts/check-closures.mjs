// Browser check for untimed street closures: the Closure tool has no time window, a closure on the city is
// clickable, and Remove closure previews a reopen branch. Blocks every API write except the read-only preview.
// usage: node scripts/check-closures.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'

const base = process.argv[2] ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.stack || error.message || String(error)))
  const writes = []
  await page.route('**/api/**', (route) => {
    const request = route.request()
    if (request.method() === 'GET' || /\/edit\/preview$/.test(new URL(request.url()).pathname)) return route.continue()
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    return route.abort()
  })
  await page.goto(`${base}/world`)
  await page.waitForFunction(() => window.__cityshift?.babylon && window.__cityshift.store.getState().scenarioId && window.__cityshift.store.getState().roads, null, { timeout: 120000 })
  // A replay that finishes loading resets the selection; let it settle before clicking around.
  await page.waitForFunction(() => {
    const s = window.__cityshift.store.getState()
    return s.loadingReplay === null && (s.primaryRunId !== null || !s.runs.some((r) => r.status === 'completed'))
  }, null, { timeout: 120000 })
  await page.evaluate(() => window.__cityshift.pause())

  // --- Closure tool: no time sliders, no reopen mode; closed corridors hand off to the card.
  await page.getByRole('button', { name: 'Closure', exact: true }).click()
  const panel = page.locator('.toolpanel')
  await expect(panel.getByText('Close a street')).toBeVisible()
  await expect(panel.locator('input[type="range"]')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Choose a street', exact: true })).toBeDisabled()
  const closedItem = panel.locator('.listitem').filter({ hasText: 'closed — click to manage' }).first()
  await expect(closedItem).toBeVisible()
  await closedItem.click()
  await expect(page.getByRole('dialog', { name: 'Street closure' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Street closure' })).toContainText('closed until you remove it')
  await page.getByRole('dialog', { name: 'Street closure' }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Street closure' })).toHaveCount(0)
  const openItem = panel.locator('.listitem').filter({ hasNotText: 'closed' }).first()
  await openItem.click()
  await expect(panel.getByRole('button', { name: 'Preview closure', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Preview closure', exact: true }).click()
  await expect(panel.locator('.proposal')).toContainText('closed for the whole scenario')
  await expect(panel.locator('.proposal')).not.toContainText('window +')
  await panel.getByRole('button', { name: 'Discard', exact: true }).click()
  await panel.getByRole('button', { name: 'Close', exact: true }).click()

  // --- Click the closure on the city itself.
  const target = await page.evaluate(() => {
    const s = window.__cityshift.store.getState()
    const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
    const r = scenario.restrictions.find((x) => !x.restriction_id.startsWith('hazard'))
    const ws = window.__cityshift.babylon
    const road = r.edge_ids.map((id) => ws.roads.byId.get(id)).filter(Boolean).sort((a, b) => b.shape.length - a.shape.length)[0]
    const i = Math.floor(road.shape.length / 4) * 2
    const x = (road.shape[i] + road.shape[i + 2]) / 2, z = (road.shape[i + 1] + road.shape[i + 3]) / 2
    ws.camera.flyTo({ target: [x, z], radius: 260, heading: 20, elevation: 62 }, 0)
    return { id: r.restriction_id, segments: r.edge_ids.length, x, z }
  })
  await page.waitForTimeout(300)
  const point = await page.evaluate(({ x, z }) => window.__cityshift.map().projectWorld(x, 0.2, z), target)
  assert.ok(point.x > 0 && point.y > 0 && point.x < 1440 && point.y < 900, `closure off screen at ${JSON.stringify(point)}`)
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => window.__cityshift.store.getState().selection)).toMatchObject({ kind: 'restriction', id: target.id })
  const clicked = await page.evaluate(() => window.__cityshift.store.getState().selection.at)
  assert.ok(Array.isArray(clicked) && clicked.length === 2, 'the card anchors at the clicked point on the closure')
  const card = page.getByRole('dialog', { name: 'Street closure' })
  await expect(card).toBeVisible()
  await expect(card).toContainText(`${target.segments} segments`)
  await expect(card).toContainText('closed until you remove it')
  await expect(card).not.toContainText('+00:00')

  // --- Remove closure previews a reopen branch through the normal confirm step.
  await card.getByRole('button', { name: 'Remove closure', exact: true }).click()
  await expect(card.locator('.proposal')).toContainText(`Remove closure · ${target.segments} road segments`)
  await expect(card.locator('.proposal')).toContainText('remove closure')
  await expect(card.getByRole('button', { name: 'Run branch', exact: true })).toBeEnabled()
  const proposal = await page.evaluate(() => window.__cityshift.store.getState().ghost?.proposal)
  assert.equal(proposal.kind, 'reopen_edge')
  assert.equal(proposal.edge_ids.length, target.segments)
  assert.deepEqual([proposal.start_s, proposal.end_s], [null, null])
  await card.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Remove closure', exact: true })).toBeVisible()

  // --- Clicking empty ground clears nothing else and does not throw.
  await card.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(card).toHaveCount(0)

  // --- Scenario drawer and timeline show no closure window.
  await page.locator('.scenario-name').click()
  const drawer = page.locator('.scenario-drawer')
  await expect(drawer.locator('.linkish').first()).toContainText('segments')
  await expect(drawer.locator('.linkish').first()).not.toContainText('+00:00')
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(await page.locator('.band.closure').count(), 0, 'untimed closures should not draw a timeline band')

  assert.deepEqual(writes, [], `no scenario or run may be created: ${writes.join(', ')}`)
  assert.deepEqual(errors, [])
  console.log(`Closures: tool has no time window; clicked ${target.id} on the city; Remove closure previewed a ${target.segments}-segment reopen branch; no writes`)
  await page.close()
} finally {
  await browser.close()
}
