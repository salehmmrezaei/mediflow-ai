import { Amplify } from 'aws-amplify'
import { getCurrentUser, type AuthUser } from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'

const environment = {
  VITE_USER_POOL_ID: import.meta.env.VITE_USER_POOL_ID,
  VITE_CLIENT_ID: import.meta.env.VITE_CLIENT_ID,
  VITE_COGNITO_DOMAIN: import.meta.env.VITE_COGNITO_DOMAIN,
  VITE_API_URL: import.meta.env.VITE_API_URL,
}

const missing = Object.entries(environment)
  .filter(([, value]) => !value?.trim())
  .map(([name]) => name)

export const configurationError = missing.length
  ? `Set ${missing.join(', ')} in frontend/.env.local, then restart the dev server.`
  : null

type DoctorSession =
  | { status: 'checking' }
  | { status: 'signedOut'; error?: string }
  | { status: 'signedIn'; user: AuthUser }

let session: DoctorSession = { status: 'checking' }
let revision = 0
const subscribers = new Set<() => void>()

export function getDoctorSession(): DoctorSession {
  return session
}

export function subscribeToDoctorSession(subscriber: () => void) {
  subscribers.add(subscriber)
  return () => { subscribers.delete(subscriber) }
}

function updateSession(nextSession: DoctorSession) {
  session = nextSession
  subscribers.forEach((subscriber) => subscriber())
}

export async function restoreDoctorSession() {
  const currentRevision = ++revision
  try {
    const user = await getCurrentUser()
    if (currentRevision === revision) updateSession({ status: 'signedIn', user })
  } catch (error) {
    if (currentRevision !== revision) return
    const isSignedOut = error instanceof Error && error.name === 'UserUnAuthenticatedException'
    updateSession({
      status: 'signedOut',
      error: isSignedOut ? undefined : 'Your session could not be restored. Please sign in again.',
    })
  }
}

// Listen before configuring Amplify so even an early OAuth callback failure is
// retained until React subscribes. A slow session check cannot undo sign-out.
const stopListening = Hub.listen('auth', ({ payload }) => {
  switch (payload.event) {
    case 'signedIn':
    case 'signInWithRedirect':
      void restoreDoctorSession()
      break
    case 'signedOut':
      revision += 1
      updateSession({ status: 'signedOut' })
      break
    case 'signInWithRedirect_failure':
      revision += 1
      updateSession({ status: 'signedOut', error: 'Sign in could not be completed. Please try again.' })
      break
    case 'tokenRefresh_failure': {
      const name = payload.data.error?.name
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
        revision += 1
        updateSession({ status: 'signedOut', error: 'Your session has expired. Please sign in again.' })
      }
      break
    }
  }
})

if (!configurationError) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: environment.VITE_USER_POOL_ID,
        userPoolClientId: environment.VITE_CLIENT_ID,
        loginWith: {
          oauth: {
            domain: environment.VITE_COGNITO_DOMAIN,
            scopes: ['openid'],
            redirectSignIn: ['http://localhost:5173/'],
            redirectSignOut: ['http://localhost:5173/'],
            responseType: 'code',
          },
        },
      },
    },
  })
}

if (import.meta.hot) import.meta.hot.dispose(stopListening)
