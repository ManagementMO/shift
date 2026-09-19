import { lazy, Suspense } from 'react'

import App from './App.tsx'

// `/` and `/world` use the full Babylon interface. `/mapbox` is the Mapbox alternative.
// `/world/lab` is the bare Babylon viewer for renderer experiments.
const WorldApp = lazy(() => import('./babylon/WorldApp.tsx'))

export default function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '/mapbox') return <App renderer="mapbox" />
  if (path === '/world/lab')
    return (
      <Suspense fallback={null}>
        <WorldApp />
      </Suspense>
    )
  return <App />
}
