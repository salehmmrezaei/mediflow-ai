import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoWorkspace } from './DemoWorkspace'

// These factories deliberately throw rather than replacing the production
// clients with working mocks. A public-demo import of any of them is a failure.
vi.mock('../auth', () => { throw new Error('Public demo imported doctor authentication') })
vi.mock('aws-amplify', () => { throw new Error('Public demo imported Amplify') })
vi.mock('aws-amplify/auth', () => { throw new Error('Public demo imported Amplify authentication') })
vi.mock('aws-amplify/utils', () => { throw new Error('Public demo imported Amplify Hub') })
vi.mock('aws-amplify/auth/enable-oauth-listener', () => { throw new Error('Public demo imported OAuth listener') })
vi.mock('../api/patients', () => { throw new Error('Public demo imported getPatients') })
vi.mock('../api/clinicalAssistant', () => { throw new Error('Public demo imported askPatientQuestion') })
vi.mock('../api/dischargeLetters', () => { throw new Error('Public demo imported production discharge clients') })

const sections = [
  'Admission reason', 'Hospital course', 'Investigations', 'Discharge diagnosis',
  'Discharge medications', 'Discharge date', 'Follow-up',
]
const fetchMock = vi.fn(() => { throw new Error('Public demo attempted fetch') })
const beaconMock = vi.fn(() => { throw new Error('Public demo attempted remote logging') })
let storageWrite: ReturnType<typeof vi.spyOn>
let xhrOpen: ReturnType<typeof vi.spyOn>
let originalBeacon: PropertyDescriptor | undefined

function clickButton(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

function phase() {
  return screen.getByRole('status', { name: 'Discharge simulation status' })
}

function generate() {
  clickButton('Generate sample discharge letter')
  expect(phase().textContent).toContain('QUEUED')
  act(() => { vi.advanceTimersByTime(800) })
  expect(phase().textContent).toContain('PROCESSING')
  act(() => { vi.advanceTimersByTime(800) })
  expect(phase().textContent).toContain('PENDING_REVIEW')
}

function answer() {
  return screen.getByRole('region', { name: 'Simulated answer' })
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockClear()
  beaconMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  storageWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Public demo attempted persistent storage')
  })
  xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
    throw new Error('Public demo attempted XMLHttpRequest')
  })
  originalBeacon = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon')
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beaconMock })
})

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled()
  expect(beaconMock).not.toHaveBeenCalled()
  expect(storageWrite).not.toHaveBeenCalled()
  expect(xhrOpen).not.toHaveBeenCalled()
  if (originalBeacon) Object.defineProperty(navigator, 'sendBeacon', originalBeacon)
  else Reflect.deleteProperty(navigator, 'sendBeacon')
  vi.useRealTimers()
})

describe('isolated public DemoWorkspace', () => {
  it('opens without doctor credentials, keeps the permanent banner and offers distinct exits', () => {
    render(<DemoWorkspace />)
    expect(screen.getByText('PUBLIC DEMO — SIMULATED DATA — NOT FOR CLINICAL USE')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Alice Example (DEMO-ALICE)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Select Bob Example (DEMO-BOB)' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('link', { name: 'Return to Home' }).getAttribute('href')).toBe('/')
    expect(screen.getByRole('link', { name: 'Doctor Sign In' }).getAttribute('href')).toBe('/?signin=1')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('switches fictional patients and clears the previous patient answer and workflow', () => {
    render(<DemoWorkspace />)
    clickButton('What symptoms led to admission?')
    const aliceAnswer = answer().textContent
    generate()
    clickButton('Select Bob Example (DEMO-BOB)')
    expect(screen.getByRole('button', { name: 'Select Bob Example (DEMO-BOB)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Select Alice Example (DEMO-ALICE)' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Simulated answer' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate sample discharge letter' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit documented sections' })).toBeNull()
    clickButton('What symptoms led to admission?')
    expect(answer().textContent).not.toBe(aliceAnswer)
    expect(screen.getByText('PUBLIC DEMO — SIMULATED DATA — NOT FOR CLINICAL USE')).toBeTruthy()
  })

  it('returns deterministic symptom and investigation examples with supporting notes', () => {
    render(<DemoWorkspace />)
    clickButton('What symptoms led to admission?')
    const symptoms = answer().textContent
    expect(symptoms).toContain('N001')
    expect(symptoms).toMatch(/simulated/i)
    clickButton('What investigations are documented?')
    expect(answer().textContent).toContain('N002')
    expect(answer().textContent).not.toBe(symptoms)
    clickButton('What symptoms led to admission?')
    expect(answer().textContent).toBe(symptoms)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('marks an unsupported medication question as insufficient evidence without inventing a plan', () => {
    render(<DemoWorkspace />)
    clickButton('What is the discharge medication plan?')
    expect(answer().textContent).toMatch(/insufficient evidence/i)
    expect(answer().textContent).toMatch(/do not document|not documented|no .*plan/i)
    expect(answer().textContent).toMatch(/simulated/i)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('progresses locally through every generation phase and shows seven sections with five missing', () => {
    render(<StrictMode><DemoWorkspace /></StrictMode>)
    generate()
    sections.forEach((name) => expect(screen.getByRole('heading', { name })).toBeTruthy())
    expect(screen.getAllByText('Not documented in the supplied notes.')).toHaveLength(5)
    const admission = screen.getByRole('article', { name: 'Admission reason' })
    const investigations = screen.getByRole('article', { name: 'Investigations' })
    expect(admission.textContent).toContain('N001')
    expect(investigations.textContent).toContain('N002')
    expect(screen.getByText(/no real Step Functions execution, DynamoDB write, or OpenAI request/i)).toBeTruthy()
  })

  it('edits only the two documented sections and retains saved changes in memory', () => {
    render(<DemoWorkspace />)
    generate()
    clickButton('Edit documented sections')
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    const admission = screen.getByRole('textbox', { name: 'Admission reason' })
    fireEvent.change(admission, { target: { value: 'Edited fictional admission summary.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Investigations' }), {
      target: { value: 'Edited fictional investigation summary.' },
    })
    clickButton('Save changes locally')
    expect(screen.getByText('Edited fictional admission summary.')).toBeTruthy()
    expect(screen.getByText('Edited fictional investigation summary.')).toBeTruthy()
    expect(screen.getAllByText('Not documented in the supplied notes.')).toHaveLength(5)
    clickButton('Edit documented sections')
    expect((screen.getByRole('textbox', { name: 'Admission reason' }) as HTMLTextAreaElement).value).toBe('Edited fictional admission summary.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), { target: { value: 'Discard this change.' } })
    clickButton('Cancel editing')
    expect(screen.getByText('Edited fictional admission summary.')).toBeTruthy()
    expect(screen.queryByText('Discard this change.')).toBeNull()
  })

  it('does not save a blank documented section or silently replace evidence with missing information', () => {
    render(<DemoWorkspace />)
    generate()
    clickButton('Edit documented sections')
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), { target: { value: '   ' } })
    const save = screen.getByRole('button', { name: 'Save changes locally' }) as HTMLButtonElement
    fireEvent.click(save)
    expect(screen.getByRole('textbox', { name: 'Admission reason' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve draft' })).toBeNull()
    clickButton('Cancel editing')
    expect(screen.getAllByText('Not documented in the supplied notes.')).toHaveLength(5)
  })

  it('requires an explicit approval dialog and missing-section acknowledgement and remains unsigned', () => {
    render(<DemoWorkspace />)
    generate()
    clickButton('Approve draft')
    let dialog = screen.getByRole('dialog', { name: 'Approve sample draft?' })
    expect(dialog.textContent).toContain('5 missing sections')
    expect(phase().textContent).toContain('PENDING_REVIEW')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm unsigned approval' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(phase().textContent).toContain('PENDING_REVIEW')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I acknowledge the 5 missing sections' }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(phase().textContent).toContain('PENDING_REVIEW')
    clickButton('Approve draft')
    dialog = screen.getByRole('dialog', { name: 'Approve sample draft?' })
    const finalConfirm = within(dialog).getByRole('button', { name: 'Confirm unsigned approval' }) as HTMLButtonElement
    expect(finalConfirm.disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I acknowledge the 5 missing sections' }))
    fireEvent.click(finalConfirm)
    expect(phase().textContent).toContain('APPROVED')
    expect(screen.getByText(/review approved.*unsigned/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit documented sections' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate new sample discharge letter' })).toBeTruthy()
  })

  it('requires a nonblank rejection reason and records it only in the current session', () => {
    render(<DemoWorkspace />)
    generate()
    clickButton('Reject draft')
    const dialog = screen.getByRole('dialog', { name: 'Reject sample draft?' })
    const reason = within(dialog).getByRole('textbox', { name: 'Rejection reason' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(reason, { target: { value: '   ' } })
    fireEvent.click(confirm)
    expect(phase().textContent).toContain('PENDING_REVIEW')
    expect(confirm.disabled).toBe(true)
    fireEvent.change(reason, { target: { value: '  Missing fictional follow-up information.  ' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(phase().textContent).toContain('REJECTED')
    expect(screen.getByText(/Rejection reason: Missing fictional follow-up information\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit documented sections' })).toBeNull()
    clickButton('Generate new sample discharge letter')
    expect(phase().textContent).toContain('QUEUED')
    expect(screen.queryByText(/Rejection reason: Missing fictional follow-up information\./)).toBeNull()
  })

  it('resets edits, answers, selected patient and review state to the initial in-memory demo', () => {
    render(<DemoWorkspace />)
    clickButton('Select Bob Example (DEMO-BOB)')
    clickButton('What symptoms led to admission?')
    generate()
    clickButton('Edit documented sections')
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), { target: { value: 'Only this session.' } })
    clickButton('Save changes locally')
    clickButton('Reset demo')
    expect(screen.getByRole('button', { name: 'Select Alice Example (DEMO-ALICE)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('region', { name: 'Simulated answer' })).toBeNull()
    expect(screen.queryByText('Only this session.')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate sample discharge letter' })).toBeTruthy()
  })

  it('cancels generation on reset and patient change, including a late timer', () => {
    const { unmount } = render(<DemoWorkspace />)
    clickButton('Generate sample discharge letter')
    clickButton('Reset demo')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByRole('button', { name: 'Edit documented sections' })).toBeNull()
    clickButton('Generate sample discharge letter')
    act(() => { vi.advanceTimersByTime(800) })
    clickButton('Select Bob Example (DEMO-BOB)')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByRole('button', { name: 'Edit documented sections' })).toBeNull()
    clickButton('Generate sample discharge letter')
    unmount()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts fresh after unmount/remount as on browser reload and does not share state across sessions', () => {
    const first = render(<DemoWorkspace />)
    clickButton('Select Bob Example (DEMO-BOB)')
    clickButton('What is the discharge medication plan?')
    generate()
    clickButton('Edit documented sections')
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), { target: { value: 'Ephemeral fictional edit.' } })
    clickButton('Save changes locally')
    first.unmount()
    render(<DemoWorkspace />)
    expect(screen.getByRole('button', { name: 'Select Alice Example (DEMO-ALICE)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('region', { name: 'Simulated answer' })).toBeNull()
    expect(screen.queryByText('Ephemeral fictional edit.')).toBeNull()
    generate()
    expect(screen.queryByText('Ephemeral fictional edit.')).toBeNull()
  })
})
