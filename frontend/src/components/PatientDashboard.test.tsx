import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPatients, type Patient } from '../api/patients'
import { askPatientQuestion, type ClinicalAnswer } from '../api/clinicalAssistant'
import { PatientDashboard } from './PatientDashboard'

vi.mock('../api/patients', () => ({ getPatients: vi.fn() }))
vi.mock('../api/clinicalAssistant', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/clinicalAssistant')>(),
  askPatientQuestion: vi.fn(),
}))

const patients: Patient[] = [
  { patient_id: 'A', first_name: 'Alice', last_name: 'Example', age: 30,
    diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'admitted' },
  { patient_id: 'B', first_name: 'Bob', last_name: 'Example', age: 42,
    diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'scheduled' },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(getPatients).mockReset().mockResolvedValue(patients)
  vi.mocked(askPatientQuestion).mockReset()
})

describe('Doctor workspace integration', () => {
  it('keeps the assistant disabled until an authorized listed patient is selected', async () => {
    const signOut = vi.fn()
    render(<PatientDashboard username="doctor-test" onSignOut={signOut} />)
    await screen.findByRole('button', { name: 'Select Alice Example (A)' })
    expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('doctor-test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select Alice Example (A)' }))
    expect(screen.getByRole('button', { name: 'Select Alice Example (A)' }).getAttribute('aria-pressed')).toBe('true')
    const assistant = document.getElementById('clinical-assistant')!
    expect(within(assistant).getByText(/Alice Example/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), {
      target: { value: 'Why was this patient admitted?' },
    })
    vi.mocked(askPatientQuestion).mockResolvedValue({
      answer: 'Observation for fever.', supporting_note_ids: ['N001'], insufficient_evidence: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
    await screen.findByText('Observation for fever.')
    expect(askPatientQuestion).toHaveBeenCalledWith('A', 'Why was this patient admitted?', expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('aborts the previous patient request and never shows its late answer for the new patient', async () => {
    const answer = deferred<ClinicalAnswer>()
    vi.mocked(askPatientQuestion).mockReturnValue(answer.promise)
    render(<PatientDashboard username="doctor-test" onSignOut={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select Alice Example (A)' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), {
      target: { value: 'What happened?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
    const signal = vi.mocked(askPatientQuestion).mock.calls[0][2]!
    fireEvent.click(screen.getByRole('button', { name: 'Select Bob Example (B)' }))
    expect(signal.aborted).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Clinical question' }) as HTMLTextAreaElement).value).toBe('')
    await act(async () => {
      answer.resolve({ answer: 'Alice-only answer', supporting_note_ids: ['N001'], insufficient_evidence: false })
    })
    expect(screen.queryByText('Alice-only answer')).toBeNull()
    expect(within(document.getElementById('clinical-assistant')!).getByText(/Bob Example/)).toBeTruthy()
  })

  it('clears the assistant if refresh removes the selected patient', async () => {
    vi.mocked(askPatientQuestion).mockResolvedValue({
      answer: 'Alice-only answer', supporting_note_ids: ['N001'], insufficient_evidence: false,
    })
    render(<PatientDashboard username="doctor-test" onSignOut={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select Alice Example (A)' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), { target: { value: 'What happened?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
    await screen.findByText('Alice-only answer')
    vi.mocked(getPatients).mockResolvedValue([patients[1]])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Alice Example (A)' })).toBeNull())
    expect(screen.queryByText('Alice-only answer')).toBeNull()
    expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('preserves the patient-list failure and retry flow', async () => {
    vi.mocked(getPatients).mockRejectedValueOnce(new Error('Unable to load patients.'))
    render(<PatientDashboard username="doctor-test" onSignOut={vi.fn()} />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('table')
    expect(getPatients).toHaveBeenCalledTimes(2)
  })
})
