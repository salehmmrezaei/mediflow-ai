import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { loadApplication } from './loadApplication'
import './index.css'
import './App.css'

const root = createRoot(document.getElementById('root')!)

void loadApplication(window.location.pathname).then((Application) => {
  root.render(<StrictMode><Application /></StrictMode>)
}).catch(() => {
  // Loading a public demo must never fall back to the authenticated application.
  root.render(
    <main className="app-shell">
      <section className="auth-pending" role="alert">
        <p>The workspace could not load. Please reload to try again.</p>
        <a href="/">Return to Home</a>
      </section>
    </main>,
  )
})
