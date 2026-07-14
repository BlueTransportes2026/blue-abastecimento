// Cloudflare Pages Function — POSTOS COMPARTILHADOS (banco na nuvem via KV)
// Guarda a lista de postos de toda a equipe. Todas as edições ficam salvas
// para todos, e não somem ao recarregar.
//
// Precisa de um KV namespace ligado ao projeto com o binding: POSTOS_KV
// Usa também o USERS_KV (do login) para validar a sessão de quem escreve.
//
// Tudo via POST /postos com { action, token, ... }:
//   action:'list'                      -> devolve a lista (e se já foi semeada)
//   action:'seed'   { postos:[...] }   -> semeia a lista SÓ se estiver vazia
//   action:'save'   { postos:[...] }   -> substitui a lista inteira (importações)
//   action:'upsert' { posto:{...} }    -> cria/atualiza um posto pelo id
//   action:'delete' { id }             -> remove um posto pelo id

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

  const kv = env.POSTOS_KV;
  if (!kv) return json({ error: 'Banco de postos (POSTOS_KV) não configurado.' }, 500);

  let body = {};
  try { body = await request.json(); } catch {}
  const action = body.action;

  // ---- valida a sessão usando o mesmo banco de usuários do login ----
  let sess = null;
  if (env.USERS_KV && body.token) {
    const s = await env.USERS_KV.get('sess:' + body.token);
    if (s) { try { sess = JSON.parse(s); } catch {} }
  }
  if (!sess) return json({ error: 'Sessão inválida. Faça login novamente.' }, 401);

  const getList = async () => {
    const v = await kv.get('postos');
    if (v == null) return null;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
  };
  const putList = async (arr) => {
    await kv.put('postos', JSON.stringify(arr));
    await kv.put('postos_updated', String(Date.now()));
    await kv.put('postos_by', sess.user || '');
  };
  const meta = async () => ({
    updatedAt: Number(await kv.get('postos_updated')) || 0,
    updatedBy: (await kv.get('postos_by')) || '',
  });

  if (action === 'list') {
    const arr = await getList();
    return json({ ok: true, postos: arr || [], seeded: arr != null, ...(await meta()) });
  }

  if (action === 'seed') {
    const atual = await getList();
    if (atual != null && atual.length) return json({ ok: true, postos: atual, seeded: true, already: true });
    const arr = Array.isArray(body.postos) ? body.postos : [];
    await putList(arr);
    return json({ ok: true, postos: arr, seeded: true, ...(await meta()) });
  }

  if (action === 'save') {
    const arr = Array.isArray(body.postos) ? body.postos : [];
    await putList(arr);
    return json({ ok: true, n: arr.length, ...(await meta()) });
  }

  if (action === 'upsert') {
    const p = body.posto;
    if (!p || !p.id) return json({ error: 'Posto inválido (sem id).' }, 400);
    const arr = (await getList()) || [];
    const i = arr.findIndex(x => x.id === p.id);
    if (i >= 0) arr[i] = p; else arr.push(p);
    await putList(arr);
    return json({ ok: true, ...(await meta()) });
  }

  if (action === 'delete') {
    if (!body.id) return json({ error: 'id ausente.' }, 400);
    let arr = (await getList()) || [];
    arr = arr.filter(x => x.id !== body.id);
    await putList(arr);
    return json({ ok: true, ...(await meta()) });
  }

  return json({ error: 'Ação inválida.' }, 400);
}
