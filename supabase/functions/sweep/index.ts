import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { clean, decode, findClosingDate, isGenericTitle, mainText } from "./shared.ts";

// Learnership Radar daily sweep (v2).
// Reads each source page, follows its general category pages (Internships, Bursaries...) one step
// to reach the specific adverts, and stores new adverts as pending for the link check to verify.
// Auth: header x-sweep-secret must match app_config.sweep_secret. Optional ?source_id=3.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const KEYWORDS = /learnership|bursar|internship|\bintern\b|apprentice|graduate\s+(programme|program|development)|candidacy|work[\s-]integrated|\bcadet|trainee|skills\s+programme|\bwil\b/i;
const EXCLUDE = /annual\s+report|tender|\brfq\b|\brfp\b|privacy|popia|paia|login|log\s*in|sign\s*in|terms|cookie|facebook\.com|twitter\.com|x\.com\/|linkedin\.com|instagram\.com|youtube\.com|wa\.me|mailto:|tel:|javascript:|\/feed\/?$|\/tag\/|\/author\/|grant(ed)?\s+(list|approved)|successful\s+(applicants|candidates)|shortlist|results|awarded|circular|policy|guidelines?\b|template|report|study|\.xlsx?$|\.docx?$/i;
const GENERIC_TEXT = /^(read\s+more|more|click\s+here|apply(\s+now)?|view(\s+more)?\.*|veiw\s+advert|view\s+advert|download|here|details|learn\s+more|find\s+out\s+more)$/i;
const PROVINCES: [RegExp, string][] = [
  [/gauteng/i, "Gauteng"], [/western\s+cape/i, "Western Cape"], [/eastern\s+cape/i, "Eastern Cape"],
  [/northern\s+cape/i, "Northern Cape"], [/free\s+state/i, "Free State"], [/kwazulu[\s-]*natal|\bkzn\b/i, "KwaZulu-Natal"],
  [/limpopo/i, "Limpopo"], [/mpumalanga/i, "Mpumalanga"], [/north[\s-]+west/i, "North West"],
];
const SCAM_RULES: [RegExp, string][] = [
  [/(application|registration|admin(istration)?|processing)\s+fee/i, "mentions_fee"],
  [/send\s+money|pay\s+(a|the|r\d)|deposit\s+of/i, "asks_payment"],
  [/whats\s*app\s*(\+|0)\d/i, "whatsapp_number"],
];
const FREE_HOSTS = /blogspot\.|wordpress\.com|wixsite\.com|weebly\.com|sites\.google\.com/i;
const UA = "Mozilla/5.0 (compatible; LearnershipRadarBot/0.2; public listing aggregator; links back to source)";

function titleFromUrl(u: URL) {
  const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const t = decodeURIComponent(slug).replace(/\.(html?|php|aspx|pdf)$/i, "").replace(/[-_]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}
function inferType(t: string) {
  if (/bursar/i.test(t)) return "bursary";
  if (/learnership/i.test(t)) return "learnership";
  if (/apprentice/i.test(t)) return "apprenticeship";
  if (/graduate/i.test(t)) return "graduate_programme";
  if (/intern|work[\s-]integrated|\bwil\b|candidacy|trainee|cadet/i.test(t)) return "internship";
  return "other";
}

async function fetchHtml(url: string, ms: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) { await res.body?.cancel(); throw new Error("not html"); }
    return { html: await res.text(), base: new URL(res.url || url) };
  } finally {
    clearTimeout(timer);
  }
}

type Cand = { href: string; title: string; hay: string };

function extract(html: string, base: URL) {
  const adverts: Cand[] = [];
  const categories: string[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    let u: URL;
    try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = "";
    const href = u.toString();
    if (seen.has(href) || href.replace(/\/$/, "") === base.toString().replace(/\/$/, "")) continue;
    seen.add(href);
    let text = clean(m[2]);
    const hay = `${text} ${decodeURIComponent(u.pathname)}`;
    if (!KEYWORDS.test(hay) || EXCLUDE.test(hay) || EXCLUDE.test(href)) continue;
    if (!text || text.length < 6 || GENERIC_TEXT.test(text)) text = titleFromUrl(u);
    if (!text || text.length < 3) continue;
    text = text.slice(0, 300);
    if (isGenericTitle(text)) {
      if (u.hostname === base.hostname) categories.push(href);
    } else {
      adverts.push({ href, title: text, hay });
    }
  }
  return { adverts, categories };
}

type Source = { id: number; name: string; url: string; mode: string };

// ---------- Aggregator mode: read single-advert articles, keep the official apply link ----------
const ROUNDUP = /still\s+open|closing\s+(from|by|soon|this|on|in)|apply\s+before\s+the\s+deadline|list\s+of|top\s+\d+|\d+\s+(learnerships|bursaries|internships)|weekly|round[\s-]?up|how\s+to|tips|guide|status\s+check|results|shortlist/i;
const APPLY_TEXT = /apply|application|click\s+here|submit|register\s+here|official\s+(site|website|portal)/i;
const BAD_HOSTS = /facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|wa\.me|whatsapp\.com|t\.me|pinterest\.|google(adservices|syndication)?\.com\/(aclk|ads)|doubleclick|studentroom\.co\.za|graduates24|joblaunch|nasi-ispani|allbursaries|nextstepza|grads24|mabumbe|wordpress\.org|gravatar/i;
const NEGATED_FEE = /(no|never|not|free|don.t|do\s+not|without|zero)\b[^.]{0,40}$/i;

const PAY_ASK = /\b(pay|paid|payment|deposit|send|transfer|eft|e-wallet|airtime|R\s?\d+)/i;
const COVERED = /\b(cover|covers|covered|coverage|include|includes|included|pays?\s+for|will\s+pay|bursary\s+pays|funded|funding|tuition)\b/i;

// Flags a fee only when the advert asks the applicant to pay it (not "the bursary covers registration fees").
function hasRealFee(text: string) {
  for (const m of text.matchAll(/(application|registration|admin(istration)?|processing)\s+fees?/gi)) {
    const i = m.index ?? 0;
    const before = text.slice(Math.max(0, i - 60), i);
    const around = text.slice(Math.max(0, i - 60), i + m[0].length + 60);
    if (NEGATED_FEE.test(before) || COVERED.test(around)) continue;
    if (PAY_ASK.test(around)) return true;
  }
  return false;
}

function providerFromTitle(title: string, fallback: string) {
  const m = title.match(/^(.*?)\s+(learnerships?|bursar(y|ies)|internships?|graduate|trainee|apprentice\w*|yes\b|in-?service|candidate|cadet|work[\s-]integrated|applications?)/i);
  const p = m?.[1]?.replace(/[:\-–|]+$/, "").trim();
  return p && p.length >= 2 && p.length <= 80 ? p : fallback;
}

// Follows an aggregator's own apply/redirect page and returns the employer's URL (or null).
async function resolveRedirect(url: string, aggregatorHost: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
    let final = new URL(res.url || url);
    if (final.hostname === aggregatorHost && (res.headers.get("content-type") ?? "").includes("html")) {
      const html = (await res.text()).slice(0, 200000);
      const meta = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i)
        ?? html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      let ext: string | undefined = meta?.[1];
      if (!ext) {
        // a page with a single prominent external link (e.g. "Continue to employer")
        const links = [...html.matchAll(/<a\b[^>]*?href\s*=\s*["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .filter((m) => { try { const h = new URL(m[1]).hostname; return h !== aggregatorHost && !BAD_HOSTS.test(m[1]); } catch { return false; } })
          .filter((m) => APPLY_TEXT.test(clean(m[2])) || /continue|proceed|employer|company\s+website/i.test(clean(m[2])));
        ext = links[0]?.[1];
      }
      if (!ext) return null;
      final = new URL(decode(ext), final);
    } else {
      await res.body?.cancel();
    }
    if (final.hostname === aggregatorHost || BAD_HOSTS.test(final.hostname + final.pathname)) return null;
    return final.toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- DPSA mode: one listing per new Public Service Vacancy Circular ----------
async function sweepDpsa(src: Source) {
  const first = await fetchHtml(src.url, 15000);
  const year = new Date().getUTCFullYear();
  const found = new Map<string, { href: string; num: number; yr: number }>();
  const samples: string[] = [];
  const anchorRe = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(first.html))) {
    const text = clean(m[2]);
    const href = decode(m[1]);
    const hay = `${text} ${href}`;
    if (/circular/i.test(hay) && samples.length < 6) samples.push(`${text.slice(0, 60)} -> ${href.slice(0, 80)}`);
    let num = 0, yr = 0;
    const c1 = hay.match(/circular\s*(?:no\.?\s*)?(\d{1,2})\s*(?:of|\/|-)\s*(20\d\d)/i);
    const c2 = href.match(/(20\d\d)\/(\d{1,2})(?:\/|$)/);
    if (c1) { num = +c1[1]; yr = +c1[2]; }
    else if (c2 && /psvc|circular|vacanc/i.test(href)) { yr = +c2[1]; num = +c2[2]; }
    else continue;
    // current year only (in January also accept last year's final circulars)
    if (yr !== year && !(yr === year - 1 && new Date().getUTCMonth() === 0)) continue;
    let u: URL;
    try { u = new URL(href, first.base); } catch { continue; }
    const key = `${num}/${yr}`;
    if (!found.has(key)) found.set(key, { href: u.toString(), num, yr });
  }
  const latest = [...found.values()].sort((a, b) => b.yr - a.yr || b.num - a.num).slice(0, 2);
  if (!latest.length) throw new Error(`no circulars matched; samples: ${samples.join(" | ") || "none"}`);
  const rows = latest.map((c) => ({
    source_id: src.id, origin: "sweep", provider: "DPSA (national & provincial departments)",
    title: `Public Service Vacancy Circular ${String(c.num).padStart(2, "0")} of ${c.yr}: government posts, including internships`,
    type: "other", provinces: [], url: c.href, status: "pending", scam_flags: [],
  }));
  const { data, error } = await supabase.from("opportunities").upsert(rows, { onConflict: "url", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(`db: ${error.message}`);
  return { matched: rows.length, new: data?.length ?? 0 };
}

async function sweepAggregator(src: Source) {
  const first = await fetchHtml(src.url, 15000);
  const host = first.base.hostname;
  const articles: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(first.html)) && articles.length < 25) {
    let u: URL;
    try { u = new URL(decode(m[1]), first.base); } catch { continue; }
    if (u.hostname !== host || /\/(category|tag|page|author)\//.test(u.pathname) || u.pathname.split("/").filter(Boolean).length !== 1) continue;
    const text = clean(m[2]);
    if (text.length < 12 || seen.has(u.toString())) continue;
    seen.add(u.toString());
    if (!KEYWORDS.test(text + " " + u.pathname) && !/trainee|programme|yes\b/i.test(text)) continue;
    if (ROUNDUP.test(text)) continue;
    articles.push({ href: u.toString(), text });
  }
  // Skip articles already processed on earlier days
  const { data: known } = await supabase.from("opportunities").select("via_url").in("via_url", articles.map((a) => a.href));
  const knownSet = new Set((known ?? []).map((k) => k.via_url));
  const todo = articles.filter((a) => !knownSet.has(a.href)).slice(0, 15);

  const today = new Date().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  const pages = await Promise.allSettled(todo.map((a) => fetchHtml(a.href, 10000).then((p) => ({ a, p }))));
  for (const r of pages) {
    if (r.status !== "fulfilled") continue;
    const { a, p } = r.value;
    const h1 = p.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const title = (h1 ? clean(h1[1]) : a.text).slice(0, 300);
    if (ROUNDUP.test(title)) continue;
    let region = p.html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
    const art = region.match(/<article\b[\s\S]*?<\/article>/i);
    if (art) region = art[0];
    region = region.replace(/<(nav|aside|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
    const text = mainText(p.html);
    const closing = findClosingDate(text);
    const closed = !!closing && closing < today; // stored as expired so the article isn't re-read every day
    // Official apply link: first external link with apply-style text
    let apply: string | null = null;
    const aRe = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(region))) {
      let u: URL;
      try { u = new URL(decode(am[1]), p.base); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || u.hostname === host || BAD_HOSTS.test(u.hostname + u.pathname)) continue;
      if (APPLY_TEXT.test(clean(am[2])) || APPLY_TEXT.test(am[0])) { apply = u.toString(); break; }
    }
    if (!apply) {
      // Some sites route "Apply" through their own redirect page (e.g. /Apply/15075): follow it to the employer
      const aRe2 = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let am2: RegExpExecArray | null;
      while ((am2 = aRe2.exec(region))) {
        let u: URL;
        try { u = new URL(decode(am2[1]), p.base); } catch { continue; }
        if (u.hostname !== host || !/\/apply\b/i.test(u.pathname) || !APPLY_TEXT.test(clean(am2[2]))) continue;
        apply = await resolveRedirect(u.toString(), host);
        break;
      }
    }
    if (!apply) continue;
    const au = new URL(apply);
    const flags: string[] = [];
    if (hasRealFee(text)) flags.push("mentions_fee");
    if (FREE_HOSTS.test(au.hostname)) flags.push("free_hosting");
    const lead = title + " " + text.slice(0, 1500);
    rows.push({
      source_id: src.id, origin: "sweep", title, provider: providerFromTitle(title, src.name), type: inferType(title),
      provinces: PROVINCES.filter(([re]) => re.test(lead)).map(([, pv]) => pv),
      closing_date: closing, url: apply, via_url: a.href, status: closed ? "expired" : "pending", scam_flags: flags,
    });
  }
  let inserted = 0;
  for (const row of rows) {
    // one by one so a duplicate official link or article doesn't block the rest
    const { data, error } = await supabase.from("opportunities").insert(row).select("id");
    if (!error && data?.length) inserted++;
  }
  return { articles: articles.length, matched: rows.length, new: inserted };
}

async function sweepSource(src: Source) {
  try {
    if (src.mode === "aggregator" || src.mode === "dpsa") {
      const r = src.mode === "dpsa" ? await sweepDpsa(src) : await sweepAggregator(src);
      await supabase.from("sources").update({ last_checked_at: new Date().toISOString(), last_status: "ok", last_found: r.matched, last_error: null }).eq("id", src.id);
      return { source: src.name, ok: true, ...r };
    }
    const first = await fetchHtml(src.url, 15000);
    const { adverts, categories } = extract(first.html, first.base);
    // Follow up to 6 category pages one level deeper
    const deeper = await Promise.allSettled(categories.slice(0, 6).map((c) => fetchHtml(c, 10000)));
    for (const d of deeper) if (d.status === "fulfilled") adverts.push(...extract(d.value.html, d.value.base).adverts);

    const byUrl = new Map<string, Cand>();
    for (const a of adverts) if (!byUrl.has(a.href)) byUrl.set(a.href, a);
    const rows = [...byUrl.values()].slice(0, 80).map((a) => {
      const u = new URL(a.href);
      const flags = SCAM_RULES.filter(([re]) => re.test(a.hay)).map(([, f]) => f);
      if (FREE_HOSTS.test(u.hostname)) flags.push("free_hosting");
      return {
        source_id: src.id, origin: "sweep", title: a.title, provider: src.name, type: inferType(a.hay),
        provinces: PROVINCES.filter(([re]) => re.test(a.hay)).map(([, p]) => p),
        url: a.href, status: "pending", scam_flags: flags,
      };
    });
    let inserted = 0;
    if (rows.length) {
      const { data, error } = await supabase.from("opportunities").upsert(rows, { onConflict: "url", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`db: ${error.message}`);
      inserted = data?.length ?? 0;
    }
    await supabase.from("sources").update({ last_checked_at: new Date().toISOString(), last_status: "ok", last_found: rows.length, last_error: null }).eq("id", src.id);
    return { source: src.name, ok: true, categories: categories.length, matched: rows.length, new: inserted };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    await supabase.from("sources").update({ last_checked_at: new Date().toISOString(), last_status: "error", last_error: msg.slice(0, 500) }).eq("id", src.id);
    return { source: src.name, ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  const { data: cfg } = await supabase.from("app_config").select("value").eq("key", "sweep_secret").single();
  if (!cfg || req.headers.get("x-sweep-secret") !== cfg.value) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const sourceId = new URL(req.url).searchParams.get("source_id");
  let q = supabase.from("sources").select("id,name,url,mode").eq("active", true);
  if (sourceId) q = q.eq("id", Number(sourceId));
  const { data: sources, error } = await q;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const { data: run } = await supabase.from("sweep_runs").insert({}).select("id").single();
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("opportunities").update({ status: "expired" }).lt("closing_date", today).in("status", ["pending", "approved"]);
  // Vacancy circulars carry many posts with their own dates; retire each circular two weeks after it appears
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  await supabase.from("opportunities").update({ status: "expired" }).ilike("title", "Public Service Vacancy Circular%").lt("first_seen_at", twoWeeksAgo).in("status", ["pending", "approved"]);

  const results: Awaited<ReturnType<typeof sweepSource>>[] = [];
  const queue = [...(sources ?? [])];
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) results.push(await sweepSource(queue.shift()!)); }));

  const newFound = results.reduce((n, r) => n + ("new" in r ? (r.new ?? 0) : 0), 0);
  const errors = results.filter((r) => !r.ok).length;
  if (run) await supabase.from("sweep_runs").update({ finished_at: new Date().toISOString(), sources_checked: results.length, new_found: newFound, errors }).eq("id", run.id);
  return new Response(JSON.stringify({ sources_checked: results.length, new_found: newFound, errors, results }), { headers: { "Content-Type": "application/json" } });
});
