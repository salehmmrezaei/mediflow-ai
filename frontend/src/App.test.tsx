import { act, fireEvent, render, screen } from '@testing-library/react'
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
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await act(async () => {})
    expect(signInWithRedirect).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false)
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
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
