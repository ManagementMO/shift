import { lazy, Suspense } from 'react'

import Experience from './globe/Experience'

// `/` opens the globe; `/world` (and the old `/live`) open the live SUMO city directly.
// `/world/lab` is the bare Babylon viewer for renderer experiments.
const WorldApp = lazy(() => import('./babylon/WorldApp.tsx'))
const CityShowcase = lazy(() => import('./babylon/CityShowcase.tsx'))
const TornadoDemo = lazy(() => import('./babylon/TornadoDemo.tsx'))

export default function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '/tornado') return <Suspense fallback={<div className="bworld-veil">Loading tornado sandbox…</div>}><TornadoDemo /></Suspense>
  if (path === '/showcase') return <Suspense fallback={null}><CityShowcase /></Suspense>
  if (path === '/world/lab')
    return (
      <Suspense fallback={null}>
        <WorldApp />
      </Suspense>
    )
  return <Experience initialCity={path === '/world' || path === '/live'} />
}
