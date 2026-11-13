const cache = new Map();

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlSeconds = 180) {
  cache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function clearAllCache() {
  cache.clear();
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 140)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const ESPN_LEAGUES = [
  { slug: 'bra.1', name: 'Brasileirão Série A' },
  { slug: 'bra.2', name: 'Brasileirão Série B' },
  { slug: 'esp.1', name: 'La Liga' },
  { slug: 'eng.1', name: 'Premier League' },
  { slug: 'ita.1', name: 'Serie A (Itália)' },
  { slug: 'ger.1', name: 'Bundesliga' },
  { slug: 'fra.1', name: 'Ligue 1' },
  { slug: 'por.1', name: 'Liga Portugal' },
  { slug: 'uefa.champions', name: 'Champions League' },
  { slug: 'uefa.europa', name: 'Europa League' },
  { slug: 'conmebol.libertadores', name: 'Libertadores' },
  { slug: 'conmebol.sudamericana', name: 'Sul-Americana' }
];

function toEspnDate(isoDate) {
  return isoDate.replace(/-/g, '');
}

// ==========================================
// 1. ESPN API (Principal - Sem Chave)
// ==========================================
async function fetchEspnMatches(isoDate, leagueFilter = 'all') {
  const espnDate = toEspnDate(isoDate);
  const cacheKey = `espn_matches_${espnDate}_${leagueFilter}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const targetLeagues =
    leagueFilter === 'all'
      ? ESPN_LEAGUES
      : ESPN_LEAGUES.filter((l) => l.slug === leagueFilter);

  const urls =
    leagueFilter === 'all'
      ? [
          {
            slug: 'all',
            name: 'Destaques Globais',
            url: `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${espnDate}`
          },
          ...targetLeagues.map((l) => ({
            slug: l.slug,
            name: l.name,
            url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${l.slug}/scoreboard?dates=${espnDate}`
          }))
        ]
      : targetLeagues.map((l) => ({
          slug: l.slug,
          name: l.name,
          url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${l.slug}/scoreboard?dates=${espnDate}`
        }));

  const results = await Promise.allSettled(
    urls.map(async (item) => {
      const json = await fetchJson(item.url);
      return { item, json };
    })
  );

  const matchMap = new Map();

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.json?.events) continue;
    const { item, json } = r.value;
    const leagueTitle = json.leagues?.[0]?.name || item.name;
    const leagueSlug = json.leagues?.[0]?.slug || item.slug;

    for (const ev of json.events) {
      const comp = ev.competitions?.[0];
      if (!comp || !comp.competitors || comp.competitors.length < 2) continue;

      const home = comp.competitors.find((c) => c.homeAway === 'home') || comp.competitors[0];
      const away = comp.competitors.find((c) => c.homeAway === 'away') || comp.competitors[1];
      if (!home?.team || !away?.team) continue;

      const id = String(ev.id);
      if (matchMap.has(id)) continue;

      const state = comp.status?.type?.state || 'pre';
      matchMap.set(id, {
        id: `espn_${id}`,
        rawId: id,
        source: 'ESPN',
        leagueSlug: ev.season?.slug ? leagueSlug : item.slug === 'all' ? (json.leagues?.[0]?.slug || 'soccer') : item.slug,
        leagueName: leagueTitle,
        date: ev.date,
        status: state === 'in' ? 'LIVE' : state === 'post' ? 'FINISHED' : 'SCHEDULED',
        statusDetail: comp.status?.type?.shortDetail || comp.status?.type?.description || '',
        venue: comp.venue?.fullName || null,
        homeTeam: {
          id: String(home.team.id),
          name: home.team.displayName || home.team.name,
          shortName: home.team.shortDisplayName || home.team.abbreviation || home.team.name,
          logo: home.team.logo || null,
          score: home.score !== undefined && state !== 'pre' ? Number(home.score) : null
        },
        awayTeam: {
          id: String(away.team.id),
          name: away.team.displayName || away.team.name,
          shortName: away.team.shortDisplayName || away.team.abbreviation || away.team.name,
          logo: away.team.logo || null,
          score: away.score !== undefined && state !== 'pre' ? Number(away.score) : null
        },
        apiSources: ['ESPN']
      });
    }
  }

  const list = Array.from(matchMap.values()).sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );
  setCache(cacheKey, list, 120);
  return list;
}

async function fetchEspnSummary(leagueSlug, eventId) {
  const safeLeague = !leagueSlug || leagueSlug === 'all' ? 'soccer' : leagueSlug;
  const cacheKey = `espn_sum_${safeLeague}_${eventId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const trySlugs = [safeLeague, 'eng.1', 'esp.1', 'bra.1', 'uefa.champions'];
  for (const slug of [...new Set(trySlugs)]) {
    if (slug === 'soccer') continue;
    try {
      const data = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${eventId}`
      );
      if (data && (data.boxscore || data.header)) {
        setCache(cacheKey, data, 1800);
        return data;
      }
    } catch (_) {
      // Tenta próximo slug caso evento pertença a outra liga
    }
  }
  return null;
}

async function fetchEspnTeamLast7(leagueSlug, teamId) {
  const cacheKey = `espn_team7_${leagueSlug}_${teamId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const slugsToTry = [leagueSlug, 'bra.1', 'esp.1', 'eng.1', 'ita.1', 'ger.1', 'fra.1'].filter(
    (s) => s && s !== 'all' && s !== 'soccer'
  );

  let scheduleData = null;
  let resolvedSlug = leagueSlug;

  for (const slug of [...new Set(slugsToTry)]) {
    try {
      const json = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule`
      );
      if (json?.events?.length) {
        scheduleData = json;
        resolvedSlug = slug;
        break;
      }
    } catch (_) {}
  }

  if (!scheduleData?.events) return [];

  const completed = scheduleData.events
    .filter((ev) => ev.competitions?.[0]?.status?.type?.completed === true)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 7);

  // Busca os summaries dos 7 jogos com concorrência controlada
  const enriched = [];
  for (let i = 0; i < completed.length; i += 4) {
    const chunk = completed.slice(i, i + 4);
    const chunkRes = await Promise.all(
      chunk.map(async (ev) => {
        const comp = ev.competitions[0];
        const home = comp.competitors.find((c) => c.homeAway === 'home') || comp.competitors[0];
        const away = comp.competitors.find((c) => c.homeAway === 'away') || comp.competitors[1];
        const summary = await fetchEspnSummary(resolvedSlug, ev.id);
        return parseEspnMatchDetail(ev, comp, home, away, summary, teamId);
      })
    );
    enriched.push(...chunkRes);
  }

  setCache(cacheKey, enriched, 1800);
  return enriched;
}

function getEspnStat(statsArr, names) {
  if (!Array.isArray(statsArr)) return null;
  for (const n of names) {
    const found = statsArr.find(
      (s) =>
        s.name?.toLowerCase() === n.toLowerCase() ||
        s.label?.toLowerCase() === n.toLowerCase()
    );
    if (found && found.displayValue !== undefined) {
      const num = parseFloat(String(found.displayValue).replace('%', ''));
      if (!Number.isNaN(num)) return num;
    }
  }
  return null;
}

function parseEspnMatchDetail(ev, comp, home, away, summary, focusTeamId) {
  const homeScore = Number(home?.score?.value ?? home?.score ?? 0);
  const awayScore = Number(away?.score?.value ?? away?.score ?? 0);
  const isHome = String(home?.team?.id) === String(focusTeamId);

  let homeHTGoals = 0;
  let awayHTGoals = 0;
  let hasHalfTimeGoals = false;

  const scoringEvents = summary?.keyEvents || summary?.scoringPlays || [];
  if (Array.isArray(scoringEvents) && scoringEvents.length > 0) {
    const goalEvents = scoringEvents.filter(
      (k) => k.scoringPlay === true || k.type?.text?.toLowerCase().includes('goal')
    );
    if (goalEvents.length > 0 || (homeScore === 0 && awayScore === 0)) {
      hasHalfTimeGoals = true;
      for (const g of goalEvents) {
        const periodNum = g.period?.number;
        const clockStr = String(g.clock?.displayValue || '');
        const min = parseInt(clockStr, 10);
        const isFirstHalf = periodNum === 1 || (!periodNum && !Number.isNaN(min) && min <= 45);
        if (isFirstHalf) {
          const teamId = String(g.team?.id || '');
          if (teamId === String(home?.team?.id)) homeHTGoals++;
          else if (teamId === String(away?.team?.id)) awayHTGoals++;
        }
      }
    }
  } else if (homeScore === 0 && awayScore === 0) {
    hasHalfTimeGoals = true;
  }

  // Estatísticas da partida no boxscore
  let homeStats = null;
  let awayStats = null;
  if (summary?.boxscore?.teams?.length >= 2) {
    const tHome = summary.boxscore.teams.find(
      (t) => String(t.team?.id) === String(home?.team?.id)
    );
    const tAway = summary.boxscore.teams.find(
      (t) => String(t.team?.id) === String(away?.team?.id)
    );
    homeStats = tHome?.statistics || null;
    awayStats = tAway?.statistics || null;
  }

  const hCorners = getEspnStat(homeStats, ['wonCorners', 'corners']);
  const aCorners = getEspnStat(awayStats, ['wonCorners', 'corners']);
  const hYellow = getEspnStat(homeStats, ['yellowCards']) ?? 0;
  const aYellow = getEspnStat(awayStats, ['yellowCards']) ?? 0;
  const hRed = getEspnStat(homeStats, ['redCards']) ?? 0;
  const aRed = getEspnStat(awayStats, ['redCards']) ?? 0;
  const hFouls = getEspnStat(homeStats, ['foulsCommitted', 'fouls']);
  const aFouls = getEspnStat(awayStats, ['foulsCommitted', 'fouls']);
  const hOffsides = getEspnStat(homeStats, ['offsides']);
  const aOffsides = getEspnStat(awayStats, ['offsides']);

  const players = [];
  if (Array.isArray(summary?.rosters)) {
    for (const r of summary.rosters) {
      const teamName = r.team?.displayName || '';
      for (const p of r.roster || []) {
        if (!p.athlete?.displayName) continue;
        const st = p.stats || [];
        const getP = (names) => {
          for (const n of names) {
            const f = st.find((x) => x.name?.toLowerCase() === n.toLowerCase());
            if (f && f.value !== undefined) return Number(f.value) || 0;
          }
          return 0;
        };
        players.push({
          id: String(p.athlete.id),
          name: p.athlete.displayName,
          team: teamName,
          position: p.position?.abbreviation || '',
          goals: getP(['totalGoals', 'goals']),
          assists: getP(['goalAssists', 'assists']),
          shots: getP(['totalShots', 'shots']),
          shotsOnTarget: getP(['shotsOnTarget']),
          cards: getP(['yellowCards']) + getP(['redCards']),
          saves: getP(['saves'])
        });
      }
    }
  }

  return {
    id: String(ev.id),
    date: ev.date,
    homeId: String(home?.team?.id),
    awayId: String(away?.team?.id),
    homeName: home?.team?.displayName || home?.team?.shortDisplayName,
    awayName: away?.team?.displayName || away?.team?.shortDisplayName,
    homeScore,
    awayScore,
    isHome,
    teamGoals: isHome ? homeScore : awayScore,
    opponentGoals: isHome ? awayScore : homeScore,
    hasHalfTimeGoals,
    homeHTGoals,
    awayHTGoals,
    teamHTGoals: isHome ? homeHTGoals : awayHTGoals,
    corners: hCorners !== null && aCorners !== null ? hCorners + aCorners : null,
    homeCorners: hCorners,
    awayCorners: aCorners,
    // ESPN boxscore não separa escanteios por tempo; Sportmonks preenche quando conectada
    homeHTCorners: null,
    awayHTCorners: null,
    cards: homeStats && awayStats ? hYellow + aYellow + hRed + aRed : null,
    fouls: hFouls !== null && aFouls !== null ? hFouls + aFouls : null,
    offsides: hOffsides !== null && aOffsides !== null ? hOffsides + aOffsides : null,
    players
  };
}

// ==========================================
// 2. FOOTBALL-DATA.ORG v4 (Chave Manual)
// ==========================================
async function testFootballDataKey(apiKey) {
  const data = await fetchJson('https://api.football-data.org/v4/competitions', {
    headers: { 'X-Auth-Token': apiKey }
  });
  return { ok: true, competitions: data.count || data.competitions?.length || 0 };
}

async function fetchFootballDataMatches(apiKey, isoDate) {
  if (!apiKey) return [];
  const cacheKey = `fd_matches_${isoDate}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson(
      `https://api.football-data.org/v4/matches?dateFrom=${isoDate}&dateTo=${isoDate}`,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    const list = (data.matches || []).map((m) => ({
      id: `fd_${m.id}`,
      rawId: String(m.id),
      source: 'Football-Data.org',
      leagueSlug: m.competition?.code || 'fd',
      leagueName: m.competition?.name || 'Competição',
      date: m.utcDate,
      status:
        m.status === 'IN_PLAY' || m.status === 'PAUSED'
          ? 'LIVE'
          : m.status === 'FINISHED'
          ? 'FINISHED'
          : 'SCHEDULED',
      statusDetail: m.status,
      venue: m.venue || null,
      homeTeam: {
        id: String(m.homeTeam?.id),
        name: m.homeTeam?.name,
        shortName: m.homeTeam?.shortName || m.homeTeam?.tla || m.homeTeam?.name,
        logo: m.homeTeam?.crest || null,
        score: m.score?.fullTime?.home ?? null
      },
      awayTeam: {
        id: String(m.awayTeam?.id),
        name: m.awayTeam?.name,
        shortName: m.awayTeam?.shortName || m.awayTeam?.tla || m.awayTeam?.name,
        logo: m.awayTeam?.crest || null,
        score: m.score?.fullTime?.away ?? null
      },
      apiSources: ['Football-Data.org']
    }));
    setCache(cacheKey, list, 180);
    return list;
  } catch (err) {
    console.warn('[Football-Data] Erro:', err.message);
    return [];
  }
}

async function fetchFootballDataH2H(apiKey, matchId) {
  if (!apiKey) return null;
  const cacheKey = `fd_h2h_${matchId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const data = await fetchJson(
      `https://api.football-data.org/v4/matches/${matchId}/head2head?limit=7`,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    setCache(cacheKey, data, 1800);
    return data;
  } catch (_) {
    return null;
  }
}

async function fetchFootballDataScorers(apiKey, competitionCode = 'PL') {
  if (!apiKey) return [];
  const cacheKey = `fd_scorers_${competitionCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const data = await fetchJson(
      `https://api.football-data.org/v4/competitions/${competitionCode}/scorers?limit=25`,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    const list = (data.scorers || []).map((s) => ({
      id: `fd_p_${s.player?.id}`,
      name: s.player?.name,
      team: s.team?.shortName || s.team?.name,
      position: s.player?.section || '',
      goals: s.goals || 0,
      assists: s.assists || 0,
      shots: 0,
      shotsOnTarget: 0,
      cards: 0,
      saves: 0,
      source: 'Football-Data.org'
    }));
    setCache(cacheKey, list, 1800);
    return list;
  } catch (_) {
    return [];
  }
}

// ==========================================
// 3. SPORTMONKS v3 (Chave Manual)
// ==========================================
async function testSportmonksKey(apiKey) {
  const data = await fetchJson(
    `https://api.sportmonks.com/v3/football/leagues?api_token=${encodeURIComponent(apiKey)}&per_page=1`
  );
  return { ok: true, leaguesFound: data.data?.length || 0 };
}

async function fetchSportmonksMatches(apiKey, isoDate) {
  if (!apiKey) return [];
  const cacheKey = `sm_matches_${isoDate}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://api.sportmonks.com/v3/football/fixtures/date/${isoDate}?api_token=${encodeURIComponent(
      apiKey
    )}&include=participants;scores;league`;
    const json = await fetchJson(url);
    const list = (json.data || []).map((f) => {
      const home = f.participants?.find((p) => p.meta?.location === 'home') || f.participants?.[0];
      const away = f.participants?.find((p) => p.meta?.location === 'away') || f.participants?.[1];
      const currentScores = (f.scores || []).filter((s) => s.description === 'CURRENT');
      const hScore = currentScores.find((s) => s.participant_id === home?.id)?.score?.goals ?? null;
      const aScore = currentScores.find((s) => s.participant_id === away?.id)?.score?.goals ?? null;

      return {
        id: `sm_${f.id}`,
        rawId: String(f.id),
        source: 'Sportmonks',
        leagueSlug: `sm_${f.league_id}`,
        leagueName: f.league?.name || 'Liga Sportmonks',
        date: f.starting_at ? f.starting_at.replace(' ', 'T') + 'Z' : isoDate,
        status: [2, 3, 22].includes(f.state_id) ? 'LIVE' : f.state_id === 5 ? 'FINISHED' : 'SCHEDULED',
        statusDetail: f.result_info || '',
        venue: null,
        homeTeam: {
          id: String(home?.id),
          name: home?.name || 'Mandante',
          shortName: home?.short_code || home?.name,
          logo: home?.image_path || null,
          score: hScore
        },
        awayTeam: {
          id: String(away?.id),
          name: away?.name || 'Visitante',
          shortName: away?.short_code || away?.name,
          logo: away?.image_path || null,
          score: aScore
        },
        apiSources: ['Sportmonks']
      };
    });
    setCache(cacheKey, list, 180);
    return list;
  } catch (err) {
    console.warn('[Sportmonks] Erro:', err.message);
    return [];
  }
}

async function fetchSportmonksFixtureDeep(apiKey, fixtureId) {
  if (!apiKey) return null;
  const cacheKey = `sm_deep_${fixtureId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://api.sportmonks.com/v3/football/fixtures/${fixtureId}?api_token=${encodeURIComponent(
      apiKey
    )}&include=participants;scores;statistics;periods.statistics;events;predictions`;
    const json = await fetchJson(url);
    setCache(cacheKey, json.data || null, 600);
    return json.data || null;
  } catch (_) {
    return null;
  }
}

async function fetchSportmonksH2H(apiKey, team1Id, team2Id) {
  if (!apiKey) return [];
  const cacheKey = `sm_h2h_${team1Id}_${team2Id}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://api.sportmonks.com/v3/football/fixtures/head-to-head/${team1Id}/${team2Id}?api_token=${encodeURIComponent(
      apiKey
    )}&include=participants;scores;statistics;periods.statistics`;
    const json = await fetchJson(url);
    const list = (json.data || []).slice(0, 7);
    setCache(cacheKey, list, 1800);
    return list;
  } catch (_) {
    return [];
  }
}

// ==========================================
// 4. BZZOIRO SPORTS DATA (Chave Manual)
// ==========================================
async function testBzzoiroKey(apiKey) {
  const data = await fetchJson('https://sports.bzzoiro.com/api/v2/leagues/', {
    headers: { Authorization: `Token ${apiKey}` }
  });
  return { ok: true, count: Array.isArray(data) ? data.length : data.results?.length || 1 };
}

async function fetchBzzoiroMatchesAndPredictions(apiKey, isoDate) {
  if (!apiKey) return { events: [], predictions: [] };
  const cacheKey = `bz_data_${isoDate}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const headers = { Authorization: `Token ${apiKey}` };
    const [evRes, predRes] = await Promise.allSettled([
      fetchJson(`https://sports.bzzoiro.com/api/events/?date_from=${isoDate}&date_to=${isoDate}`, {
        headers
      }),
      fetchJson(`https://sports.bzzoiro.com/api/predictions/`, { headers })
    ]);
    const out = {
      events: evRes.status === 'fulfilled' ? evRes.value?.results || evRes.value || [] : [],
      predictions: predRes.status === 'fulfilled' ? predRes.value?.results || predRes.value || [] : []
    };
    setCache(cacheKey, out, 180);
    return out;
  } catch (err) {
    console.warn('[Bzzoiro] Erro:', err.message);
    return { events: [], predictions: [] };
  }
}

async function fetchBzzoiroPlayers(apiKey) {
  if (!apiKey) return [];
  const cacheKey = 'bz_players';
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const data = await fetchJson('https://sports.bzzoiro.com/api/v2/players/?limit=100', {
      headers: { Authorization: `Token ${apiKey}` }
    });
    const list = data.results || data || [];
    setCache(cacheKey, list, 1800);
    return list;
  } catch (_) {
    return [];
  }
}

module.exports = {
  ESPN_LEAGUES,
  clearAllCache,
  getCache,
  setCache,
  fetchEspnMatches,
  fetchEspnSummary,
  fetchEspnTeamLast7,
  testFootballDataKey,
  fetchFootballDataMatches,
  fetchFootballDataH2H,
  fetchFootballDataScorers,
  testSportmonksKey,
  fetchSportmonksMatches,
  fetchSportmonksFixtureDeep,
  fetchSportmonksH2H,
  testBzzoiroKey,
  fetchBzzoiroMatchesAndPredictions,
  fetchBzzoiroPlayers
};