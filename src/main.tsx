import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App'
import AppErrorBoundary, { CrashFallback } from './components/ui/AppErrorBoundary'
import MotionProvider from './components/ui/MotionProvider'
import MigrationRecovery from './components/ui/MigrationRecovery'
import { trackInputModality } from './components/ui/inputModality'
import { runMigrations } from './utils/migrations'
import { migratePullLog } from './game/history'
import { receiveSave } from './game/move'
import { resumeReopening } from './game/reopenJob'
import { warmUpFirstPack } from './game/warmUp'
import { markStaging } from './game/staging'
import { STORAGE_KEYS } from './constants'
import { prefersReducedMotion, setMotionSetting } from './utils/motion'
import { readSettings } from './utils/settings'
import { getStoredData } from './utils/storage'

markStaging()

// If receiveSave fails (it throws, or its promise rejects), the game starts here as usual rather than
// stopping at that step. Migrations and the pull-log move have their own screens below.
const handedOver = Promise.resolve()
  .then(receiveSave)
  .catch((error: unknown) => {
    console.error('Bringing the save over failed; starting the game here.', error)
    return false
  })

/** Show a screen in place of the game when a startup step stops it from starting. */
const renderInstead = (screen: ReactNode) => {
  trackInputModality()
  createRoot(document.getElementById('root')!).render(<StrictMode>{screen}</StrictMode>)
}

// A window the site's old address opened to hand over a save does only that (see game/move.ts).
handedOver.then((receiver) => {
  if (receiver) return
  try {
    // False: there is saved data and its upgrade couldn't be written (usually full storage), so a
    // reload would fail the same way. Offer the save as a file instead of starting the game on it.
    if (!runMigrations()) {
      console.error('App startup stopped: saved data could not be upgraded')
      renderInstead(<MigrationRecovery />)
      return
    }
    migratePullLog()
  } catch (error) {
    console.error('App startup failed before mount', error)
    renderInstead(<CrashFallback event="unhandled-error" />)
    return
  }

  // Packs re-opened on this device (IndexedDB) aren't loaded here: the app reads the ones it needs
  // a page at a time once it runs (watchMyPacks in game/packCache.ts).

  // AppErrorBoundary covers render errors once React has mounted; the startup steps above have
  // their own handling (the hand-over is skipped, migrations show the screens above).
  // Script-moved focus rings for keyboard players only (base.css); this says which kind they are.
  trackInputModality()
  // The saved Motion setting applies from the first paint (App keeps it current afterwards).
  setMotionSetting(readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)).motion ?? 'auto')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <MotionProvider>
          <App />
        </MotionProvider>
      </AppErrorBoundary>
    </StrictMode>,
  )
  resumeReopening()
  // The confetti library and Argon2 come with the card back, so a player who goes offline before the
  // first pack still has them (Argon2 is what the main-thread fallback mines with when the worker
  // can't). A failed load is ignored: the reveal tries confetti again at the first flip.
  warmUpFirstPack(() => {
    import('./engine/argon2').catch(() => {})
    if (readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)).particlesEnabled && !prefersReducedMotion()) import('./components/pack/confettiEffects').catch(() => {})
  })
})
