function pct(hits, total) {
  if (!total || total <= 0) return null;
  return Math.round((hits / total) * 100);
}

function avg(arr) {
  const valid = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!valid.length) return null;
  return Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2));
}

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function buildMatchAnalysis(match, homeLast7, awayLast7, h2hMatches = [], bzzoiroPred = null) {
  const combined = [...homeLast7, ...awayLast7];
  const totalSample = combined.length;

  // --- CÁLCULO REAL DOS MERCADOS SOLICITADOS ---
  // 1. Ambas marcam (BTTS)
  const bttsHits = combined.filter((m) => m.homeScore > 0 && m.awayScore > 0).length;
  const bttsProb = pct(bttsHits, totalSample);

  // 2. 1º Tempo: 0,5+ gols do Mandante (analisa jogos do mandante com info de 1T)
  const homeHTGames = homeLast7.filter((m) => m.hasHalfTimeGoals);
  const homeHT05Hits = homeHTGames.filter((m) => m.teamHTGoals >= 1).length;
  const homeHT05Prob = pct(homeHT05Hits, homeHTGames.length);

  // 3. 1º Tempo: 0,5+ gols do Visitante
  const awayHTGames = awayLast7.filter((m) => m.hasHalfTimeGoals);
  const awayHT05Hits = awayHTGames.filter((m) => m.teamHTGoals >= 1).length;
  const awayHT05Prob = pct(awayHT05Hits, awayHTGames.length);

  // 4. 1,5+ gols na partida
  const over15MatchHits = combined.filter((m) => m.homeScore + m.awayScore >= 2).length;
  const over15MatchProb = pct(over15MatchHits, totalSample);

  // 5. 1,5+ gols do Mandante
  const homeOver15Hits = homeLast7.filter((m) => m.teamGoals >= 2).length;
  const homeOver15Prob = pct(homeOver15Hits, homeLast7.length);

  // 6. 1,5+ gols do Visitante
  const awayOver15Hits = awayLast7.filter((m) => m.teamGoals >= 2).length;
  const awayOver15Prob = pct(awayOver15Hits, awayLast7.length);

  // 7. 1º Tempo: 4,5+ escanteios Mandante / Visitante (requer dados de período 1T, ex: Sportmonks)
  const homeHTCornerGames = homeLast7.filter((m) => m.homeHTCorners !== null);
  const homeHTCorner45Prob = pct(
    homeHTCornerGames.filter((m) => m.homeHTCorners >= 5).length,
    homeHTCornerGames.length
  );

  const awayHTCornerGames = awayLast7.filter((m) => m.awayHTCorners !== null);
  const awayHTCorner45Prob = pct(
    awayHTCornerGames.filter((m) => m.awayHTCorners >= 5).length,
    awayHTCornerGames.length
  );

  // 8. 8,5+ escanteios no jogo todo
  const cornerGames = combined.filter((m) => m.corners !== null);
  const over85CornersHits = cornerGames.filter((m) => m.corners >= 9).length;
  const over85CornersProb = pct(over85CornersHits, cornerGames.length);

  // --- CONFRONTOS DIRETOS (H2H) ---
  // Combina H2H externo (Football-Data/Sportmonks) ou confrontos encontrados nos últimos jogos
  const localH2H = homeLast7.filter(
    (m) =>
      normalizeName(m.homeName) === normalizeName(match.awayTeam.name) ||
      normalizeName(m.awayName) === normalizeName(match.awayTeam.name)
  );
  const effectiveH2H = h2hMatches.length > 0 ? h2hMatches : localH2H;

  // --- 4 LINHAS DE ANÁLISE (Gols, Cartões, Faltas, Impedimentos) ---
  const avgGoals = avg(combined.map((m) => m.homeScore + m.awayScore));
  const avgCards = avg(combined.map((m) => m.cards));
  const avgFouls = avg(combined.map((m) => m.fouls));
  const avgOffsides = avg(combined.map((m) => m.offsides));

  const goals25Hits = combined.filter((m) => m.homeScore + m.awayScore >= 3).length;
  const goals15Hits = over15MatchHits;
  const cardsGames = combined.filter((m) => m.cards !== null);
  const cards35Hits = cardsGames.filter((m) => m.cards >= 4).length;
  const foulsGames = combined.filter((m) => m.fouls !== null);
  const fouls22Hits = foulsGames.filter((m) => m.fouls >= 22).length;
  const offsidesGames = combined.filter((m) => m.offsides !== null);
  const offsides25Hits = offsidesGames.filter((m) => m.offsides >= 3).length;

  const fourLines = [
    {
      key: 'gols',
      label: 'Gols na Partida',
      line: avgGoals !== null && avgGoals >= 2.5 ? 'Mais de 2.5 Gols' : 'Mais de 1.5 Gols',
      average: avgGoals,
      guaranteePct:
        avgGoals !== null && avgGoals >= 2.5
          ? pct(goals25Hits, totalSample)
          : pct(goals15Hits, totalSample),
      sampleSize: totalSample,
      status:
        totalSample === 0
          ? 'Sem histórico recente retornado pelas APIs'
          : `${avgGoals >= 2.5 ? goals25Hits : goals15Hits} de ${totalSample} jogos bateram`
    },
    {
      key: 'cartoes',
      label: 'Cartões na Partida',
      line: 'Mais de 3.5 Cartões',
      average: avgCards,
      guaranteePct: pct(cards35Hits, cardsGames.length),
      sampleSize: cardsGames.length,
      status:
        cardsGames.length === 0
          ? 'Sem dados de cartões nas APIs conectadas'
          : `${cards35Hits} de ${cardsGames.length} jogos com 4+ cartões`
    },
    {
      key: 'faltas',
      label: 'Faltas Cometidas',
      line: 'Mais de 21.5 Faltas',
      average: avgFouls,
      guaranteePct: pct(fouls22Hits, foulsGames.length),
      sampleSize: foulsGames.length,
      status:
        foulsGames.length === 0
          ? 'Sem dados de faltas nas APIs conectadas'
          : `${fouls22Hits} de ${foulsGames.length} jogos com 22+ faltas`
    },
    {
      key: 'impedimentos',
      label: 'Impedimentos',
      line: 'Mais de 2.5 Impedimentos',
      average: avgOffsides,
      guaranteePct: pct(offsides25Hits, offsidesGames.length),
      sampleSize: offsidesGames.length,
      status:
        offsidesGames.length === 0
          ? 'Sem dados de impedimentos nas APIs conectadas'
          : `${offsides25Hits} de ${offsidesGames.length} jogos com 3+ impedimentos`
    }
  ];

  // --- TODOS OS MERCADOS PARA SCANNER E PALPITE FIXO ---
  const markets = [
    {
      code: 'btts',
      label: 'Ambas as Equipes Marcam (Sim)',
      probability: bttsProb,
      hits: bttsHits,
      sample: totalSample
    },
    {
      code: 'ht_home_05',
      label: `1º Tempo: 0,5+ Gols (${match.homeTeam.shortName})`,
      probability: homeHT05Prob,
      hits: homeHT05Hits,
      sample: homeHTGames.length
    },
    {
      code: 'ht_away_05',
      label: `1º Tempo: 0,5+ Gols (${match.awayTeam.shortName})`,
      probability: awayHT05Prob,
      hits: awayHT05Hits,
      sample: awayHTGames.length
    },
    {
      code: 'ft_over_15',
      label: 'Partida: 1,5+ Gols',
      probability: over15MatchProb,
      hits: over15MatchHits,
      sample: totalSample
    },
    {
      code: 'home_over_15',
      label: `${match.homeTeam.shortName}: 1,5+ Gols`,
      probability: homeOver15Prob,
      hits: homeOver15Hits,
      sample: homeLast7.length
    },
    {
      code: 'away_over_15',
      label: `${match.awayTeam.shortName}: 1,5+ Gols`,
      probability: awayOver15Prob,
      hits: awayOver15Hits,
      sample: awayLast7.length
    },
    {
      code: 'ht_home_corners_45',
      label: `1º Tempo: 4,5+ Escanteios (${match.homeTeam.shortName})`,
      probability: homeHTCorner45Prob,
      hits: homeHTCornerGames.filter((m) => m.homeHTCorners >= 5).length,
      sample: homeHTCornerGames.length,
      requiresSportmonks: homeHTCornerGames.length === 0
    },
    {
      code: 'ht_away_corners_45',
      label: `1º Tempo: 4,5+ Escanteios (${match.awayTeam.shortName})`,
      probability: awayHTCorner45Prob,
      hits: awayHTCornerGames.filter((m) => m.awayHTCorners >= 5).length,
      sample: awayHTCornerGames.length,
      requiresSportmonks: awayHTCornerGames.length === 0
    },
    {
      code: 'ft_corners_85',
      label: 'Jogo Todo: 8,5+ Escanteios',
      probability: over85CornersProb,
      hits: over85CornersHits,
      sample: cornerGames.length
    }
  ];

  // --- PALPITE FIXO DO CONFRONTO (Maior convergência estatística real) ---
  const validCandidates = markets.filter((m) => m.probability !== null && m.sample >= 3);
  validCandidates.sort((a, b) => b.probability - a.probability);
  const fixedPick = validCandidates[0] || {
    code: 'insufficient',
    label: 'Aguardando amostragem mínima de jogos',
    probability: null,
    hits: 0,
    sample: totalSample
  };

  // --- EDITORIAL TÁTICO REAL (Opção 2) ---
  const homeAvgScored = avg(homeLast7.map((m) => m.teamGoals));
  const homeAvgConceded = avg(homeLast7.map((m) => m.opponentGoals));
  const awayAvgScored = avg(awayLast7.map((m) => m.teamGoals));
  const awayAvgConceded = avg(awayLast7.map((m) => m.opponentGoals));

  const editorialParts = [];
  if (totalSample > 0) {
    editorialParts.push(
      `Análise pré-jogo baseada em ${homeLast7.length} jogos recentes do ${match.homeTeam.name} e ${awayLast7.length} do ${match.awayTeam.name}.`
    );
    if (homeAvgScored !== null && awayAvgScored !== null) {
      editorialParts.push(
        `O mandante apresenta média real de ${homeAvgScored} gols marcados e ${homeAvgConceded} sofridos por jogo; já o visitante registra ${awayAvgScored} gols pró e ${awayAvgConceded} contra.`
      );
    }
    if (effectiveH2H.length > 0) {
      const h2hAvgGoals = avg(effectiveH2H.map((m) => m.homeScore + m.awayScore));
      editorialParts.push(
        `Nos últimos ${effectiveH2H.length} confrontos diretos (H2H) localizados, a média foi de ${h2hAvgGoals} gols por partida.`
      );
    } else {
      editorialParts.push(
        `Não foram localizados confrontos diretos recentes na janela atual das APIs conectadas; o peso da análise recai integralmente sobre os últimos 7 jogos individuais.`
      );
    }
    if (fixedPick.probability !== null) {
      editorialParts.push(
        `Com ${fixedPick.probability}% de ocorrência comprovada (${fixedPick.hits}/${fixedPick.sample} jogos), o mercado "${fixedPick.label}" consolida-se como o Palpite Fixo mais sólido para este duelo.`
      );
    }
    if (bzzoiroPred) {
      editorialParts.push(
        `Modelo ML Bzzoiro aponta probabilidades 1X2: Casa ${bzzoiroPred.prob_home ?? '-'}% | Empate ${bzzoiroPred.prob_draw ?? '-'}% | Fora ${bzzoiroPred.prob_away ?? '-'}%.`
      );
    }
  } else {
    editorialParts.push(
      'Esta competição não retornou histórico detalhado na ESPN. Conecte Sportmonks ou Football-Data.org nas configurações para ampliar a cobertura.'
    );
  }

  return {
    match,
    fixedPick,
    editorial: editorialParts.join(' '),
    homeSummary: {
      gamesCount: homeLast7.length,
      avgScored: homeAvgScored,
      avgConceded: homeAvgConceded,
      last7: homeLast7.map((m) => ({
        date: m.date,
        homeName: m.homeName,
        awayName: m.awayName,
        score: `${m.homeScore} x ${m.awayScore}`,
        corners: m.corners,
        cards: m.cards,
        fouls: m.fouls,
        offsides: m.offsides
      }))
    },
    awaySummary: {
      gamesCount: awayLast7.length,
      avgScored: awayAvgScored,
      avgConceded: awayAvgConceded,
      last7: awayLast7.map((m) => ({
        date: m.date,
        homeName: m.homeName,
        awayName: m.awayName,
        score: `${m.homeScore} x ${m.awayScore}`,
        corners: m.corners,
        cards: m.cards,
        fouls: m.fouls,
        offsides: m.offsides
      }))
    },
    h2h: effectiveH2H.map((m) => ({
      date: m.date,
      homeName: m.homeName,
      awayName: m.awayName,
      score: `${m.homeScore} x ${m.awayScore}`
    })),
    fourLines,
    markets
  };
}

module.exports = {
  buildMatchAnalysis,
  normalizeName
};