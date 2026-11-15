import { createAuthClient } from '@neon/neon-js/auth';

const ready = (async () => {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Auth configuration unavailable');
  const config = await response.json();
  if (!config.neonAuthUrl) throw new Error('Auth configuration unavailable');

  const client = createAuthClient(config.neonAuthUrl);
  return {
    async getSession() {
      const { data, error } = await client.getSession();
      if (error) throw error;
      const user = data?.user || data?.session?.user || null;
      const accessToken = data?.session?.access_token || null;
      return user && accessToken ? { user, accessToken } : null;
    },
    signIn: credentials => client.signIn.email(credentials),
    signUp: credentials => client.signUp.email(credentials),
    signOut: () => client.signOut()
  };
})();

window.sbAuthReady = ready;
ready.then(async auth => {
  try {
    const session = await auth.getSession();
    window.dispatchEvent(new CustomEvent('sb-auth-state', { detail: { user: session?.user || null } }));
  } catch {
    window.dispatchEvent(new CustomEvent('sb-auth-state', { detail: { user: null, unavailable: true } }));
  }
}).catch(() => {
  window.dispatchEvent(new CustomEvent('sb-auth-state', { detail: { user: null, unavailable: true } }));
});
