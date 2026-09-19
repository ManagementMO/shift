import { lazy, Suspense } from 'react'

import App from './App.tsx'

// `/world` runs the full shell on the Babylon.js miniature Toronto (progressive migration); `/` stays on
// Mapbox/deck.gl.  `/world/lab` is the bare Babylon viewer used for renderer work and screenshots.
const WorldApp = lazy(() => import('./babylon/WorldApp.tsx'))

export default function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '/world') return <App renderer="babylon" />
  if (path === '/world/lab')
    return (
      <Suspense fallback={null}>
        <WorldApp />
      </Suspense>
    )
  return <App />
}
