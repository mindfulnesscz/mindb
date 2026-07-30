/* Shared OAuth plumbing: PKCE and the loopback callback.
 *
 * All three providers use the same desktop flow — open the system browser, let a Rust loopback
 * listener capture the redirect, exchange the code. The verifier never leaves this process, which is
 * why a desktop app can use PKCE without a client secret.
 */

import { invoke } from '@tauri-apps/api/core';

export const REDIRECT_URI = 'http://localhost:7623/callback';
export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');

  const encoded = new TextEncoder().encode(verifier);
  const digest  = await crypto.subtle.digest('SHA-256', encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { verifier, challenge };
}

export async function waitForCallback(): Promise<URLSearchParams> {
  const path   = await invoke<string>('wait_for_oauth_redirect');
  const query  = path.split('?')[1] ?? '';
  return new URLSearchParams(query);
}
