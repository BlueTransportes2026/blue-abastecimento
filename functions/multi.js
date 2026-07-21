// Cloudflare Pages Function — INTEGRAÇÃO COM O MULTITMS (KMM)
//
// A API inteira é protegida por HTTP Basic. O endpoint ObterTokenIntegracao
// pertence ao módulo de Webhook/CadastroUnificado e devolve 500 para qualquer
// formato — então NÃO dependemos dele: tentamos os endpoints de negócio
// direto com Basic e, se houver token, também com Bearer.
//
// Credenciais (cadastrar no Cloudflare como secrets, nunca no código):
//   MULTI_USER, MULTI_PASS  e opcionalmente MULTI_BASE
//
// Ações (POST /multi com { action, token, ... }):
//   'testar'  -> diagnóstico completo de autenticação
//   'cargas'  { dataInicial, dataFinal }
//   'posicao' { placa }

const BASE_PADRAO = 'https://barbieri.multitms.com.br/SGT.WEbService.REST';

function acharToken(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.access_token === 'string' && o.access_token) return o.access_token;
  if (typeof o.accessToken === 'string' && o.accessToken) return o.accessToken;
  for (const k in o) {
    const v = o[k];
    if (v && typeof v === 'object') { const t = acharToken(v); if (t) return t; }
  }
  return null;
}

// procura uma lista de resultados em qualquer formato de envelope
function acharLista(o) {
  if (!o) return [];
  if (Array.isArray(o)) return o;
  for (const k of ['retorno', 'dados', 'data', 'result', 'resultado', 'itens', 'items', 'lista']) {
    if (o[k] != null) { const r = acharLista(o[k]); if (r.length) return r; }
  }
  if (typeof o === 'object') {
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object') { const r = acharLista(v); if (r.length) return r; } }
  }
  return [];
}

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

  // só quem está logado no nosso site
  let sess = null;
  if (env.USERS_KV && body.token) {
    const s = await env.USERS_KV.get('sess:' + body.token);
    if (s) { try { sess = JSON.parse(s); } catch {} }
  }
  if (!sess) return json({ error: 'Sessão inválida. Faça login novamente.' }, 401);

  const user = env.MULTI_USER, pass = env.MULTI_PASS;
  if (!user || !pass) return json({ error: 'Credenciais do Multi não configuradas (MULTI_USER / MULTI_PASS).' }, 500);

  const base = (env.MULTI_BASE || BASE_PADRAO).replace(/\/+$/, '');
  const basic = 'Basic ' + btoa(user + ':' + pass);

  // ---------- token (opcional, não bloqueia) ----------
  async function tentarToken() {
    const url = base + '/CadastroUnificado/ObterTokenIntegracao';
    const form = 'application/x-www-form-urlencoded';
    const e = encodeURIComponent;
    const tries = [
      { ct: form, b: 'usuario=' + e(user) + '&senha=' + e(pass) },
      { ct: form, b: 'grant_type=client_credentials' },
      { ct: null, b: undefined },
    ];
    for (const t of tries) {
      try {
        const h = { 'authorization': basic, 'accept': 'application/json' };
        if (t.ct) h['content-type'] = t.ct;
        const r = await fetch(url, { method: 'POST', headers: h, body: t.b });
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch {}
        const tk = acharToken(j);
        if (tk) return { token: tk, tipo: (j && j.token_type) || 'Bearer' };
      } catch {}
    }
    return null;
  }

  const tk = await tentarToken();

  // estratégias de autenticação, da mais provável para a menos
  const autenticacoes = [];
  autenticacoes.push({ nome: 'Basic direto', h: { 'authorization': basic } });
  if (tk) autenticacoes.push({ nome: 'Bearer (token)', h: { 'authorization': (tk.tipo || 'Bearer') + ' ' + tk.token } });
  autenticacoes.push({ nome: 'Basic + cabeçalhos usuario/senha', h: { 'authorization': basic, 'usuario': user, 'senha': pass } });

  // ---------- chamada com fallback de autenticação e formato ----------
  async function chamar(caminho, corpo) {
    const log = [];
    for (const a of autenticacoes) {
      for (const ct of ['application/json', 'text/json']) {
        let r, txt;
        try {
          r = await fetch(base + caminho, {
            method: 'POST',
            headers: Object.assign({ 'content-type': ct, 'accept': 'application/json' }, a.h),
            body: JSON.stringify(corpo || {}),
          });
          txt = await r.text();
        } catch (err) {
          log.push({ tentativa: a.nome + ' + ' + ct, erro: String(err).slice(0, 120) });
          continue;
        }
        let j = null; try { j = JSON.parse(txt); } catch {}
        log.push({
          tentativa: a.nome + ' + ' + ct,
          status: r.status,
          tipoResposta: (r.headers.get('content-type') || '').split(';')[0],
          resposta: String(txt || '').replace(/\s+/g, ' ').slice(0, 220),
        });
        if (r.ok && j) return { ok: true, json: j, via: a.nome, log };
      }
    }
    return { ok: false, log };
  }

  // ---------- diagnóstico ----------
  if (body.action === 'testar') {
    const r = await chamar('/Cargas/BuscarCargasPorPeriodo', {
      dataCriacaoInicial: body.dataInicial || '2026-07-01',
      dataCriacaoFinal: body.dataFinal || '2026-07-21',
      dataCarregamentoInicial: null, dataCarregamentoFinal: null,
    });
    return json({ ok: r.ok, tokenObtido: !!tk, via: r.via || null, diagnostico: r.log });
  }

  // ---------- viagens ----------
  if (body.action === 'cargas') {
    const di = body.dataInicial, df = body.dataFinal;
    if (!di || !df) return json({ error: 'Informe dataInicial e dataFinal.' }, 400);
    const r = await chamar('/Cargas/BuscarCargasPorPeriodo', {
      dataCriacaoInicial: di, dataCriacaoFinal: df,
      dataCarregamentoInicial: null, dataCarregamentoFinal: null,
    });
    if (!r.ok) return json({ error: 'Não consegui consultar as viagens no Multi.', diagnostico: r.log }, 502);

    const arr = acharLista(r.json);
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? null : n; };
    const endereco = e => e ? {
      cidade: (e.cidade && (e.cidade.nome || e.cidade.descricao)) || (typeof e.cidade === 'string' ? e.cidade : '') || '',
      uf: e.uf || (e.estado && (e.estado.sigla || e.estado.nome)) || '',
      lat: num(e.latitude), lng: num(e.longitude),
      texto: e.enderecoConcatenado || [e.logradouro, e.numero, e.bairro].filter(Boolean).join(', '),
    } : null;

    const viagens = arr.map(c => ({
      protocolo: c.protocoloCarga,
      numero: c.numeroCarga || c.numeroPreCarga || '',
      origem: endereco(c.origem),
      destino: endereco(c.destino),
      placa: (c.veiculo && (c.veiculo.placa || c.veiculo.placaCavalo)) || '',
      motorista: (c.motoristas && c.motoristas[0] && (c.motoristas[0].nome || c.motoristas[0].nomeMotorista)) || '',
      inicio: c.dataInicioCarregamento || c.dataCriacaoCarga || '',
      previsaoEntrega: c.dataPrevisaoEntrega || '',
      distancia: num(c.distancia) || num(c.kmOrigemXDestino),
      refrigerada: !!c.contemCargaRefrigerada,
      temperatura: c.temperatura || '',
      situacao: c.situacaoCarga || '',
    })).filter(v => v.origem && v.destino);

    return json({ ok: true, total: viagens.length, viagens, via: r.via, brutoAmostra: viagens.length ? undefined : JSON.stringify(r.json).slice(0, 500) });
  }

  // ---------- posição do veículo ----------
  if (body.action === 'posicao') {
    const placa = (body.placa || '').trim();
    if (!placa) return json({ error: 'Informe a placa.' }, 400);
    const r = await chamar('/Monitoramento/ConsultaPosicionamentoStatusDispositivo',
      { placa, cpf: body.cpf || '', transporte: body.transporte || '' });
    if (!r.ok) return json({ error: 'Não consegui consultar a posição no Multi.', diagnostico: r.log }, 502);
    return json({ ok: true, via: r.via, bruto: r.json });
  }

  return json({ error: 'Ação inválida.' }, 400);
}
