// Accounts (Supabase email + password) and per-user score history.
// Without a Supabase project in config.js the app works as before: scores stay in this browser.
const cfg = window.SC_CLOUD || {};
const SB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

let sb = null;
export const cloud = { enabled: !!(cfg.url && cfg.anonKey), user: null };

export async function initCloud(onChange) {
  if (!cloud.enabled) return;
  const { createClient } = await import(SB_URL);
  sb = createClient(cfg.url, cfg.anonKey);
  const { data } = await sb.auth.getSession();
  cloud.user = data.session?.user || null;
  sb.auth.onAuthStateChange((_, session) => {
    const was = cloud.user?.id; cloud.user = session?.user || null;
    if (was !== cloud.user?.id) onChange();
  });
}

export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return !!data.session; // false → the project asks for email confirmation first
}
export async function logIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export const logOut = () => sb.auth.signOut();

// history rows → the same shape the chart uses: {t, score, takes, stuck}
export async function listScores(scriptKey) {
  const { data, error } = await sb.from('scores').select('score,takes,stuck,created_at').eq('script_key', scriptKey).order('created_at').limit(30);
  if (error) throw error;
  return data.map(r => ({ t: Date.parse(r.created_at), score: r.score, takes: r.takes, stuck: r.stuck }));
}
export async function addScore(scriptKey, h) {
  const { error } = await sb.from('scores').insert({ script_key: scriptKey, score: h.score, takes: h.takes, stuck: h.stuck });
  if (error) throw error;
}
export async function clearScores(scriptKey) {
  let q = sb.from('scores').delete().eq('user_id', cloud.user.id);
  if (scriptKey) q = q.eq('script_key', scriptKey);
  const { error } = await q;
  if (error) throw error;
}
