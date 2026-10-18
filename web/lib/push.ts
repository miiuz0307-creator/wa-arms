'use client';
import { sb } from './supabase';

// Public key of the system's push sender (the private half is a secret of the push-send function).
const VAPID_PUBLIC = 'BDhmvgJU98_EamDif50YjVqK-4dXVLRsgb4kanYjTEoDvdVAgLW5Plpm9aJZwMEAnrVWNESHgNH42XaZoB4NhtI';

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'ios-install';

const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushState(): Promise<PushState> {
  if (typeof window === 'undefined') return 'unsupported';
  // iPhone: notifications work only from the app added to the home screen
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ask the phone for permission and register it. Must be called from a tap. */
export async function enablePush(): Promise<PushState> {
  const st = await pushState();
  if (st === 'unsupported' || st === 'ios-install' || st === 'denied') return st;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) }));
  const j = sub.toJSON() as any;
  const { error } = await sb().rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_ua: navigator.userAgent });
  if (error) throw error;
  return 'on';
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await sb().rpc('push_unsubscribe', { p_endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}
