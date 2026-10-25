// Shared parsing helpers for the Learnership Radar sweep and link check.

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

export function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#0?39;|&rsquo;|&#8217;|&lsquo;|&#8216;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, "-").replace(/&#038;/g, "&").replace(/&copy;|&#169;/g, "©");
}

export function clean(html: string) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Main readable text of a page: drops scripts, menus, headers, footers and sidebars.
export function mainText(html: string) {
  let h = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const main = h.match(/<main\b[\s\S]*?<\/main>/i);
  const articles = h.match(/<article\b[\s\S]*?<\/article>/gi);
  if (main) h = main[0];
  else if (articles && articles.length) h = articles.join(" ");
  else h = h.replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<(nav|aside|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
  return clean(h).replace(/(©|copyright)\s*(\d{4}\s*[-–]\s*)?\d{4}/gi, " ");
}

function mkDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}
function monthNum(s: string) { return MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1; }

// First date found in a short piece of text (SA style dd/mm/yyyy for numeric dates).
export function parseAnyDate(t: string): string | null {
  const pats: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON},?\\s+(20\\d\\d)`, "i"), (m) => mkDate(+m[3], monthNum(m[2]), +m[1])],
    [new RegExp(`${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)`, "i"), (m) => mkDate(+m[3], monthNum(m[1]), +m[2])],
    [/\b(\d{1,2})[\/.](\d{1,2})[\/.](20\d\d)\b/, (m) => mkDate(+m[3], +m[2], +m[1])],
    [/\b(20\d\d)[-\/](\d{1,2})[-\/](\d{1,2})\b/, (m) => mkDate(+m[1], +m[2], +m[3])],
  ];
  let best: { idx: number; val: string } | null = null;
  for (const [re, fn] of pats) {
    const m = t.match(re);
    if (m && m.index !== undefined) {
      const v = fn(m);
      if (v && (!best || m.index < best.idx)) best = { idx: m.index, val: v };
    }
  }
  return best?.val ?? null;
}

const CLOSE_CUE = /(closing\s+date|closes|close\s+on|applications?\s+close|close\s*:|closing|deadline|due\s+date|applications?\s+(?:must\s+(?:be\s+)?)?(?:submitted|received|reach\s+us)\s+(?:by|before|no\s+later\s+than|on\s+or\s+before)|submit\s+(?:by|before|no\s+later\s+than))/gi;

// Closing date taken from the words right after a closing-date phrase.
export function findClosingDate(text: string, year = new Date().getUTCFullYear()): string | null {
  for (const m of text.matchAll(CLOSE_CUE)) {
    const slice = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 90);
    const d = parseAnyDate(slice);
    if (d) {
      const y = +d.slice(0, 4);
      if (y >= year - 1 && y <= year + 1) return d;
    }
  }
  return null;
}

const CALL = "(?:apply|applications?|call\\s+for|invit\\w*|submit\\w*|closing|deadline|intake|recruit\\w*|now\\s+open)";
// True when the page mentions this or next year close to an application phrase.
export function hasOpenCall(text: string, year = new Date().getUTCFullYear()) {
  const yrs = `(?:${year}|${year + 1})`;
  return new RegExp(`${CALL}[\\s\\S]{0,200}?\\b${yrs}\\b|\\b${yrs}\\b[\\s\\S]{0,200}?${CALL}`, "i").test(text);
}

const GENERIC_WORDS = new Set((
  "learnership learnerships bursary bursaries internship internships intern interns apprenticeship apprenticeships " +
  "skills skill programme programmes program programs work integrated learning wil graduate graduates development " +
  "artisan artisans non unemployed employed learners learner youth students student registered stipend stipends sector " +
  "qualifications qualification occupational funding grants grant discretionary workplace based experience " +
  "and the of for a an to in on at our your all list latest new open current available opportunities opportunity " +
  "vacancies vacancy careers career jobs job page info information about apply now here click view veiw more read " +
  "details learn find out advert adverts what is are how " +
  "agriseta merseta mict bankseta chieta hwseta fasset mqa inseta etdp ceta teta services wrseta seta setas nsfas sa"
).split(" "));

// "Internships", "Bursaries", "Apprenticeships, Learnerships and Skills Programmes" -> generic category pages.
export function isGenericTitle(title: string) {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  if (words.length <= 1) return true;
  if (words.some((w) => /\d/.test(w))) return false;
  return words.every((w) => GENERIC_WORDS.has(w));
}

export function hasValidYear(s: string, year = new Date().getUTCFullYear()) {
  return new RegExp(`\\b(${year}|${year + 1})\\b`).test(s);
}
