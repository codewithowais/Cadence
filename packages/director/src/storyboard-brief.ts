/**
 * BRIEF — read a one-sentence request and work out what the user means: the genre,
 * platform, length, mood, palette, language and the concrete nouns (subject, name,
 * place, topic, count, dates…). Pure, deterministic, no I/O.
 */
import type { Genre, Language, Mood, Platform, StoryAspect, StoryboardBrief } from "./storyboard";

export interface Brief extends StoryboardBrief {
  genre: Genre;
  /** How sure the genre call is (0..1). Low ⇒ the "didn't understand" fallback may suggest rephrasing. */
  confidence: number;
  platform: Platform;
  aspect: StoryAspect;
  targetSec: number;
  /** True when the user gave an explicit length. */
  explicitLength: boolean;
  mood: Mood;
  /** Explicit mood words found in the prompt (vs. the genre default). */
  explicitMood: boolean;
  language: Language;
  musicWord?: "lofi" | "upbeat" | "cinematic" | "corporate" | "ambient" | "none";
  paletteWord?: string;
  themeWord?: "retro" | "neon" | "aurora" | "handwritten" | "minimal" | "bold" | "playful" | "elegant" | "corporate" | "cinematic";
  wantsVoiceover: boolean;
  usesMedia: boolean;
}

const has = (re: RegExp, s: string): boolean => re.test(s);

// ---- genre ---------------------------------------------------------------------------

const GENRE_RULES: [Genre, [RegExp, number][]][] = [
  [
    "greeting",
    [
      [/\bbirthday\b|\bb-?day\b|\bhappy birthday\b/, 5],
      [/\bwish(?:es)?\b|\bgreeting\b|\bcongrat\w*|\bconfetti\b/, 3],
      [/\banniversary\b|\bgraduat\w*|\beid\b|\bmubarak\b|\bnew year\b|\bthank[- ]?you (?:video|card|message)\b|\bget well\b|\bmother'?s day\b|\bfather'?s day\b|\bvalentine\w*|\bdiwali\b|\bchristmas\b|\bramadan\b|\bholiday greeting\b/, 4],
    ],
  ],
  ["travel", [[/\btravel\w*|\btrip\b|\bvacation\b|\bholiday (?:recap|video|memories)\b|\bjourney\b|\bgetaway\b|\bsightseeing\b|\bitinerary\b|\broad ?trip\b/, 4], [/\brecap\b|\btour of\b|\bvlog\b/, 2]]],
  [
    "invite",
    [
      [/\binvit\w*|\bsave the date\b|\brsvp\b|\byou(?:'re| are) invited\b/, 8],
      [/\bparty\b|\bwebinar\b|\bworkshop\b|\bconference\b|\bmeetup\b|\biftar\b|\bgrand opening\b|\bopening (?:day|night)\b|\bdinner\b|\breunion\b/, 3],
      [/\bevent\b|\bwedding\b/, 2],
    ],
  ],
  ["launch", [[/\blaunch\w*|\bintroducing\b|\bunveil\w*|\bnew product\b|\bcoming soon\b|\bnow available\b|\bpre-?order\b|\brelease\b/, 4]]],
  ["testimonial", [[/\btestimonial\w*|\bcustomer (?:story|review|quote)\b|\breviews?\b|\bwhat (?:our )?(?:customers|clients) say\b|\bsuccess story\b|\bcase study\b/, 5]]],
  ["intro", [[/\bintro\b|\boutro\b|\bchannel (?:intro|trailer)\b|\blogo (?:reveal|sting|intro)\b|\bopener\b|\bbumper\b|\bend ?screen\b|\bend card\b/, 5]]],
  ["quote", [[/\bquote\b|\bmotivat\w*|\binspir\w*|\baffirmation\b|\bmindset\b|\bdaily reminder\b|\bpositive vibes?\b/, 4]]],
  ["tutorial", [[/\btutorial\b|\bhow to\b|\btips?\b|\bways to\b|\bsteps? to\b|\bhacks?\b|\bguide to\b|\bdos and don'?ts\b|\btop \d+\b|\b\d+ (?:tips|ways|steps|things|reasons|mistakes|ideas|hacks)\b|\bbeginner'?s guide\b/, 4]]],
  ["explainer", [[/\bexplain\w*|\bexplainer\b|\bhow (?:does|do|is|are)\b[\s\S]*\bwork\w*|\bwhat is\b|\bwhat are\b|\bwhy (?:does|do|is|are)\b|\bunderstand\b|\bdemystif\w*|\bfor beginners\b|\beli5\b|\blearn about\b/, 4]]],
  ["announcement", [[/\bannounc\w*|\bbig news\b|\bnews\b|\bupdate\b|\bnow open\b|\bwe(?:'re| are) (?:hiring|open|moving|closing)\b|\bhiring\b|\bopening soon\b/, 4]]],
  ["slideshow", [[/\bslide ?show\b|\bphoto (?:video|montage|reel|album|story)\b|\bmemories\b|\bmontage\b|\bcollage\b|\bphoto dump\b|\balbum\b/, 4], [/\busing my (?:photos|pictures|images)\b|\bfrom my (?:photos|pictures|images)\b/, 2]]],
  ["promo", [[/\bpromo\w*|\bad\b|\bads\b|\badvert\w*|\bcommercial\b|\bcampaign\b|\bmarketing\b|\bsale\b|\boffer\b|\bdiscount\b|\d\s*%\s*off|\bgrand sale\b|\bshowcase\b|\bpromote\b|\bfor my (?:shop|store|business|brand|cafe|café|restaurant|salon|gym|bakery|company|startup|studio|boutique|clinic)\b/, 6]]],
];

export function classifyGenre(lower: string, hasMedia: boolean): { genre: Genre; confidence: number } {
  const scores = new Map<Genre, number>();
  for (const [genre, rules] of GENRE_RULES) {
    let s = 0;
    for (const [re, w] of rules) if (re.test(lower)) s += w;
    if (s) scores.set(genre, s);
  }
  // Specific occasions beat generic "video about" words.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { genre: hasMedia ? "slideshow" : "promo", confidence: 0.2 };
  const [best, second] = ranked;
  const margin = best![1] - (second?.[1] ?? 0);
  return { genre: best![0], confidence: Math.min(1, 0.45 + best![1] / 10 + margin / 20) };
}

// ---- platform / aspect / length ---------------------------------------------------------

export function parsePlatform(lower: string): Platform | undefined {
  if (/\bshorts\b/.test(lower)) return "shorts";
  if (/tik ?tok/.test(lower)) return "tiktok";
  if (/\binsta(?:gram)?\b|\big\b|\breels?\b/.test(lower)) return "instagram";
  if (/\byoutube\b|\byt\b/.test(lower)) return "youtube";
  if (/\bwhats ?app\b/.test(lower)) return "whatsapp";
  if (/\bfacebook\b|\bfb\b/.test(lower)) return "facebook";
  if (/\blinked ?in\b/.test(lower)) return "linkedin";
  if (/\btwitter\b|\bon x\b/.test(lower)) return "x";
  return undefined;
}

export function aspectFor(platform: Platform, lower: string, genre: Genre): StoryAspect {
  if (/9:16|vertical|portrait|\bstor(?:y|ies)\b/.test(lower)) return "9:16";
  if (/1:1|square/.test(lower)) return "1:1";
  if (/4:5/.test(lower)) return "4:5";
  if (/16:9|landscape|widescreen|horizontal/.test(lower)) return "16:9";
  if (/\b(?:feed|post)\b/.test(lower) && platform === "instagram") return "4:5";
  switch (platform) {
    case "instagram":
    case "tiktok":
    case "shorts":
    case "whatsapp":
      return "9:16";
    case "youtube":
    case "linkedin":
    case "x":
      return "16:9";
    case "facebook":
      return "1:1";
    default:
      return genre === "explainer" || genre === "intro" || genre === "launch" ? "16:9" : "9:16";
  }
}

export function parseLength(lower: string): number | undefined {
  const min = lower.match(/(\d+(?:\.\d+)?)[-\s]*(?:m\b|min(?:ute)?s?\b)/);
  if (min) return Math.round(parseFloat(min[1]!) * 60);
  const sec = lower.match(/(\d+(?:\.\d+)?)[-\s]*(?:s\b|secs?\b|seconds?\b)/);
  if (sec) return Math.round(parseFloat(sec[1]!));
  if (/\bhalf (?:a )?minute\b/.test(lower)) return 30;
  if (/\bone minute\b|\ba minute\b/.test(lower)) return 60;
  return undefined;
}

const DEFAULT_LENGTH: Record<Genre, number> = {
  promo: 20,
  explainer: 45,
  greeting: 15,
  travel: 30,
  tutorial: 35,
  announcement: 15,
  quote: 12,
  invite: 18,
  launch: 25,
  testimonial: 20,
  intro: 8,
  slideshow: 30,
};

/** Natural length bounds per genre (stops "a 5s explainer" / "a 10 minute quote"). */
export const LENGTH_BOUNDS: Record<Genre, [number, number]> = {
  promo: [8, 90],
  explainer: [20, 180],
  greeting: [6, 60],
  travel: [12, 120],
  tutorial: [15, 180],
  announcement: [6, 60],
  quote: [6, 45],
  invite: [8, 60],
  launch: [10, 90],
  testimonial: [10, 60],
  intro: [3, 20],
  slideshow: [8, 180],
};

export function defaultLength(genre: Genre): number {
  return DEFAULT_LENGTH[genre];
}

// ---- mood / music / palette / theme ----------------------------------------------------------

const MOOD_WORDS: [Mood, RegExp][] = [
  ["luxury", /\bluxur\w*|\bpremium\b|\bhigh[- ]end\b|\bupscale\b/],
  ["elegant", /\belegan\w*|\bclassy\b|\bsophisticated\b|\brefined\b|\bchic\b/],
  ["cinematic", /\bcinematic\b|\bepic\b|\bdramatic\b|\bmoody\b|\bmovie\b|\btrailer\b/],
  ["emotional", /\bemotional\b|\bheartfelt\b|\bsentimental\b|\btouching\b|\bnostalgi\w*|\bsweet\b|\bheartwarming\b/],
  ["energetic", /\benergetic\b|\bhype\w*|\bhigh[- ]energy\b|\bdynamic\b|\bfast[- ]paced\b|\bpumped\b|\bintense\b/],
  ["playful", /\bplayful\b|\bquirky\b|\bcute\b|\bfun\b|\bsilly\b|\bcheeky\b|\bcolou?rful\b|\bkids?\b/],
  ["upbeat", /\bupbeat\b|\bhappy\b|\bcheerful\b|\blively\b|\bjoyful\b|\bpositive\b|\bbright\b|\bfestive\b|\bcelebrat\w*/],
  ["calm", /\bcalm\w*|\brelax\w*|\bchill\b|\bpeaceful\b|\bsoothing\b|\bgentle\b|\bserene\b|\bzen\b|\bslow\b/],
  ["warm", /\bwarm\w*|\bcozy\b|\bcosy\b|\bfriendly\b|\binviting\b|\bhomey\b|\bcomfort\w*/],
  ["bold", /\bbold\b|\bloud\b|\bstrong\b|\bpunchy\b|\bpowerful\b|\bedgy\b/],
  ["professional", /\bprofessional\b|\bcorporate\b|\bclean\b|\bbusiness\b|\bformal\b|\bpolished\b/],
  ["minimal", /\bminimal\w*|\bsimple\b|\bsubtle\b|\bunderstated\b/],
];

const GENRE_MOOD: Record<Genre, Mood> = {
  promo: "upbeat",
  explainer: "professional",
  greeting: "playful",
  travel: "cinematic",
  tutorial: "professional",
  announcement: "bold",
  quote: "calm",
  invite: "elegant",
  launch: "bold",
  testimonial: "warm",
  intro: "bold",
  slideshow: "emotional",
};

export function parseMood(lower: string, genre: Genre): { mood: Mood; explicit: boolean } {
  // "warm vibe" / "calm feel" name the mood directly; "upbeat music" names the SOUNDTRACK, not the mood.
  const direct = lower.match(/\b([a-z-]+)\s+(?:vibes?|feel(?:ing)?|mood|tone|energy|aesthetic|style)\b/);
  if (direct) for (const [m, re] of MOOD_WORDS) if (re.test(direct[1]!)) return { mood: m, explicit: true };
  const noMusic = lower.replace(/\b[a-z-]+\s+(?:music|beats?|soundtrack|songs?|track)\b/g, " ");
  for (const [m, re] of MOOD_WORDS) if (re.test(noMusic)) return { mood: m, explicit: true };
  return { mood: GENRE_MOOD[genre], explicit: false };
}

export function parseMusicWord(lower: string): Brief["musicWord"] {
  if (/\b(?:no|without|silent)\s+(?:background\s+)?music\b|\bsilent\b|\bmute\b/.test(lower)) return "none";
  if (/\blo-?fi\b|\bchill(?:ed)?\s+(?:music|beats?)\b|\bjazzy\b|\bcoffee ?house\b/.test(lower)) return "lofi";
  if (/\bcinematic music\b|\bepic music\b|\borchestral\b|\bdramatic music\b|\bepic\b/.test(lower)) return "cinematic";
  if (/\bcorporate music\b|\bbusiness music\b|\bcorporate\b/.test(lower)) return "corporate";
  if (/\bambient\b|\bcalm music\b|\brelaxing music\b|\bpeaceful music\b|\bsoft music\b/.test(lower)) return "ambient";
  if (/\bupbeat\b|\bhappy music\b|\bpop\b|\bdance\b|\benergetic music\b|\bfun music\b|\bcatchy\b|\bbeat\b/.test(lower)) return "upbeat";
  return undefined;
}

export function parsePaletteWord(lower: string): string | undefined {
  const table: [string, RegExp][] = [
    ["pastel", /\bpastel\b|\bsoft colou?rs\b|\bbaby (?:pink|blue)\b/],
    ["gold", /\bgold(?:en)?\b|\bblack and gold\b|\bblack & gold\b/],
    ["berry", /\bpink\b|\brose\b|\bmagenta\b|\bberry\b|\bfuchsia\b/],
    ["royal", /\bpurple\b|\bviolet\b|\broyal\b|\blavender\b/],
    ["ember", /\bred\b|\bcrimson\b|\bfire\b|\bscarlet\b/],
    ["sunset", /\borange\b|\bsunset\b|\bsunrise\b|\bpeach\b|\bcoral\b/],
    ["forest", /\bgreen\b|\bforest\b|\bnature\b|\beco\b|\borganic\b|\bemerald\b/],
    ["mint", /\bmint\b|\bteal\b|\baqua\b|\bturquoise\b/],
    ["ocean", /\bblue\b|\bocean\b|\bsea\b|\bnavy\b|\bsky\b/],
    ["midnight", /\bdark\b|\bnight\b|\bmidnight\b|\bblack\b/],
    ["coffee", /\bbrown\b|\bcoffee\b|\bearthy\b|\bcaramel\b|\bchocolate\b/],
    ["mono", /\bmonochrome\b|\bgr[ae]y\b|\bblack and white\b|\bblack & white\b|\bb&w\b/],
  ];
  for (const [name, re] of table) if (re.test(lower)) return name;
  return undefined;
}

export function parseThemeWord(lower: string): Brief["themeWord"] {
  if (/\bretro\b|\bvintage\b|\b80s\b|\b90s\b|\bsynthwave\b/.test(lower)) return "retro";
  if (/\bneon\b|\bcyber\w*|\bglow\b/.test(lower)) return "neon";
  if (/\baurora\b|\bnorthern lights\b|\bdreamy\b/.test(lower)) return "aurora";
  if (/\bhand-?written\b|\bhandwriting\b|\bscript\b/.test(lower)) return "handwritten";
  return undefined;
}

// ---- language ---------------------------------------------------------------------------------

export function parseLanguage(prompt: string, lower: string): Language {
  if (/[؀-ۿ]/.test(prompt)) return "ur";
  if (/\bin (?:roman )?urdu\b|\burdu\b/.test(lower)) return "ur";
  if (/\bin spanish\b|\ben español\b|\bspanish\b/.test(lower)) return "es";
  if (/\bin french\b|\ben français\b|\bfrench\b/.test(lower)) return "fr";
  if (/\bin german\b|\bauf deutsch\b|\bgerman\b/.test(lower)) return "de";
  return "en";
}

// ---- nouns ------------------------------------------------------------------------------------

const JUNK_SUBJECT =
  /^(?:me|us|you|it|this|that|them|instagram|tiktok|youtube|facebook|linkedin|whatsapp|twitter|x|reels?|shorts?|stor(?:y|ies)|feed|my photos|photos|pictures|images|my pictures|my images|my videos?|videos?|the video|a video|\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?)|social media|today|tomorrow)$/i;

const STOP_AFTER = String.raw`(?=\s+(?:with|using|in|on|at|that|which|to|from|featuring|including|under|by|so|because|set to|and\s+(?:use|add|make|a\s+\w+\s+(?:vibe|feel|music))|make it)\b|\s*[,.;:!?\n]|\s*$)`;

const cleanSubject = (s: string): string =>
  s
    .replace(/\s+(?:on|for|in)\s+(?:instagram|tiktok|youtube|facebook|linkedin|whatsapp|twitter|reels?|shorts)\b.*$/i, "")
    .replace(/\s+(?:vibe|vibes|feel|mood|style|music|look)\b.*$/i, "")
    .replace(/^(?:the|a|an|my|our|your|his|her|their)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

/** All "for/about/of/on <noun phrase>" captures, in order, minus junk. */
function phrasesAfter(raw: string, preps: string): string[] {
  const re = new RegExp(String.raw`\b(?:${preps})\s+(?:(?:my|our|the|a|an|his|her|their|your)\s+)?([^,.;:!?\n]+?)${STOP_AFTER}`, "gi");
  const out: string[] = [];
  for (const m of raw.matchAll(re)) {
    const c = cleanSubject(m[1] ?? "");
    if (c.length >= 2 && !JUNK_SUBJECT.test(c)) out.push(c);
  }
  return out;
}

const titleCase = (s: string): string => s.replace(/\b([a-z])(\w*)/g, (_, a: string, b: string) => a.toUpperCase() + b);

const NAME_STOP = new Set(["my", "our", "the", "a", "an", "you", "me", "us", "him", "her", "them", "everyone", "everybody", "all", "instagram", "tiktok", "youtube", "reels", "reel", "facebook", "whatsapp", "linkedin", "twitter", "x", "friends", "family", "fans", "customers"]);
const RELATIONS = "best friend|bestie|friend|mom|mum|mother|dad|father|sister|brother|wife|husband|boss|teacher|colleague|coworker|cousin|grandma|grandpa|grandmother|grandfather|son|daughter|fiancé|fiancee|girlfriend|boyfriend|uncle|aunt|neighbou?r|mentor|team";

export function extractName(raw: string): { name?: string; relation?: string } {
  const rel = raw.match(new RegExp(String.raw`\b(?:my|our)\s+(?:dear\s+|lovely\s+|favou?rite\s+)?(${RELATIONS})\b`, "i"));
  // "for Ayesha", "to Ayesha Khan", "for my friend Ayesha"
  const afterRel = raw.match(new RegExp(String.raw`\b(?:${RELATIONS})\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)`, "u"));
  if (afterRel) return { name: afterRel[1], relation: rel?.[1]?.toLowerCase() };
  const cap = raw.match(/\b(?:for|to|wish(?:ing)?|dear|of)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/u);
  if (cap && !NAME_STOP.has(cap[1]!.toLowerCase())) return { name: cap[1], relation: rel?.[1]?.toLowerCase() };
  const low = raw.match(/\b(?:for|to)\s+([a-z][\p{L}'’-]{2,})(?:\s|[,.!?]|$)/u);
  if (low && !NAME_STOP.has(low[1]!.toLowerCase()) && !JUNK_SUBJECT.test(low[1]!) && !new RegExp(`^(?:${RELATIONS})$`, "i").test(low[1]!)) {
    return { name: titleCase(low[1]!), relation: rel?.[1]?.toLowerCase() };
  }
  return { relation: rel?.[1]?.toLowerCase() };
}

export function extractPlace(raw: string): string | undefined {
  const m =
    raw.match(/\b(?:of|in|to|around|through|across)\s+([A-Z][\p{L}'’.-]+(?:\s+(?:[A-Z][\p{L}'’.-]+|of|de|la|el))*(?:\s+[A-Z][\p{L}'’.-]+)*)/u) ??
    raw.match(/\b(?:trip|travel|visit(?:ed|ing)?|recap|vacation|holiday|tour)\s+(?:of|to|in|through)\s+([a-z][\p{L}'’.-]+(?:\s+[a-z][\p{L}'’.-]+)?)/iu);
  if (!m) return undefined;
  const p = m[1]!.trim();
  if (JUNK_SUBJECT.test(p) || NAME_STOP.has(p.toLowerCase())) return undefined;
  return /^[a-z]/.test(p) ? titleCase(p) : p;
}

const DAY = "(?:mon|tues?|wednes|thurs?|fri|satur|sun)day";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export function extractWhen(raw: string): string | undefined {
  const parts: string[] = [];
  const day = raw.match(new RegExp(String.raw`\b((?:this|next|every)\s+(?:${DAY}|weekend|week|month|evening)|on\s+${DAY}|${DAY}|tomorrow|tonight|today)\b`, "i"));
  if (day) parts.push(day[1]!.replace(/^on\s+/i, ""));
  const date = raw.match(new RegExp(String.raw`\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}|${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?)\b`, "i"));
  if (date) parts.push(date[1]!);
  const time = raw.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i);
  if (time) parts.push(`at ${time[1]!.toUpperCase().replace(/\s/g, "")}`);
  if (parts.length === 0) return undefined;
  return parts.join(" ").replace(/\s+/g, " ").replace(/^(\w)/, (c) => c.toUpperCase());
}

export function extractWhere(raw: string): string | undefined {
  const m = raw.match(/\bat\s+(?:the\s+)?([A-Z][\p{L}'’&.-]+(?:\s+[A-Z][\p{L}'’&.-]+){0,4})/u);
  if (m && !/^\d/.test(m[1]!)) return m[1];
  return undefined;
}

export function extractOffer(raw: string): string | undefined {
  const pct = raw.match(/(\d{1,2})\s*%\s*(?:off|discount)/i) ?? raw.match(/(?:save|get)\s+(\d{1,2})\s*%/i);
  if (pct) return `${pct[1]}% off`;
  if (/\bbuy (?:one|1) get (?:one|1)\b|\bbogo\b/i.test(raw)) return "Buy one, get one free";
  const free = raw.match(/\bfree (?:delivery|shipping|trial|sample|gift|dessert|coffee|consultation)\b/i);
  if (free) return free[0].replace(/^\w/, (c) => c.toUpperCase());
  if (/\bgrand opening\b/i.test(raw)) return "Grand opening";
  if (/\b(?:summer|winter|eid|ramadan|black friday|flash|weekend|clearance|big)\s+sale\b/i.test(raw)) return raw.match(/\b(?:summer|winter|eid|ramadan|black friday|flash|weekend|clearance|big)\s+sale\b/i)![0].replace(/\b\w/g, (c) => c.toUpperCase());
  return undefined;
}

export function extractCount(lower: string): number | undefined {
  const m = lower.match(/\b(?:top\s+)?(\d{1,2})\s+(?:tips?|ways?|steps?|reasons?|things?|hacks?|ideas?|mistakes?|facts?)\b/) ?? lower.match(/\btop\s+(\d{1,2})\b/);
  if (m) return Math.min(10, Math.max(2, parseInt(m[1]!, 10)));
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const w = lower.match(/\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?:tips?|ways?|steps?|reasons?|things?|hacks?|ideas?|mistakes?|facts?)\b/);
  return w ? words[w[1]!] : undefined;
}

/** A quoted line the user wants shown verbatim (“…”, "…"). */
export function extractQuote(raw: string): string | undefined {
  const q = [...raw.matchAll(/[“"]([^”"]{6,})[”"]/g)].map((m) => m[1]!.trim()).sort((a, b) => b.length - a.length)[0];
  return q;
}

export function extractAge(lower: string): number | undefined {
  const m = lower.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:birthday|anniversary)\b/) ?? lower.match(/\bturn(?:s|ing)?\s+(\d{1,3})\b/) ?? lower.match(/\b(\d{1,3})\s+years?\s+(?:old|young|of)\b/);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  return n >= 1 && n <= 120 ? n : undefined;
}

export type Occasion = "birthday" | "anniversary" | "congrats" | "graduation" | "eid" | "newyear" | "thanks" | "getwell" | "wedding" | "valentine" | "diwali" | "christmas" | "ramadan" | "parentsday" | "generic";

export function extractOccasion(lower: string): Occasion {
  if (/\bbirthday\b|\bb-?day\b/.test(lower)) return "birthday";
  if (/\banniversary\b/.test(lower)) return "anniversary";
  if (/\bgraduat\w*/.test(lower)) return "graduation";
  if (/\beid\b|\bmubarak\b/.test(lower)) return "eid";
  if (/\bramadan\b/.test(lower)) return "ramadan";
  if (/\bnew year\b/.test(lower)) return "newyear";
  if (/\bwedding\b|\bnikah\b/.test(lower)) return "wedding";
  if (/\bvalentine\w*/.test(lower)) return "valentine";
  if (/\bdiwali\b/.test(lower)) return "diwali";
  if (/\bchristmas\b/.test(lower)) return "christmas";
  if (/\bmother'?s day\b|\bfather'?s day\b/.test(lower)) return "parentsday";
  if (/\bthank/.test(lower)) return "thanks";
  if (/\bget well\b/.test(lower)) return "getwell";
  if (/\bcongrat\w*/.test(lower)) return "congrats";
  return "generic";
}

const CATEGORY_RULES: [string, RegExp][] = [
  ["coffee", /\bcoffee\b|\bcafe\b|\bcafé\b|\bespresso\b|\blatte\b|\broast\w*|\bbarista\b|\btea (?:shop|house|room)\b|\bchai\b/],
  ["food", /\bbak(?:ery|ing|ed)\b|\bbread\b|\bcake\b|\bpizza\b|\bburger\b|\brestaurant\b|\bfood\b|\bkitchen\b|\bgrill\b|\bbiryani\b|\bdessert\b|\bsweets?\b|\bcatering\b|\bdiner\b|\bbbq\b|\bice ?cream\b|\bjuice\b|\bsnack\b/],
  ["fitness", /\bgym\b|\bfitness\b|\bworkout\b|\byoga\b|\bcrossfit\b|\bpilates\b|\bpersonal train\w*|\bwellness\b|\bsport\w*/],
  ["beauty", /\bsalon\b|\bbeauty\b|\bskin ?care\b|\bmakeup\b|\bspa\b|\bbarber\b|\bhair\b|\bnails?\b|\bcosmetic\w*|\bperfume\b|\bfragrance\b/],
  ["tech", /\bapp\b|\bsoftware\b|\bsaas\b|\bstartup\b|\bplatform\b|\btool\b|\bwebsite\b|\btech\b|\bgadget\b|\bsmart ?(?:watch|phone|home)\b|\bplugin\b|\bdashboard\b|\bai\b/],
  ["fashion", /\bfashion\b|\bclothing\b|\bclothes\b|\bboutique\b|\bjewel\w*|\bshoes?\b|\bsneakers?\b|\bbags?\b|\bcollection\b|\bwear\b|\bapparel\b|\bstore\b|\bshop\b/],
  ["education", /\bcourse\b|\bclass(?:es)?\b|\bschool\b|\bacademy\b|\btutor\w*|\bcoaching\b|\bbootcamp\b|\bworkshop\b|\buniversity\b|\bcollege\b/],
  ["realestate", /\breal estate\b|\bproperty\b|\bapartment\b|\bhome for sale\b|\bhousing\b|\bplots?\b|\binterior\w*/],
];

export function detectCategory(lower: string): string {
  for (const [c, re] of CATEGORY_RULES) if (re.test(lower)) return c;
  return "generic";
}

/** Subject for promo-ish genres: "for my coffee shop" → "coffee shop". */
export function extractSubject(raw: string, genre: Genre): string | undefined {
  const g = (re: RegExp): string | undefined => {
    const m = raw.match(re);
    if (!m) return undefined;
    const c = cleanSubject(m[1] ?? "");
    return c && !JUNK_SUBJECT.test(c) ? c : undefined;
  };
  if (genre === "explainer") {
    return (
      g(new RegExp(String.raw`\bexplain(?:\s+to\s+me)?\s+(?:how|what|why)?\s*(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+(?:works?|is|are|happens?|do(?:es)?)\b|\s+(?:in|for|with|using|to)\s+\d|\s+in\s+(?:simple|plain|under|less)|${STOP_AFTER})`, "i")) ??
      g(new RegExp(String.raw`\b(?:how|what|why)\s+(?:does|do|is|are)\s+(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+works?\b|\s+(?:in|for|with|using)\b|[?,.;]|\s*$)`, "i")) ??
      g(new RegExp(String.raw`\b(?:about|on|of)\s+(?:the\s+|a\s+|an\s+)?([^,.;:!?\n]+?)${STOP_AFTER}`, "i"))
    );
  }
  if (genre === "tutorial") {
    const TUT_STOP = String.raw`(?=\s+(?:with|using|that|which|so|because|for \d|in \d)\b|\s*[,.;:!?\n]|\s*$)`;
    return (
      g(new RegExp(String.raw`\bhow to\s+([^,.;:!?\n]+?)${TUT_STOP}`, "i")) ??
      g(new RegExp(String.raw`\b(?:tips?|ways?|steps?|hacks?|reasons?|things|ideas|mistakes|guide)\s+(?:for|to|on|about|of)\s+(?:the\s+)?([^,.;:!?\n]+?)${TUT_STOP}`, "i")) ??
      phrasesAfter(raw, "for|about|on|of")[0]
    );
  }
  if (genre === "travel") return extractPlace(raw) ?? phrasesAfter(raw, "of|to|in|about")[0];
  if (genre === "invite") {
    const m = raw.match(/\b((?:my|our|the)\s+(?:[\w'’-]+\s+){0,3}(?:party|wedding|webinar|workshop|conference|meetup|iftar|launch|opening|event|dinner|celebration|reunion|concert|exhibition|baby shower|get-together|gathering))\b/i);
    if (m) return m[1]!.replace(/\s+/g, " ").trim();
    return (
      g(new RegExp(String.raw`\b(?:invit\w*|invite)\s+(?:video\s+)?(?:for|to)\s+(?:(?:my|our|the|a|an)\s+)?([^,.;:!?\n]+?)${STOP_AFTER}`, "i")) ??
      phrasesAfter(raw, "for|to|about")[0]
    );
  }
  if (genre === "intro") return (phrasesAfter(raw, "for|of|called|named")[0] ?? "").replace(/^(?:channel|brand|company|business|page|podcast|show|studio|vlog)\s+/i, "") || undefined;
  if (genre === "announcement") {
    const hire = raw.match(new RegExp(String.raw`\bhiring\s+(?:(?:a|an|our|new)\s+)*([^,.;:!?\n]+?)${STOP_AFTER}`, "i"));
    if (hire) return cleanSubject(hire[1]!);
    const verb = raw.match(new RegExp(String.raw`\b(?:announcing|announce|introducing|launching|opening|moving|selling)\s+(?:(?:a|an|the|our|my|new)\s+)*([^,.;:!?\n]+?)${STOP_AFTER}`, "i"));
    if (verb) return cleanSubject(verb[1]!);
  }
  if (genre === "quote") return phrasesAfter(raw, "about|on")[0];
  const verb = raw.match(
    new RegExp(String.raw`\b(?:unveil(?:ing)?|launch(?:ing)?|introduc(?:e|ing)|promot(?:e|ing)|announc(?:e|ing)|present(?:ing)?|reveal(?:ing)?)\s+(?:(?:our|my|the|a|an|new|brand[- ]new)\s+)*(?:(?:app|product|brand|collection|range|line|service|course|game|album|book|website|platform|startup|gadget)\s+(?=[A-Z]))?([^,.;:!?\n]+?)${STOP_AFTER}`, "i"),
  );
  const fromVerb = verb ? cleanSubject(verb[1]!) : undefined;
  const generic = phrasesAfter(raw, "for|about|of|promoting|promote|announcing|introducing|launching")[0];
  // "for Nimbus, a budgeting app" → Nimbus; but "for my coffee shop" beats a verb-less guess.
  return generic ?? (fromVerb && !JUNK_SUBJECT.test(fromVerb) ? fromVerb : undefined);
}

// ---- main ---------------------------------------------------------------------------------------

export function parseBrief(prompt: string, opts: { hasMedia?: boolean } = {}): Brief {
  const raw = prompt.trim();
  const lower = raw.toLowerCase();
  const { genre, confidence } = classifyGenre(lower, !!opts.hasMedia);
  const platform = parsePlatform(lower) ?? "generic";
  const length = parseLength(lower);
  const { mood, explicit } = parseMood(lower, genre);
  const { name, relation } = extractName(raw);
  const subject = extractSubject(raw, genre);
  const category = detectCategory(lower);

  return {
    genre,
    confidence,
    platform,
    aspect: aspectFor(platform, lower, genre),
    targetSec: length ?? DEFAULT_LENGTH[genre],
    explicitLength: length !== undefined,
    mood,
    explicitMood: explicit,
    language: parseLanguage(raw, lower),
    musicWord: parseMusicWord(lower),
    paletteWord: parsePaletteWord(lower),
    themeWord: parseThemeWord(lower),
    wantsVoiceover: /\bvoice[- ]?over\b|\bnarrat\w*|\bvoiceover\b|\bwith (?:a )?voice\b|\bnarrated\b/.test(lower),
    usesMedia: /\b(?:my|these|the|our)\s+(?:photos?|pictures?|images?|clips?|footage|videos?|screenshots?)\b|\busing (?:my )?(?:photos|pictures|images)\b/.test(lower),
    subject,
    name: genre === "greeting" || genre === "intro" ? name ?? (genre === "intro" ? subject : undefined) : genre === "testimonial" ? raw.match(/\b(?:from|by|says?)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/u)?.[1] : undefined,
    relation,
    place: genre === "travel" ? subject ?? extractPlace(raw) : extractPlace(raw),
    topic: genre === "explainer" || genre === "tutorial" || genre === "quote" ? subject : genre === "announcement" && /\bhiring\b/i.test(raw) ? "hiring" : undefined,
    count: extractCount(lower),
    occasion: extractOccasion(lower),
    age: extractAge(lower),
    offer: extractOffer(raw),
    when: extractWhen(raw),
    where: extractWhere(raw),
    quote: extractQuote(raw),
    quoteBy: raw.match(/[”"]\s*[—–-]{1,2}\s*([^\n"”]{2,50}?)\s*$/)?.[1]?.trim(),
    category,
    howto: /\bhow to\b/i.test(raw),
    verbal: /\bhow to\b|\b(?:ways?|steps?|tips?|hacks?)\s+to\b/i.test(raw),
    outro: /\boutro\b|\bend ?screen\b|\bend card\b/i.test(raw),
  };
}
