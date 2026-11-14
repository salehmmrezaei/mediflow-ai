import './auth'
import 'aws-amplify/auth/enable-oauth-listener'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { configurationError, restoreDoctorSession } from './auth'
import './index.css'
import App from './App.tsx'

if (!configurationError) void restoreDoctorSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
