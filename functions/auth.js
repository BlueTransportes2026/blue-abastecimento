// Cloudflare Pages Function — login/usuários (Blue Transportes)
// Guarda usuários no KV (senhas com hash SHA-256) e sessões por token.
// Precisa de um KV namespace ligado ao projeto com o nome de binding: USERS_KV

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  const json = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const kv = env.USERS_KV;
  if (!kv) return json({ error: 'Banco de usuários (USERS_KV) não configurado.' }, 500);

  let body = {};
  try { body = await request.json(); } catch {}
  const action = body.action;

  const hash = async (s) => {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blueTransp$' + s));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const getUsers = async () => JSON.parse((await kv.get('users')) || '{}');
  const saveUsers = async (u) => kv.put('users', JSON.stringify(u));
  const getSess = async (t) => (t ? await kv.get('sess:' + t) : null);

  const users = await getUsers();

  // ---- sessão / login ----
  if (action === 'login') {
    const u = users[(body.user || '').trim()];
    if (!u || u.hash !== await hash(body.pass || '')) return json({ error: 'Usuário ou senha inválidos.' }, 401);
    const token = crypto.randomUUID();
    await kv.put('sess:' + token, JSON.stringify({ user: (body.user || '').trim(), admin: !!u.admin }), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true, token, user: (body.user || '').trim(), admin: !!u.admin });
  }
  if (action === 'me') {
    const s = await getSess(body.token);
    return s ? json({ ok: true, ...JSON.parse(s) }) : json({ ok: false });
  }
  if (action === 'logout') {
    if (body.token) await kv.delete('sess:' + body.token);
    return json({ ok: true });
  }

  // quem está pedindo (para ações de admin)
  let admin = false, sessUser = null;
  const s = await getSess(body.token);
  if (s) { const sd = JSON.parse(s); admin = !!sd.admin; sessUser = sd.user; }
  const bootstrap = Object.keys(users).length === 0; // sem usuários ainda → primeiro acesso cria admin

  if (action === 'create') {
    if (!bootstrap && !admin) return json({ error: 'Apenas um administrador pode criar usuários.' }, 403);
    const nome = (body.user || '').trim();
    if (!nome || !body.pass) return json({ error: 'Informe usuário e senha.' }, 400);
    if (users[nome]) return json({ error: 'Esse usuário já existe.' }, 409);
    users[nome] = { hash: await hash(body.pass), admin: bootstrap ? true : !!body.admin, criadoEm: new Date().toISOString() };
    await saveUsers(users);
    return json({ ok: true, primeiro: bootstrap });
  }
  if (action === 'list') {
    if (!admin) return json({ error: 'Apenas administrador.' }, 403);
    return json({ ok: true, users: Object.entries(users).map(([n, u]) => ({ user: n, admin: !!u.admin })) });
  }
  if (action === 'delete') {
    if (!admin) return json({ error: 'Apenas administrador.' }, 403);
    if (body.user === sessUser) return json({ error: 'Você não pode excluir a si mesmo.' }, 400);
    if (!users[body.user]) return json({ error: 'Usuário não existe.' }, 404);
    delete users[body.user];
    await saveUsers(users);
    return json({ ok: true });
  }
  if (action === 'resetpass') {
    if (!admin) return json({ error: 'Apenas administrador.' }, 403);
    if (!users[body.user]) return json({ error: 'Usuário não existe.' }, 404);
    if (!body.nova) return json({ error: 'Informe a nova senha.' }, 400);
    users[body.user].hash = await hash(body.nova);
    await saveUsers(users);
    return json({ ok: true });
  }

  return json({ error: 'Ação inválida.' }, 400);
}
