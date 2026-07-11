import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../../store/authStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { makeEnvironment, saveEnvironments } from '../../services/environmentService';
import {
  initAuthClient, checkEmail, sendMagicLink,
  waitForMagicLink, loadProfile, signOut, DESKTOP_ROLES,
} from '../../services/authService';
import css from './LoginView.module.css';

type Step = 'email' | 'checking' | 'waiting' | 'server';

/** Full-screen gate shown until a staff (editor/admin) session exists.
 * Magic-link only: email → staff pre-check → OTP mail → the user clicks the
 * link in their browser → loopback callback completes the PKCE exchange. */
export function LoginView() {
  const { status, server, setServer, setStatus, setProfile } = useAuthStore();
  const [step, setStep]   = useState<Step>(server ? 'email' : 'server');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const [serverUrl, setServerUrl]   = useState(server?.url ?? '');
  const [serverKey, setServerKey]   = useState(server?.anonKey ?? '');

  async function handleServerSave(e: FormEvent) {
    e.preventDefault();
    const url = serverUrl.trim().replace(/\/+$/, '');
    const anonKey = serverKey.trim();
    if (!url || !anonKey) return;

    // The server config IS an environment: update the active one, or create
    // the first. Multiple environments are managed in Settings once signed in.
    const { environments, activeEnvId, setEnvironments, setActiveEnvId } = useEnvironmentStore.getState();
    let list = environments;
    let envId = activeEnvId;
    const active = environments.find(e2 => e2.id === activeEnvId);
    if (active) {
      list = environments.map(e2 => e2.id === active.id ? { ...e2, supabaseUrl: url, anonKey } : e2);
    } else {
      const env = makeEnvironment({
        name: url.includes('localhost') || url.includes('127.0.0.1') ? 'Local' : 'Production',
        supabaseUrl: url,
        anonKey,
      });
      list = [...environments, env];
      envId = env.id;
    }
    await saveEnvironments({ activeId: envId, list });
    setEnvironments(list);
    setActiveEnvId(envId);

    const config = { url, anonKey };
    initAuthClient(config);
    setServer(config);
    setStatus('signedOut');
    setError('');
    setStep('email');
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setError('');
    setStep('checking');
    try {
      const type = await checkEmail(trimmed);
      if (type !== 'staff') {
        setError('The desktop app is restricted to DC Hub staff (editor/admin).');
        setStep('email');
        return;
      }
      await sendMagicLink(trimmed);
      setStep('waiting');
      const session = await waitForMagicLink();
      if (!session) throw new Error('Sign-in did not complete.');
      const profile = await loadProfile();
      if (!DESKTOP_ROLES.includes(profile.role)) {
        await signOut();
        setError(`Role "${profile.role}" cannot operate the desktop app.`);
        setStep('email');
        setStatus('signedOut');
        return;
      }
      setProfile(profile);
      setStatus('signedIn');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setStep('email');
    }
  }

  return (
    <div className={css.screen}>
      <form
        className={css.card}
        onSubmit={step === 'server' ? handleServerSave : handleEmailSubmit}
      >
        <h1 className={css.brand}>DC Hub</h1>

        {step === 'server' ? (
          <>
            <p className={css.sub}>
              Connect this app to your DC Hub server. Both values come from your
              administrator (or `supabase status` for the local stack).
            </p>
            <label className={css.label}>Server URL</label>
            <input
              className={css.input}
              placeholder="https://your-project.supabase.co"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
            />
            <label className={css.label}>Anon key</label>
            <input
              className={css.input}
              placeholder="eyJhbGciOi…"
              value={serverKey}
              onChange={e => setServerKey(e.target.value)}
            />
            <button className={css.button} type="submit" disabled={!serverUrl.trim() || !serverKey.trim()}>
              Save & continue
            </button>
          </>
        ) : step === 'waiting' ? (
          <>
            <p className={css.sub}>
              We sent a sign-in link to <strong>{email.trim()}</strong>.
              Open it in your browser — this window will unlock automatically.
            </p>
            <div className={css.waiting}>
              <div className={css.spinner} />
              Waiting for you to click the link…
            </div>
            <button type="button" className={css.linkButton} onClick={() => { setStep('email'); setError(''); }}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <p className={css.sub}>
              Sign in to operate the pipeline. {status === 'denied'
                ? 'Your previous session was not authorized.'
                : 'Staff access only.'}
            </p>
            <label className={css.label}>Email</label>
            <input
              className={css.input}
              type="email"
              placeholder="you@disruptcollective.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoFocus
            />
            {error && <p className={css.error}>{error}</p>}
            <button className={css.button} type="submit" disabled={step === 'checking' || !email.trim()}>
              {step === 'checking' ? 'Checking…' : 'Send sign-in link'}
            </button>
            <button type="button" className={css.linkButton} onClick={() => setStep('server')}>
              Configure server
            </button>
          </>
        )}
      </form>
    </div>
  );
}
