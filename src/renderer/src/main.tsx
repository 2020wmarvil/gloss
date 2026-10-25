import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { App } from './App'
import { CloseDialog } from './CloseDialog'
import { SessionWindow } from './SessionWindow'
import './styles.css'

// A session window loads this page with its session in the URL (SPEC → Session windows).
const popped = new URLSearchParams(location.search).get('session')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One icon size and stroke everywhere (docs/mocks/design-system.html → Icons). */}
    <LucideProvider size={16} strokeWidth={1.75}>
      <CloseDialog />
      {popped ? <SessionWindow sessionId={popped} /> : <App />}
    </LucideProvider>
  </StrictMode>
)
