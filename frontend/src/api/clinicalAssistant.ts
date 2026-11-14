import { fetchAuthSession } from 'aws-amplify/auth'

export interface ClinicalAnswer {
  answer: string
  supporting_note_ids: string[]
  insufficient_evidence: boolean
}

export const MAX_QUESTION_LENGTH = 500
export const CLINICAL_REQUEST_TIMEOUT_MS = 35_000

export class ClinicalAssistantError extends Error {
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, retryable = false, status?: number) {
    super(message)
    this.name = 'ClinicalAssistantError'
    this.retryable = retryable
    this.status = status
  }
}

const expiredSession = () => new ClinicalAssistantError(
  'Your session has expired. Please sign out and sign in again.', false, 401,
)

const invalidResponse = () => new ClinicalAssistantError(
  'The assistant could not return a valid answer. Please try again.', true, 502,
)

function responseError(status: number): ClinicalAssistantError {
  switch (status) {
    case 401: return expiredSession()
    case 403:
    case 404:
      return new ClinicalAssistantError(
        'This patient is unavailable or you do not have access. Refresh your patient list.', false, status,
      )
    case 422:
      return new ClinicalAssistantError(
        'Enter a question containing 1 to 500 characters and try again.', false, status,
      )
    case 502: return invalidResponse()
    case 429:
    case 503:
      return new ClinicalAssistantError(
        'The clinical assistant is temporarily unavailable. Please try again shortly.', true, status,
      )
    case 504:
      return new ClinicalAssistantError(
        'The clinical assistant took too long to respond. Please try again.', true, status,
      )
    default:
      return new ClinicalAssistantError(
        'The question could not be answered. Please try again later.', status >= 500, status,
      )
  }
}

function isClinicalAnswer(value: unknown): value is ClinicalAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const answer = value as Record<string, unknown>
  return typeof answer.answer === 'string' && answer.answer.trim().length > 0
    && Array.isArray(answer.supporting_note_ids)
    && answer.supporting_note_ids.every((id) => typeof id === 'string' && id.trim().length > 0)
    && typeof answer.insufficient_evidence === 'boolean'
    && (answer.insufficient_evidence || answer.supporting_note_ids.length > 0)
}

/** Uses only Cognito and the existing protected API; no AI credentials enter the browser. */
export async function askPatientQuestion(
  patientId: string,
  question: string,
  signal?: AbortSignal,
): Promise<ClinicalAnswer> {
  if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError')
  if (!patientId.trim()) throw new ClinicalAssistantError('Select a patient before asking a question.')
  const trimmedQuestion = question.trim()
  if (!trimmedQuestion || Array.from(trimmedQuestion).length > MAX_QUESTION_LENGTH) {
    throw responseError(422)
  }

  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CLINICAL_REQUEST_TIMEOUT_MS)
  let rejectOnAbort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(new DOMException('Request cancelled.', 'AbortError'))
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })

  async function requestAnswer(): Promise<ClinicalAnswer> {
    let session
    try {
      session = await fetchAuthSession()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (['UserUnAuthenticatedException', 'NotAuthorizedException', 'UserNotFoundException'].includes(name)) {
        throw expiredSession()
      }
      throw new ClinicalAssistantError('Your session could not be checked. Please try again.', true)
    }
    // Amplify's session request cannot be aborted; never start an API request if
    // the patient changed or the deadline passed while that request was pending.
    controller.signal.throwIfAborted()
    const token = session.tokens?.accessToken
    if (!token) throw expiredSession()

    const baseUrl = import.meta.env.VITE_API_URL?.replace(/\/+$/, '')
    if (!baseUrl) throw new ClinicalAssistantError('The clinical assistant API is not configured.')
    const response = await fetch(`${baseUrl}/patients/${encodeURIComponent(patientId)}/ask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.toString()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: trimmedQuestion }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw responseError(response.status)

    let result: unknown
    try {
      result = await response.json()
    } catch {
      throw invalidResponse()
    }
    if (!isClinicalAnswer(result)) throw invalidResponse()
    return {
      answer: result.answer,
      supporting_note_ids: result.supporting_note_ids,
      insufficient_evidence: result.insufficient_evidence,
    }
  }

  try {
    return await Promise.race([requestAnswer(), interrupted])
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError')
    if (timedOut) throw responseError(504)
    if (error instanceof ClinicalAssistantError) throw error
    throw new ClinicalAssistantError(
      'Unable to reach the clinical assistant. Check your connection and try again.', true,
    )
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', rejectOnAbort)
  }
}
