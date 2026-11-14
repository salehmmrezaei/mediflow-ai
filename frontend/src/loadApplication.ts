import type { ComponentType } from 'react'

/** Choose the public bundle before evaluating any doctor authentication code. */
export async function loadApplication(pathname: string): Promise<ComponentType> {
  if (pathname === '/demo' || pathname === '/demo/') {
    return (await import('./demo/DemoWorkspace')).default
  }

  // Preserve the existing doctor initialization order, including OAuth callbacks.
  const { configurationError, restoreDoctorSession } = await import('./auth')
  await import('aws-amplify/auth/enable-oauth-listener')
  const { default: App } = await import('./App')
  if (!configurationError) void restoreDoctorSession()
  return App
}
