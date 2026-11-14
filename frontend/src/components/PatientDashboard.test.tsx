import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPatients, type Patient } from '../api/patients'
import { askPatientQuestion, type ClinicalAnswer } from '../api/clinicalAssistant'
import {
  createDischargeJob, getDischargeDraft, getDischargeJob, saveDischargeDraft, reviewDischargeDraft,
  SECTION_NAMES, type DischargeDraft, type DischargeDraftResponse, type DischargeJob,
} from '../api/dischargeLetters'
import { PatientDashboard } from './PatientDashboard'

vi.mock('../api/patients', () => ({ getPatients: vi.fn() }))
vi.mock('../api/clinicalAssistant', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/clinicalAssistant')>(),
  askPatientQuestion: vi.fn(),
}))
vi.mock('../api/dischargeLetters', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/dischargeLetters')>(),
  createDischargeJob: vi.fn(),
  getDischargeJob: vi.fn(),
  getDischargeDraft: vi.fn(),
  saveDischargeDraft: vi.fn(),
  reviewDischargeDraft: vi.fn(),
}))

const patients: Patient[] = [
  { patient_id: 'A', first_name: 'Alice', last_name: 'Example', age: 30,
    diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'admitted' },
  { patient_id: 'B', first_name: 'Bob', last_name: 'Example', age: 42,
    diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'scheduled' },
]

const dischargeJob: DischargeJob = {
  job_id: 'synthetic-job-a', patient_id: 'A', status: 'PENDING_REVIEW',
  created_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:01:00Z',
}
const dischargeDraft: DischargeDraftResponse = {
  job_id: dischargeJob.job_id, patient_id: 'A', status: 'PENDING_REVIEW',
  updated_at: dischargeJob.updated_at, document_state: 'UNSIGNED_DRAFT',
  draft: Object.fromEntries(SECTION_NAMES.map((name) => [name, {
    text: name === 'admission_reason' ? 'Synthetic Alice discharge evidence.' : `Synthetic ${name} evidence.`,
    documented: true, supporting_note_ids: ['N001'],
  }])) as DischargeDraft,
  missing_sections: [], supporting_note_ids: ['N001'], review_note: '',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(getPatients).mockReset().mockResolvedValue(patients)
  vi.mocked(askPatientQuestion).mockReset()
  vi.mocked(createDischargeJob).mockReset().mockResolvedValue(dischargeJob)
  vi.mocked(getDischargeJob).mockReset().mockResolvedValue(dischargeJob)
  vi.mocked(getDischargeDraft).mockReset().mockResolvedValue(dischargeDraft)
  vi.mocked(saveDischargeDraft).mockReset()
  vi.mocked(reviewDischargeDraft).mockReset()
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

  it('supports discharge generation alongside the existing assistant and clears both on patient change', async () => {
    vi.mocked(askPatientQuestion).mockResolvedValue({
      answer: 'Synthetic Alice assistant answer.', supporting_note_ids: ['N001'], insufficient_evidence: false,
    })
    render(<PatientDashboard username="doctor-test" onSignOut={vi.fn()} />)
    await screen.findByRole('button', { name: 'Select Alice Example (A)' })
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Select Alice Example (A)' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), { target: { value: 'What happened?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
    await screen.findByText('Synthetic Alice assistant answer.')
    fireEvent.click(screen.getByRole('button', { name: 'Generate Discharge Letter' }))
    await screen.findByText('Synthetic Alice discharge evidence.')
    expect(createDischargeJob).toHaveBeenCalledWith('A', expect.any(String), expect.any(AbortSignal))
    expect(screen.getByText('Synthetic Alice assistant answer.')).toBeTruthy()
    expect(within(document.getElementById('discharge-letter')!).getByText(/Alice Example/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Select Bob Example (B)' }))
    expect(screen.queryByText('Synthetic Alice discharge evidence.')).toBeNull()
    expect(screen.queryByText('Synthetic Alice assistant answer.')).toBeNull()
    expect(within(document.getElementById('discharge-letter')!).getByText(/Bob Example/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(false)
    expect(getDischargeDraft).toHaveBeenCalledTimes(1)
  })

  it('cancels discharge retrieval when patient refresh removes the selection and ignores a late draft', async () => {
    const pendingDraft = deferred<DischargeDraftResponse>()
    vi.mocked(getDischargeDraft).mockReturnValue(pendingDraft.promise)
    render(<PatientDashboard username="doctor-test" onSignOut={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select Alice Example (A)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate Discharge Letter' }))
    await waitFor(() => expect(getDischargeDraft).toHaveBeenCalledOnce())
    const signal = vi.mocked(getDischargeDraft).mock.calls[0][1]!
    vi.mocked(getPatients).mockResolvedValue([patients[1]])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Alice Example (A)' })).toBeNull())
    expect(signal.aborted).toBe(true)
    await act(async () => { pendingDraft.resolve(dischargeDraft) })
    expect(screen.queryByText('Synthetic Alice discharge evidence.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
