import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthSession } from 'aws-amplify/auth'
import {
  askPatientQuestion,
  CLINICAL_REQUEST_TIMEOUT_MS,
  ClinicalAssistantError,
} from './clinicalAssistant'

vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }))

const answer = {
  answer: 'Admitted for observation after fever and a persistent cough.',
  supporting_note_ids: ['N001'],
  insufficient_evidence: false,
}
const fetchMock = vi.fn<typeof fetch>()
const session = {
  tokens: { accessToken: { toString: () => 'mock-access-token' } },
} as Awaited<ReturnType<typeof fetchAuthSession>>

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_API_URL', 'https://example.test/api///')
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(fetchAuthSession).mockResolvedValue(session)
  fetchMock.mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('askPatientQuestion', () => {
  it('uses the Cognito access token, encoded selected patient ID, and trimmed JSON question', async () => {
    await expect(askPatientQuestion('patient/a ?#', '  Why was this patient admitted?  ')).resolves.toEqual(answer)
    expect(fetchAuthSession).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/patients/patient%2Fa%20%3F%23/ask',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer mock-access-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Why was this patient admitted?' }),
        signal: expect.any(AbortSignal),
        cache: 'no-store',
      }),
    )
  })

  it('accepts a valid insufficient-evidence response with no supporting IDs', async () => {
    const insufficient = { answer: 'Insufficient evidence in the provided notes.', supporting_note_ids: [], insufficient_evidence: true }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(insufficient)))
    await expect(askPatientQuestion('A', 'What was the lab result?')).resolves.toEqual(insufficient)
  })

  it.each(['', '   ', 'x'.repeat(501)])('rejects an invalid question without an authenticated request', async (question) => {
    await expect(askPatientQuestion('A', question)).rejects.toMatchObject({ status: 422, retryable: false })
    expect(fetchAuthSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('matches the backend 500-character Unicode limit', async () => {
    await expect(askPatientQuestion('A', '🩺'.repeat(500))).resolves.toEqual(answer)
  })

  it('requires a selected patient', async () => {
    await expect(askPatientQuestion(' ', 'Why?')).rejects.toThrow('Select a patient')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires an access token and never sends an unauthenticated request', async () => {
    vi.mocked(fetchAuthSession).mockResolvedValue({})
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({ status: 401, retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an expired Cognito session to a sign-in message without leaking the original error', async () => {
    const error = new Error('private authentication details')
    error.name = 'UserUnAuthenticatedException'
    vi.mocked(fetchAuthSession).mockRejectedValue(error)
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({
      status: 401, message: 'Your session has expired. Please sign out and sign in again.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows retry when a session check temporarily fails', async () => {
    vi.mocked(fetchAuthSession).mockRejectedValue(new Error('internal network diagnostics'))
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({
      message: 'Your session could not be checked. Please try again.', retryable: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, false, 'Your session has expired'],
    [403, false, 'This patient is unavailable'],
    [404, false, 'This patient is unavailable'],
    [422, false, 'Enter a question containing 1 to 500 characters'],
    [502, true, 'could not return a valid answer'],
    [503, true, 'temporarily unavailable'],
    [504, true, 'took too long'],
    [500, true, 'could not be answered'],
  ])('maps HTTP %s to a safe actionable error', async (status, retryable, message) => {
    fetchMock.mockResolvedValue(new Response('private backend stack trace', { status: Number(status) }))
    const result = await askPatientQuestion('A', 'Why?').catch((error: unknown) => error)
    expect(result).toBeInstanceOf(ClinicalAssistantError)
    expect(result).toMatchObject({ status, retryable })
    expect((result as Error).message).toContain(message)
    expect((result as Error).message).not.toContain('private backend')
  })

  it('shows a retryable network message without exposing network internals', async () => {
    fetchMock.mockRejectedValue(new TypeError('private connection diagnostics'))
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({
      message: 'Unable to reach the clinical assistant. Check your connection and try again.', retryable: true,
    })
  })

  it.each([
    null,
    [],
    { ...answer, answer: '' },
    { ...answer, answer: 42 },
    { ...answer, supporting_note_ids: 'N001' },
    { ...answer, supporting_note_ids: [1] },
    { ...answer, supporting_note_ids: [] },
    { ...answer, insufficient_evidence: 'false' },
  ])('rejects malformed successful response %#', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)))
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({ status: 502, retryable: true })
  })

  it('rejects a non-JSON successful response', async () => {
    fetchMock.mockResolvedValue(new Response('<html>private server details</html>'))
    await expect(askPatientQuestion('A', 'Why?')).rejects.toMatchObject({ status: 502, retryable: true })
  })

  it('bounds a hanging request and aborts it with a retryable timeout message', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const result = askPatientQuestion('A', 'Why?')
    const check = expect(result).rejects.toMatchObject({ status: 504, retryable: true })
    await vi.advanceTimersByTimeAsync(CLINICAL_REQUEST_TIMEOUT_MS)
    await check
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also bounds a hanging Amplify session check', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchAuthSession).mockImplementation(() => new Promise(() => {}))
    const result = askPatientQuestion('A', 'Why?')
    const check = expect(result).rejects.toMatchObject({ status: 504, retryable: true })
    await vi.advanceTimersByTimeAsync(CLINICAL_REQUEST_TIMEOUT_MS)
    await check
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates cancellation without turning it into a visible service error', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const result = askPatientQuestion('A', 'Why?', controller.signal)
    const check = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort()
    await check
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('does not request an answer if cancellation occurs during authentication', async () => {
    let resolveSession: (value: typeof session) => void = () => {}
    vi.mocked(fetchAuthSession).mockImplementation(() => new Promise((resolve) => { resolveSession = resolve }))
    const controller = new AbortController()
    const result = askPatientQuestion('A', 'Why?', controller.signal)
    const check = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    resolveSession(session)
    await check
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not authenticate or fetch when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(askPatientQuestion('A', 'Why?', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchAuthSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
