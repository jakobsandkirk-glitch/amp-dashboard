# AMP-Dashboard — projektoversigt og handover

Et arbejdsmarkedspolitisk dashboard til en dansk kontekst (politik, debat
og interessevaretagelse). Dette dokument er en handover, så en udvikler —
eller Claude Code — hurtigt kan tage over.

## Formål

Samle de centrale arbejdsmarkedspolitiske tal og den politiske aktivitet
ét sted: nøgletal, politiske temaer, partipositioner, og hvad der sker i
Folketinget. Bruges til analyse og interessevaretagelse.

## Status lige nu

- **Designprototype** færdig (statisk HTML, alle tal er pladsholdere) —
  viser den ønskede struktur: overblik, politiske temaer med drawer,
  partimatrix, social/debat-felt og Folketings-sektion pr. tema.
- **Live-version** påbegyndt (denne mappe). Backend + frontend der henter
  ægte data fra to gratis, åbne kilder. **Ikke testet mod live-API'er**,
  fordi den blev skrevet i et miljø uden netadgang. Første opgave er at
  køre den og rette de kald der fejler.

## Aktuel beslutning om datakilder

**Med i første version (gratis, åbne, ingen nøgle):**
1. **Folketinget** — oda.ft.dk (OData-API). Sager, udvalg, afstemninger.
2. **Danmarks Statistik** — api.statbank.dk. Fx ledighed (AUS07).

**Bevidst holdt ude i første omgang:**
3. **Nyheds-/debatsøgning** — koden findes i `server/index.js` (endpointet
   `/api/debat`) men er deaktiveret uden en `SEARCH_API_KEY`. Tilføjes
   først når 1+2 kører stabilt. Erstatter sociale medier (X/LinkedIn er
   fravalgt pga. API-licens + GDPR ved navngivne personer).

## Arkitektur

```
amp-live/
├─ package.json        Node 18+, eneste afhængighed: express
├─ server/index.js     Backend: henter data, cacher, udstiller eget API
└─ public/index.html   Frontend: kalder backend og viser data
```

Frontenden kalder aldrig de eksterne kilder direkte — den kalder vores
egen backend, som henter, cacher og forenkler svaret. Det holder
nøgler skjult, respekterer kildernes rate limits, og gør frontenden
simpel.

### Backend-endpoints
- `GET /api/folketinget?q=<emne>` → seneste sager fra oda.ft.dk
- `GET /api/ledighed`            → tidsserie fra Danmarks Statistik (AUS07)
- `GET /api/debat?q=<emne>`      → nyheder (tom uden SEARCH_API_KEY)

## Kør lokalt

Kræver Node.js 18+.

```bash
npm install
npm start
# åbn http://localhost:3000
```

## Kendte ting der skal løses (i prioriteret rækkefølge)

1. **Verificér Folketings-kaldet.** Kør appen, vælg et emne, se om
   sagslisten fyldes. oda.ft.dk bruger æ/ø/å i entitets- og feltnavne
   og `substringof('ord',titel)` til "indeholder". Juster ved behov.
2. **Ret Danmarks Statistik-kaldet.** AUS07 kan kræve flere obligatoriske
   variable end angivet. Tjek tabellens metadata:
   `GET https://api.statbank.dk/v1/tableinfo/AUS07?format=JSON`
   og udfyld `variables` i `server/index.js` med de gyldige koder.
3. **Udvid Folketings-data.** Brug OData `$expand` til at hente
   udvalgsbehandlinger og afstemninger pr. sag, så Folketings-sektionen
   fra prototypen bliver ægte.
4. **Kobl flere nøgletal på** fra Danmarks Statistik (beskæftigelse,
   løn, ledige stillinger) — samme mønster som ledigheds-kaldet.
5. **Senere:** tilføj nyhedssøgning (vælg udbyder, sæt SEARCH_API_KEY).
6. **Senere:** flet det visuelle design fra prototypen ind i live-frontenden.

## Online-hosting (når det kører lokalt)

- **Nemmest:** Render.com eller Railway — peg på et GitHub-repo,
  build `npm install`, start `npm start`, evt. nøgle som miljøvariabel.
- **Mest kontrol:** VPS (Hetzner/DigitalOcean) med Node bag pm2 + Nginx
  + gratis HTTPS via Let's Encrypt.
- **GDPR ved offentliggørelse:** hvis nyheder tilføjes, vis kun
  overskrift + link til kilden; lagr ikke persondata; kreditér kilden.

## Til Claude Code / udvikler — foreslået første session

1. `npm install && npm start`, åbn dashboardet.
2. Se hvilke af de to datakald der virker, og hvilke der fejler.
3. Ret Danmarks Statistik-kaldet ved at slå AUS07's metadata op (se pkt. 2
   ovenfor) og indsætte de korrekte variabel-koder.
4. Bekræft at Folketings-listen viser rigtige, aktuelle sager.
5. Commit en fungerende baseline, og gå derefter videre til pkt. 3–4
   i listen ovenfor.
```
