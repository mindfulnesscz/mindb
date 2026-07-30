/* The connect/refresh/disconnect state machine for one destination form.
 *
 * The cancel signal lives in a ref so unmounting cancels an in-flight device-code wait: the flow can
 * outlive the screen by minutes, and the operator has no other way to stop it.
 */

import { useEffect, useRef, useState } from 'react';
import type { DestConfig, CloudToken } from '../../domain/client';
import type { DeviceCodeInfo } from '../../services/cloudService';
import { connectDestination, refreshDestinationToken } from './connectDest';

export type AuthPhase = 'idle' | 'connecting' | 'device-code' | 'checking' | 'refreshing' | 'done' | 'error';

export interface DestAuth {
  authPhase:  AuthPhase;
  deviceInfo: DeviceCodeInfo | null;
  authError:  string | null;
  copied:     boolean;
  busy:       boolean;
  connect:    () => Promise<void>;
  refresh:    () => Promise<void>;
  disconnect: () => void;
  copyCode:   () => Promise<void>;
}

export function useDestAuth(
  cfg: DestConfig,
  onToken: (token: CloudToken | null) => void,
  hasToken: boolean,
): DestAuth {
  const [authPhase, setAuthPhase]   = useState<AuthPhase>(() => (hasToken ? 'done' : 'idle'));
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeInfo | null>(null);
  const [authError, setAuthError]   = useState<string | null>(null);
  const [copied, setCopied]         = useState(false);
  const cancelRef = useRef({ cancelled: false });

  useEffect(() => {
    const sig = cancelRef.current;
    return () => { sig.cancelled = true; };
  }, []);

  async function connect() {
    if (cfg.type === 'local') return;
    setAuthPhase('connecting');
    setAuthError(null);
    setDeviceInfo(null);
    cancelRef.current.cancelled = false;

    try {
      const token = await connectDestination(cfg, {
        signal: cancelRef.current,
        onDeviceCode: info => {
          setDeviceInfo(info);
          setAuthPhase('device-code');
        },
      });
      if (!token) return;              // cancelled — leave the form as the operator left it
      onToken(token);
      setAuthPhase('done');
    } catch (e) {
      if (!cancelRef.current.cancelled) {
        setAuthError(String(e).replace(/^Error:\s*/i, ''));
        setAuthPhase('error');
      }
    }
  }

  async function refresh() {
    if (cfg.type === 'local' || !cfg.token) return;
    setAuthPhase('refreshing');
    setAuthError(null);
    try {
      const updates = await refreshDestinationToken(cfg);
      onToken({ ...cfg.token, ...updates });
      setAuthPhase('done');
    } catch (e) {
      setAuthError(String(e).replace(/^Error:\s*/i, ''));
      setAuthPhase('error');
    }
  }

  function disconnect() {
    cancelRef.current.cancelled = true;
    onToken(null);
    setAuthPhase('idle');
    setAuthError(null);
    setDeviceInfo(null);
  }

  async function copyCode() {
    if (!deviceInfo) return;
    await navigator.clipboard.writeText(deviceInfo.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const busy = authPhase === 'connecting' || authPhase === 'device-code'
    || authPhase === 'checking' || authPhase === 'refreshing';

  return { authPhase, deviceInfo, authError, copied, busy, connect, refresh, disconnect, copyCode };
}
