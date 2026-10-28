import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { makeApi } from '@shared/api'
import { LocalFileLinks } from '../src/Markdown'
import { link } from './link'
import { MobileApp } from './MobileApp'
import { Pair } from './Pair'
import '../src/styles.css'
import './mobile.css'

// The phone client (SPEC → Remote and mobile): the same window.gloss the desktop's preload exposes,
// over the bridge's WebSocket.
window.gloss = makeApi(link)

// The service worker only shows pushes and opens their session; it caches nothing.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})

function Root(): React.JSX.Element {
  const [pairing, setPairing] = useState(() => location.pathname === '/pair')
  return pairing ? <Pair onDone={() => setPairing(false)} /> : <MobileApp link={link} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LucideProvider size={16} strokeWidth={1.75}>
      <LocalFileLinks.Provider value={false}>
        <Root />
      </LocalFileLinks.Provider>
    </LucideProvider>
  </StrictMode>
)
