export const supportsPush = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const needsHomeScreen = () => (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !matchMedia('(display-mode: standalone)').matches && !(navigator as Navigator & {standalone?: boolean}).standalone;

export async function pushRegistration() {
 await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
 return await withTimeout(navigator.serviceWorker.ready);
}

export async function withTimeout<T>(promise: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout>;
 try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Браузер не ответил. Проверьте интернет и повторите подключение.')), 20000); })]); }
 finally { clearTimeout(timer!); }
}

export async function clearBrowserPush() {
 if (!('serviceWorker' in navigator)) return;
 const registration = await navigator.serviceWorker.getRegistration('/');
 if (!registration) return;
 const subscription = await registration.pushManager?.getSubscription();
 if (subscription) await withTimeout(subscription.unsubscribe());
 for (const notification of await registration.getNotifications()) notification.close();
}

export function applicationKey(key: string) {
 return Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-key.length%4)%4)), c => c.charCodeAt(0));
}
