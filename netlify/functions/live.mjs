// Tukkers Matchday – live gegevens
// Haalt stand, wedstrijden, onderlinge duels, topscorers en nieuws op.
// Netlify bewaart het antwoord 30 minuten; daarna wordt het automatisch ververst.

const API = "https://api.football-data.org/v4";
const COMP = "DED"; // Eredivisie
const CACHE_SECONDS = 30 * 60;

const NEWS_FEEDS = [
  "https://news.google.com/rss/search?q=%22FC%20Twente%22%20when%3A7d&hl=nl&gl=NL&ceid=NL:nl",
  "https://feeds.nos.nl/nossportvoetbal",
];

function env(name) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name); } catch (e) {}
  return process.env[name];
}

async function fd(path) {
  const key = env("FOOTBALL_DATA_KEY");
  if (!key) throw new Error("FOOTBALL_DATA_KEY ontbreekt in de Netlify-instellingen");
  const res = await fetch(API + path, {
    headers: { "X-Auth-Token": key },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`football-data ${path} gaf status ${res.status}`);
  return res.json();
}

const isTwente = (t) => /twente/i.test(t?.name || "") || /twente/i.test(t?.shortName || "");

function team(t) {
  return { id: t?.id ?? null, name: t?.name ?? "", short: t?.shortName || t?.name || "", tla: t?.tla || "" };
}

function match(m) {
  const ft = m.score?.fullTime || {};
  return {
    id: m.id,
    date: m.utcDate,
    status: m.status, // SCHEDULED (tijd nog niet vast), TIMED, IN_PLAY, PAUSED, FINISHED, POSTPONED
    comp: m.competition?.code === COMP ? "ERE" : (m.competition?.code || "ERE"),
    matchday: m.matchday ?? null,
    home: team(m.homeTeam),
    away: team(m.awayTeam),
    score: { h: ft.home ?? null, a: ft.away ?? null },
    referee: (m.referees || []).find((r) => r.type === "REFEREE")?.name || null,
  };
}

function seasonYear(d = new Date()) {
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

// ---------- nieuws (RSS) ----------
function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}
function parseRss(xml, fallbackSource) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    let title = tag(b, "title");
    let source = tag(b, "source") || fallbackSource;
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length);
    const desc = tag(b, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const date = new Date(tag(b, "pubDate") || Date.now());
    items.push({ title, url: tag(b, "link"), source, date: isNaN(date) ? null : date.toISOString(), summary: desc.slice(0, 220) });
  }
  return items;
}
async function news() {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "TukkersMatchday/1.0" } });
      if (!res.ok) throw new Error(`nieuwsfeed status ${res.status}`);
      const isNos = url.includes("nos.nl");
      let items = parseRss(await res.text(), isNos ? "NOS" : "");
      if (isNos) items = items.filter((i) => /twente|tukkers/i.test(i.title + " " + i.summary));
      if (!isNos) items.forEach((i) => (i.summary = "")); // Google News geeft geen bruikbare samenvatting
      return items;
    })
  );
  const seen = new Set();
  return results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((i) => i.title && i.url)
    .filter((i) => { const k = i.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 24);
}

// ---------- hoofdfunctie ----------
export default async (req) => {
  const out = { updatedAt: new Date().toISOString(), table: null, matches: null, next: null, opponent: null, h2h: null, scorers: null, news: null, errors: [] };
  const fail = (part, e) => out.errors.push(`${part}: ${e.message || e}`);

  const newsTask = news().then((n) => (out.news = n)).catch((e) => fail("nieuws", e));

  try {
    const st = await fd(`/competitions/${COMP}/standings`);
    const total = (st.standings || []).find((s) => s.type === "TOTAL") || st.standings?.[0];
    out.matchday = st.season?.currentMatchday ?? null;
    out.table = (total?.table || []).map((r) => ({
      pos: r.position, ...team(r.team), played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost,
      gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, pts: r.points,
    }));
    const tw = out.table.find(isTwente);
    if (!tw) throw new Error("FC Twente niet gevonden in de stand");

    const season = seasonYear();
    const [ms, sc] = await Promise.allSettled([
      fd(`/teams/${tw.id}/matches?competitions=${COMP}&season=${season}`),
      fd(`/competitions/${COMP}/scorers?limit=15`),
    ]);
    if (sc.status === "fulfilled") {
      out.scorers = (sc.value.scorers || []).map((s) => ({ name: s.player?.name, team: s.team?.shortName || s.team?.name, twente: isTwente(s.team), goals: s.goals ?? 0, assists: s.assists ?? 0, penalties: s.penalties ?? 0 }));
    } else fail("topscorers", sc.reason);

    if (ms.status !== "fulfilled") throw ms.reason;
    out.matches = (ms.value.matches || []).map(match).sort((a, b) => a.date.localeCompare(b.date));

    const now = Date.now();
    const next = out.matches.find((m) => ["IN_PLAY", "PAUSED"].includes(m.status))
      || out.matches.find((m) => m.status !== "FINISHED" && new Date(m.date).getTime() > now - 3 * 3600e3 && !["POSTPONED", "CANCELLED"].includes(m.status));
    out.next = next || null;

    if (next) {
      const opp = next.home.id === tw.id ? next.away : next.home;
      const from = new Date(now - 45 * 864e5), to = new Date(now + 864e5);
      const [om, hh] = await Promise.allSettled([
        fd(`/teams/${opp.id}/matches?status=FINISHED&dateFrom=${isoDay(from)}&dateTo=${isoDay(to)}`),
        fd(`/matches/${next.id}/head2head?limit=6`),
      ]);
      out.opponent = { ...opp, row: out.table.find((r) => r.id === opp.id) || null, recent: [] };
      if (om.status === "fulfilled") {
        out.opponent.recent = (om.value.matches || []).map(match).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
      } else fail("vorm tegenstander", om.reason);
      if (hh.status === "fulfilled") {
        const list = (hh.value.matches || []).map(match).filter((m) => m.status === "FINISHED").sort((a, b) => b.date.localeCompare(a.date));
        const agg = hh.value.aggregates || {};
        const tAgg = agg.homeTeam?.id === tw.id ? agg.homeTeam : agg.awayTeam;
        const oAgg = agg.homeTeam?.id === tw.id ? agg.awayTeam : agg.homeTeam;
        out.h2h = { count: agg.numberOfMatches ?? list.length, twenteWins: tAgg?.wins ?? null, draws: tAgg?.draws ?? null, oppWins: oAgg?.wins ?? null, matches: list.slice(0, 5) };
      } else fail("onderling", hh.reason);
    }
  } catch (e) {
    fail("voetbaldata", e);
  }

  await newsTask;

  const ok = out.table || out.news;
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      // Volledig gelukt: 30 min bewaren. Iets mis: na 5 min opnieuw proberen.
      "Netlify-CDN-Cache-Control": ok && out.errors.length === 0
        ? `public, durable, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=300`
        : "public, s-maxage=300",
    },
  });
};

export const config = { path: "/api/live" };
