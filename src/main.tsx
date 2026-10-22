import { StrictMode } from 'react'
import { MotionConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App'
import AppErrorBoundary, { CrashFallback } from './components/ui/AppErrorBoundary'
import { trackInputModality } from './components/ui/inputModality'
import { runMigrations } from './utils/migrations'
import { migratePullLog } from './game/history'
import { receiveSave } from './game/move'
import { resumeReopening } from './game/profiles'
import { warmUpFirstPack } from './game/warmUp'

// If receiveSave fails (it throws, or its promise rejects), the game starts here as usual rather than
// stopping at that step. This guards only that step: migrations and the first render are not covered.
const handedOver = Promise.resolve()
  .then(receiveSave)
  .catch((error: unknown) => {
    console.error('Bringing the save over failed; starting the game here.', error)
    return false
  })

// A window the site's old address opened to hand over a save does only that (see game/move.ts).
handedOver.then((receiver) => {
  if (receiver) return
  try {
    const ok = runMigrations()
    if (ok === false) {
      throw new Error('Startup migrations could not complete')
    }
    migratePullLog()
  } catch (error) {
    console.error('App startup failed before mount', error)
    trackInputModality()
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <CrashFallback event="unhandled-error" />
      </StrictMode>,
    )
    return
  }

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
  warmUpFirstPack()
})
