// Cloudflare Pages Function — lê a rota da NOX nos bastidores.
// Endpoint publicado: /nox?u=<link da NOX>
// Ex.: /nox?u=https://www.noxgr.srv.br/noxwebcliente/geo/mapa/here-rotograma/2786052/2786052_ent_13_57_00.html

export async function onRequest(context) {
  const cors = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
  const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

  const target = new URL(context.request.url).searchParams.get('u') || '';

  // Segurança: só aceita links da NOX
  if (!/^https?:\/\/([\w-]+\.)*noxgr\.srv\.br\//i.test(target)) {
    return j({ error: 'O link precisa ser da NOX (noxgr.srv.br).' }, 400);
  }

  let html;
  try {
    const r = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (BlueTransportes)' } });
    if (!r.ok) return j({ error: 'Não consegui abrir o link da NOX (status ' + r.status + ').' }, 502);
    html = await r.text();
  } catch (e) {
    return j({ error: 'Falha ao acessar o link da NOX.' }, 502);
  }

  // A página embute a rota num link do Google Maps: .../maps/dir/lat,lng/lat,lng/...
  const m = html.match(/google\.[^\/]*\/maps\/dir\/([^"'\s\\<>]+)/i);
  if (!m) return j({ error: 'Não encontrei a rota (link do Google Maps) dentro da página.' }, 404);

  let seg = m[1].split('/@')[0].split('/data=')[0];
  const pontos = [...seg.matchAll(/(-?\d+\.\d+),(-?\d+\.\d+)/g)].map(x => ({ lat: +x[1], lng: +x[2] }));

  if (pontos.length < 2) return j({ error: 'Encontrei a rota, mas com pontos insuficientes.' }, 422);

  const t = html.match(/<title>([^<]*)<\/title>/i);
  const titulo = t ? t[1].replace(/\s+/g, ' ').trim() : '';

  return j({ pontos, titulo });
}
