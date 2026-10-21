import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One icon size and stroke everywhere (docs/mocks/design-system.html → Icons). */}
    <LucideProvider size={16} strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </StrictMode>
)
