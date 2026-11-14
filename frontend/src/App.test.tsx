import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signInWithRedirect, signOut } from 'aws-amplify/auth'
import { getDoctorSession, subscribeToDoctorSession } from './auth'
import App from './App'

vi.mock('./auth', () => ({
  configurationError: null,
  getDoctorSession: vi.fn(),
  subscribeToDoctorSession: vi.fn(),
  restoreDoctorSession: vi.fn(),
}))
vi.mock('aws-amplify/auth', () => ({ signInWithRedirect: vi.fn(), signOut: vi.fn() }))
vi.mock('./components/PatientDashboard', () => ({
  PatientDashboard: ({ username, onSignOut }: { username: string; onSignOut: () => void }) => (
    <section aria-label="Patient dashboard"><p>{username}</p><button onClick={onSignOut}>Sign out</button></section>
  ),
}))

let notify: (() => void) | undefined
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  notify = undefined
  vi.mocked(getDoctorSession).mockReturnValue({ status: 'signedOut' })
  vi.mocked(subscribeToDoctorSession).mockImplementation((subscriber) => {
    notify = subscriber
    return () => { notify = undefined }
  })
  vi.mocked(signInWithRedirect).mockReset().mockResolvedValue()
  vi.mocked(signOut).mockReset().mockResolvedValue()
})

describe('existing Cognito application flow', () => {
  it('retains the hosted sign-in action and hides protected content when signed out', async () => {
    render(<App />)
    expect(screen.queryByRole('region', { name: 'Patient dashboard' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Explore Interactive Demo' }).getAttribute('href')).toBe('/demo')
    fireEvent.click(screen.getByRole('button', { name: 'Doctor Sign In' }))
    await act(async () => {})
    expect(signInWithRedirect).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: 'Doctor Sign In' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('unmounts protected content immediately on sign-out and keeps it hidden after completion', async () => {
    vi.mocked(getDoctorSession).mockReturnValue({
      status: 'signedIn', user: { username: 'doctor-test', userId: 'doctor-sub' },
    })
    let finishSignOut!: () => void
    vi.mocked(signOut).mockReturnValue(new Promise<void>((resolve) => { finishSignOut = resolve }))
    render(<App />)
    expect(screen.getByText('doctor-test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.queryByText('doctor-test')).toBeNull()
    await act(async () => {
      vi.mocked(getDoctorSession).mockReturnValue({ status: 'signedOut' })
      notify?.()
      finishSignOut()
    })
    expect(screen.queryByRole('region', { name: 'Patient dashboard' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Doctor Sign In' })).toBeTruthy()
  })

  it('starts the existing hosted login once after leaving demo mode', async () => {
    window.history.replaceState(null, '', '/?signin=1')
    render(<StrictMode><App /></StrictMode>)
    await act(async () => {})
    expect(signInWithRedirect).toHaveBeenCalledOnce()
    expect(window.location.search).toBe('')
  })

  it('waits for session restoration before starting a requested doctor login', async () => {
    window.history.replaceState(null, '', '/?signin=1')
    vi.mocked(getDoctorSession).mockReturnValue({ status: 'checking' })
    render(<App />)
    expect(signInWithRedirect).not.toHaveBeenCalled()
    await act(async () => {
      vi.mocked(getDoctorSession).mockReturnValue({ status: 'signedOut' })
      notify?.()
    })
    expect(signInWithRedirect).toHaveBeenCalledOnce()
  })

  it('keeps an existing signed-in session when returning from the demo', async () => {
    window.history.replaceState(null, '', '/?signin=1')
    vi.mocked(getDoctorSession).mockReturnValue({
      status: 'signedIn', user: { username: 'doctor-test', userId: 'doctor-sub' },
    })
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('doctor-test')).toBeTruthy()
    expect(signInWithRedirect).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })
})
