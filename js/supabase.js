import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://dpixehhdbtzsbckfektd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRwaXhlaGhkYnR6c2Jja2Zla3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNDI0MjcsImV4cCI6MjA3NjcxODQyN30.nR1KCSRQj1E_evQWnE2VaZzg7PgLp2kqt4eDKP2PkpE';

function buildSessionStorageAdapter() {
  const memory = new Map();
  const hasSessionStorage = () => typeof window !== 'undefined' && !!window.sessionStorage;

  return {
    getItem(key) {
      try {
        if (hasSessionStorage()) return window.sessionStorage.getItem(key);
      } catch {}
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      try {
        if (hasSessionStorage()) {
          window.sessionStorage.setItem(key, value);
          return;
        }
      } catch {}
      memory.set(key, value);
    },
    removeItem(key) {
      try {
        if (hasSessionStorage()) {
          window.sessionStorage.removeItem(key);
          return;
        }
      } catch {}
      memory.delete(key);
    },
  };
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    storage: buildSessionStorageAdapter(),
  },
});

export function getSupabaseClient() {
  return supabase;
}
