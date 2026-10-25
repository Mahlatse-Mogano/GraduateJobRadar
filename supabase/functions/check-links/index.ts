import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { findClosingDate, hasOpenCall, hasValidYear, isGenericTitle, mainText } from "./shared.ts";

// Learnership Radar link check (v2). Runs on every pending/approved listing:
//  - dead page (404/410 or "page not found")            -> rejected
//  - general info page (e.g. "Internships")             -> rejected
//  - page shows a closing date                          -> closing_date set; past -> expired, future -> approved
//  - no date, but a this/next-year application call     -> approved (shown as "no closing date given")
//  - no sign of an open application                     -> rejected
//  - documents (PDF etc.) need this/next year in the title or link to be approved
//  - server errors/timeouts                             -> unchanged, retried next run
// Listings with scam warnings are never approved.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UA = "Mozilla/5.0 (compatible; LearnershipRadarBot/0.2; link check)";
const SOFT404_TITLE = /<title[^>]*>[^<]*(page not found|not found|404|can.t be found|nothing found)[^<]*<\/title>/i;
const SOFT404_BODY = /nothing was found at this location|the page you (are|were) looking for (could not|cannot|can.t) be found|page can.t be found/i;
const DOC_CUE = /bursar|learnership|internship|apprentice|advert|application|call|intake|recruit/i;
const DOC_NOT_CALL = /award|approved|ready\s+for\s+implementation|\blist\b|results|circular|policy|brochure|agreement|process|report|study|guideline|template|successful|shortlist/i;

type Row = { id: string; url: string; title: string; status: string; scam_flags: string[]; closing_date: string | null };
type Verdict = { id: string; code: number | null; note: string | null; verdict: "reject" | "approve" | "expire" | "retry"; closing_date?: string };

async function check(row: Row): Promise<Verdict> {
  if (isGenericTitle(row.title)) return { id: row.id, code: null, note: "general information page", verdict: "reject" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(row.url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "text/html,application/pdf,*/*" } });
    const code = res.status;
    const ct = res.headers.get("content-type") ?? "";
    if (code === 404 || code === 410) { await res.body?.cancel(); return { id: row.id, code, note: "page removed", verdict: "reject" }; }
    if (code >= 500) { await res.body?.cancel(); return { id: row.id, code, note: "server error", verdict: "retry" }; }
    if (code === 401 || code === 403 || code === 429) {
      await res.body?.cancel();
      return hasValidYear(row.title + " " + row.url) || (!!row.closing_date && row.closing_date >= new Date().toISOString().slice(0, 10))
        ? { id: row.id, code, note: "site blocks checks; current year in title", verdict: "approve" }
        : { id: row.id, code, note: "site blocks checks", verdict: "retry" };
    }
    if (code >= 300) { await res.body?.cancel(); return { id: row.id, code, note: "unexpected status", verdict: "retry" }; }
    if (/^Public Service Vacancy Circular/.test(row.title)) {
      await res.body?.cancel();
      return { id: row.id, code, note: "vacancy circular opens", verdict: "approve" };
    }

    if (!ct.includes("html")) {
      await res.body?.cancel();
      if (row.closing_date && row.closing_date >= new Date().toISOString().slice(0, 10)) {
        return { id: row.id, code, note: "document; closing date from advert", verdict: "approve" };
      }
      return hasValidYear(row.title) && DOC_CUE.test(row.title) && !DOC_NOT_CALL.test(row.title)
        ? { id: row.id, code, note: "current document", verdict: "approve" }
        : { id: row.id, code, note: "old or non-advert document", verdict: "reject" };
    }

    const html = (await res.text()).slice(0, 600000);
    if (SOFT404_TITLE.test(html) || SOFT404_BODY.test(html)) return { id: row.id, code, note: "page not found", verdict: "reject" };
    const text = mainText(html);
    const date = findClosingDate(text) ?? row.closing_date;
    const today = new Date().toISOString().slice(0, 10);
    if (date) {
      return date < today
        ? { id: row.id, code, note: "closing date passed", verdict: "expire", closing_date: date }
        : { id: row.id, code, note: "open; closing date on page", verdict: "approve", closing_date: date };
    }
    return hasOpenCall(text)
      ? { id: row.id, code, note: "open call, no closing date on page", verdict: "approve" }
      : { id: row.id, code, note: "no open application found on page", verdict: "reject" };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    return { id: row.id, code: null, note: msg.slice(0, 300), verdict: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  const { data: cfg } = await supabase.from("app_config").select("value").eq("key", "sweep_secret").single();
  if (!cfg || req.headers.get("x-sweep-secret") !== cfg.value) return new Response("unauthorized", { status: 401 });

  const { data: rows, error } = await supabase.from("opportunities").select("id,url,title,status,scam_flags,closing_date").in("status", ["pending", "approved"]).limit(1000);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const byId = new Map((rows ?? []).map((r) => [r.id, r as Row]));
  const queue = [...(rows ?? [])] as Row[];
  const results: Verdict[] = [];
  await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) results.push(await check(queue.shift()!)); }));

  const now = new Date().toISOString();
  const tally = { approve: 0, reject: 0, expire: 0, retry: 0 };
  for (const r of results) {
    const row = byId.get(r.id)!;
    const patch: Record<string, unknown> = { link_status: r.code, link_note: r.note, link_checked_at: now };
    if (r.closing_date) patch.closing_date = r.closing_date;
    let v = r.verdict;
    if (v === "approve" && (row.scam_flags ?? []).length) v = "retry";
    if (v === "approve" && row.status !== "approved") { patch.status = "approved"; patch.reviewed_at = now; }
    if (v === "reject") { patch.status = "rejected"; patch.reviewed_at = now; }
    if (v === "expire") patch.status = "expired";
    tally[v]++;
    await supabase.from("opportunities").update(patch).eq("id", r.id);
  }
  return new Response(JSON.stringify({ checked: results.length, ...tally }), { headers: { "Content-Type": "application/json" } });
});
