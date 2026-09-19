'use client';
import { useCallback, useSyncExternalStore } from 'react';

function subscribe(callback: () => void) {
  window.addEventListener('guard:storage', callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener('guard:storage', callback);
    window.removeEventListener('storage', callback);
  };
}
export function useSessionValue(key: string) {
  const snapshot = useCallback(() => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);
  const value = useSyncExternalStore(subscribe, snapshot, () => null);
  const set = useCallback(
    (next: string | null) => {
      if (next === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, next);
      window.dispatchEvent(new Event('guard:storage'));
    },
    [key],
  );
  return [value, set] as const;
}
const noSubscribe = () => () => {};
export function useClientReady() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
export function useInvite() {
  return useSyncExternalStore(
    subscribe,
    () => {
      const id = new URLSearchParams(window.location.search).get('trip');
      return id && /^[0-9a-f-]{36}$/.test(id) ? id : '';
    },
    () => '',
  );
}
