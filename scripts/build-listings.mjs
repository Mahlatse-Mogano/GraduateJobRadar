// Runs on Netlify at build time: fetches open, approved listings from Supabase once
// and writes them to public/listings.json, which visitors load from Netlify's cache.
// If Supabase can't be reached the build fails, so Netlify keeps the last good version live.
import { writeFile } from "node:fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://lczruefjljcgxrgdhtdp.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_5dkMWxG7VTfUyduFXPMXTA_EDmcgpwR";
const FIELDS = "title,provider,type,field,provinces,closing_date,url,first_seen_at";

const res = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?select=${FIELDS}&order=closing_date.asc.nullslast&limit=1000`, {
  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
});
if (!res.ok) throw new Error(`Supabase returned ${res.status}: ${await res.text()}`);
const listings = await res.json();
if (!Array.isArray(listings)) throw new Error("Unexpected response from Supabase");

const out = { generated_at: new Date().toISOString(), count: listings.length, listings };
await writeFile(new URL("../public/listings.json", import.meta.url), JSON.stringify(out));
console.log(`Wrote ${listings.length} listings to public/listings.json`);
