import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDischargeJob,
  DischargeLetterError,
  getDischargeDraft,
  getDischargeJob,
  MISSING_TEXT,
  reviewDischargeDraft,
  saveDischargeDraft,
  SECTION_LABELS,
  SECTION_NAMES,
  type DischargeDraft,
  type DischargeDraftResponse,
  type DischargeJob,
} from '../api/dischargeLetters'
import type { Patient } from '../api/patients'
import { DischargeLetter } from './DischargeLetter'

vi.mock('../api/dischargeLetters', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/dischargeLetters')>(),
  createDischargeJob: vi.fn(),
  getDischargeJob: vi.fn(),
  getDischargeDraft: vi.fn(),
  saveDischargeDraft: vi.fn(),
  reviewDischargeDraft: vi.fn(),
}))

const createJob = vi.mocked(createDischargeJob)
const getJob = vi.mocked(getDischargeJob)
const getDraft = vi.mocked(getDischargeDraft)
const saveDraft = vi.mocked(saveDischargeDraft)
const reviewDraft = vi.mocked(reviewDischargeDraft)
const timestamp = '2026-11-14T10:00:00Z'
const newerTimestamp = '2026-11-14T10:01:00Z'
const alice: Patient = {
  patient_id: 'PATIENT-A', first_name: 'Alice', last_name: 'Example', age: 30,
  diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'admitted',
}
const bob: Patient = { ...alice, patient_id: 'PATIENT-B', first_name: 'Bob' }
const job: DischargeJob = {
  job_id: 'synthetic-job-a', patient_id: alice.patient_id, status: 'PENDING_REVIEW',
  created_at: timestamp, updated_at: timestamp,
}

function draftResponse(overrides: Partial<DischargeDraftResponse> = {}): DischargeDraftResponse {
  const draft = Object.fromEntries(SECTION_NAMES.map((name) => [name, {
    text: name === 'admission_reason' ? 'Synthetic admission for observation.' : MISSING_TEXT,
    documented: name === 'admission_reason',
    supporting_note_ids: name === 'admission_reason' ? ['N001'] : [],
  }])) as DischargeDraft
  return {
    job_id: job.job_id, patient_id: alice.patient_id, status: 'PENDING_REVIEW',
    updated_at: timestamp, document_state: 'UNSIGNED_DRAFT', draft,
    missing_sections: SECTION_NAMES.filter((name) => name !== 'admission_reason'),
    supporting_note_ids: ['N001'], review_note: '', ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function generate() {
  fireEvent.click(screen.getByRole('button', { name: 'Generate Discharge Letter' }))
}

async function showDraft(response = draftResponse()) {
  createJob.mockResolvedValue(job)
  getDraft.mockResolvedValue(response)
  render(<DischargeLetter patient={alice} />)
  generate()
  await screen.findByRole('button', { name: 'Edit Draft' })
}

function editAdmission(value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Edit Draft' }))
  fireEvent.change(screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }), {
    target: { value },
  })
}

beforeEach(() => {
  createJob.mockReset().mockResolvedValue(job)
  getJob.mockReset().mockResolvedValue(job)
  getDraft.mockReset().mockResolvedValue(draftResponse())
  saveDraft.mockReset()
  reviewDraft.mockReset()
})

afterEach(() => vi.useRealTimers())

describe('DischargeLetter', () => {
  it('requires a selected patient and never starts a request implicitly', () => {
    render(<DischargeLetter patient={null} />)
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(true)
    expect(createJob).not.toHaveBeenCalled()
  })

  it('creates a job for the selected patient with a UUIDv4 key and blocks duplicate clicks', async () => {
    const request = deferred<DischargeJob>()
    createJob.mockReturnValue(request.promise)
    render(<DischargeLetter patient={alice} />)
    const button = screen.getByRole('button', { name: 'Generate Discharge Letter' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(createJob).toHaveBeenCalledTimes(1)
    const [patientId, key, signal] = createJob.mock.calls[0]
    expect(patientId).toBe(alice.patient_id)
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { request.resolve(job) })
    await screen.findByRole('button', { name: 'Edit Draft' })
  })

  it('reuses the original idempotency key when retrying an uncertain submission', async () => {
    createJob.mockRejectedValueOnce(new DischargeLetterError('Temporarily unavailable. Retry safely.', true, 503))
    render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByRole('alert')
    const originalKey = createJob.mock.calls[0][1]
    fireEvent.click(screen.getByRole('button', { name: 'Retry generation' }))
    await screen.findByRole('button', { name: 'Edit Draft' })
    expect(createJob).toHaveBeenCalledTimes(2)
    expect(createJob.mock.calls[1][1]).toBe(originalKey)
  })

  it('uses a fresh key after a definitive first validation failure and prevents fresh jobs after an uncertain retry fails validation', async () => {
    createJob.mockRejectedValueOnce(new DischargeLetterError('Invalid generation request.', false, 422))
    const { rerender } = render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByRole('alert')
    const rejectedKey = createJob.mock.calls[0][1]
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(false)
    generate()
    await screen.findByRole('button', { name: 'Edit Draft' })
    expect(createJob.mock.calls[1][1]).not.toBe(rejectedKey)

    rerender(<DischargeLetter patient={bob} />)
    createJob.mockRejectedValueOnce(new DischargeLetterError('Temporarily unavailable.', true, 503))
    createJob.mockRejectedValueOnce(new DischargeLetterError('Invalid generation request.', false, 422))
    generate()
    fireEvent.click(await screen.findByRole('button', { name: 'Retry generation' }))
    await screen.findByText('Invalid generation request.')
    expect(createJob.mock.calls[3][1]).toBe(createJob.mock.calls[2][1])
    const newGeneration = screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement
    expect(newGeneration.disabled).toBe(true)
    fireEvent.click(newGeneration)
    expect(createJob).toHaveBeenCalledTimes(4)
  })

  it('polls queued and processing jobs, loads the draft at pending review, and stops polling', async () => {
    vi.useFakeTimers()
    createJob.mockResolvedValue({ ...job, status: 'QUEUED' })
    getJob.mockResolvedValueOnce({ ...job, status: 'PROCESSING' }).mockResolvedValueOnce(job)
    const { unmount } = render(<DischargeLetter patient={alice} />)
    generate()
    await act(async () => {})
    expect(screen.getByText(/^Queued$/i)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByText(/^Processing$/i)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('button', { name: 'Edit Draft' })).toBeTruthy()
    expect(getDraft).toHaveBeenCalledWith(job.job_id, expect.any(AbortSignal))
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(getJob).toHaveBeenCalledTimes(2)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders all seven clinical sections, missing warnings and evidence without implying a signature', async () => {
    await showDraft()
    for (const name of SECTION_NAMES) {
      expect(screen.getByRole('heading', { name: SECTION_LABELS[name] })).toBeTruthy()
    }
    expect(screen.getByText('Synthetic admission for observation.')).toBeTruthy()
    expect(screen.getAllByText(MISSING_TEXT)).toHaveLength(6)
    expect(screen.getByText(/Supporting note IDs: N001/)).toBeTruthy()
    expect(screen.getByText(/AI-generated draft.*Requires doctor review.*Not signed/i)).toBeTruthy()
    expect(screen.getByText(/1 documented.*6 missing/i)).toBeTruthy()
  })

  it('saves only the seven sections with evidence flags and the latest version, then uses the returned version', async () => {
    const original = draftResponse()
    const edited: DischargeDraft = {
      ...original.draft,
      admission_reason: { ...original.draft.admission_reason, text: 'Reviewed synthetic admission details.' },
    }
    const saved = {
      ...original, updated_at: newerTimestamp,
      draft: { ...edited, admission_reason: { ...edited.admission_reason, text: 'Server-confirmed synthetic admission details.' } },
    }
    saveDraft.mockResolvedValue(saved)
    await showDraft(original)
    editAdmission(edited.admission_reason.text)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(saved.draft.admission_reason.text)
    expect(saveDraft).toHaveBeenCalledWith(job.job_id, {
      expected_updated_at: timestamp, draft: edited,
    }, expect.any(AbortSignal))
    expect(Object.keys(saveDraft.mock.calls[0][1].draft).sort()).toEqual([...SECTION_NAMES].sort())
    editAdmission('Second edit based on the latest timestamp.')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    expect(saveDraft.mock.calls[1][1].expected_updated_at).toBe(newerTimestamp)
  })

  it('keeps missing information canonical and blocks blank or overlong documented text', async () => {
    await showDraft()
    editAdmission('   ')
    const missingInput = screen.queryByRole('textbox', { name: SECTION_LABELS.hospital_course }) as HTMLTextAreaElement | null
    expect(missingInput === null || missingInput.readOnly || missingInput.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(saveDraft).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }), {
      target: { value: 'x'.repeat(2001) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(saveDraft).not.toHaveBeenCalled()
  })

  it('saves the current controlled admission text under the application StrictMode wrapper', async () => {
    const replacement = 'Updated synthetic admission reason.'
    const saved = draftResponse({ updated_at: newerTimestamp })
    saved.draft.admission_reason.text = replacement
    saveDraft.mockResolvedValue(saved)
    render(<StrictMode><DischargeLetter patient={alice} /></StrictMode>)
    generate()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Draft' }))
    const input = screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }) as HTMLTextAreaElement
    for (let count = 1; count <= replacement.length; count += 1) {
      fireEvent.change(input, { target: { value: replacement.slice(0, count) } })
      expect(input.value).toBe(replacement.slice(0, count))
    }
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(replacement)
    expect(saveDraft).toHaveBeenCalledOnce()
    expect(saveDraft.mock.calls[0][1]).toEqual({
      expected_updated_at: timestamp, draft: { ...draftResponse().draft, admission_reason: saved.draft.admission_reason },
    })
  })

  it('shows saving progress beside the save controls until the server confirms the edit', async () => {
    const request = deferred<DischargeDraftResponse>()
    saveDraft.mockReturnValue(request.promise)
    await showDraft()
    editAdmission('Synthetic edit awaiting save confirmation.')
    const actions = screen.getByRole('button', { name: 'Save changes' }).closest('.discharge-actions')!
    fireEvent.click(within(actions as HTMLElement).getByRole('button', { name: 'Save changes' }))
    expect((within(actions as HTMLElement).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(actions as HTMLElement).getByRole('status').textContent).toMatch(/saving/i)
    expect((screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }) as HTMLTextAreaElement).value)
      .toBe('Synthetic edit awaiting save confirmation.')
    const saved = draftResponse({ updated_at: newerTimestamp })
    saved.draft.admission_reason.text = 'Synthetic edit awaiting save confirmation.'
    await act(async () => { request.resolve(saved) })
    expect(screen.getByText(saved.draft.admission_reason.text)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull()
  })

  it('preserves unsaved edits after a network failure and allows saving again', async () => {
    saveDraft.mockRejectedValueOnce(new DischargeLetterError('Unable to reach the service.', true))
    const updated = draftResponse()
    updated.draft.admission_reason.text = 'Unsaved synthetic edit.'
    saveDraft.mockResolvedValueOnce({ ...updated, updated_at: newerTimestamp })
    await showDraft()
    editAdmission(updated.draft.admission_reason.text)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const failure = await screen.findByRole('alert')
    expect(failure.closest('.discharge-actions')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }) as HTMLTextAreaElement).value)
      .toBe(updated.draft.admission_reason.text)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(updated.draft.admission_reason.text)
    expect(saveDraft).toHaveBeenCalledTimes(2)
  })

  it('preserves edits on a 409 conflict and offers an explicit reload of the latest draft', async () => {
    saveDraft.mockRejectedValue(new DischargeLetterError('The draft changed. Reload the latest draft.', false, 409))
    await showDraft()
    editAdmission('Unsaved version must not disappear.')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('textbox', { name: SECTION_LABELS.admission_reason }) as HTMLTextAreaElement).value)
      .toBe('Unsaved version must not disappear.')
    const latest = draftResponse({ updated_at: newerTimestamp })
    latest.draft.admission_reason.text = 'Another doctor saved this version.'
    getDraft.mockResolvedValue(latest)
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest draft' }))
    const confirmation = screen.queryByRole('dialog')
    if (confirmation) {
      fireEvent.click(within(confirmation).getByRole('button', { name: /reload|discard/i }))
    }
    await screen.findByText(latest.draft.admission_reason.text)
    expect(getDraft).toHaveBeenCalledTimes(2)
  })

  it('requires explicit approval confirmation and acknowledgement of missing sections', async () => {
    const approved = draftResponse({
      status: 'APPROVED', document_state: 'REVIEW_APPROVED_UNSIGNED', updated_at: newerTimestamp,
    })
    reviewDraft.mockResolvedValue(approved)
    await showDraft()
    expect(reviewDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/6.*missing|missing.*6/i)
    expect(dialog.textContent).toMatch(/signature/i)
    const confirm = within(dialog).getByRole('button', { name: 'Confirm approval' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm)
    expect(reviewDraft).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I acknowledge the missing sections' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(reviewDraft).toHaveBeenCalledOnce())
    expect(reviewDraft).toHaveBeenCalledWith(job.job_id, expect.objectContaining({
      action: 'APPROVE', expected_updated_at: timestamp, acknowledge_missing_sections: true,
    }), expect.any(AbortSignal))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Approve Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject Draft' })).toBeNull()
    expect(screen.getAllByText(/not signed/i).length).toBeGreaterThan(0)
  })

  it('reviews the saved server version and never submits unsaved edits for review', async () => {
    const saved = draftResponse({ updated_at: newerTimestamp })
    saved.draft.admission_reason.text = 'Reviewed synthetic admission details.'
    saveDraft.mockResolvedValue(saved)
    reviewDraft.mockResolvedValue({ ...saved, status: 'APPROVED', document_state: 'REVIEW_APPROVED_UNSIGNED' })
    await showDraft()
    editAdmission(saved.draft.admission_reason.text)
    expect(screen.queryByRole('button', { name: 'Approve Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject Draft' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(saved.draft.admission_reason.text)
    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I acknowledge the missing sections' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm approval' }))
    await waitFor(() => expect(reviewDraft).toHaveBeenCalledOnce())
    expect(reviewDraft.mock.calls[0][1].expected_updated_at).toBe(newerTimestamp)
  })

  it('offers an accessible reload inside the review dialog after a version conflict', async () => {
    reviewDraft.mockRejectedValue(new DischargeLetterError('The draft changed. Reload the latest draft.', false, 409))
    await showDraft()
    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I acknowledge the missing sections' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm approval' }))
    await within(dialog).findByRole('alert')
    expect((within(dialog).getByRole('button', { name: 'Confirm approval' }) as HTMLButtonElement).disabled).toBe(true)
    const terminal = draftResponse({
      status: 'REJECTED', document_state: 'REJECTED_DRAFT', updated_at: newerTimestamp,
      review_note: 'Synthetic review performed in another workspace.',
    })
    getJob.mockResolvedValue({ ...job, status: 'REJECTED', updated_at: newerTimestamp })
    getDraft.mockResolvedValue(terminal)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload latest draft' }))
    await screen.findByText(/Synthetic review performed in another workspace/)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject Draft' })).toBeNull()
    expect(reviewDraft).toHaveBeenCalledOnce()
  })

  it('can cancel approval without making a review request', async () => {
    await showDraft()
    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reviewDraft).not.toHaveBeenCalled()
  })

  it('requires a nonempty rejection reason and displays the rejected result read-only', async () => {
    const reason = 'Additional synthetic clinical evidence is required.'
    reviewDraft.mockResolvedValue(draftResponse({
      status: 'REJECTED', document_state: 'REJECTED_DRAFT', review_note: reason, updated_at: newerTimestamp,
    }))
    await showDraft()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Draft' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'Rejection reason' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm rejection' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(confirm)
    expect(reviewDraft).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ` ${reason} ` } })
    fireEvent.click(confirm)
    await screen.findByText(reason)
    expect(reviewDraft).toHaveBeenCalledWith(job.job_id, {
      action: 'REJECT', expected_updated_at: timestamp, note: reason, acknowledge_missing_sections: false,
    }, expect.any(AbortSignal))
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject Draft' })).toBeNull()
  })

  it.each(['APPROVED', 'REJECTED'] as const)('loads an existing %s draft read-only', async (status) => {
    createJob.mockResolvedValue({ ...job, status })
    getDraft.mockResolvedValue(draftResponse({
      status, document_state: status === 'APPROVED' ? 'REVIEW_APPROVED_UNSIGNED' : 'REJECTED_DRAFT',
    }))
    render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByText('Synthetic admission for observation.')
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject Draft' })).toBeNull()
    expect(getJob).not.toHaveBeenCalled()
  })

  it('aborts a pending generation and ignores a late response when switching patients', async () => {
    const request = deferred<DischargeJob>()
    createJob.mockReturnValueOnce(request.promise)
    const { rerender } = render(<DischargeLetter patient={alice} />)
    generate()
    const signal = createJob.mock.calls[0][2]!
    rerender(<DischargeLetter patient={bob} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('Alice Example')).toBeNull()
    expect(screen.queryByText('Synthetic admission for observation.')).toBeNull()
    await act(async () => { request.resolve(job) })
    expect(getDraft).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears an existing draft synchronously when switching patients or clearing selection', async () => {
    const { rerender } = render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByText('Synthetic admission for observation.')
    rerender(<DischargeLetter patient={bob} />)
    expect(screen.queryByText('Synthetic admission for observation.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
    rerender(<DischargeLetter patient={null} />)
    expect((screen.getByRole('button', { name: 'Generate Discharge Letter' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores an old draft request that completes under a different patient', async () => {
    const request = deferred<DischargeDraftResponse>()
    getDraft.mockReturnValueOnce(request.promise)
    const { rerender } = render(<DischargeLetter patient={alice} />)
    generate()
    await waitFor(() => expect(getDraft).toHaveBeenCalledOnce())
    const signal = getDraft.mock.calls[0][1]!
    rerender(<DischargeLetter patient={bob} />)
    expect(signal.aborted).toBe(true)
    await act(async () => { request.resolve(draftResponse()) })
    expect(screen.queryByText('Synthetic admission for observation.')).toBeNull()
  })

  it('cancels in-flight polling and ignores a late terminal status on unmount', async () => {
    vi.useFakeTimers()
    createJob.mockResolvedValue({ ...job, status: 'PROCESSING' })
    const request = deferred<DischargeJob>()
    getJob.mockReturnValue(request.promise)
    const { unmount } = render(<DischargeLetter patient={alice} />)
    generate()
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(getJob).toHaveBeenCalledOnce()
    const signal = getJob.mock.calls[0][1]!
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { request.resolve(job) })
    expect(getDraft).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows expired authentication safely and does not retry automatically', async () => {
    createJob.mockRejectedValue(new DischargeLetterError('Your session has expired. Please sign out and sign in again.', false, 401))
    render(<DischargeLetter patient={alice} />)
    generate()
    expect((await screen.findByRole('alert')).textContent).toMatch(/session has expired/i)
    expect(screen.getByText(/sign out and sign in again/i)).toBeTruthy()
    expect(createJob).toHaveBeenCalledOnce()
  })

  it('shows a failed job without fetching a draft or polling further', async () => {
    createJob.mockResolvedValue({ ...job, status: 'FAILED' })
    render(<DischargeLetter patient={alice} />)
    generate()
    await waitFor(() => expect(screen.getByText(/^Failed$/i)).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/fail|could not/i)
    expect(getDraft).not.toHaveBeenCalled()
    expect(getJob).not.toHaveBeenCalled()
  })

  it('uses a fresh idempotency key for an intentionally new generation', async () => {
    createJob.mockResolvedValueOnce({ ...job, status: 'FAILED' }).mockResolvedValueOnce(job)
    render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByText(/^Failed$/i)
    fireEvent.click(screen.getByRole('button', { name: /Generate New Discharge Letter/i }))
    await screen.findByRole('button', { name: 'Edit Draft' })
    expect(createJob).toHaveBeenCalledTimes(2)
    expect(createJob.mock.calls[1][1]).not.toBe(createJob.mock.calls[0][1])
  })

  it('stops polling on a network error and resumes the same job through an explicit retry', async () => {
    vi.useFakeTimers()
    createJob.mockResolvedValue({ ...job, status: 'QUEUED' })
    getJob.mockRejectedValueOnce(new DischargeLetterError('Unable to reach the service.', true)).mockResolvedValueOnce(job)
    const { unmount } = render(<DischargeLetter patient={alice} />)
    generate()
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('alert').textContent).toContain('Unable to reach')
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(getJob).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry status check' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(getJob).toHaveBeenLastCalledWith(job.job_id, expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: 'Edit Draft' })).toBeTruthy()
    expect(createJob).toHaveBeenCalledOnce()
    unmount()
  })

  it('never displays a draft whose response identifies another patient', async () => {
    getDraft.mockResolvedValue(draftResponse({ patient_id: bob.patient_id }))
    render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByRole('alert')
    expect(screen.queryByText('Synthetic admission for observation.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
  })

  it('aborts an in-flight save and ignores its late response when the selected patient changes', async () => {
    const request = deferred<DischargeDraftResponse>()
    saveDraft.mockReturnValue(request.promise)
    const { rerender } = render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByRole('button', { name: 'Edit Draft' })
    editAdmission('Alice-only pending edit.')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const signal = saveDraft.mock.calls[0][2]!
    rerender(<DischargeLetter patient={bob} />)
    expect(signal.aborted).toBe(true)
    await act(async () => { request.resolve(draftResponse()) })
    expect(document.body.textContent).not.toContain('Alice-only pending edit.')
    expect(screen.queryByText('Synthetic admission for observation.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
  })

  it('does not expose internal details from an unexpected exception', async () => {
    createJob.mockRejectedValue(new Error('Authorization: Bearer private-token internal stack'))
    render(<DischargeLetter patient={alice} />)
    generate()
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('private-token')
    expect(document.body.textContent).not.toContain('internal stack')
  })
})
