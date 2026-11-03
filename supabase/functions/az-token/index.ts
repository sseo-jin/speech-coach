// Edge function: hands a logged-in user a 10-minute Azure Speech token,
// so the Azure key stays in Supabase secrets and never reaches the browser.
// Secrets: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION. Only logged-in users get a token.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // ask Supabase Auth who is calling; the publishable key alone (logged out) is refused
  const who = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: req.headers.get('apikey') ?? '' },
  });
  if (!who.ok) return Response.json({ error: 'Log in to use the pronunciation check' }, { status: 401, headers: cors });
  const key = Deno.env.get('AZURE_SPEECH_KEY'), region = Deno.env.get('AZURE_SPEECH_REGION');
  if (!key || !region) return Response.json({ error: 'Azure key is not set in Supabase secrets' }, { status: 500, headers: cors });
  const r = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (!r.ok) return Response.json({ error: `Azure token request failed (${r.status})` }, { status: 502, headers: cors });
  return Response.json({ token: await r.text(), region }, { headers: cors });
});
