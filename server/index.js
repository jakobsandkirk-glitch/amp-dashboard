/**
 * AMP-Dashboard — backend
 * -----------------------------------------------------------
 * En lille Express-server der henter LIVE data fra gratis kilder:
 *   1. Folketinget        — oda.ft.dk (åbent, gratis, ingen nøgle)
 *   2. Danmarks Statistik — api.statbank.dk (åbent, gratis, ingen nøgle)
 *   3. Nyhedssøgning       — valgfri (kræver nøgle hos en søge-/nyhedsudbyder)
 *
 * Serveren cacher svarene, så vi ikke spammer kilderne, og
 * udstiller dem på simple endpoints som frontenden kalder.
 *
 * Kør lokalt:  npm install && npm start  →  http://localhost:3000
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Simpel in-memory cache (minutter) -------------------------------
const cache = new Map();
async function cached(key, ttlMinutes, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMinutes * 60_000) return hit.v;
  const v = await producer();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Node 18+ har global fetch indbygget.
async function getJSON(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "Accept": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fra ${url}`);
  return r.json();
}

// =====================================================================
// 1) FOLKETINGET — oda.ft.dk
// =====================================================================
// OData-API. Entiteter: Sag, Aktør, Afstemning, Dokument m.fl.
// Bemærk: entitets- og feltnavne bruger æ/ø/å og SKAL URL-encodes.
// Vi søger sager hvis titel indeholder et nøgleord, nyeste først.
// -----------------------------------------------------------
const ODA = "https://oda.ft.dk/api";

// Direkte link til en sag på ft.dk: /samling/<samling>/<segment>/<prefix><nr>/index.htm.
// Segmentet afhænger af sagstypen, som vi aflæser af nummer-præfikset (L/B/S/F …).
// Kun de sikre typer får et direkte link; resten falder tilbage til en søgning,
// så vi aldrig sender brugeren til et dødt link.
const FT_SEGMENT = {
  L: "lovforslag",
  B: "beslutningsforslag",
  S: "spoergsmaal", // § 20-spørgsmål
  F: "forespoergsel",
};
function ftSagLink(s) {
  const samling = s.Periode?.kode;
  const seg = FT_SEGMENT[s.nummerprefix];
  if (samling && seg && s.nummerprefix && s.nummernumerisk != null) {
    return `https://www.ft.dk/samling/${samling}/${seg}/${s.nummerprefix}${s.nummernumerisk}/index.htm`;
  }
  return `https://www.ft.dk/samling/sog?q=${encodeURIComponent(s.titel)}`;
}

app.get("/api/folketinget", async (req, res) => {
  const q = (req.query.q || "dagpenge").toString();
  try {
    const data = await cached(`ft:${q}`, 60, async () => {
      // $filter med substringof( ) er den klassiske OData-måde at lave "indeholder".
      const filter = `substringof('${q.replace(/'/g, "''")}',titel)`;
      // $expand henter status + sagstrin med tilhørende afstemninger pr. sag,
      // så vi kan vise hvor i Folketinget sagen er, og hvordan der er stemt.
      const url =
        `${ODA}/Sag?` +
        `$filter=${encodeURIComponent(filter)}` +
        `&$orderby=${encodeURIComponent("opdateringsdato desc")}` +
        `&$top=8` +
        `&$expand=${encodeURIComponent("Sagsstatus,Sagstrin/Afstemning,Periode")}`;
      const json = await getJSON(url);
      return (json.value || []).map((s) => {
        const trin = s.Sagstrin || [];
        // Nyeste sagstrin = hvor sagen er lige nu.
        const senesteTrin = trin
          .slice()
          .sort((a, b) => new Date(b.dato) - new Date(a.dato))[0];
        // Saml alle afstemninger på tværs af sagstrin, nyeste først.
        const afstemninger = trin
          .flatMap((t) => t.Afstemning || [])
          .sort((a, b) => new Date(b.opdateringsdato) - new Date(a.opdateringsdato))
          .map((a) => ({
            vedtaget: a.vedtaget,
            konklusion: (a.konklusion || "").trim(),
          }));
        return {
          id: s.id,
          titel: s.titel,
          opdateret: s.opdateringsdato,
          resume: s.resume || "",
          status: s.Sagsstatus?.status || null,
          senesteTrin: senesteTrin
            ? { titel: senesteTrin.titel, dato: senesteTrin.dato }
            : null,
          afstemninger,
          link: ftSagLink(s),
        };
      });
    });
    res.json({
      ok: true,
      kilde: "oda.ft.dk",
      kildeLink: "https://oda.ft.dk",
      emne: q,
      sager: data,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------
// 1b) BESKÆFTIGELSESUDVALGET — udvalgets møder og dagsordener
// ---------------------------------------------------------------------
// Beskæftigelsesudvalget (BEU) er Folketingets stående udvalg på
// arbejdsmarkedsområdet. Hvert udvalgsmøde ligger i Møde-entiteten med
// titel "Beskæftigelsesudvalget"; dagsordenspunkterne hentes med
// $expand=Dagsordenspunkt. Vi viser de seneste møder med dato og hvad
// der stod på dagsordenen — det fortæller hvad udvalget reelt behandler.
// -----------------------------------------------------------
// Roller i et udvalg (AktørAktørRolle). Vi viser ledelse + menige medlemmer
// og udelader stedfortrædere/sekretærer. Tallene er rolle-id'er fra API'et.
const UDVALGSROLLER = {
  16: { navn: "Formand", rang: 0 },
  14: { navn: "Næstformand", rang: 1 },
  1: { navn: "1. næstformand", rang: 1 },
  9: { navn: "2. næstformand", rang: 1 },
  5: { navn: "3. næstformand", rang: 1 },
  11: { navn: "4. næstformand", rang: 1 },
  15: { navn: "Medlem", rang: 2 },
};

// Biografien er et XML-dokument med kontakt- og profiloplysninger.
// Vi trækker parti, foto, e-mail og links til sociale medier ud.
function parseBio(xml = "") {
  const tag = (t) => {
    const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i"));
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()) : "";
  };
  const links = [...xml.matchAll(/https?:\/\/[^<>\s"']+/g)].map((m) => m[0]);
  const find = (re) => links.find((l) => re.test(l)) || null;
  return {
    parti: tag("party") || null,
    partiKort: tag("partyShortname") || null,
    // Foto: ft.dk's CV-billede (.ashx), ikke .zip-arkivet.
    foto: links.find((l) => /ft\.dk\/-\/media\/cv\/foto.*\.ashx/i.test(l)) || null,
    email: tag("email") || null,
    facebook: find(/facebook\.com/i),
    instagram: find(/instagram\.com/i),
    linkedin: find(/linkedin\.com/i),
    twitter: find(/twitter\.com|x\.com/i),
    // Personlig hjemmeside = link der hverken er foto, arkiv eller socialt medie.
    hjemmeside:
      links.find(
        (l) =>
          !/ft\.dk\/-\/media|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|\.zip$/i.test(l)
      ) || null,
  };
}

// Foto, profillink OG sociale medier pr. medlem. ft.dk's biografi er ofte
// tynd, så vi beriger via Wikidata, der matcher oda's aktør-id 1:1 (P10207).
// Vi trækker portræt (P18), ft.dk-slug (P7882), X (P2002), Facebook (P2013),
// Instagram (P2003), LinkedIn (P6634) og hjemmeside (P856). SAMPLE+GROUP BY
// giver én værdi pr. felt (undgår kombinatorisk eksplosion ved flere værdier).
// Returnerer {aktørid: {foto, ftdk, twitter, facebook, instagram, linkedin, hjemmeside}}.
async function wikidataMedlemsdata() {
  return cached("wd:ft-medlemmer", 1440, async () => {
    const q =
      "SELECT ?actorId (SAMPLE(?image) AS ?aImg) (SAMPLE(?ftId) AS ?aFt) " +
      "(SAMPLE(?x) AS ?aTw) (SAMPLE(?fb) AS ?aFb) (SAMPLE(?ig) AS ?aIg) " +
      "(SAMPLE(?li) AS ?aLi) (SAMPLE(?web) AS ?aWeb) WHERE { " +
      "?p wdt:P10207 ?actorId . " +
      "OPTIONAL { ?p wdt:P18 ?image } OPTIONAL { ?p wdt:P7882 ?ftId } " +
      "OPTIONAL { ?p wdt:P2002 ?x } OPTIONAL { ?p wdt:P2013 ?fb } " +
      "OPTIONAL { ?p wdt:P2003 ?ig } OPTIONAL { ?p wdt:P6634 ?li } " +
      "OPTIONAL { ?p wdt:P856 ?web } } GROUP BY ?actorId";
    const url =
      "https://query.wikidata.org/sparql?format=json&query=" +
      encodeURIComponent(q);
    try {
      const json = await getJSON(url, {
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "AMP-Dashboard/1.0 (arbejdsmarkedspolitisk dashboard)",
        },
      });
      const map = {};
      const v = (r, k) => (r[k] && r[k].value ? r[k].value : null);
      for (const r of json.results?.bindings || []) {
        const id = v(r, "actorId");
        if (!id) continue;
        const e = (map[id] = {});
        // Commons Special:FilePath skaleres med ?width=… (hotlink-venligt).
        if (v(r, "aImg")) e.foto = `${v(r, "aImg")}?width=300`;
        if (v(r, "aFt")) e.ftdk = `https://www.ft.dk/medlemmer/mf/${v(r, "aFt")}`;
        // Wikidata gemmer brugernavne/ID'er — vi bygger den fulde URL.
        if (v(r, "aTw")) e.twitter = `https://x.com/${v(r, "aTw")}`;
        if (v(r, "aFb")) e.facebook = `https://www.facebook.com/${v(r, "aFb")}`;
        if (v(r, "aIg")) e.instagram = `https://www.instagram.com/${v(r, "aIg")}`;
        if (v(r, "aLi")) e.linkedin = `https://www.linkedin.com/in/${v(r, "aLi")}`;
        if (v(r, "aWeb")) e.hjemmeside = v(r, "aWeb");
      }
      return map;
    } catch {
      return {}; // Wikidata utilgængeligt → fald tilbage til biografi/initialer.
    }
  });
}

// Find den aktuelle Beskæftigelsesudvalg-aktør og hent dens nuværende
// medlemmer (relationer uden slutdato). Aktøren nyoprettes pr. folketingsår,
// så vi tager den med højeste id (nyeste).
async function beuMedlemmer() {
  const akt = await getJSON(
    `${ODA}/Aktør?` +
      `$filter=${encodeURIComponent("navn eq 'Beskæftigelsesudvalget'")}` +
      `&$orderby=${encodeURIComponent("id desc")}&$top=1&$select=id`
  );
  const beuId = akt.value?.[0]?.id;
  if (!beuId) return [];
  // Medlemsrelationer og Wikidata-data (foto + profillink) hentes parallelt.
  const [rel, wd] = await Promise.all([
    getJSON(
      `${ODA}/AktørAktør?` +
        `$filter=${encodeURIComponent(`tilaktørid eq ${beuId}`)}` +
        `&$expand=FraAktør&$top=80`
    ),
    wikidataMedlemsdata(),
  ]);
  const seen = new Map();
  for (const r of rel.value || []) {
    if (r.slutdato) continue; // kun nuværende
    const rolle = UDVALGSROLLER[r.rolleid];
    if (!rolle) continue; // spring stedfortrædere/sekretærer over
    const p = r.FraAktør || {};
    const prev = seen.get(p.id);
    if (prev && prev._rang <= rolle.rang) continue; // behold højeste rolle
    const bio = parseBio(p.biografi || "");
    const w = wd[String(p.id)] || {};
    seen.set(p.id, {
      _rang: rolle.rang,
      navn: p.navn,
      rolle: rolle.navn,
      parti: bio.parti,
      partiKort: bio.partiKort,
      // Frit Commons-portræt (matchet på oda-aktør-id); ft.dk-fotoet er blokeret.
      foto: w.foto || null,
      // Officielt profillink på Folketingets hjemmeside (matchet på oda-id).
      ftdk: w.ftdk || null,
      email: bio.email,
      // Biografiens egne links foretrækkes; Wikidata fylder hullerne ud.
      links: {
        facebook: bio.facebook || w.facebook || null,
        instagram: bio.instagram || w.instagram || null,
        linkedin: bio.linkedin || w.linkedin || null,
        twitter: bio.twitter || w.twitter || null,
        hjemmeside: bio.hjemmeside || w.hjemmeside || null,
      },
    });
  }
  return [...seen.values()]
    .sort((a, b) => a._rang - b._rang || a.navn.localeCompare(b.navn, "da"))
    .map(({ _rang, ...m }) => m);
}

app.get("/api/udvalg", async (_req, res) => {
  try {
    const data = await cached("ft:beu", 180, async () => {
      const filter = "substringof('Beskæftigelsesudvalget',titel)";
      const moedeUrl =
        `${ODA}/Møde?` +
        `$filter=${encodeURIComponent(filter)}` +
        `&$orderby=${encodeURIComponent("dato desc")}` +
        `&$top=8` +
        `&$expand=Dagsordenspunkt`;
      // Hent møder og medlemmer parallelt; fejler medlemmer, viser vi stadig møder.
      const [moedeJson, medlemmer] = await Promise.all([
        getJSON(moedeUrl),
        beuMedlemmer().catch(() => []),
      ]);
      const moeder = (moedeJson.value || []).map((m) => ({
        id: m.id,
        dato: m.dato,
        lokale: m.lokale || null,
        tidspunkt: (m.starttidsbemærkning || "").trim() || null,
        // O = offentligt møde, andet = lukket.
        offentligt: m.offentlighedskode === "O",
        punkter: (m.Dagsordenspunkt || [])
          .slice()
          .sort((a, b) => (a.nummer || 0) - (b.nummer || 0))
          .map((p) => ({ nummer: p.nummer, titel: (p.titel || "").trim() }))
          // "Eventuelt." er rent proceduremæssigt — det springer vi over.
          .filter((p) => p.titel && !/^eventuelt\.?$/i.test(p.titel)),
      }));
      return { moeder, medlemmer };
    });
    res.json({
      ok: true,
      kilde: "oda.ft.dk",
      kildeLink: "https://www.ft.dk/da/udvalg/udvalgene/beu",
      udvalg: "Folketingets Beskæftigelsesudvalg",
      forkortelse: "BEU",
      moeder: data.moeder,
      medlemmer: data.medlemmer,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// =====================================================================
// 2) DANMARKS STATISTIK — api.statbank.dk
// =====================================================================
// POST mod /v1/data/<TABEL>/JSONSTAT med ønskede variable.
// Eksempel: AUS07 = registreret ledighed. Tilpas variabler/koder
// til den konkrete tabel — se statbank.dk for tabellens metadata.
// -----------------------------------------------------------
const DST = "https://api.statbank.dk/v1";

// Generisk DST-hjælper: POST mod en tabel, returnér en simpel tidsserie
// [{periode, vaerdi}] med de nyeste `antal` perioder. DST har ingen
// "seneste N", så vi henter hele serien (Tid:"*") og slicer her.
async function dstSeries(table, variables, { antal = 12 } = {}) {
  const json = await getJSON(`${DST}/data/${table}/JSONSTAT`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table, format: "JSONSTAT", variables }),
  });
  // JSON-stat: værdier i .dataset.value, periode-labels i dimension.Tid.
  const ds = json.dataset || json;
  const values = ds.value || [];
  const tid = ds.dimension?.Tid?.category?.label
    ? Object.values(ds.dimension.Tid.category.label)
    : [];
  return tid
    .map((periode, i) => ({ periode, vaerdi: values[i] }))
    .slice(-antal);
}

// Lille generator til et nøgletals-endpoint, så hvert tal kun behøver
// tabel + variable + cache-nøgle. Variabel-koderne er slået op i hver
// tabels metadata (GET /v1/tableinfo/<TABEL>?format=JSON).
function nogletal({ key, table, variables, kilde, antal = 12, enhed }) {
  // Direkte link til tabellen i Statistikbanken (www.statistikbanken.dk/<TABEL>).
  const kildeLink = `https://www.statistikbanken.dk/${table}`;
  return async (_req, res) => {
    try {
      const serie = await cached(key, 720, () =>
        dstSeries(table, variables, { antal })
      );
      res.json({ ok: true, kilde, kildeLink, enhed, serie });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  };
}

// Bruttoledighed (sæsonkorrigeret antal). AUS07: YD=TOT, SAESONFAK=10.
app.get(
  "/api/ledighed",
  nogletal({
    key: "dst:aus07",
    table: "AUS07",
    variables: [
      { code: "YD", values: ["TOT"] },
      { code: "SAESONFAK", values: ["10"] },
      { code: "Tid", values: ["*"] },
    ],
    kilde: "Danmarks Statistik (AUS07)",
    enhed: "fuldtidsledige",
  })
);

// Beskæftigede i alt (1.000 personer, kvartal). AKU210K: kun Tid kræves;
// de øvrige variable elimineres til totaler.
app.get(
  "/api/beskaeftigelse",
  nogletal({
    key: "dst:aku210k",
    table: "AKU210K",
    variables: [{ code: "Tid", values: ["*"] }],
    kilde: "Danmarks Statistik (AKU210K)",
    enhed: "1.000 personer",
    antal: 8,
  })
);

// Ledige stillinger (sæsonkorrigeret antal, kvartal).
// LSK15: ENHED=LS (antal), SÆSON=10 (sæsonkorrigeret).
app.get(
  "/api/ledige-stillinger",
  nogletal({
    key: "dst:lsk15",
    table: "LSK15",
    variables: [
      { code: "ENHED", values: ["LS"] },
      { code: "SÆSON", values: ["10"] },
      { code: "Tid", values: ["*"] },
    ],
    kilde: "Danmarks Statistik (LSK15)",
    enhed: "ledige stillinger",
    antal: 8,
  })
);

// Lønudvikling: standardberegnet lønindeks, årsændring i pct. (kvartal).
// SBLON2: ARBFUNK=TOT (alle), VARIA1=215 (ændring ift. samme kvartal året før).
app.get(
  "/api/loen",
  nogletal({
    key: "dst:sblon2",
    table: "SBLON2",
    variables: [
      { code: "ARBFUNK", values: ["TOT"] },
      { code: "VARIA1", values: ["215"] },
      { code: "Tid", values: ["*"] },
    ],
    kilde: "Danmarks Statistik (SBLON2)",
    enhed: "% å/å",
    antal: 8,
  })
);

// Medlemmer af faglige organisationer (lønmodtagerorganisationer).
// LONMED2: MEDORG=00 (medlemmer i alt), KOEN=TOT. Årlig opgørelse pr. 31.12.
// Bemærk: DST har IKKE tal for a-kasse-medlemmer, flytninger mellem
// a-kasser eller arbejdsgiverorganisationer — de udgives af STAR
// (jobindsats.dk, kræver API-nøgle) og DA, ikke i Statistikbanken.
app.get(
  "/api/faglige",
  nogletal({
    key: "dst:lonmed2",
    table: "LONMED2",
    variables: [
      { code: "MEDORG", values: ["00"] },
      { code: "KOEN", values: ["TOT"] },
      { code: "Tid", values: ["*"] },
    ],
    kilde: "Danmarks Statistik (LONMED2)",
    enhed: "medlemmer",
    antal: 10,
  })
);

// Fordeling af lønmodtagerorganisationernes medlemmer på hovedorganisationer
// (LONMED2, MEDORG). Vi henter de to seneste år, så vi kan vise medlemstal
// og årsændring pr. hovedorganisation i en tabel.
app.get("/api/faglige-org", async (_req, res) => {
  try {
    const data = await cached("dst:lonmed2-org", 720, async () => {
      const json = await getJSON(`${DST}/data/LONMED2/JSONSTAT`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: "LONMED2",
          format: "JSONSTAT",
          variables: [
            { code: "MEDORG", values: ["*"] },
            { code: "KOEN", values: ["TOT"] },
            { code: "Tid", values: ["*"] },
          ],
        }),
      });
      const ds = json.dataset || json;
      const val = ds.value || [];
      const org = ds.dimension.MEDORG.category;
      const orgIdx = org.index; // {kode: position}
      const tidLabels = Object.values(ds.dimension.Tid.category.label);
      const nTid = tidLabels.length;
      const periode = tidLabels[nTid - 1];
      const forrigePeriode = tidLabels[nTid - 2];
      const rad = (kode) => {
        const i = orgIdx[kode];
        const vaerdi = val[i * nTid + (nTid - 1)];
        const forrige = val[i * nTid + (nTid - 2)];
        return {
          navn: org.label[kode],
          vaerdi,
          forrige,
          aendring: vaerdi != null && forrige != null ? vaerdi - forrige : null,
        };
      };
      // 00 = total; de øvrige er hovedorganisationerne.
      const koder = Object.keys(orgIdx).filter((k) => k !== "00");
      const organisationer = koder
        .map(rad)
        .sort((a, b) => (b.vaerdi || 0) - (a.vaerdi || 0));
      return { periode, forrigePeriode, organisationer, total: rad("00") };
    });
    res.json({
      ok: true,
      kilde: "Danmarks Statistik (LONMED2)",
      kildeLink: "https://www.statistikbanken.dk/LONMED2",
      enhed: "medlemmer",
      ...data,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Hvilken hovedorganisation hver enkelt organisation (LONMED3) hører under.
// DST har ikke selv koblingen, så den er bygget ud fra hovedorganisationernes
// egne medlemslister (Akademikerne + FH (fho.dk) + Lederne). Valideret mod
// LONMED2: ALLE fire kategorier summer PRÆCIST (FH 1.039.782, Akademikerne
// 359.050, Lederne 114.050, uden for 469.942). Nøgler matcher rensNavn-output.
const HOVEDORG = {
  "Fagligt Fælles Forbund": "FH", "HK/Danmark": "FH", "FOA - Fag og Arbejde": "FH",
  "2B - Bedst og Billigst - Det Faglige Hus": "UDEN", "Ingeniørforeningen i Danmark": "AC",
  "Lederne": "LED", "Krifa - Kristelig Fagforening": "UDEN", "ASE Lønmodtagere": "UDEN",
  "Jurist- og Økonomforbundet": "AC", "Dansk Metal": "FH", "Dansk Sygeplejeråd": "FH",
  "Dansk Magisterforening": "AC", "Børne- og Ungdoms Pædagogernes Landsorganisation": "FH",
  "Danmarks Lærerforening": "FH", "Fagforeningen Danmark - Det Faglige Hus": "UDEN",
  "Finansforbundet": "FH", "Socialpædagogerne": "FH", "FRIE Funktionærer": "UDEN",
  "Lægeforeningen": "AC", "Business Danmark": "UDEN", "Dansk EL-Forbund": "FH",
  "Funktionærkartellet/Teknikersammenslutningen - Det Faglige Hus": "UDEN",
  "Teknisk Landsforbund": "FH", "Dansk Socialrådgiverforening": "FH", "Fødevareforbundet NNF": "FH",
  "Politiforbundet i Danmark": "FH", "Serviceforbundet": "FH", "Frie Skolers Lærerforening": "FH",
  "Gymnasielærerne": "AC", "Dansk Journalistforbund": "UDEN", "Maskinmestrenes Forening": "UDEN",
  "PROSA - EDB-fagets fagforening": "FH", "Forsikringsforbundet": "FH", "Danske Fysioterapeuter": "AC",
  "Blik og Rørarbejderforbundet i Danmark": "FH", "Centralforeningen for Stampersonel": "FH",
  "Konstruktørforeningen": "AC", "Ergoterapeutforeningen": "AC", "Psykologforeningen": "AC",
  "Uddannelsesforbundet": "FH", "Spring": "LED", "Pharma-Danmark": "AC", "Luftfart og Jernbane": "FH",
  "Kost og Ernæringsforbundet": "FH", "Malerforbundet i Danmark": "FH", "Danske Bioanalytikere": "AC",
  "Arkitektforbundet": "AC", "Ejendoms- og Servicefunktionærernes Landsforbund": "FH",
  "Hærens Konstabel- og Korporalforening": "FH", "Dansk Musiker Forbund": "FH",
  "Farmakonomforeningen": "FH", "Dansk Journalistforbund under AC": "AC", "Forsvarsgruppen i AC": "AC",
  "Deltidsansatte Brandfolks Faglige Organisation": "FH", "Fængselsforbundet i Danmark": "FH",
  "Dansk Told- og Skatteforbund": "FH", "Jordemoderforening": "AC", "Præsteforeningen": "AC",
  "Radiograf Rådet i Danmark": "FH", "Tandlægeforeningen": "AC", "Dansk Skuespillerforbund": "FH",
  "Dansk Tandplejerforening": "FH", "Den Danske Dyrlægeforening": "AC", "Danske Fodterapeuter": "FH",
  "Dansk Artistforbund": "FH", "Spillerforeningen": "FH", "Foreningen af Mejeriledere og Funktionærer": "UDEN",
  "SAFU Sammenslutningen af Funktionærer": "FH", "Danske Skov- og Landskabsingeniører": "FH",
  "Danske psykomotoriske Terapeuter": "FH", "Den Danske Landinspektørforening - LSP": "AC",
  "FAF - Film- og TV-arbejderforeningen": "FH", "JID": "FH", "Håndbold Spillerforeningen": "FH",
  "Trafikforbundet": "FH", "De offentlige tandlæger": "AC", "Kort- og Landmålingsteknikernes Forening": "FH",
  "Danmarks Kordegneforening": "FH", "Fagforeningen Musiker og Musikunderviser": "AC",
  "Merkonomernes Hovedorganisation": "UDEN", "Funktionærforeningen Carlsberg": "UDEN",
  "Dansk Formands Forening": "UDEN", "Organistforeningen": "FH", "Dansk Organist og Kantor Samfund": "AC",
  "Det Offentlige Beredskabspersonales Landsforbund": "FH", "Kirkekultur.nu": "FH",
  "Frederiksberg Kommunalforening": "FH", "Dansk Kirkemusiker Forening": "FH",
  "Dansk Kiropraktor Forening": "AC", "Gentofte Kommunalforening": "FH", "Mejeriingeniørforeningen": "AC",
  "Danske Scenografer": "UDEN", "Medieforbundet i Danmarks Radio": "FH",
  "Hi - Organisation for ledende medarbejdere i idræt-kultur-fritid": "FH",
  "Dansk Billedkunstneres Forbund - BKF": "AC", "Cabin Union Denmark": "FH",
  "Foreningen af danske inseminører": "FH", "Foreningen af danske Sceneinstruktører": "UDEN",
  "Foreningen af Danske Kirkegårdsledere": "FH", "Dansk Elitesportsudøveres Forening (DEF-Sport)": "FH",
  "Hoffunktionærforeningen": "FH",
};
// Visningsnavn pr. hovedorganisations-kode.
const HOVEDORG_NAVN = { FH: "FH", AC: "Akademikerne", LED: "Lederne", UDEN: "Uden for" };

// Den fulde liste: medlemstal for ALLE enkelte lønmodtagerorganisationer
// (LONMED3, MEDORG). Vi viser kun organisationer med et aktuelt tal (de
// historiske/nedlagte har null i seneste år) og sorterer efter størrelse.
app.get("/api/faglige-alle", async (_req, res) => {
  try {
    const data = await cached("dst:lonmed3-alle", 720, async () => {
      const json = await getJSON(`${DST}/data/LONMED3/JSONSTAT`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: "LONMED3",
          format: "JSONSTAT",
          variables: [
            { code: "MEDORG", values: ["*"] },
            { code: "KOEN", values: ["TOT"] },
            { code: "Tid", values: ["*"] },
          ],
        }),
      });
      const ds = json.dataset || json;
      const val = ds.value || [];
      const org = ds.dimension.MEDORG.category;
      const orgIdx = org.index;
      const tidLabels = Object.values(ds.dimension.Tid.category.label);
      const nTid = tidLabels.length;
      const periode = tidLabels[nTid - 1];
      const forrigePeriode = tidLabels[nTid - 2];
      // Rens årstal-parenteser i organisationsnavne, fx "( -2022)".
      const rensNavn = (s = "") => s.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const rad = (kode) => {
        const i = orgIdx[kode];
        const vaerdi = val[i * nTid + (nTid - 1)];
        const forrige = val[i * nTid + (nTid - 2)];
        const navn = rensNavn(org.label[kode]);
        const hoved = HOVEDORG[navn] || "UDEN";
        return {
          navn,
          vaerdi,
          forrige,
          aendring: vaerdi != null && forrige != null ? vaerdi - forrige : null,
          hoved,
          hovedNavn: HOVEDORG_NAVN[hoved],
        };
      };
      const organisationer = Object.keys(orgIdx)
        .filter((k) => k !== "00")
        .map(rad)
        .filter((r) => r.vaerdi != null) // kun organisationer med aktuelt tal
        .sort((a, b) => (b.vaerdi || 0) - (a.vaerdi || 0));
      return { periode, forrigePeriode, organisationer, total: rad("00") };
    });
    res.json({
      ok: true,
      kilde: "Danmarks Statistik (LONMED3)",
      kildeLink: "https://www.statistikbanken.dk/LONMED3",
      enhed: "medlemmer",
      antal: data.organisationer.length,
      ...data,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Arbejdsgiverorganisationer — medlemsVIRKSOMHEDER. Disse tal findes IKKE i
// DST og har intet åbent API, så de er manuelt indsamlet fra organisationernes
// egne sider/årsrapporter (2024–2025). Vises tydeligt adskilt fra live-data:
// enheden er virksomheder (ikke personer), og tallene kan IKKE lægges sammen
// pga. stor overlap mellem organisationerne. Opdateres manuelt her i koden.
const DA_KILDE = "https://www.da.dk/om-da/medlemsorganisationer/";
app.get("/api/arbejdsgivere", (_req, res) => {
  res.json({
    ok: true,
    statisk: true,
    enhed: "medlemsvirksomheder",
    opdateret: "2024–2025",
    note:
      "Manuelt indsamlede tal fra organisationernes egne sider/årsrapporter — " +
      "ikke DST og ikke live. Enheden er virksomheder (ikke personer), og tallene " +
      "kan ikke lægges sammen pga. overlap mellem organisationerne.",
    organisationer: [
      { navn: "DA – Dansk Arbejdsgiverforening", antalTekst: "~23.000", rolle: "Paraply for 11 arbejdsgiverorg.", kildeLink: DA_KILDE },
      { navn: "DI – Dansk Industri", antalTekst: "~20.000", rolle: "Medlem af DA · ~650.000 ansatte", kildeLink: "https://www.danskindustri.dk/om-di/" },
      { navn: "Dansk Erhverv", antalTekst: "18.000", rolle: "Medlem af DA · +100 brancheforeninger", kildeLink: "https://www.danskerhverv.dk/om-dansk-erhverv/" },
      { navn: "SMVdanmark", antalTekst: "~18.000", rolle: "Uden for DA · små/mellemstore virksomheder", kildeLink: "https://smvdanmark.dk/" },
      { navn: "TEKNIQ Arbejdsgiverne", antalTekst: "~4.100", rolle: "Medlem af DA · el/vvs/industri", kildeLink: DA_KILDE },
      { navn: "Sama", antalTekst: ">4.000", rolle: "Medlem af DA · 5 medlemsorg.", kildeLink: DA_KILDE },
      { navn: "Dansk Mode & Textil", antalTekst: ">375", rolle: "Medlem af DA", kildeLink: DA_KILDE },
      { navn: "Danske Rederier", antalTekst: ">40 rederier", rolle: "Medlem af DA", kildeLink: DA_KILDE },
    ],
  });
});

// Beskæftigelse fordelt på brancheområder (LBESK03 — lønmodtagere,
// sæsonkorrigeret, månedlig). BRANCHEDB071038 i ren 10-gruppering. Vi
// viser seneste måned + ændring ift. forrige måned og samme måned året
// før, så både niveau og udvikling pr. branche fremgår.
const BRANCHE_KORT = {
  TOT: "Erhverv i alt",
  "1": "Landbrug, skovbrug & fiskeri",
  "2": "Industri & forsyning",
  "3": "Bygge & anlæg",
  "4": "Handel & transport mv.",
  "5": "Information & kommunikation",
  "6": "Finansiering & forsikring",
  "7": "Ejendomshandel & udlejning",
  "8": "Erhvervsservice",
  "9": "Offentlig adm., undervisning & sundhed",
  "10": "Kultur, fritid & anden service",
};
app.get("/api/branche-beskaeftigelse", async (_req, res) => {
  try {
    const data = await cached("dst:lbesk03-branche", 720, async () => {
      const koder = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
      const json = await getJSON(`${DST}/data/LBESK03/JSONSTAT`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: "LBESK03",
          format: "JSONSTAT",
          variables: [
            { code: "BRANCHEDB071038", values: ["TOT", ...koder] },
            { code: "Tid", values: ["*"] },
          ],
        }),
      });
      const ds = json.dataset || json;
      const val = ds.value || [];
      const br = ds.dimension.BRANCHEDB071038.category;
      const brIdx = br.index; // {kode: position}
      const tidLabels = Object.values(ds.dimension.Tid.category.label);
      const nTid = tidLabels.length;
      const periode = tidLabels[nTid - 1];
      const forrigeMaaned = tidLabels[nTid - 2];
      const aaretFoer = tidLabels[nTid - 13];
      const rad = (kode) => {
        const i = brIdx[kode];
        const vaerdi = val[i * nTid + (nTid - 1)];
        const forrige = val[i * nTid + (nTid - 2)];
        const foer = val[i * nTid + (nTid - 13)];
        return {
          navn: br.label[kode],
          kort: BRANCHE_KORT[kode] || br.label[kode],
          vaerdi,
          aendringMaaned:
            vaerdi != null && forrige != null ? vaerdi - forrige : null,
          aendringAar: vaerdi != null && foer != null ? vaerdi - foer : null,
        };
      };
      const brancher = koder
        .map(rad)
        .sort((a, b) => (b.vaerdi || 0) - (a.vaerdi || 0));
      return { periode, forrigeMaaned, aaretFoer, brancher, total: rad("TOT") };
    });
    res.json({
      ok: true,
      kilde: "Danmarks Statistik (LBESK03)",
      kildeLink: "https://www.statistikbanken.dk/LBESK03",
      enhed: "lønmodtagere",
      ...data,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// =====================================================================
// 3) NYHEDER & DEBAT  (erstatter sociale medier)
// =====================================================================
// I stedet for at scrape X/LinkedIn (API-licens + GDPR) henter vi danske
// nyheds-/debat-RSS-feeds og filtrerer på det valgte emne. Det er gratis,
// kræver ingen nøgle, og er GDPR-venligt: vi viser kun overskrift, medie,
// dato og link til kilden — vi lagrer ingen persondata.
//
// Standardkilde: Altinget (dansk politisk medie, har et arbejdsmarked-feed).
// Valgfrit: sæt SEARCH_API_KEY for i stedet at bruge NewsAPI.org.
// -----------------------------------------------------------
const RSS_FEEDS = [
  { medie: "Altinget", url: "https://www.altinget.dk/arbejdsmarked/rss" },
  { medie: "Altinget", url: "https://www.altinget.dk/rss" },
  { medie: "Fagbladet 3F", url: "https://fagbladet3f.dk/rss" },
  { medie: "DR Penge", url: "https://www.dr.dk/nyheder/service/feeds/penge" },
  { medie: "DR Politik", url: "https://www.dr.dk/nyheder/service/feeds/politik" },
  // Fagbevægelsens egen kilde + A4 Medier (arbejdsmarkeds-journalistik).
  // A4 har ingen RSS, så vi læser deres Google News-sitemap i stedet.
  { medie: "FH", url: "https://fho.dk/feed/" },
  { medie: "A4 Medier", url: "https://www.a4medier.dk/news-sitemap.xml", parse: parseNyhedsSitemap },
];

// Hent rå tekst (RSS er XML, ikke JSON).
async function getText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "AMP-Dashboard/1.0 (+nyhedsfeed)" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fra ${url}`);
  return r.text();
}

// Afkod HTML-entiteter (RSS-titler bruger fx &#230; for æ).
function decodeEntities(s = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (n.toLowerCase() in named ? named[n.toLowerCase()] : m));
}

const pick = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")).trim();
};

// Parse RSS-items til {titel, link, tid, uddrag} fra én feed.
function parseRSS(xml, medie) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const b = m[1];
    return {
      titel: pick(b, "title"),
      link: pick(b, "link") || pick(b, "guid"),
      tid: pick(b, "pubDate"),
      uddrag: pick(b, "description").slice(0, 200),
      medie,
    };
  });
}

// Parse en Google News-sitemap (fx A4 Medier, der ikke har RSS) til samme
// format. Hver <url> har <loc>, <news:title> og <news:publication_date>.
function parseNyhedsSitemap(xml, medie) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)]
    .map((m) => {
      const b = m[1];
      return {
        titel: pick(b, "news:title"),
        link: pick(b, "loc"),
        tid: pick(b, "news:publication_date"),
        uddrag: "",
        medie,
      };
    })
    .filter((a) => a.titel && a.link);
}

app.get("/api/debat", async (req, res) => {
  const q = (req.query.q || "dagpenge").toString();
  try {
    // Opt-in: brug NewsAPI hvis en nøgle er sat, ellers de gratis danske feeds.
    const key = process.env.SEARCH_API_KEY;
    if (key) {
      const data = await cached(`news:${q}`, 30, async () => {
        const url =
          `https://newsapi.org/v2/everything?` +
          `q=${encodeURIComponent(q + " arbejdsmarked")}` +
          `&language=da&sortBy=publishedAt&pageSize=6`;
        const json = await getJSON(url, { headers: { "X-Api-Key": key } });
        return (json.articles || []).map((a) => ({
          titel: a.title,
          medie: a.source?.name,
          tid: a.publishedAt,
          uddrag: a.description,
          link: a.url,
        }));
      });
      return res.json({ ok: true, kilde: "NewsAPI", emne: q, artikler: data });
    }

    // De rå feeds hentes og caches ÉN gang (delt på tværs af ALLE emner), så
    // vi ikke genhenter 7 eksterne feeds for hvert emne — det var skrøbeligt
    // og langsomt. Emnet filtreres bagefter i hukommelsen.
    const hentPool = async () => {
      const settled = await Promise.allSettled(
        RSS_FEEDS.map(async (f) => (f.parse || parseRSS)(await getText(f.url), f.medie))
      );
      const alle = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      const set = new Map();
      for (const a of alle) if (a.link && !set.has(a.link)) set.set(a.link, a);
      return [...set.values()].sort((a, b) => new Date(b.tid) - new Date(a.tid));
    };
    let pool = await cached("rss:pool", 20, hentPool);
    // Tom pulje = alle feeds timede ud (typisk kold start) → prøv igen frem
    // for at cache en tom liste i 20 min.
    if (!pool.length) {
      cache.delete("rss:pool");
      pool = await cached("rss:pool", 20, hentPool);
    }
    // Filtrér på emnet (i titel eller uddrag). Falder tilbage til de nyeste
    // arbejdsmarkeds-artikler hvis emnet ikke nævnes.
    const term = q.toLowerCase();
    const match = pool.filter(
      (a) =>
        a.titel.toLowerCase().includes(term) ||
        a.uddrag.toLowerCase().includes(term)
    );
    const traf = match.length > 0;
    const result = { artikler: (traf ? match : pool).slice(0, 6), traf };

    res.json({
      ok: true,
      kilde: "Altinget · Fagbladet 3F · DR · FH · A4 Medier",
      kildeLink: "https://www.altinget.dk/arbejdsmarked",
      emne: q,
      note: result.traf
        ? undefined
        : `Ingen artikler nævner "${q}" lige nu — viser seneste arbejdsmarkeds-nyheder.`,
      artikler: result.artikler,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// =====================================================================
// 4) PARTIERNES HJEMMESIDER  — hvad skriver partierne om emnet?
// =====================================================================
// Partierne har ingen fælles API. Nogle kører WordPress, hvis REST-API
// (/wp-json/wp/v2/posts?search=) kan søge direkte i deres indhold — dem
// henter vi live-indlæg fra. For ALLE folketingspartier giver vi desuden
// et "søg på partiets hjemmeside"-link (Google site-søgning), så emnet
// kan slås op uanset partiets CMS. Vi viser kun overskrift, dato, uddrag
// og link til partiets egen side — ingen persondata lagres.
// -----------------------------------------------------------
const PARTIER = [
  { navn: "Socialdemokratiet", dom: "socialdemokratiet.dk" },
  { navn: "Venstre", dom: "venstre.dk" },
  { navn: "Moderaterne", dom: "moderaterne.dk", wp: "https://moderaterne.dk" },
  { navn: "SF", dom: "sf.dk" },
  { navn: "Danmarksdemokraterne", dom: "danmarksdemokraterne.dk" },
  { navn: "Liberal Alliance", dom: "liberalalliance.dk", wp: "https://www.liberalalliance.dk" },
  { navn: "Det Konservative Folkeparti", dom: "konservative.dk" },
  { navn: "Enhedslisten", dom: "enhedslisten.dk", wp: "https://enhedslisten.dk" },
  { navn: "Radikale Venstre", dom: "radikale.dk" },
  { navn: "Dansk Folkeparti", dom: "danskfolkeparti.dk" },
  { navn: "Alternativet", dom: "alternativet.dk" },
];

// Rens HTML-tekst (fjern tags + afkod entiteter), brugt til WP-uddrag.
const renTekst = (s = "") =>
  decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();

// Træk de sætninger ud af en tekst der nævner emnet — et simpelt
// "ekstraktivt" resume (ingen AI): vi citerer partiets egne ord om emnet.
function emneSaetninger(tekst, q, maks = 3) {
  const term = q.toLowerCase();
  return tekst
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 320 && s.toLowerCase().includes(term))
    .slice(0, maks);
}

async function wpSoeg(base, q) {
  const url =
    `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}` +
    `&per_page=3&_fields=title,link,date,excerpt,content`;
  const r = await fetch(url, {
    headers: { "User-Agent": "AMP-Dashboard/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const arr = await r.json();
  const indlaeg = (Array.isArray(arr) ? arr : []).map((p) => ({
    titel: renTekst(p.title?.rendered),
    tid: p.date,
    uddrag: renTekst(p.excerpt?.rendered).slice(0, 180),
    indhold: renTekst(p.content?.rendered),
    link: p.link,
  }));
  // Emneresume: saml emne-sætninger på tværs af partiets indlæg.
  const resume = [];
  for (const i of indlaeg) {
    for (const s of emneSaetninger(i.indhold, q)) {
      if (resume.length < 3 && !resume.includes(s)) resume.push(s);
    }
  }
  // Drop det tunge råindhold inden vi sender svaret videre.
  return { indlaeg: indlaeg.map(({ indhold, ...rest }) => rest), resume };
}

app.get("/api/partier", async (req, res) => {
  const q = (req.query.q || "dagpenge").toString();
  try {
    const data = await cached(`partier:${q}`, 60, async () => {
      const settled = await Promise.allSettled(
        PARTIER.map(async (p) => {
          const soegelink = `https://www.google.com/search?q=${encodeURIComponent(
            `${q} site:${p.dom}`
          )}`;
          let indlaeg = [];
          let resume = [];
          if (p.wp) {
            try {
              const r = await wpSoeg(p.wp, q);
              indlaeg = r.indlaeg;
              resume = r.resume;
            } catch {
              /* parti utilgængeligt → vis kun søgelink */
            }
          }
          return {
            parti: p.navn,
            hjemmeside: `https://${p.dom}`,
            soegelink,
            resume,
            indlaeg,
          };
        })
      );
      return settled.map((s) => s.value);
    });
    res.json({ ok: true, kilde: "partiernes hjemmesider", emne: q, partier: data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// --- Statiske filer (frontend) ---------------------------------------
app.use(express.static(path.join(__dirname, "..", "public")));

// Bind eksplicit til 0.0.0.0, så hosting-platforme (Render m.fl.) kan nå
// serveren udefra. Nodes standard binder ellers til IPv6 (::), hvilket kan
// give intermitterende "no-server"/routing-fejl på nogle platforme.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AMP-dashboard kører på port ${PORT}`);
});
