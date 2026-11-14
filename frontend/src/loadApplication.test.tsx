import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApplication } from './loadApplication'

const boundary = vi.hoisted(() => ({
  evaluated: vi.fn(),
  restore: vi.fn(),
  forbiddenCall: vi.fn(() => { throw new Error('Public demo crossed the doctor boundary') }),
  configurationError: null as string | null,
}))

vi.mock('./auth', () => {
  boundary.evaluated('doctor authentication')
  return {
    get configurationError() { return boundary.configurationError },
    restoreDoctorSession: boundary.restore,
    getDoctorSession: boundary.forbiddenCall,
    subscribeToDoctorSession: boundary.forbiddenCall,
  }
})
vi.mock('aws-amplify/auth/enable-oauth-listener', () => {
  boundary.evaluated('OAuth listener')
  return {}
})
vi.mock('aws-amplify', () => {
  boundary.evaluated('Amplify configuration')
  return { Amplify: { configure: boundary.forbiddenCall } }
})
vi.mock('aws-amplify/auth', () => {
  boundary.evaluated('Amplify authentication')
  return {
    fetchAuthSession: boundary.forbiddenCall,
    getCurrentUser: boundary.forbiddenCall,
    signInWithRedirect: boundary.forbiddenCall,
    signOut: boundary.forbiddenCall,
  }
})
vi.mock('aws-amplify/utils', () => {
  boundary.evaluated('Amplify events')
  return { Hub: { listen: boundary.forbiddenCall } }
})
vi.mock('./api/patients', () => {
  boundary.evaluated('patient API')
  return { getPatients: boundary.forbiddenCall }
})
vi.mock('./api/clinicalAssistant', () => {
  boundary.evaluated('assistant API')
  return { askPatientQuestion: boundary.forbiddenCall }
})
vi.mock('./api/dischargeLetters', () => {
  boundary.evaluated('discharge API')
  return {
    createDischargeJob: boundary.forbiddenCall,
    getDischargeJob: boundary.forbiddenCall,
    getDischargeDraft: boundary.forbiddenCall,
    saveDischargeDraft: boundary.forbiddenCall,
    reviewDischargeDraft: boundary.forbiddenCall,
  }
})
vi.mock('./App', () => {
  boundary.evaluated('doctor application')
  return { default: () => <p>Existing doctor application</p> }
})

beforeEach(() => {
  vi.resetModules()
  boundary.evaluated.mockClear()
  boundary.configurationError = null
  vi.stubGlobal('fetch', boundary.forbiddenCall)
})

describe('application startup isolation', () => {
  it.each(['/demo', '/demo/'])('opens %s without importing or initializing doctor dependencies', async (pathname) => {
    const Application = await loadApplication(pathname)
    render(<Application />)
    expect(screen.getByText('PUBLIC DEMO — SIMULATED DATA — NOT FOR CLINICAL USE')).toBeTruthy()
    expect(boundary.evaluated).not.toHaveBeenCalled()
    expect(boundary.restore).not.toHaveBeenCalled()
    expect(boundary.forbiddenCall).not.toHaveBeenCalled()
  })

  it('preserves authentication, OAuth listener, and session restoration for the existing doctor entry', async () => {
    const Application = await loadApplication('/')
    render(<Application />)
    expect(screen.getByText('Existing doctor application')).toBeTruthy()
    expect(boundary.evaluated.mock.calls.map(([name]) => name)).toEqual([
      'doctor authentication', 'OAuth listener', 'doctor application',
    ])
    expect(boundary.restore).toHaveBeenCalledOnce()
    expect(boundary.forbiddenCall).not.toHaveBeenCalled()
  })

  it('continues to skip session restoration when doctor configuration is incomplete', async () => {
    boundary.configurationError = 'Missing doctor configuration'
    await loadApplication('/')
    expect(boundary.restore).not.toHaveBeenCalled()
  })

  it('does not silently fall back to the doctor application if the public bundle fails', async () => {
    vi.doMock('./demo/DemoWorkspace', () => { throw new Error('Simulated demo bundle failure') })
    await expect(loadApplication('/demo')).rejects.toThrow()
    expect(boundary.evaluated).not.toHaveBeenCalled()
    expect(boundary.restore).not.toHaveBeenCalled()
    expect(boundary.forbiddenCall).not.toHaveBeenCalled()
  })
})
