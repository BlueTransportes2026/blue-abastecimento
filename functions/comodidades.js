// Cloudflare Pages Function — CONSULTA DE COMODIDADES (Google Places API, v1)
//
// Para cada posto enviado, procura o lugar no Google e lê:
//   - 24 horas .......... regularOpeningHours (aberto 24/7)
//   - banheiro .......... restroom
//   - restaurante ....... servesLunch / servesDinner / dineIn / primaryType restaurant
//   - estacionamento .... parkingOptions
//
// Credencial (cadastrar no Cloudflare como secret, nunca no código):
//   GOOGLE_KEY = chave da Places API (New)
//
// POST /comodidades com { token, postos:[{id,nome,cidade,uf,lat,lng}, ...] }
// Devolve { ok, resultados:[{id, com:[...], achou:true/false}], semChave? }

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

  let body = {};
  try { body = await request.json(); } catch {}

  // só quem está logado
  let sess = null;
  if (env.USERS_KV && body.token) {
    const s = await env.USERS_KV.get('sess:' + body.token);
    if (s) { try { sess = JSON.parse(s); } catch {} }
  }
  if (!sess) return json({ error: 'Sessão inválida. Faça login novamente.' }, 401);

  const key = env.GOOGLE_KEY;
  if (!key) return json({ error: 'Chave do Google (GOOGLE_KEY) não configurada no Cloudflare.', semChave: true }, 500);

  const lista = Array.isArray(body.postos) ? body.postos.slice(0, 25) : []; // processa em lotes de até 25
  if (!lista.length) return json({ error: 'Nenhum posto enviado.' }, 400);

  // ---- deriva as comodidades a partir dos detalhes do lugar ----
  function extrair(d) {
    const com = [];
    // 24 horas: algum período sem horário de fechamento, ou texto com "24"
    const oh = d.regularOpeningHours;
    if (oh) {
      const per = oh.periods || [];
      const aberto247 = per.length === 1 && per[0].open && !per[0].close;
      const txt24 = (oh.weekdayDescriptions || []).some(t => /24 ?h|24 horas|00:00.*(24:00|00:00)|aberto 24/i.test(t));
      if (aberto247 || txt24) com.push('h24');
    }
    if (d.restroom === true) com.push('banheiro');
    // estacionamento
    const pk = d.parkingOptions;
    if (pk && (pk.freeParkingLot || pk.paidParkingLot || pk.freeStreetParking || pk.parkingLot)) com.push('patio');
    // restaurante / serve comida no local
    if (d.dineIn === true || d.servesLunch === true || d.servesDinner === true || d.servesBreakfast === true
        || d.primaryType === 'restaurant' || (Array.isArray(d.types) && d.types.includes('restaurant'))) com.push('restaurante');
    return com;
  }

  async function buscarPlaceId(p) {
    // Text Search (New) por nome + cidade/uf; usa viés de localização se houver coordenada
    const b = {
      textQuery: [p.nome, p.cidade, p.uf, 'posto combustível'].filter(Boolean).join(' '),
      languageCode: 'pt-BR', regionCode: 'BR', maxResultCount: 1,
    };
    if (p.lat != null && p.lng != null) {
      b.locationBias = { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 4000 } };
    }
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id',
      },
      body: JSON.stringify(b),
    });
    if (!r.ok) return { erro: r.status, txt: (await r.text()).slice(0, 200) };
    const j = await r.json();
    return { id: j.places && j.places[0] && j.places[0].id };
  }

  async function detalhes(placeId) {
    const campos = [
      'regularOpeningHours', 'restroom', 'parkingOptions',
      'dineIn', 'servesBreakfast', 'servesLunch', 'servesDinner', 'primaryType', 'types',
    ].join(',');
    const r = await fetch('https://places.googleapis.com/v1/places/' + placeId + '?languageCode=pt-BR', {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': campos },
    });
    if (!r.ok) return { erro: r.status };
    return await r.json();
  }

  const resultados = [];
  for (const p of lista) {
    try {
      const busca = await buscarPlaceId(p);
      if (busca.erro) { resultados.push({ id: p.id, achou: false, erro: busca.erro, detalhe: busca.txt }); continue; }
      if (!busca.id) { resultados.push({ id: p.id, achou: false }); continue; }
      const d = await detalhes(busca.id);
      if (d.erro) { resultados.push({ id: p.id, achou: false, erro: d.erro }); continue; }
      resultados.push({ id: p.id, achou: true, com: extrair(d) });
    } catch (e) {
      resultados.push({ id: p.id, achou: false, erro: String(e).slice(0, 120) });
    }
  }

  return json({ ok: true, resultados });
}
