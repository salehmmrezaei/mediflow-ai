import { fetchAuthSession } from 'aws-amplify/auth'

export const SECTION_NAMES = [
  'admission_reason', 'hospital_course', 'investigations', 'discharge_diagnosis',
  'discharge_medications', 'discharge_date', 'follow_up',
] as const
export type SectionName = typeof SECTION_NAMES[number]
export const SECTION_LABELS: Record<SectionName, string> = {
  admission_reason: 'Admission reason',
  hospital_course: 'Hospital course',
  investigations: 'Investigations',
  discharge_diagnosis: 'Discharge diagnosis',
  discharge_medications: 'Discharge medications',
  discharge_date: 'Discharge date',
  follow_up: 'Follow-up',
}
export const MISSING_TEXT = 'Not documented in the supplied notes.'
export const MAX_SECTION_LENGTH = 2000
export const MAX_REVIEW_NOTE_LENGTH = 1000
export const DISCHARGE_REQUEST_TIMEOUT_MS = 35_000

export type DischargeStatus = 'QUEUED' | 'PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED'
export interface DraftSection {
  text: string
  documented: boolean
  supporting_note_ids: string[]
}
export type DischargeDraft = Record<SectionName, DraftSection>
export interface DischargeJob {
  job_id: string
  patient_id: string
  status: DischargeStatus
  created_at: string
  updated_at: string
}
export interface DischargeDraftResponse {
  job_id: string
  patient_id: string
  status: DischargeStatus
  updated_at: string
  document_state: 'UNSIGNED_DRAFT' | 'REVIEW_APPROVED_UNSIGNED' | 'REJECTED_DRAFT'
  draft: DischargeDraft
  missing_sections: SectionName[]
  supporting_note_ids: string[]
  review_note: string
}
export interface EditDraftRequest {
  expected_updated_at: string
  draft: DischargeDraft
}
export interface ReviewDecisionRequest {
  action: 'APPROVE' | 'REJECT'
  expected_updated_at: string
  note: string
  acknowledge_missing_sections: boolean
}

export class DischargeLetterError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(message: string, retryable = false, status?: number) {
    super(message)
    this.name = 'DischargeLetterError'
    this.status = status
    this.retryable = retryable
  }
}

const expiredSession = () => new DischargeLetterError(
  'Your session has expired. Please sign out and sign in again.', false, 401,
)
const invalidResponse = () => new DischargeLetterError(
  'The discharge service returned an invalid response. Please retry the same request.', true, 502,
)
const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)
const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const isStatus = (value: unknown): value is DischargeStatus => (
  typeof value === 'string' && ['QUEUED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'FAILED'].includes(value)
)
const isSectionName = (value: unknown): value is SectionName => SECTION_NAMES.includes(value as SectionName)

function isJob(value: unknown): value is DischargeJob {
  return isRecord(value) && isString(value.job_id) && isString(value.patient_id)
    && isStatus(value.status) && isString(value.created_at) && isString(value.updated_at)
}

function isDraft(value: unknown): value is DischargeDraft {
  return isRecord(value) && Object.keys(value).length === SECTION_NAMES.length && SECTION_NAMES.every((name) => {
    const section = value[name]
    return isRecord(section) && Object.keys(section).length === 3
      && typeof section.text === 'string' && section.text.trim().length > 0
      && typeof section.documented === 'boolean' && isStringList(section.supporting_note_ids)
      && (section.documented
        ? section.supporting_note_ids.length > 0 && section.text.trim() !== MISSING_TEXT
        : section.text.trim() === MISSING_TEXT && section.supporting_note_ids.length === 0)
  })
}

function isDraftResponse(value: unknown): value is DischargeDraftResponse {
  if (!isRecord(value) || !isString(value.job_id) || !isString(value.patient_id)
    || !isStatus(value.status) || !isString(value.updated_at) || !isDraft(value.draft)
    || !['UNSIGNED_DRAFT', 'REVIEW_APPROVED_UNSIGNED', 'REJECTED_DRAFT'].includes(value.document_state as string)
    || !Array.isArray(value.missing_sections) || !value.missing_sections.every(isSectionName)
    || !isStringList(value.supporting_note_ids) || typeof value.review_note !== 'string') return false
  const draft = value.draft
  const missing = value.missing_sections
  return SECTION_NAMES.every((name) => missing.includes(name) === !draft[name].documented)
}

/** Matches the edit repository's rules; note membership is checked by the backend. */
export function validateDischargeDraft(draft: DischargeDraft): string | null {
  if (!isDraft(draft)) return 'Each section must preserve its documented status and evidence references. Missing sections must retain the supplied missing-information text.'
  for (const name of SECTION_NAMES) {
    const section = draft[name]
    if (Array.from(section.text).length > MAX_SECTION_LENGTH) return `${SECTION_LABELS[name]} must contain at most ${MAX_SECTION_LENGTH} characters.`
    if (section.supporting_note_ids.length > 20) return `${SECTION_LABELS[name]} may contain at most 20 evidence references.`
  }
  return null
}

/** Use once per intentional generation and retain it through uncertain retries. */
export function createIdempotencyKey(): string {
  return crypto.randomUUID()
}

// Only translate known backend validation messages. Never reflect arbitrary
// server bodies, exception details, submitted clinical text, or token contents.
function validationMessage(body: unknown): string {
  const fallback = 'The discharge request did not pass validation. Check section text, evidence references, and review fields.'
  if (!isRecord(body)) return fallback
  if (typeof body.detail === 'string') {
    const known: Record<string, string> = {
      'Invalid Idempotency-Key. Expected UUIDv4.': 'The generation request needs a valid UUIDv4 idempotency key.',
      'A rejection reason is required': 'A rejection reason is required.',
      'Acknowledge missing sections before approval': 'Acknowledge the missing sections before approval.',
      'Invalid review action': 'Select approve or reject for the review decision.',
    }
    if (known[body.detail]) return known[body.detail]
    const match = /^(Section is too long|Too many evidence references|Invalid evidence in section|Invalid missing section): ([a-z_]+)$/.exec(body.detail)
    if (match && isSectionName(match[2])) {
      const label = SECTION_LABELS[match[2]]
      switch (match[1]) {
        case 'Section is too long': return `${label} must contain at most ${MAX_SECTION_LENGTH} characters.`
        case 'Too many evidence references': return `${label} may contain at most 20 evidence references.`
        case 'Invalid evidence in section': return `${label} needs valid supporting note references and documented text.`
        default: return `${label} must retain the missing-information text and have no supporting references.`
      }
    }
  }
  if (Array.isArray(body.detail)) {
    const locations = body.detail.flatMap((entry) => isRecord(entry) && Array.isArray(entry.loc) ? entry.loc : [])
    if (locations.includes('note')) return `The review note must contain at most ${MAX_REVIEW_NOTE_LENGTH} characters.`
    if (locations.includes('expected_updated_at')) return 'Reload the latest draft before saving or reviewing it.'
    const name = locations.find(isSectionName)
    if (name) return `${SECTION_LABELS[name]} did not pass validation. Check its text and evidence references.`
  }
  return fallback
}

async function responseError(response: Response): Promise<DischargeLetterError> {
  switch (response.status) {
    case 401: return expiredSession()
    case 403: return new DischargeLetterError('Access denied. Your account does not have access to this discharge job.', false, 403)
    case 404: return new DischargeLetterError('This discharge job is unavailable or inaccessible. Refresh your patient list.', false, 404)
    case 409: return new DischargeLetterError('The draft or job changed. Reload the latest data before continuing.', false, 409)
    case 422: {
      let body: unknown
      try { body = await response.json() } catch { /* A safe generic validation message follows. */ }
      return new DischargeLetterError(validationMessage(body), false, 422)
    }
    case 429:
    case 503: return new DischargeLetterError('The discharge service is temporarily unavailable. Please retry shortly.', true, response.status)
    case 504: return new DischargeLetterError('The discharge request took too long. Please retry the same request.', true, 504)
    default: return new DischargeLetterError('The discharge request could not be completed. Please try again.', response.status >= 500, response.status)
  }
}

// Uses the existing Amplify access-token session and VITE_API_URL convention.
// Nothing is persisted in browser storage; callers own job state and retry keys.
async function dischargeRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string },
  guard: (value: unknown) => value is T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, DISCHARGE_REQUEST_TIMEOUT_MS)
  let rejectOnAbort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(new DOMException('Request cancelled.', 'AbortError'))
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  async function execute(): Promise<T> {
    let session
    try { session = await fetchAuthSession() } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (['UserUnAuthenticatedException', 'NotAuthorizedException', 'UserNotFoundException'].includes(name)) throw expiredSession()
      throw new DischargeLetterError('Your session could not be checked. Please try again.', true)
    }
    controller.signal.throwIfAborted()
    const token = session.tokens?.accessToken
    if (!token) throw expiredSession()
    const baseUrl = import.meta.env.VITE_API_URL?.replace(/\/+$/, '')
    if (!baseUrl) throw new DischargeLetterError('The discharge API is not configured.')
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token.toString()}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw await responseError(response)
    let result: unknown
    try { result = await response.json() } catch { throw invalidResponse() }
    if (!guard(result)) throw invalidResponse()
    return result
  }
  try {
    return await Promise.race([execute(), interrupted])
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError')
    if (timedOut) throw new DischargeLetterError('The discharge request took too long. Please retry the same request.', true, 504)
    if (error instanceof DischargeLetterError) throw error
    throw new DischargeLetterError('Unable to reach the discharge service. Check your connection and retry the same request.', true)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', rejectOnAbort)
  }
}

export async function createDischargeJob(patientId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DischargeJob> {
  if (!patientId.trim()) throw new DischargeLetterError('Select a patient before generating a discharge letter.')
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(idempotencyKey)) {
    throw new DischargeLetterError('The generation request needs a valid UUIDv4 idempotency key.', false, 422)
  }
  const job = await dischargeRequest(`/patients/${encodeURIComponent(patientId)}/discharge-letters`, {
    method: 'POST', idempotencyKey,
  }, isJob, signal)
  if (job.patient_id !== patientId) throw invalidResponse()
  return job
}

export async function getDischargeJob(jobId: string, signal?: AbortSignal): Promise<DischargeJob> {
  const job = await dischargeRequest(`/discharge-jobs/${encodeURIComponent(jobId)}`, {}, isJob, signal)
  if (job.job_id !== jobId) throw invalidResponse()
  return job
}

export async function getDischargeDraft(jobId: string, signal?: AbortSignal): Promise<DischargeDraftResponse> {
  const draft = await dischargeRequest(`/discharge-jobs/${encodeURIComponent(jobId)}/draft`, {}, isDraftResponse, signal)
  if (draft.job_id !== jobId) throw invalidResponse()
  return draft
}

export async function saveDischargeDraft(jobId: string, payload: EditDraftRequest, signal?: AbortSignal): Promise<DischargeDraftResponse> {
  const problem = validateDischargeDraft(payload.draft)
  if (problem) throw new DischargeLetterError(problem, false, 422)
  const draft = await dischargeRequest(`/discharge-jobs/${encodeURIComponent(jobId)}/draft`, {
    method: 'PUT', body: payload,
  }, isDraftResponse, signal)
  if (draft.job_id !== jobId) throw invalidResponse()
  return draft
}

export async function reviewDischargeDraft(jobId: string, payload: ReviewDecisionRequest, signal?: AbortSignal): Promise<DischargeDraftResponse> {
  if (Array.from(payload.note).length > MAX_REVIEW_NOTE_LENGTH) throw new DischargeLetterError(`The review note must contain at most ${MAX_REVIEW_NOTE_LENGTH} characters.`, false, 422)
  if (payload.action === 'REJECT' && !payload.note.trim()) throw new DischargeLetterError('A rejection reason is required.', false, 422)
  const draft = await dischargeRequest(`/discharge-jobs/${encodeURIComponent(jobId)}/review`, {
    method: 'POST', body: payload,
  }, isDraftResponse, signal)
  if (draft.job_id !== jobId) throw invalidResponse()
  return draft
}
