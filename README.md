# AMP-Dashboard — live-version

Et arbejdsmarkedspolitisk dashboard der henter **live data** fra gratis,
offentlige kilder, og som kan suppleres med nyhedssøgning i stedet for
sociale medier.

## Hvad henter den — og hvad koster det

| Kilde | Hvad | Nøgle? | Pris |
|---|---|---|---|
| **oda.ft.dk** | Folketingssager, udvalg, afstemninger | Nej | Gratis |
| **api.statbank.dk** | Danmarks Statistik (fx ledighed AUS07) | Nej | Gratis |
| **Nyhedssøgning** | Artikler/debat om hvert emne | Ja | Varierer* |

\* Nyhedssøgning kræver én udbyder-nøgle. Muligheder: NewsAPI.org / GNews
(billige, internationale), Brave Search API, Bing News (Azure), eller
**Infomedia** (dansk, dyrest, men mest komplet til danske medier).
Uden nøgle virker resten af dashboardet fint — nyhedsfeltet er bare tomt.

### Hvorfor nyhedssøgning i stedet for sociale medier
At hente rigtige opslag fra X/LinkedIn kræver betalt API-adgang, er
teknisk skørt, og rejser GDPR-spørgsmål når man viser navngivne
personers ytringer. Nyheder og debatindlæg er lovligt tilgængelige,
har bedre kildeangivelse, og er ofte mere brugbare i interessevaretagelse.

## Kør lokalt

Kræver Node.js 18 eller nyere.

```bash
npm install
npm start
# åbn http://localhost:3000
```

For at aktivere nyhedssøgning, sæt en miljøvariabel før start:

```bash
SEARCH_API_KEY=din_noegle npm start
```

## Vigtigt om datakilderne

- **Statbank (AUS07):** Tabellen kan kræve flere obligatoriske variable
  end vist. Kør `GET https://api.statbank.dk/v1/tableinfo/AUS07?format=JSON`
  for at se de gyldige koder, og udfyld `variables` i `server/index.js`.
- **oda.ft.dk:** Entitets- og feltnavne bruger æ/ø/å. Søgningen bruger
  `substringof('ord', titel)`. Du kan udvide med `$expand` for at hente
  fx udvalgsbehandlinger og afstemninger.
- Alle svar caches (10–720 min) for ikke at belaste kilderne unødigt.

---

## Sådan lægger du det online

Appen er en helt almindelig Node-webapp. Tre realistiske veje, fra
nemmest til mest fleksibel:

### A) Render.com / Railway (nemmest — anbefalet til start)
1. Læg koden i et GitHub-repo.
2. Opret en gratis/billig "Web Service" på render.com og peg på repoet.
3. Build-kommando: `npm install` · Start-kommando: `npm start`.
4. Tilføj `SEARCH_API_KEY` som miljøvariabel i deres dashboard.
5. Færdig — du får en URL som `https://amp-dashboard.onrender.com`.

### B) Et VPS (mest kontrol)
Fx Hetzner eller DigitalOcean (en lille server koster typisk få euro/md):
1. Installér Node 18+ og kør appen bag `pm2` (holder den kørende).
2. Sæt Nginx foran som reverse proxy + gratis HTTPS via Let's Encrypt.
3. Peg et domæne på serveren.

### C) Adskilt frontend + serverless backend
Læg `public/` på et CDN (Netlify/Vercel/Cloudflare Pages) og lav
backend-endpoints som serverless functions. Mere arbejde, men skalerer
og er billigt ved svingende trafik.

### Inden offentlig udgivelse — huskeliste
- **GDPR:** Vis kun nyhedsoverskrifter + link til kilden; undlad at
  lagre persondata. Kreditér altid kilden.
- **Rate limits & cache:** Behold cachen, så I respekterer kildernes API.
- **Vilkår:** Tjek den valgte nyhedsudbyders vilkår for visning/lagring.
- **Tonemarkering:** Hvis I genindfører "medhold/neutral/kritik", så lad
  det være manuelt kodet — automatisk dansk toneanalyse er upålidelig.

## Filer
```
amp-live/
├─ package.json
├─ server/index.js     ← backend: henter live data, cacher, udstiller API
└─ public/index.html   ← frontend: kalder backend og viser data
```
