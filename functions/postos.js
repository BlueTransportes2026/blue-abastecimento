// Cloudflare Pages Function — postos compartilhados (banco na nuvem via KV)
// Endpoints:
//   GET  /postos  -> devolve a lista (JSON)
//   PUT  /postos  -> salva a lista (corpo = JSON com array de postos)
// Precisa de um KV namespace ligado ao projeto com o nome de binding: POSTOS_KV

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const kv = env.POSTOS_KV;
  if (!kv) return new Response(JSON.stringify({ error: 'KV (POSTOS_KV) não configurado.' }), { status: 500, headers: cors });

  if (request.method === 'GET') {
    const data = await kv.get('lista');
    return new Response(data || '[]', { headers: cors });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    try {
      const arr = JSON.parse(body);
      if (!Array.isArray(arr)) throw 0;
    } catch {
      return new Response(JSON.stringify({ error: 'Corpo precisa ser um array JSON.' }), { status: 400, headers: cors });
    }
    await kv.put('lista', body);
    return new Response(JSON.stringify({ ok: true }), { headers: cors });
  }

  return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers: cors });
}
