import { useState, useSyncExternalStore } from 'react'
import { signInWithRedirect, signOut } from 'aws-amplify/auth'
import { configurationError, getDoctorSession, restoreDoctorSession, subscribeToDoctorSession } from './auth'
import { PatientDashboard } from './components/PatientDashboard'
import './App.css'

function App() {
  const session = useSyncExternalStore(subscribeToDoctorSession, getDoctorSession)
  const [action, setAction] = useState<'signIn' | 'signOut' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleSignIn() {
    setActionError(null)
    setAction('signIn')
    try {
      await signInWithRedirect()
    } catch (error) {
      if (error instanceof Error && error.name === 'UserAlreadyAuthenticatedException') {
        await restoreDoctorSession()
      } else {
        setActionError('Sign in could not start. Please try again.')
      }
    } finally {
      setAction(null)
    }
  }

  async function handleSignOut() {
    setActionError(null)
    // Unmount the dashboard immediately, including any in-flight patient request.
    setAction('signOut')
    try {
      await signOut()
    } catch {
      setActionError('Sign out could not complete. Please try again.')
    } finally {
      setAction(null)
    }
  }

  const isPending = !configurationError && (
    session.status === 'checking' || action === 'signOut'
  )
  const error = actionError || (session.status === 'signedOut' ? session.error : null)

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="MediFlow AI home">
          <span className="brand-mark" aria-hidden="true">+</span>
          <span>
            <span className="brand-name">MediFlow <span>AI</span></span>
            <span className="brand-caption">Doctor workspace</span>
          </span>
        </a>
        <span className="environment-badge">Demo · Synthetic data only</span>
      </header>

      {isPending ? (
        <section className="auth-pending" role="status">
          <span className="loading-indicator" aria-hidden="true" />
          <p>{action === 'signOut' ? 'Signing out…' : 'Checking your session…'}</p>
        </section>
      ) : !configurationError && session.status === 'signedIn' ? (
        <>
          {actionError && <p className="error-message" role="alert">{actionError}</p>}
          <PatientDashboard
            key={session.user.userId}
            username={session.user.username}
            onSignOut={() => { void handleSignOut() }}
          />
        </>
      ) : (
        <section className="login-layout">
          <div className="login-card">
            <p className="eyebrow">YOUR DOCTOR WORKSPACE</p>
            <h1>Welcome to<br />MediFlow AI.</h1>
            <p className="login-description">
              Sign in to view the patients assigned to you, all in one place.
            </p>
            {configurationError ? (
              <p className="error-message" role="alert">{configurationError}</p>
            ) : (
              <>
                {error && <p className="error-message" role="alert">{error}</p>}
                <button
                  className="primary-button"
                  type="button"
                  disabled={action === 'signIn'}
                  onClick={() => { void handleSignIn() }}
                >
                  {action === 'signIn' ? 'Opening sign in…' : 'Sign in'}
                  <span aria-hidden="true">↗</span>
                </button>
                <p className="login-note">Use your existing doctor account.</p>
              </>
            )}
          </div>
        </section>
      )}

      <footer className="footer-note">MediFlow AI · Demonstration environment</footer>
    </main>
  )
}

export default App
