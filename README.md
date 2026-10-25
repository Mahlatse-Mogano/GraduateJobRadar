# GraduateJobRadar

Free daily list of open learnerships, bursaries, internships and graduate programmes in South Africa.
Every listing links to the official application page.

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Website | `public/index.html` → Netlify | Shows open listings with type, industry and province filters. Reads live data from Supabase on every visit. |
| Daily search | `supabase/functions/sweep` | 05:00 SAST: collects adverts from SETA, DPSA and youth-opportunity sites; keeps the official apply link. |
| Daily link check | `supabase/functions/check-links` | 05:15 SAST: opens every link; keeps only open calls; reads closing dates; drops dead or info-only pages. |
| Database | Supabase project "Learnership Radar" | `opportunities`, `sources`, `sweep_runs`. Public can read approved, open listings only. |

## Deploying

- **Website:** push to `main` and Netlify publishes it automatically (about 30 seconds).
- **Listings:** no deploy needed. They update in the database every morning and the page reads them live.
- **Functions:** deployed to Supabase separately (`supabase functions deploy sweep` / `check-links`).

The key in `index.html` is Supabase's public read-only key; database rules limit it to approved, open listings.
