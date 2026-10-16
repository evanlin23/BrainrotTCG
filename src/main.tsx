import { StrictMode } from 'react'
import { MotionConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App'
import AppErrorBoundary from './components/ui/AppErrorBoundary'
import { trackInputModality } from './components/ui/inputModality'
import { runMigrations } from './utils/migrations'
import { migratePullLog } from './game/history'
import { receiveSave } from './game/move'
import { resumeReopening } from './game/profiles'

// A window the site's old address opened to hand over a save does only that (see game/move.ts).
receiveSave().then((receiver) => {
  if (receiver) return
  runMigrations()
  migratePullLog()
  // Packs re-opened on this device (IndexedDB) aren't loaded here: the app reads the ones it needs
  // a page at a time once it runs (watchMyPacks in game/profiles.ts).

  // AppErrorBoundary covers render errors once React has mounted. A failure in the startup steps
  // above (save hand-over, migrations) happens before React and is not caught by it.
  // Script-moved focus rings for keyboard players only (base.css); this says which kind they are.
  trackInputModality()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        {/* Respect the OS "reduce motion" setting for every framer-motion animation. */}
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
      </AppErrorBoundary>
    </StrictMode>,
  )
  resumeReopening()
})
