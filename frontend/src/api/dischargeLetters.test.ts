import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthSession } from 'aws-amplify/auth'
import {
  createDischargeJob, createIdempotencyKey, DISCHARGE_REQUEST_TIMEOUT_MS,
  DischargeLetterError, getDischargeDraft, getDischargeJob, MISSING_TEXT,
  reviewDischargeDraft, saveDischargeDraft, SECTION_NAMES, validateDischargeDraft,
  type DischargeDraft, type DischargeDraftResponse,
} from './dischargeLetters'

vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }))

const key = '9e4e7271-601e-4c8c-bf0e-ac688c8005a0'
const job = {
  job_id: 'job-1', patient_id: 'patient/a ?#', status: 'QUEUED',
  created_at: '2026-11-14T12:00:00Z', updated_at: '2026-11-14T12:00:00Z',
}
const draft: DischargeDraft = Object.fromEntries(SECTION_NAMES.map((name, index) => [name, index === 0
  ? { text: 'Admitted for synthetic observation.', documented: true, supporting_note_ids: ['N001'] }
  : { text: MISSING_TEXT, documented: false, supporting_note_ids: [] },
])) as DischargeDraft
const draftResponse: DischargeDraftResponse = {
  job_id: job.job_id, patient_id: job.patient_id, status: 'PENDING_REVIEW', updated_at: job.updated_at,
  document_state: 'UNSIGNED_DRAFT', draft, missing_sections: SECTION_NAMES.slice(1),
  supporting_note_ids: ['N001'], review_note: '',
}
const session = { tokens: { accessToken: { toString: () => 'synthetic-token' } } } as Awaited<ReturnType<typeof fetchAuthSession>>
const fetchMock = vi.fn<typeof fetch>()
const respond = (body: unknown, status = 200) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_API_URL', 'https://example.test/api///')
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(fetchAuthSession).mockResolvedValue(session)
  respond(job)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('discharge API', () => {
  it('generates a fresh UUIDv4 for every intentional generation', () => {
    const first = createIdempotencyKey()
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)
    expect(createIdempotencyKey()).not.toBe(first)
  })

  it('creates an encoded patient job with the existing Cognito access token and UUIDv4 header', async () => {
    await expect(createDischargeJob(job.patient_id, key)).resolves.toEqual(job)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/patients/patient%2Fa%20%3F%23/discharge-letters', {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Idempotency-Key': key },
      signal: expect.any(AbortSignal), cache: 'no-store',
    })
  })

  it('retains the caller supplied idempotency key when an uncertain creation is retried', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('internal network details'))
    await expect(createDischargeJob(job.patient_id, key)).rejects.toMatchObject({ retryable: true })
    await createDischargeJob(job.patient_id, key)
    expect(fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string> | undefined)?.['Idempotency-Key'])).toEqual([key, key])
  })

  it('does not create jobs without patient selection or a valid UUIDv4', async () => {
    await expect(createDischargeJob(' ', key)).rejects.toThrow('Select a patient')
    await expect(createDischargeJob('A', 'not-a-uuid')).rejects.toMatchObject({ status: 422 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retrieves job status and rejects a mismatched job identity', async () => {
    await expect(getDischargeJob(job.job_id)).resolves.toEqual(job)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/discharge-jobs/job-1', expect.objectContaining({ method: 'GET' }))
    respond({ ...job, job_id: 'another-job' })
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ status: 502 })
  })

  it('rejects a creation response for another patient', async () => {
    respond({ ...job, patient_id: 'patient-B' })
    await expect(createDischargeJob(job.patient_id, key)).rejects.toMatchObject({ status: 502 })
  })

  it('retrieves all seven sections with top-level missing metadata', async () => {
    respond(draftResponse)
    await expect(getDischargeDraft(job.job_id)).resolves.toEqual(draftResponse)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/discharge-jobs/job-1/draft', expect.objectContaining({ method: 'GET' }))
  })

  it('saves the full draft with the expected timestamp and returns the server version', async () => {
    const updated = { ...draftResponse, updated_at: '2026-11-14T12:01:00Z' }
    const payload = { expected_updated_at: job.updated_at, draft }
    respond(updated)
    await expect(saveDischargeDraft(job.job_id, payload)).resolves.toEqual(updated)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/discharge-jobs/job-1/draft', expect.objectContaining({
      method: 'PUT', body: JSON.stringify(payload),
      headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' },
    }))
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).draft)).toEqual(SECTION_NAMES)
  })

  it('submits explicit review decisions with their latest version and acknowledgement', async () => {
    const payload = { action: 'APPROVE' as const, expected_updated_at: job.updated_at, note: 'Reviewed synthetic draft.', acknowledge_missing_sections: true }
    const approved = { ...draftResponse, status: 'APPROVED', document_state: 'REVIEW_APPROVED_UNSIGNED', review_note: payload.note }
    respond(approved)
    await expect(reviewDischargeDraft(job.job_id, payload)).resolves.toEqual(approved)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/discharge-jobs/job-1/review', expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) }))
  })

  it('requires a nonempty rejection reason and enforces the backend Unicode note limit', async () => {
    const payload = { action: 'REJECT' as const, expected_updated_at: job.updated_at, note: '  ', acknowledge_missing_sections: false }
    await expect(reviewDischargeDraft(job.job_id, payload)).rejects.toThrow('A rejection reason is required')
    await expect(reviewDischargeDraft(job.job_id, { ...payload, note: '🩺'.repeat(1001) })).rejects.toMatchObject({ status: 422 })
    expect(fetchMock).not.toHaveBeenCalled()
    respond(draftResponse)
    await expect(reviewDischargeDraft(job.job_id, { ...payload, note: '🩺'.repeat(1000) })).resolves.toEqual(draftResponse)
  })

  it.each([
    [401, false, 'Your session has expired'],
    [403, false, 'Access denied'],
    [404, false, 'unavailable or inaccessible'],
    [409, false, 'Reload the latest'],
    [422, false, 'did not pass validation'],
    [429, true, 'temporarily unavailable'],
    [503, true, 'temporarily unavailable'],
    [504, true, 'took too long'],
    [500, true, 'could not be completed'],
  ])('maps HTTP %s without exposing sensitive backend details', async (status, retryable, message) => {
    respond({ detail: 'private stack trace and clinical text' }, Number(status))
    const error = await getDischargeJob(job.job_id).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DischargeLetterError)
    expect(error).toMatchObject({ status, retryable })
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain('private')
  })

  it.each([
    [{ detail: 'Invalid evidence in section: admission_reason' }, 'Admission reason needs valid supporting'],
    [{ detail: 'Invalid missing section: hospital_course' }, 'Hospital course must retain'],
    [{ detail: 'Section is too long: follow_up' }, 'Follow-up must contain at most 2000'],
    [{ detail: 'Too many evidence references: investigations' }, 'Investigations may contain at most 20'],
    [{ detail: 'A rejection reason is required' }, 'A rejection reason is required'],
    [{ detail: 'Acknowledge missing sections before approval' }, 'Acknowledge the missing sections'],
    [{ detail: [{ loc: ['body', 'note'], msg: 'private validation details', input: 'private clinical note' }] }, 'review note must contain at most 1000'],
  ])('displays known backend validation feedback safely %#', async (body, message) => {
    respond(body, 422)
    await expect(getDischargeJob(job.job_id)).rejects.toThrow(message)
  })

  it('handles missing/expired Cognito authentication through the existing sign-in message', async () => {
    vi.mocked(fetchAuthSession).mockResolvedValueOnce({})
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ status: 401 })
    const error = new Error('private authentication details')
    error.name = 'NotAuthorizedException'
    vi.mocked(fetchAuthSession).mockRejectedValueOnce(error)
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ status: 401, message: 'Your session has expired. Please sign out and sign in again.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows retry on transient session-check errors without exposing diagnostics', async () => {
    vi.mocked(fetchAuthSession).mockRejectedValueOnce(new Error('private diagnostics'))
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ message: 'Your session could not be checked. Please try again.', retryable: true })
  })

  it('rejects missing API configuration without making a request', async () => {
    vi.stubEnv('VITE_API_URL', '')
    await expect(getDischargeJob(job.job_id)).rejects.toThrow('not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([null, [], { ...job, status: 'SIGNED' }, { ...job, updated_at: '' }])('rejects a malformed job response %#', async (body) => {
    respond(body)
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ status: 502 })
  })

  it.each([
    { ...draftResponse, job_id: 'other-job' },
    { ...draftResponse, missing_sections: [] },
    { ...draftResponse, draft: { ...draft, missing_sections: [] } },
    { ...draftResponse, draft: { ...draft, admission_reason: { text: 'No references', documented: true, supporting_note_ids: [] } } },
    { ...draftResponse, draft: { ...draft, hospital_course: { text: 'Invented undocumented text', documented: false, supporting_note_ids: [] } } },
  ])('rejects malformed or inconsistent draft data %#', async (body) => {
    respond(body)
    await expect(getDischargeDraft(job.job_id)).rejects.toMatchObject({ status: 502 })
  })

  it('rejects a non-JSON success response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>private server output</html>'))
    await expect(getDischargeJob(job.job_id)).rejects.toMatchObject({ status: 502 })
  })

  it('cancels in-flight requests and clears its deadline', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = getDischargeJob(job.job_id, controller.signal)
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await check
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during Amplify authentication without issuing a later API request', async () => {
    let resolveSession: (value: typeof session) => void = () => {}
    vi.mocked(fetchAuthSession).mockImplementation(() => new Promise((resolve) => { resolveSession = resolve }))
    const controller = new AbortController()
    const pending = getDischargeJob(job.job_id, controller.signal)
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    resolveSession(session)
    await check
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never authenticates already cancelled requests', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(getDischargeDraft(job.job_id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchAuthSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['fetch', 'session'])('bounds a hanging %s operation and permits safe retry', async (operation) => {
    vi.useFakeTimers()
    if (operation === 'fetch') fetchMock.mockImplementation(() => new Promise(() => {}))
    else vi.mocked(fetchAuthSession).mockImplementation(() => new Promise(() => {}))
    const pending = getDischargeJob(job.job_id)
    const check = expect(pending).rejects.toMatchObject({ status: 504, retryable: true })
    await vi.advanceTimersByTimeAsync(DISCHARGE_REQUEST_TIMEOUT_MS)
    await check
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('draft validation', () => {
  it('accepts complete evidence and missing sections', () => {
    expect(validateDischargeDraft(draft)).toBeNull()
  })
  it('uses the backend Unicode character limit', () => {
    expect(validateDischargeDraft({ ...draft, admission_reason: { ...draft.admission_reason, text: '🩺'.repeat(2000) } })).toBeNull()
    expect(validateDischargeDraft({ ...draft, admission_reason: { ...draft.admission_reason, text: '🩺'.repeat(2001) } })).toContain('2000 characters')
  })
  it('does not permit silently adding text to an undocumented section', async () => {
    const invalid = { ...draft, hospital_course: { ...draft.hospital_course, text: 'Unverified text' } }
    expect(validateDischargeDraft(invalid)).toContain('Missing sections')
    await expect(saveDischargeDraft(job.job_id, { expected_updated_at: job.updated_at, draft: invalid })).rejects.toMatchObject({ status: 422 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('requires documented evidence references and limits their count', () => {
    expect(validateDischargeDraft({ ...draft, admission_reason: { ...draft.admission_reason, text: '   ' } })).not.toBeNull()
    expect(validateDischargeDraft({ ...draft, admission_reason: { ...draft.admission_reason, supporting_note_ids: [] } })).not.toBeNull()
    expect(validateDischargeDraft({ ...draft, admission_reason: { ...draft.admission_reason, supporting_note_ids: Array(21).fill('N001') } })).toContain('20 evidence references')
  })
})
