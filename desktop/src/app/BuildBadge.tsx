/* Which build am I actually running, and against which backend?
 *
 * A packaged desktop app gives no other answer: there is no address bar, and "the one I installed
 * last" stops being true the moment a staging build and a prod build are both on disk. Getting this
 * wrong is expensive — it means running a pipeline that writes to the wrong Supabase project.
 *
 * So the badge is always visible, and it names BOTH halves: the app version and the backend. They
 * are independent (a 3.2.2 build can point at staging), and only the pair identifies a session.
 *
 * The environment label is not a build-time constant on purpose: the desktop app switches
 * environments at runtime, so it is read from the active environment the same way every request is.
 */

import { useEnvironmentStore } from '../store/environmentStore';
import { environmentTone } from './environmentTone';
import css from './BuildBadge.module.css';

const APP_VERSION = __APP_VERSION__;

export function BuildBadge() {
  const { environments, activeEnvId } = useEnvironmentStore();
  const env = environments.find(e => e.id === activeEnvId) ?? null;

  const label = env?.name ?? 'No environment';
  const tone = env ? environmentTone(env.name, env.supabaseUrl) : 'staging';

  return (
    <div
      className={`${css.badge} ${css[tone]}`}
      title={`Sotto ${APP_VERSION} — ${label}${env ? `\n${env.supabaseUrl}` : ''}`}
    >
      <span className={css.env}>{label}</span>
      <span className={css.version}>{APP_VERSION}</span>
    </div>
  );
}
