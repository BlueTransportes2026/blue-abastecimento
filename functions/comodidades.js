// Cloudflare Pages Function — CONSULTA DE COMODIDADES (OpenStreetMap / Overpass)
//
// Totalmente gratuito, sem chave. Para cada posto (com lat/lng), procura um
// posto de combustível (amenity=fuel) no mapa aberto por perto e lê as etiquetas:
//   - 24 horas ......... opening_hours = 24/7
//   - banheiro ......... toilets = yes/customers
//   - estacionamento ... parking / hgv (pátio para caminhão)
//   - restaurante ...... restaurant / fast_food / cuisine
//   - conveniência ..... shop = convenience
//
// POST /comodidades com { token, postos:[{id,nome,cidade,uf,lat,lng}, ...] }
// Devolve { ok, resultados:[{id, achou, com:[...]}] }
//
// Cobertura depende do que a comunidade mapeou — para postos pequenos costuma
// vir vazio. O que faltar, a equipe completa na ficha.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

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

  const lista = (Array.isArray(body.postos) ? body.postos : []).filter(p => p.lat != null && p.lng != null).slice(0, 12);
  if (!lista.length) return json({ ok: true, resultados: [] });

  // uma única consulta com um "around" por posto
  const partes = lista.map(p => `nwr(around:300,${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)})[amenity=fuel];`).join('');
  const q = `[out:json][timeout:60];(${partes});out tags center;`;

  let elementos = null, ultimoErro = '';
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'BlueTransportesRoteirizador/1.0 (roteirizador de abastecimento interno)',
          'accept': 'application/json',
        },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!r.ok) { ultimoErro = 'HTTP ' + r.status; continue; }
      const j = await r.json();
      elementos = j.elements || [];
      break;
    } catch (e) { ultimoErro = String(e).slice(0, 120); }
  }
  if (elementos == null) return json({ error: 'Não consegui consultar o mapa aberto agora. Tente de novo em instantes.', detalhe: ultimoErro }, 502);

  const kx = lat => 111320 * Math.cos(lat * Math.PI / 180), ky = 110570;
  function dist(aLat, aLng, bLat, bLng) {
    const dx = (aLng - bLng) * kx((aLat + bLat) / 2), dy = (aLat - bLat) * ky;
    return Math.sqrt(dx * dx + dy * dy); // metros
  }
  function derivar(t) {
    if (!t) return [];
    const com = [];
    const oh = (t.opening_hours || '').toLowerCase();
    if (oh.includes('24/7')) com.push('h24');
    if (t.toilets === 'yes' || t.toilets === 'customers' || t['toilets:access'] === 'yes' || t['toilets:access'] === 'customers') com.push('banheiro');
    if (t.shop === 'convenience' || t.shop === 'kiosk') com.push('conveniencia');
    if (t.restaurant === 'yes' || t.amenity === 'restaurant' || t.fast_food === 'yes' || t.cuisine) com.push('restaurante');
    if (t.parking || t.hgv === 'yes' || t['hgv:parking'] === 'yes' || t['parking:hgv']) com.push('estacionamento');
    return com;
  }

  // para cada posto, pega o elemento de combustível mais próximo (até 350 m)
  const resultados = lista.map(p => {
    let melhor = null, md = 351;
    for (const el of elementos) {
      const elat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const elng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (elat == null) continue;
      const d = dist(+p.lat, +p.lng, elat, elng);
      if (d < md) { md = d; melhor = el; }
    }
    if (!melhor) return { id: p.id, achou: false };
    return { id: p.id, achou: true, com: derivar(melhor.tags) };
  });

  return json({ ok: true, resultados });
}
