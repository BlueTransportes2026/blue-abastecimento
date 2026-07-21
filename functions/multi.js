// Cloudflare Pages Function — INTEGRAÇÃO COM O MULTITMS (KMM)
//
// Fluxo de autenticação:
//   1) POST /CadastroUnificado/ObterTokenIntegracao com HTTP Basic (usuário/senha da API)
//      -> devolve { token_type, access_token, expires_in }
//   2) Demais chamadas usam Authorization: Bearer <access_token>
//
// As credenciais NUNCA ficam no código. Cadastre no Cloudflare como secrets:
//   MULTI_USER  = usuário da API
//   MULTI_PASS  = senha da API
//   MULTI_BASE  = (opcional) https://barbieri.multitms.com.br/SGT.WEbService.REST
//
// Ações (POST /multi com { action, token, ... }):
//   'testar'  -> só autentica e diz se deu certo
//   'cargas'  { dataInicial, dataFinal } -> viagens do período (origem/destino com coordenadas)
//   'posicao' { placa } -> última posição do veículo (retorno bruto, para inspeção)

const BASE_PADRAO = 'https://barbieri.multitms.com.br/SGT.WEbService.REST';

// procura o access_token em qualquer nível da resposta
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

  // --- só quem está logado no nosso site pode usar ---
  let sess = null;
  if (env.USERS_KV && body.token) {
    const s = await env.USERS_KV.get('sess:' + body.token);
    if (s) { try { sess = JSON.parse(s); } catch {} }
  }
  if (!sess) return json({ error: 'Sessão inválida. Faça login novamente.' }, 401);

  const user = env.MULTI_USER, pass = env.MULTI_PASS;
  if (!user || !pass) {
    return json({ error: 'Credenciais do Multi não configuradas. Cadastre MULTI_USER e MULTI_PASS nas variáveis do Cloudflare.' }, 500);
  }
  const base = (env.MULTI_BASE || BASE_PADRAO).replace(/\/+$/, '');
  const basic = 'Basic ' + btoa(user + ':' + pass);

  // ---------- 1) obter o token ----------
  // O endpoint não documenta o corpo esperado. Tentamos os formatos usuais,
  // do mais provável ao menos, e ficamos com o primeiro que devolver access_token.
  async function obterToken() {
    const url = base + '/CadastroUnificado/ObterTokenIntegracao';
    const H = extra => Object.assign({ 'authorization': basic, 'accept': 'application/json' }, extra || {});
    const form = 'application/x-www-form-urlencoded';
    const e = encodeURIComponent;

    // O formulário passa da validação (500) e o JSON é recusado (415):
    // o formato certo é form-urlencoded; o que falta é o NOME dos campos.
    const pares = [
      ['usuario', 'senha'], ['Usuario', 'Senha'], ['login', 'senha'],
      ['usuario', 'password'], ['username', 'password'], ['user', 'pass'],
      ['client_id', 'client_secret'], ['email', 'senha'], ['cpf', 'senha'],
    ];
    const tentativas = [];
    for (const [cu, cs] of pares) {
      tentativas.push({ nome: 'form ' + cu + '/' + cs,
        init: { method: 'POST', headers: H({ 'content-type': form }), body: cu + '=' + e(user) + '&' + cs + '=' + e(pass) } });
    }
    // credenciais na URL
    tentativas.push({ nome: 'query usuario/senha',
      init: { method: 'POST', headers: H({ 'content-type': form }), body: '' }, url: url + '?usuario=' + e(user) + '&senha=' + e(pass) });
    // credenciais em cabeçalhos
    tentativas.push({ nome: 'cabecalhos usuario/senha',
      init: { method: 'POST', headers: H({ 'content-type': form, 'usuario': user, 'senha': pass }), body: '' } });
    tentativas.push({ nome: 'cabecalhos Usuario/Senha',
      init: { method: 'POST', headers: H({ 'content-type': form, 'Usuario': user, 'Senha': pass }), body: '' } });
    // sem o Basic, caso ele atrapalhe
    tentativas.push({ nome: 'form usuario/senha sem basic',
      init: { method: 'POST', headers: { 'accept': 'application/json', 'content-type': form }, body: 'usuario=' + e(user) + '&senha=' + e(pass) } });
    // grant_type junto, caso seja OAuth de verdade
    tentativas.push({ nome: 'form grant_type+usuario/senha',
      init: { method: 'POST', headers: H({ 'content-type': form }), body: 'grant_type=password&usuario=' + e(user) + '&senha=' + e(pass) } });
    tentativas.push({ nome: 'form vazio (referencia)',
      init: { method: 'POST', headers: H({ 'content-type': form }), body: '' } });

    const log = [];
    for (const t of tentativas) {
      let r, txt;
      try { r = await fetch(t.url || url, t.init); txt = await r.text(); }
      catch (err) { log.push({ tentativa: t.nome, erro: String(err).slice(0, 120) }); continue; }
      let j = null; try { j = JSON.parse(txt); } catch {}
      const tk = acharToken(j);
      log.push({
        tentativa: t.nome,
        status: r.status,
        tipoResposta: (r.headers.get('content-type') || '').split(';')[0],
        resposta: String(txt || '').replace(/\s+/g, ' ').slice(0, 220),
      });
      if (tk) return { token: tk, tipo: (j && j.token_type) || 'Bearer', expira: j && j.expires_in, via: t.nome, log };
    }
    return { erro: 'Não consegui obter o token do Multi. Veja o diagnóstico de cada tentativa.', log };
  }

  // ---------- chamada autenticada ----------
  async function chamar(caminho, corpo, tk) {
    const r = await fetch(base + caminho, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + tk,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(corpo || {}),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { ok: r.ok, status: r.status, json: j, texto: j ? null : txt.slice(0, 400) };
  }

  const auth = await obterToken();
  if (auth.erro) return json({ error: auth.erro, diagnostico: auth.log }, 502);

  if (body.action === 'testar') {
    return json({ ok: true, autenticado: true, via: auth.via, expiraEm: auth.expira, tipo: auth.tipo, diagnostico: auth.log });
  }

  // ---------- viagens (cargas) do período ----------
  if (body.action === 'cargas') {
    const di = body.dataInicial, df = body.dataFinal;
    if (!di || !df) return json({ error: 'Informe dataInicial e dataFinal.' }, 400);
    const r = await chamar('/Cargas/BuscarCargasPorPeriodo', {
      dataCriacaoInicial: di, dataCriacaoFinal: df,
      dataCarregamentoInicial: null, dataCarregamentoFinal: null,
    }, auth.token);
    if (!r.ok) return json({ error: 'O Multi recusou a consulta de cargas (código ' + r.status + ').', detalhe: r.json || r.texto }, 502);

    const lista = (r.json && (r.json.retorno || r.json.dados || r.json.data)) || r.json || [];
    const arr = Array.isArray(lista) ? lista : (lista.itens || lista.items || []);
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? null : n; };
    const endereco = e => e ? {
      cidade: (e.cidade && (e.cidade.nome || e.cidade.descricao)) || e.cidade || '',
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

    return json({ ok: true, total: viagens.length, viagens });
  }

  // ---------- posição do veículo ----------
  if (body.action === 'posicao') {
    const placa = (body.placa || '').trim();
    if (!placa) return json({ error: 'Informe a placa.' }, 400);
    const r = await chamar('/Monitoramento/ConsultaPosicionamentoStatusDispositivo',
      { placa, cpf: body.cpf || '', transporte: body.transporte || '' }, auth.token);
    if (!r.ok) return json({ error: 'O Multi recusou a consulta de posição (código ' + r.status + ').', detalhe: r.json || r.texto }, 502);
    // devolve o retorno bruto: os campos de posição vêm como texto e precisam ser inspecionados
    return json({ ok: true, bruto: r.json });
  }

  return json({ error: 'Ação inválida.' }, 400);
}
