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
  async function obterToken() {
    const r = await fetch(base + '/CadastroUnificado/ObterTokenIntegracao', {
      method: 'POST',
      headers: { 'authorization': basic, 'content-type': 'application/json', 'accept': 'application/json' },
      body: '{}',
    });
    const txt = await r.text();
    if (!r.ok) return { erro: 'Falha ao autenticar no Multi (código ' + r.status + '). ' + txt.slice(0, 200) };
    let j; try { j = JSON.parse(txt); } catch { return { erro: 'O Multi respondeu algo que não é JSON: ' + txt.slice(0, 200) }; }
    const tk = j.access_token || (j.retorno && j.retorno.access_token) || (j.dados && j.dados.access_token);
    if (!tk) return { erro: 'Autenticou, mas não encontrei o access_token na resposta.', bruto: j };
    return { token: tk, tipo: j.token_type || 'Bearer', expira: j.expires_in };
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
  if (auth.erro) return json({ error: auth.erro, bruto: auth.bruto }, 502);

  if (body.action === 'testar') {
    return json({ ok: true, autenticado: true, expiraEm: auth.expira, tipo: auth.tipo });
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
