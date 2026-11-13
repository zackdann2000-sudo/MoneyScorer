const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const apis = require('./services/apis');
const { buildMatchAnalysis, normalizeName } = require('./services/analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// PERSISTÊNCIA LOCAL & SEGURANÇA
// ==========================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('greenscore_lifetime_secret_2026').digest('hex');
const ENC_KEY = crypto.createHash('sha256').update(SESSION_SECRET + '_enc').digest();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function ensureAdminSeed() {
  if (!fs.existsSync(USERS_FILE)) {
    const admin = {
      email: 'admin@greenscore.app',
      name: 'Administrador GreenScore',
      role: 'admin',
      plan: 'VITALÍCIO',
      passwordHash: hashPassword('12345678'),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
  }
}
ensureAdminSeed();

function encryptText(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptText(payload) {
  if (!payload || !payload.includes(':')) return '';
  try {
    const [ivHex, tagHex, encHex] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function loadApiKeys() {
  if (!fs.existsSync(SECRETS_FILE)) {
    return { sportmonks: '', bzzoiro: '', footballData: '' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return {
      sportmonks: decryptText(raw.sportmonks),
      bzzoiro: decryptText(raw.bzzoiro),
      footballData: decryptText(raw.footballData)
    };
  } catch (_) {
    return { sportmonks: '', bzzoiro: '', footballData: '' };
  }
}

function saveApiKeys(keys) {
  const encrypted = {
    sportmonks: encryptText(keys.sportmonks || ''),
    bzzoiro: encryptText(keys.bzzoiro || ''),
    footballData: encryptText(keys.footballData || '')
  };
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(encrypted, null, 2));
}

// ==========================================
// SESSÃO HTTP-ONLY
// ==========================================
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

function signSession(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.gs_session);
  if (!session) return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
  req.user = session;
  next();
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  const user = users.find((u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  const token = signSession({ email: user.email, name: user.name, role: user.role, plan: user.plan });
  res.setHeader(
    'Set-Cookie',
    `gs_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
  );
  res.json({ email: user.email, name: user.name, role: user.role, plan: user.plan });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'gs_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.gs_session);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: session });
});

// ==========================================
// ROTAS ADMIN: CONEXÃO MANUAL DAS 3 APIS
// ==========================================
app.get('/api/admin/apis', requireAuth, (req, res) => {
  const keys = loadApiKeys();
  const mask = (k) => (k ? `${k.slice(0, 4)}••••••••${k.slice(-4)}` : '');
  res.json({
    espn: { connected: true, mode: 'Automática (Principal)', keyPreview: 'Sem necessidade de chave' },
    sportmonks: { connected: Boolean(keys.sportmonks), keyPreview: mask(keys.sportmonks) },
    bzzoiro: { connected: Boolean(keys.bzzoiro), keyPreview: mask(keys.bzzoiro) },
    footballData: { connected: Boolean(keys.footballData), keyPreview: mask(keys.footballData) }
  });
});

app.post('/api/admin/apis/:provider', requireAuth, async (req, res) => {
  const { provider } = req.params;
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'Informe a chave da API.' });

  try {
    let testResult;
    if (provider === 'sportmonks') testResult = await apis.testSportmonksKey(apiKey);
    else if (provider === 'bzzoiro') testResult = await apis.testBzzoiroKey(apiKey);
    else if (provider === 'footballData') testResult = await apis.testFootballDataKey(apiKey);
    else return res.status(404).json({ error: 'Provedor inválido.' });

    const keys = loadApiKeys();
    keys[provider] = apiKey;
    saveApiKeys(keys);
    apis.clearAllCache();
    res.json({ ok: true, provider, testResult });
  } catch (err) {
    res.status(400).json({ error: `Falha ao validar chave na ${provider}: ${err.message}` });
  }
});

app.delete('/api/admin/apis/:provider', requireAuth, (req, res) => {
  const { provider } = req.params;
  const keys = loadApiKeys();
  if (!(provider in keys)) return res.status(404).json({ error: 'Provedor inválido.' });
  keys[provider] = '';
  saveApiKeys(keys);
  apis.clearAllCache();
  res.json({ ok: true });
});

app.post('/api/admin/cache/clear', requireAuth, (req, res) => {
  apis.clearAllCache();
  res.json({ ok: true });
});

// ==========================================
// AGREGADOR DE PARTIDAS DO DIA
// ==========================================
async function getAggregatedMatches(isoDate, leagueFilter = 'all') {
  const keys = loadApiKeys();
  const [espnList, smList, fdList, bzData] = await Promise.all([
    apis.fetchEspnMatches(isoDate, leagueFilter),
    keys.sportmonks && leagueFilter === 'all' ? apis.fetchSportmonksMatches(isoDate) : Promise.resolve([]),
    keys.footballData && leagueFilter === 'all' ? apis.fetchFootballDataMatches(keys.footballData, isoDate) : Promise.resolve([]),
    keys.bzzoiro && leagueFilter === 'all' ? apis.fetchBzzoiroMatchesAndPredictions(keys.bzzoiro, isoDate) : Promise.resolve({ events: [], predictions: [] })
  ]);

  // ESPN como base principal; enriquece ou adiciona partidas exclusivas das outras APIs
  const combined = [...espnList];

  const findMatch = (homeName, awayName) => {
    const hNorm = normalizeName(homeName);
    const aNorm = normalizeName(awayName);
    return combined.find(
      (m) =>
        (normalizeName(m.homeTeam.name).includes(hNorm.slice(0, 6)) ||
          hNorm.includes(normalizeName(m.homeTeam.name).slice(0, 6))) &&
        (normalizeName(m.awayTeam.name).includes(aNorm.slice(0, 6)) ||
          aNorm.includes(normalizeName(m.awayTeam.name).slice(0, 6)))
    );
  };

  for (const sm of smList) {
    const existing = findMatch(sm.homeTeam.name, sm.awayTeam.name);
    if (existing) {
      existing.sportmonksId = sm.rawId;
      existing.apiSources.push('Sportmonks');
    } else {
      combined.push(sm);
    }
  }

  for (const fd of fdList) {
    const existing = findMatch(fd.homeTeam.name, fd.awayTeam.name);
    if (existing) {
      existing.footballDataId = fd.rawId;
      existing.apiSources.push('Football-Data.org');
    } else {
      combined.push(fd);
    }
  }

  for (const bzEv of bzData.events || []) {
    const hName = bzEv.home_team?.name || bzEv.home_team_name || '';
    const aName = bzEv.away_team?.name || bzEv.away_team_name || '';
    if (!hName || !aName) continue;
    const existing = findMatch(hName, aName);
    const pred = (bzData.predictions || []).find((p) => p.event === bzEv.id || p.event_id === bzEv.id);
    if (existing) {
      existing.apiSources.push('Bzzoiro');
      if (pred) existing.bzzoiroPred = pred;
    }
  }

  return combined;
}

app.get('/api/matches', requireAuth, async (req, res) => {
  const isoDate = req.query.date || todayIso();
  const league = req.query.league || 'all';
  try {
    const matches = await getAggregatedMatches(isoDate, league);
    res.json({ date: isoDate, leagues: apis.ESPN_LEAGUES, matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ANÁLISE COMPLETA DO CONFRONTO (Últimos 7 + H2H + 4 Linhas)
// ==========================================
async function analyzeSingleMatch(match) {
  const cacheKey = `full_analysis_${match.id}`;
  const cached = apis.getCache(cacheKey);
  if (cached) return cached;

  const keys = loadApiKeys();
  let homeLast7 = [];
  let awayLast7 = [];
  let h2hFormatted = [];

  if (match.source === 'ESPN') {
    [homeLast7, awayLast7] = await Promise.all([
      apis.fetchEspnTeamLast7(match.leagueSlug, match.homeTeam.id),
      apis.fetchEspnTeamLast7(match.leagueSlug, match.awayTeam.id)
    ]);
  }

  // Enriquece com H2H da Football-Data se conectada
  if (keys.footballData && match.footballDataId) {
    const fdH2H = await apis.fetchFootballDataH2H(keys.footballData, match.footballDataId);
    if (fdH2H?.matches?.length) {
      h2hFormatted = fdH2H.matches.slice(0, 7).map((m) => ({
        date: m.utcDate,
        homeName: m.homeTeam?.shortName || m.homeTeam?.name,
        awayName: m.awayTeam?.shortName || m.awayTeam?.name,
        homeScore: m.score?.fullTime?.home ?? 0,
        awayScore: m.score?.fullTime?.away ?? 0
      }));
    }
  }

  // Enriquece com Sportmonks se conectada (inclui escanteios 1º tempo via periods.statistics!)
  if (keys.sportmonks && match.sportmonksId) {
    const smDeep = await apis.fetchSportmonksFixtureDeep(keys.sportmonks, match.sportmonksId);
    if (smDeep?.participants?.length === 2) {
      const smH2H = await apis.fetchSportmonksH2H(
        keys.sportmonks,
        smDeep.participants[0].id,
        smDeep.participants[1].id
      );
      if (smH2H.length && h2hFormatted.length === 0) {
        h2hFormatted = smH2H.map((f) => {
          const h = f.participants?.find((p) => p.meta?.location === 'home') || f.participants?.[0];
          const a = f.participants?.find((p) => p.meta?.location === 'away') || f.participants?.[1];
          const ft = (f.scores || []).filter((s) => s.description === 'CURRENT');
          return {
            date: f.starting_at,
            homeName: h?.name,
            awayName: a?.name,
            homeScore: ft.find((s) => s.participant_id === h?.id)?.score?.goals ?? 0,
            awayScore: ft.find((s) => s.participant_id === a?.id)?.score?.goals ?? 0
          };
        });
      }
      // Injeta estatísticas de escanteios do 1º tempo nos jogos Sportmonks se disponíveis
      const firstHalf = (smDeep.periods || []).find((p) => p.type_id === 1);
      if (firstHalf?.statistics?.length) {
        const homeId = smDeep.participants.find((p) => p.meta?.location === 'home')?.id;
        const awayId = smDeep.participants.find((p) => p.meta?.location === 'away')?.id;
        const hCorners1T = firstHalf.statistics.find((s) => s.type_id === 34 && s.participant_id === homeId)?.data?.value;
        const aCorners1T = firstHalf.statistics.find((s) => s.type_id === 34 && s.participant_id === awayId)?.data?.value;
        if (homeLast7[0] && hCorners1T !== undefined) homeLast7[0].homeHTCorners = Number(hCorners1T);
        if (awayLast7[0] && aCorners1T !== undefined) awayLast7[0].awayHTCorners = Number(aCorners1T);
      }
    }
  }

  const analysis = buildMatchAnalysis(match, homeLast7, awayLast7, h2hFormatted, match.bzzoiroPred);
  apis.setCache(cacheKey, analysis, 600);
  return analysis;
}

app.get('/api/matches/:id/analysis', requireAuth, async (req, res) => {
  const { id } = req.params;
  const isoDate = req.query.date || todayIso();
  try {
    const matches = await getAggregatedMatches(isoDate, 'all');
    const match = matches.find((m) => m.id === id);
    if (!match) return res.status(404).json({ error: 'Partida não encontrada para esta data.' });
    const analysis = await analyzeSingleMatch(match);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ABA: MELHORES OPORTUNIDADES DO DIA
// ==========================================
app.get('/api/opportunities', requireAuth, async (req, res) => {
  const isoDate = req.query.date || todayIso();
  try {
    const matches = await getAggregatedMatches(isoDate, 'all');
    // Analisa os primeiros 10 jogos do dia em lotes de 3 para ser rápido e evitar rate-limit
    const slice = matches.filter((m) => m.source === 'ESPN').slice(0, 10);
    const analyses = [];
    for (let i = 0; i < slice.length; i += 3) {
      const chunk = slice.slice(i, i + 3);
      const resChunk = await Promise.allSettled(chunk.map((m) => analyzeSingleMatch(m)));
      for (const r of resChunk) {
        if (r.status === 'fulfilled' && r.value?.fixedPick?.probability !== null) {
          analyses.push(r.value);
        }
      }
    }

    analyses.sort((a, b) => (b.fixedPick.probability || 0) - (a.fixedPick.probability || 0));
    res.json({
      date: isoDate,
      totalAnalyzed: analyses.length,
      opportunities: analyses.slice(0, 8)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ABA: SCANNER DE MERCADOS
// ==========================================
app.get('/api/markets/scan', requireAuth, async (req, res) => {
  const isoDate = req.query.date || todayIso();
  const marketCode = req.query.market || 'btts';
  const teamQuery = normalizeName(req.query.team || '');

  try {
    let matches = await getAggregatedMatches(isoDate, 'all');
    if (teamQuery) {
      matches = matches.filter(
        (m) =>
          normalizeName(m.homeTeam.name).includes(teamQuery) ||
          normalizeName(m.awayTeam.name).includes(teamQuery)
      );
    }

    const slice = matches.filter((m) => m.source === 'ESPN').slice(0, 10);
    const results = [];

    for (let i = 0; i < slice.length; i += 3) {
      const chunk = slice.slice(i, i + 3);
      const resChunk = await Promise.allSettled(chunk.map((m) => analyzeSingleMatch(m)));
      for (const r of resChunk) {
        if (r.status !== 'fulfilled') continue;
        const analysis = r.value;
        const mkt = analysis.markets.find((mk) => mk.code === marketCode);
        if (mkt) {
          results.push({
            match: analysis.match,
            market: mkt,
            editorial: analysis.editorial
          });
        }
      }
    }

    results.sort((a, b) => (b.market.probability ?? -1) - (a.market.probability ?? -1));
    res.json({ date: isoDate, marketCode, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SEÇÃO: RADAR DE JOGADORES (Apenas as 6 métricas pedidas)
// ==========================================
app.get('/api/players/radar', requireAuth, async (req, res) => {
  const metric = req.query.metric || 'goals';
  const league = req.query.league || 'bra.1';
  const isoDate = req.query.date || todayIso();
  const keys = loadApiKeys();

  const validMetrics = ['assists', 'goals', 'shots', 'cards', 'saves', 'shotsOnTarget'];
  const selectedMetric = validMetrics.includes(metric) ? metric : 'goals';

  try {
    const playerMap = new Map();
    const upsertPlayer = (p) => {
      const key = `${normalizeName(p.name)}_${normalizeName(p.team)}`;
      const prev = playerMap.get(key) || {
        name: p.name,
        team: p.team,
        goals: 0,
        assists: 0,
        shots: 0,
        shotsOnTarget: 0,
        cards: 0,
        saves: 0,
        gamesSample: 0,
        source: p.source || 'ESPN'
      };
      prev.goals += p.goals || 0;
      prev.assists += p.assists || 0;
      prev.shots += p.shots || 0;
      prev.shotsOnTarget += p.shotsOnTarget || 0;
      prev.cards += p.cards || 0;
      prev.saves += p.saves || 0;
      prev.gamesSample += 1;
      playerMap.set(key, prev);
    };

    // 1. Coleta dados reais de jogadores dos últimos jogos dos times na liga (ESPN)
    const matches = await apis.fetchEspnMatches(isoDate, league);
    const sampleMatches = matches.slice(0, 4);
    for (const m of sampleMatches) {
      const [h7, a7] = await Promise.all([
        apis.fetchEspnTeamLast7(m.leagueSlug, m.homeTeam.id),
        apis.fetchEspnTeamLast7(m.leagueSlug, m.awayTeam.id)
      ]);
      for (const g of [...h7, ...a7]) {
        for (const pl of g.players || []) upsertPlayer(pl);
      }
    }

    // 2. Se Football-Data estiver conectada, soma artilheiros oficiais
    if (keys.footballData) {
      const fdCodeMap = { 'eng.1': 'PL', 'esp.1': 'PD', 'bra.1': 'BSA', 'ita.1': 'SA', 'ger.1': 'BL1', 'fra.1': 'FL1' };
      const code = fdCodeMap[league] || 'PL';
      const scorers = await apis.fetchFootballDataScorers(keys.footballData, code);
      for (const s of scorers) upsertPlayer(s);
    }

    const list = Array.from(playerMap.values())
      .filter((p) => p[selectedMetric] > 0)
      .sort((a, b) => b[selectedMetric] - a[selectedMetric])
      .slice(0, 25)
      .map((p) => ({
        name: p.name,
        team: p.team,
        value: p[selectedMetric],
        goals: p.goals,
        assists: p.assists,
        shots: p.shots,
        shotsOnTarget: p.shotsOnTarget,
        cards: p.cards,
        saves: p.saves,
        gamesSample: p.gamesSample,
        source: p.source
      }));

    res.json({ metric: selectedMetric, league, players: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GreenScore Pro rodando em http://localhost:${PORT}`);
  console.log(`Admin vitalício: admin@greenscore.app | Senha: 12345678`);
});