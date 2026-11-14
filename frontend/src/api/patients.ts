import { fetchAuthSession } from 'aws-amplify/auth'

// Matches the existing FastAPI Patient response, including nested Diagnosis.
export interface Patient {
  patient_id: string
  first_name: string
  last_name: string
  age: number
  diagnosis: { diagnosis: string }
  admission_date: string
  status: 'scheduled' | 'admitted' | 'discharged'
}

export async function getPatients(signal?: AbortSignal): Promise<Patient[]> {
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken
  if (!token) throw new Error('Your session has expired. Please sign in again.')

  const response = await fetch(
    `${import.meta.env.VITE_API_URL.replace(/\/+$/, '')}/patients`,
    {
      headers: { Authorization: `Bearer ${token.toString()}` },
      signal,
      cache: 'no-store',
    },
  )

  if (!response.ok) {
    if (response.status === 401) throw new Error('Your session has expired. Please sign in again.')
    if (response.status === 403) throw new Error('Your account does not have access to these patients.')
    throw new Error(`Failed to fetch patients: ${response.status}. Please try again.`)
  }

  return response.json()
}
