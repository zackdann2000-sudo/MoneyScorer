const state = {
  user: null,
  date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  activeTab: 'matches'
};

const $ = (id) => document.getElementById(id);

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatHour(iso) {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

// ==========================================
// AUTENTICAÇÃO
// ==========================================
async function checkSession() {
  try {
    const res = await api('/api/auth/me');
    if (res.authenticated) {
      state.user = res.user;
      showApp();
    }
  } catch {
    $('loginScreen').classList.remove('hidden');
    $('appShell').classList.add('hidden');
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').classList.add('hidden');
  try {
    const user = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value
      })
    });
    state.user = user;
    showApp();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

function showApp() {
  $('loginScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('userBadge').textContent = `${state.user.email} • ${state.user.plan}`;
  $('globalDate').value = state.date;
  loadMatches();
}

// ==========================================
// NAVEGAÇÃO ENTRE ABAS
// ==========================================
function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  $(`tab-${tab}`).classList.add('active');

  document.querySelectorAll('.nav-btn, .bnav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  if (tab === 'matches') loadMatches();
  else if (tab === 'apis') loadApis();
  else if (tab === 'opportunities' && !$('opportunitiesList').innerHTML.trim()) loadOpportunities();
  else if (tab === 'players' && !$('playersList').innerHTML.trim()) loadPlayers();
}

document.querySelectorAll('.nav-btn, .bnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$('globalDate').addEventListener('change', (e) => {
  state.date = e.target.value;
  if (state.activeTab === 'matches') loadMatches();
  else if (state.activeTab === 'opportunities') loadOpportunities();
});

// ==========================================
// 1. PARTIDAS DO DIA + MODAL COMPLETO
// ==========================================
async function loadMatches() {
  const listEl = $('matchesList');
  const league = $('leagueSelect').value || 'all';
  listEl.innerHTML = '<div class="skeleton">Carregando partidas reais nas APIs conectadas...</div>';

  try {
    const data = await api(`/api/matches?date=${state.date}&league=${league}`);
    if ($('leagueSelect').options.length <= 1 && data.leagues) {
      for (const l of data.leagues) {
        const opt = document.createElement('option');
        opt.value = l.slug;
        opt.textContent = l.name;
        $('leagueSelect').appendChild(opt);
      }
      $('leagueSelect').value = league;
    }

    if (!data.matches.length) {
      listEl.innerHTML = '<div class="skeleton">Nenhuma partida encontrada para esta data/liga.</div>';
      return;
    }

    listEl.innerHTML = data.matches
      .map((m) => {
        const score =
          m.homeTeam.score !== null && m.awayTeam.score !== null
            ? `${m.homeTeam.score} - ${m.awayTeam.score}`
            : formatHour(m.date);
        const statusPill =
          m.status === 'LIVE'
            ? `<span class="pill live">AO VIVO • ${escapeHtml(m.statusDetail)}</span>`
            : `<span class="pill">${escapeHtml(m.statusDetail || m.status)}</span>`;

        return `
          <div class="match-card" data-id="${escapeHtml(m.id)}">
            <div class="match-meta">
              <span>${escapeHtml(m.leagueName)}</span>
              ${statusPill}
            </div>
            <div class="teams-row">
              <div class="team-col">
                ${m.homeTeam.logo ? `<img class="team-logo" src="${escapeHtml(m.homeTeam.logo)}" alt="" />` : ''}
                <span class="team-name">${escapeHtml(m.homeTeam.name)}</span>
              </div>
              <div class="score-box">${score}</div>
              <div class="team-col away">
                <span class="team-name">${escapeHtml(m.awayTeam.name)}</span>
                ${m.awayTeam.logo ? `<img class="team-logo" src="${escapeHtml(m.awayTeam.logo)}" alt="" />` : ''}
              </div>
            </div>
            <div class="match-footer">
              <span>Fontes: ${escapeHtml(m.apiSources.join(' + '))}</span>
              <span style="color: var(--emerald); font-weight: 700;">Ver Palpite Fixo & 4 Análises →</span>
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.match-card').forEach((card) => {
      card.addEventListener('click', () => openMatchAnalysis(card.dataset.id));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}

$('leagueSelect').addEventListener('change', loadMatches);

async function openMatchAnalysis(matchId) {
  $('matchModal').classList.remove('hidden');
  $('modalLeague').textContent = 'Analisando confronto real...';
  $('modalBody').innerHTML =
    '<div class="skeleton">Buscando últimos 7 jogos de cada equipe, H2H, 4 linhas e mercados reais...</div>';

  try {
    const a = await api(`/api/matches/${encodeURIComponent(matchId)}/analysis?date=${state.date}`);
    $('modalLeague').textContent = a.match.leagueName;

    const pickPct = a.fixedPick.probability !== null ? `${a.fixedPick.probability}%` : 'N/D';
    const pickSub =
      a.fixedPick.sample > 0
        ? `Base real: ${a.fixedPick.hits} de ${a.fixedPick.sample} jogos recentes`
        : 'Amostragem insuficiente';

    const fourHtml = a.fourLines
      .map((l) => {
        const p = l.guaranteePct !== null ? `${l.guaranteePct}%` : 'N/D';
        const w = l.guaranteePct !== null ? l.guaranteePct : 0;
        return `
          <div class="line-card">
            <div style="font-size: 12px; color: var(--muted);">${escapeHtml(l.label)}</div>
            <div style="font-size: 13px; font-weight: 700; margin-top: 2px;">${escapeHtml(l.line)}</div>
            <div class="pct">${p}</div>
            <div style="font-size: 11px; color: var(--muted);">${escapeHtml(l.status)} ${l.average !== null ? `(Média ${l.average})` : ''}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${w}%"></div></div>
          </div>
        `;
      })
      .join('');

    const marketsHtml = a.markets
      .map((mk) => {
        const badge =
          mk.probability !== null
            ? `<span class="pill ${mk.probability >= 70 ? 'green' : mk.probability >= 50 ? 'amber' : ''}">${mk.probability}% (${mk.hits}/${mk.sample})</span>`
            : `<span class="pill">${mk.requiresSportmonks ? 'Conecte Sportmonks (1ºT)' : 'Sem dados'}</span>`;
        return `
          <div class="market-row">
            <span style="font-size: 13px; font-weight: 600;">${escapeHtml(mk.label)}</span>
            ${badge}
          </div>
        `;
      })
      .join('');

    const renderLast7 = (title, sum) => `
      <div style="margin-top: 14px;">
        <h4 style="font-size: 14px; margin-bottom: 6px;">${escapeHtml(title)} (${sum.gamesCount} jogos)</h4>
        ${
          sum.last7.length
            ? sum.last7
                .map(
                  (g) => `
                <div class="market-row" style="font-size: 12px;">
                  <span>${escapeHtml(g.homeName)} <strong>${escapeHtml(g.score)}</strong> ${escapeHtml(g.awayName)}</span>
                  <span style="color: var(--muted);">Cantos: ${g.corners ?? '-'} | Cartões: ${g.cards ?? '-'}</span>
                </div>`
                )
                .join('')
            : '<div style="font-size: 12px; color: var(--muted);">Sem jogos anteriores retornados.</div>'
        }
      </div>
    `;

    $('modalBody').innerHTML = `
      <div style="text-align: center; margin-bottom: 14px;">
        <h3 style="font-size: 18px;">${escapeHtml(a.match.homeTeam.name)} vs ${escapeHtml(a.match.awayTeam.name)}</h3>
        <div style="font-size: 12px; color: var(--muted);">Fontes ativas: ${escapeHtml(a.match.apiSources.join(' • '))}</div>
      </div>

      <div class="highlight-box">
        <div style="font-size: 11px; text-transform: uppercase; color: var(--emerald); font-weight: 800;">Palpite Fixo do Confronto</div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:4px;">
          <strong style="font-size: 16px;">${escapeHtml(a.fixedPick.label)}</strong>
          <span style="font-size: 22px; font-weight: 800; color: var(--emerald);">${pickPct}</span>
        </div>
        <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">${escapeHtml(pickSub)}</div>
      </div>

      <div class="editorial-box">
        <strong style="display:block; margin-bottom:4px; color: var(--emerald);">Análise Editorial Pré-Jogo</strong>
        ${escapeHtml(a.editorial)}
      </div>

      <h4 style="font-size: 14px; margin-bottom: 8px;">4 Linhas de Análise do Confronto</h4>
      <div class="four-lines-grid">${fourHtml}</div>

      <h4 style="font-size: 14px; margin-bottom: 8px;">Probabilidade Real por Mercado</h4>
      ${marketsHtml}

      ${
        a.h2h.length
          ? `<div style="margin-top: 14px;"><h4 style="font-size: 14px; margin-bottom: 6px;">Últimos Confrontos Diretos (H2H)</h4>${a.h2h
              .map(
                (h) =>
                  `<div class="market-row" style="font-size:12px;"><span>${escapeHtml(h.homeName)} <strong>${escapeHtml(h.score)}</strong> ${escapeHtml(h.awayName)}</span><span style="color:var(--muted);">${new Date(h.date).toLocaleDateString('pt-BR')}</span></div>`
              )
              .join('')}</div>`
          : ''
      }

      ${renderLast7(`Últimos 7 Jogos — ${a.match.homeTeam.shortName}`, a.homeSummary)}
      ${renderLast7(`Últimos 7 Jogos — ${a.match.awayTeam.shortName}`, a.awaySummary)}
    `;
  } catch (err) {
    $('modalBody').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}

$('closeModalBtn').addEventListener('click', () => $('matchModal').classList.add('hidden'));
$('closeModalBackdrop').addEventListener('click', () => $('matchModal').classList.add('hidden'));

// ==========================================
// 2. OPORTUNIDADES DO DIA
// ==========================================
async function loadOpportunities() {
  const el = $('opportunitiesList');
  el.innerHTML = '<div class="skeleton">Analisando os jogos reais do dia para encontrar as maiores taxas de acerto...</div>';
  try {
    const data = await api(`/api/opportunities?date=${state.date}`);
    if (!data.opportunities.length) {
      el.innerHTML = '<div class="skeleton">Nenhuma oportunidade com amostragem suficiente encontrada hoje.</div>';
      return;
    }
    el.innerHTML = data.opportunities
      .map(
        (op) => `
        <div class="match-card" onclick="openMatchAnalysis('${escapeHtml(op.match.id)}')">
          <div class="match-meta">
            <span>${escapeHtml(op.match.leagueName)}</span>
            <span class="pill green">${op.fixedPick.probability}% de Confiança Real</span>
          </div>
          <h3 style="font-size: 15px; margin-bottom: 6px;">${escapeHtml(op.match.homeTeam.name)} vs ${escapeHtml(op.match.awayTeam.name)}</h3>
          <div style="font-size: 14px; font-weight: 700; color: var(--emerald); margin-bottom: 6px;">
            🎯 ${escapeHtml(op.fixedPick.label)} (${op.fixedPick.hits}/${op.fixedPick.sample} jogos)
          </div>
          <p style="font-size: 12.5px; color: var(--muted);">${escapeHtml(op.editorial)}</p>
        </div>
      `
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}
$('refreshOppsBtn').addEventListener('click', loadOpportunities);

// ==========================================
// 3. SCANNER DE MERCADOS
// ==========================================
async function scanMarkets() {
  const el = $('marketsList');
  const market = $('marketFilter').value;
  const team = encodeURIComponent($('marketTeamSearch').value.trim());
  el.innerHTML = '<div class="skeleton">Escaneando últimos 7 jogos das equipes para este mercado...</div>';
  try {
    const data = await api(`/api/markets/scan?date=${state.date}&market=${market}&team=${team}`);
    if (!data.results.length) {
      el.innerHTML = '<div class="skeleton">Nenhum jogo encontrado para este filtro hoje.</div>';
      return;
    }
    el.innerHTML = data.results
      .map((r) => {
        const badge =
          r.market.probability !== null
            ? `<span class="pill ${r.market.probability >= 70 ? 'green' : 'amber'}">${r.market.probability}% (${r.market.hits}/${r.market.sample})</span>`
            : `<span class="pill">${r.market.requiresSportmonks ? 'Conecte Sportmonks para 1ºT' : 'Sem dados'}</span>`;
        return `
          <div class="match-card" onclick="openMatchAnalysis('${escapeHtml(r.match.id)}')">
            <div class="match-meta">
              <span>${escapeHtml(r.match.leagueName)}</span>
              ${badge}
            </div>
            <div style="font-weight:700; font-size:15px;">${escapeHtml(r.match.homeTeam.name)} vs ${escapeHtml(r.match.awayTeam.name)}</div>
            <div style="font-size:13px; color:var(--emerald); margin-top:4px;">${escapeHtml(r.market.label)}</div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}
$('scanMarketsBtn').addEventListener('click', scanMarkets);

// ==========================================
// 4. RADAR DE JOGADORES (6 Métricas)
// ==========================================
async function loadPlayers() {
  const el = $('playersList');
  const metric = $('playerMetric').value;
  const league = $('playerLeague').value;
  el.innerHTML = '<div class="skeleton">Coletando estatísticas reais de jogadores nas partidas recentes...</div>';
  try {
    const data = await api(`/api/players/radar?date=${state.date}&metric=${metric}&league=${league}`);
    if (!data.players.length) {
      el.innerHTML =
        '<div class="skeleton">Sem dados individuais para esta liga hoje. Tente outra liga ou conecte Football-Data/Sportmonks.</div>';
      return;
    }
    const labels = {
      goals: 'Gols',
      assists: 'Assistências',
      shots: 'Finalizações',
      shotsOnTarget: 'Chutes ao Alvo',
      cards: 'Cartões',
      saves: 'Defesas'
    };
    el.innerHTML = data.players
      .map(
        (p, idx) => `
        <div class="match-card" style="cursor:default;">
          <div class="teams-row">
            <div>
              <div style="font-weight:700; font-size:14px;">#${idx + 1} ${escapeHtml(p.name)}</div>
              <div style="font-size:12px; color:var(--muted);">${escapeHtml(p.team)} • ${p.gamesSample} jogos analisados (${escapeHtml(p.source)})</div>
            </div>
            <div class="score-box" style="color:var(--emerald);">${p.value} <small style="font-size:10px; font-weight:500;">${labels[metric]}</small></div>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; font-size:11px; color:var(--muted);">
            <span>Gols: ${p.goals}</span> •
            <span>Assist: ${p.assists}</span> •
            <span>Finaliz: ${p.shots}</span> •
            <span>No Alvo: ${p.shotsOnTarget}</span> •
            <span>Cartões: ${p.cards}</span> •
            <span>Defesas: ${p.saves}</span>
          </div>
        </div>
      `
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}
$('scanPlayersBtn').addEventListener('click', loadPlayers);

// ==========================================
// 5. CONEXÕES MANUAIS DAS 4 APIS
// ==========================================
async function loadApis() {
  const el = $('apisGrid');
  try {
    const status = await api('/api/admin/apis');
    const providers = [
      { key: 'sportmonks', title: 'Sportmonks v3', url: 'my.sportmonks.com/api/tokens', info: status.sportmonks },
      { key: 'bzzoiro', title: 'Bzzoiro Sports Data', url: 'sports.bzzoiro.com/dashboard/', info: status.bzzoiro },
      { key: 'footballData', title: 'Football-Data.org v4', url: 'football-data.org', info: status.footballData }
    ];

    el.innerHTML = `
      <div class="api-card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>ESPN Soccer API (Principal)</strong>
          <span class="pill green">CONECTADA</span>
        </div>
        <p style="font-size:12.5px; color:var(--muted);">Ativa por padrão sem necessidade de chave. Fornece placares, jogos do dia, estatísticas e últimos 7 jogos.</p>
      </div>
      ${providers
        .map(
          (p) => `
          <div class="api-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>${p.title}</strong>
              <span class="pill ${p.info.connected ? 'green' : ''}">${p.info.connected ? 'CONECTADA' : 'DESCONECTADA'}</span>
            </div>
            <div style="font-size:12px; color:var(--muted);">Origem: ${p.url} ${p.info.keyPreview ? `• Chave salva: ${escapeHtml(p.info.keyPreview)}` : ''}</div>
            <input id="key-${p.key}" type="password" class="text-input" placeholder="Cole sua API Key da ${p.title} aqui..." />
            <div style="display:flex; gap:8px;">
              <button class="btn-primary" style="flex:1;" onclick="connectApi('${p.key}')">Testar e Conectar</button>
              ${p.info.connected ? `<button class="btn-danger" onclick="disconnectApi('${p.key}')">Remover</button>` : ''}
            </div>
            <div id="msg-${p.key}" style="font-size:12px;"></div>
          </div>
        `
        )
        .join('')}
    `;
  } catch (err) {
    el.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}

window.connectApi = async (provider) => {
  const input = $(`key-${provider}`);
  const msg = $(`msg-${provider}`);
  msg.style.color = 'var(--muted)';
  msg.textContent = 'Validando chave diretamente na API...';
  try {
    await api(`/api/admin/apis/${provider}`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: input.value.trim() })
    });
    msg.style.color = 'var(--emerald)';
    msg.textContent = 'Chave validada e conectada com sucesso!';
    setTimeout(loadApis, 800);
  } catch (err) {
    msg.style.color = '#fca5a5';
    msg.textContent = err.message;
  }
};

window.disconnectApi = async (provider) => {
  await api(`/api/admin/apis/${provider}`, { method: 'DELETE' });
  loadApis();
};

$('clearCacheBtn').addEventListener('click', async () => {
  await api('/api/admin/cache/clear', { method: 'POST' });
  alert('Cache limpo! Os próximos carregamentos buscarão dados novos.');
});

checkSession();