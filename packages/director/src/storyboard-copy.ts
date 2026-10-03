/**
 * COPY — hand-written, genre-aware scene copy for the stub planner. Real sentences
 * built from the user's own nouns (subject, name, place, topic, offer, dates), with
 * several variants per beat so "regenerate" gives something genuinely different.
 * Never lorem ipsum; where a fact can't be known (a customer quote, a rating, the
 * steps of an unfamiliar topic) the copy is a natural stand-in flagged `needsEdit`.
 */
import type { Brief } from "./storyboard-brief";
import type { Genre, Language, SceneGraphic, StoryboardScene } from "./storyboard";

export type SceneRole = StoryboardScene["role"];
export type SceneKind = StoryboardScene["kind"];

export interface CopyCtx {
  brief: Brief;
  /** The subject as the user typed it ("coffee shop", "Brew House"). */
  S: string;
  /** Capitalised in the prompt ⇒ a name, not a category noun. */
  proper: boolean;
  /** "our coffee shop" / "Brew House" — how the business refers to itself. */
  we: string;
  name?: string;
  place?: string;
  topic?: string;
  count: number;
  lang: Language;
  pack: Pack;
  cat: CategoryDef;
  /** True when no subject could be read from the prompt. */
  generic: boolean;
}

export interface Copy {
  heading: string;
  body?: string;
  num?: string;
  emoji?: string;
  graphic?: SceneGraphic;
  needsEdit?: boolean;
  kind?: SceneKind;
}

export interface BeatDef {
  id: string;
  role: SceneRole;
  kind: SceneKind;
  /** 1 = essential (kept first when the video is short). */
  priority: number;
  /** Relative share of the runtime. */
  weight: number;
  variants: ((c: CopyCtx) => Copy)[];
}

// ---- language packs ------------------------------------------------------------------------------

export interface Pack {
  happyBirthday: string;
  happyAnniversary: string;
  congrats: string;
  eid: string;
  thanks: string;
  visit: string;
  follow: string;
  isNew: string;
  bigNews: string;
  invited: string;
  makeAWish: string;
  seeYou: string;
  birthdayLines: [string, string, string];
}

export const PACKS: Record<Language, Pack> = {
  en: {
    happyBirthday: "Happy Birthday",
    happyAnniversary: "Happy Anniversary",
    congrats: "Congratulations",
    eid: "Eid Mubarak",
    thanks: "Thank you",
    visit: "Visit us today",
    follow: "Follow for more",
    isNew: "New",
    bigNews: "Big news",
    invited: "You're invited",
    makeAWish: "Make a wish",
    seeYou: "See you soon",
    birthdayLines: ["May this year bring you everything you've been dreaming of.", "Thank you for being exactly who you are.", "Today is your day. Enjoy every moment."],
  },
  es: {
    happyBirthday: "¡Feliz cumpleaños",
    happyAnniversary: "¡Feliz aniversario",
    congrats: "¡Felicidades",
    eid: "Eid Mubarak",
    thanks: "Gracias",
    visit: "Visítanos hoy",
    follow: "Síguenos para más",
    isNew: "Novedad",
    bigNews: "Gran noticia",
    invited: "Estás invitado",
    makeAWish: "Pide un deseo",
    seeYou: "Hasta pronto",
    birthdayLines: ["Que este año te traiga todo lo que sueñas.", "Gracias por ser exactamente como eres.", "Hoy es tu día. Disfrútalo."],
  },
  fr: {
    happyBirthday: "Joyeux anniversaire",
    happyAnniversary: "Joyeux anniversaire de mariage",
    congrats: "Félicitations",
    eid: "Eid Mubarak",
    thanks: "Merci",
    visit: "Venez nous voir",
    follow: "Suivez-nous",
    isNew: "Nouveau",
    bigNews: "Grande nouvelle",
    invited: "Vous êtes invité",
    makeAWish: "Faites un vœu",
    seeYou: "À bientôt",
    birthdayLines: ["Que cette année t'apporte tout ce dont tu rêves.", "Merci d'être exactement qui tu es.", "Aujourd'hui, c'est ton jour. Profites-en."],
  },
  de: {
    happyBirthday: "Alles Gute zum Geburtstag",
    happyAnniversary: "Alles Gute zum Jahrestag",
    congrats: "Herzlichen Glückwunsch",
    eid: "Eid Mubarak",
    thanks: "Danke",
    visit: "Besuchen Sie uns heute",
    follow: "Folgen für mehr",
    isNew: "Neu",
    bigNews: "Große Neuigkeiten",
    invited: "Du bist eingeladen",
    makeAWish: "Wünsch dir was",
    seeYou: "Bis bald",
    birthdayLines: ["Möge dir dieses Jahr alles bringen, wovon du träumst.", "Danke, dass es dich gibt.", "Heute ist dein Tag. Genieß ihn."],
  },
  ur: {
    happyBirthday: "Saalgirah Mubarak",
    happyAnniversary: "Salgirah Mubarak",
    congrats: "Bohat Bohat Mubarak",
    eid: "Eid Mubarak",
    thanks: "Shukriya",
    visit: "Aaj hi tashreef layein",
    follow: "Follow karein",
    isNew: "Naya",
    bigNews: "Bari khabar",
    invited: "Aap ki dawat hai",
    makeAWish: "Ek wish karein",
    seeYou: "Phir milenge",
    birthdayLines: ["Yeh saal aap ke liye dher saari khushiyan laaye.", "Shukriya ke aap bilkul aise hi hain jaise hain.", "Aaj aap ka din hai. Khoob enjoy karein."],
  },
};

// ---- categories (what the business is) -----------------------------------------------------------------

export interface CategoryDef {
  key: string;
  tags: string[];
  benefits: [string, string][];
  vibes: [string, string][];
  cta: string[];
  emoji: string;
  palette: string;
}

const g = (a: string, b: string): [string, string] => [a, b];

export const CATEGORIES: Record<string, CategoryDef> = {
  coffee: {
    key: "coffee",
    tags: ["Brewed slow. Served warm.", "Your daily ritual, perfected.", "Where every cup feels like home."],
    benefits: [
      g("Freshly roasted", "Beans roasted in small batches and ground the moment you order."),
      g("Made by hand", "Every latte poured with patience, one cup at a time."),
      g("A seat with your name on it", "Soft light, good music and a corner to slow down."),
      g("Something sweet on the side", "Pastries baked fresh each morning to go with your cup."),
    ],
    vibes: [g("Slow mornings", "The best part of your day, in a cup."), g("Good company", "Come alone, leave with a friend.")],
    cta: ["Come in for a cup", "Your table is waiting", "Visit us today"],
    emoji: "☕",
    palette: "coffee",
  },
  food: {
    key: "food",
    tags: ["Made fresh. Made with love.", "Taste the difference.", "Good food, good mood."],
    benefits: [
      g("Fresh every day", "Real ingredients, prepared the moment you order."),
      g("Flavour you can taste", "Recipes perfected over time and served with a smile."),
      g("Made for sharing", "Generous portions and even better moments around the table."),
      g("Right to your door", "Hot, fresh and on its way when you can't make it in."),
    ],
    vibes: [g("Comfort on a plate", "The kind of food that feels like a hug."), g("Come hungry", "Leave happy.")],
    cta: ["Order now", "Come hungry", "Taste it today"],
    emoji: "🍽️",
    palette: "ember",
  },
  fitness: {
    key: "fitness",
    tags: ["Stronger starts today.", "Your best shape, at your pace.", "Show up. We'll do the rest."],
    benefits: [
      g("Coaches who care", "Plans built around your goals, not a one-size template."),
      g("Train your way", "Strength, cardio and classes, all under one roof."),
      g("Results you can feel", "Small wins every week that add up to a new you."),
      g("A crowd that pushes you", "Train beside people who celebrate your progress."),
    ],
    vibes: [g("No excuses", "Just the next rep."), g("Earn it", "Every drop of sweat counts.")],
    cta: ["Book your first session", "Start today", "Join us today"],
    emoji: "💪",
    palette: "ember",
  },
  beauty: {
    key: "beauty",
    tags: ["Glow on your terms.", "Because you deserve it.", "Feel as good as you look."],
    benefits: [
      g("Expert hands", "A skilled team that listens before they begin."),
      g("Products we trust", "Gentle, quality formulas chosen for real results."),
      g("Your time to unwind", "Walk in busy. Walk out glowing."),
      g("Looks that last", "Tailored to you and finished to perfection."),
    ],
    vibes: [g("Treat yourself", "You've earned a little glow."), g("Confidence, styled", "Look in the mirror and smile.")],
    cta: ["Book your appointment", "Treat yourself today", "Reserve your spot"],
    emoji: "✨",
    palette: "berry",
  },
  tech: {
    key: "tech",
    tags: ["Work smarter, not harder.", "Less busywork. More done.", "Built to get out of your way."],
    benefits: [
      g("Set up in minutes", "No training, no friction. Just start."),
      g("Everything in one place", "Your tools and your data, finally together."),
      g("Made to save you time", "Automate the boring parts and focus on what matters."),
      g("Secure by design", "Your data stays yours, always."),
    ],
    vibes: [g("Simple on purpose", "Powerful where it counts."), g("Built for people", "Not for manuals.")],
    cta: ["Try it today", "Get started now", "See it in action"],
    emoji: "🚀",
    palette: "midnight",
  },
  fashion: {
    key: "fashion",
    tags: ["Wear your story.", "Style that feels like you.", "New season. New you."],
    benefits: [
      g("Fresh arrivals", "The newest pieces, hand-picked this season."),
      g("Quality you can feel", "Fabric and finishing made to outlast the trend."),
      g("Mix and match", "Pieces that work together and shine apart."),
      g("Your size, your style", "Fits for every body and every occasion."),
    ],
    vibes: [g("Dress the part", "Whatever part you're playing today."), g("Made to be noticed", "Quietly, confidently.")],
    cta: ["Shop the collection", "Find your look", "Visit us today"],
    emoji: "🛍️",
    palette: "royal",
  },
  education: {
    key: "education",
    tags: ["Learn it. Love it. Use it.", "Your next skill starts here.", "Knowledge that moves you forward."],
    benefits: [
      g("Learn by doing", "Practical lessons you can use the same day."),
      g("Teachers who've been there", "Guidance from people who have done it."),
      g("At your own pace", "Flexible schedules that fit your life."),
      g("Real progress", "Clear goals and honest feedback at every step."),
    ],
    vibes: [g("Curiosity first", "Everything else follows."), g("Small steps", "Big change.")],
    cta: ["Enrol today", "Start learning", "Join the next class"],
    emoji: "🎓",
    palette: "ocean",
  },
  realestate: {
    key: "realestate",
    tags: ["Find a place that feels like yours.", "Home is where it begins.", "Space to live, room to grow."],
    benefits: [
      g("Prime locations", "Close to everything that matters to you."),
      g("Thoughtful design", "Light, space and finishes made for daily life."),
      g("Built to last", "Quality construction you can count on."),
      g("Easy to visit", "Book a viewing that suits your schedule."),
    ],
    vibes: [g("Come home", "To somewhere you love."), g("Your next chapter", "Starts at the front door.")],
    cta: ["Book a viewing", "Visit us today", "Make it yours"],
    emoji: "🏡",
    palette: "forest",
  },
  generic: {
    key: "generic",
    tags: ["Made with care.", "Better, by design.", "Quality you can trust."],
    benefits: [
      g("Made with care", "Every detail considered, nothing left to chance."),
      g("Built around you", "Simple, friendly and designed for real life."),
      g("Quality that lasts", "Done properly the first time."),
      g("Easy to love", "The kind of thing you'll tell your friends about."),
    ],
    vibes: [g("Little things", "Done really well."), g("Be part of it", "We'd love to meet you.")],
    cta: ["Get started today", "Visit us today", "Find out more"],
    emoji: "✨",
    palette: "sunset",
  },
};

// ---- helpers --------------------------------------------------------------------------------------------

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const stripEnd = (s: string): string => s.replace(/[.!?]+$/, "");

/** Platform-appropriate call-to-action graphic. */
export function ctaGraphic(platform: string): SceneGraphic | undefined {
  switch (platform) {
    case "instagram":
      return { preset: "link-in-bio", position: "bottom" };
    case "tiktok":
      return { preset: "follow", position: "bottom" };
    case "youtube":
    case "shorts":
      return { preset: "subscribe", position: "bottom" };
    case "facebook":
      return { preset: "like", position: "bottom" };
    default:
      return undefined;
  }
}

const ctaFollow = (c: CopyCtx): string => {
  switch (c.brief.platform) {
    case "instagram":
      return "Link in bio";
    case "tiktok":
      return "Follow for more";
    case "youtube":
    case "shorts":
      return "Subscribe so you don't miss out";
    case "whatsapp":
      return "Message us to get started";
    case "linkedin":
      return "Connect with us to learn more";
    default:
      return c.lang === "en" ? "We can't wait to see you" : c.pack.follow;
  }
};

// ---- PROMO ----------------------------------------------------------------------------------------------

function promoBeats(c: CopyCtx): BeatDef[] {
  const { cat, we, S, proper, brief } = c;
  const offer = brief.offer;
  const beats: BeatDef[] = [
    {
      id: "promo.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1,
      variants: [
        () => ({ heading: cat.tags[0]!, body: c.generic ? undefined : proper ? S : cap(we), emoji: cat.emoji }),
        () => ({ heading: proper ? `Meet ${S}.` : `Meet your new favourite ${S}.`, emoji: cat.emoji }),
        () => ({ heading: cat.tags[1] ?? cat.tags[0]!, emoji: cat.emoji }),
        () => ({ heading: "Looking for something better?", body: "You just found it.", emoji: cat.emoji }),
      ],
    },
    {
      id: "promo.intro",
      role: "setup",
      kind: "body",
      priority: 3,
      weight: 1,
      variants: [
        () => ({ heading: proper ? `Say hello to ${S}.` : `Say hello to ${we}.`, body: cat.tags[2] ?? cat.tags[0]! }),
        () => ({ heading: `Welcome to ${proper ? S : we}.`, body: "We're so glad you're here." }),
        () => ({ heading: `This is ${proper ? S : we}.`, body: stripEnd(cat.tags[0]!) + ". That's the whole idea." }),
      ],
    },
    {
      id: "promo.b1",
      role: "point",
      kind: "item",
      priority: 2,
      weight: 1.1,
      variants: cat.benefits.map((_, i) => () => ({ heading: cat.benefits[i % cat.benefits.length]![0], body: cat.benefits[i % cat.benefits.length]![1] })),
    },
    {
      id: "promo.b2",
      role: "point",
      kind: "item",
      priority: 4,
      weight: 1.1,
      variants: cat.benefits.map((_, i) => () => ({ heading: cat.benefits[(i + 1) % cat.benefits.length]![0], body: cat.benefits[(i + 1) % cat.benefits.length]![1] })),
    },
    {
      id: "promo.b3",
      role: "point",
      kind: "item",
      priority: 5,
      weight: 1.1,
      variants: cat.benefits.map((_, i) => () => ({ heading: cat.benefits[(i + 2) % cat.benefits.length]![0], body: cat.benefits[(i + 2) % cat.benefits.length]![1] })),
    },
    {
      id: "promo.vibe",
      role: "proof",
      kind: "body",
      priority: 6,
      weight: 0.9,
      variants: cat.vibes.map((_, i) => () => ({ heading: cat.vibes[i % cat.vibes.length]![0], body: cat.vibes[i % cat.vibes.length]![1] })),
    },
    {
      id: "promo.offer",
      role: "offer",
      kind: "title",
      priority: offer ? 2 : 7,
      weight: 1.1,
      variants: [
        () => ({
          heading: offer ?? "Made to be enjoyed.",
          body: offer ? "Don't miss out." : `Everything at ${proper ? S : we}, made with care.`,
          graphic: offer && /%|sale|free|one/i.test(offer) ? { preset: "badge-sale", position: "top-right" } : undefined,
        }),
        () => ({ heading: offer ?? "Little things, done well.", body: offer ? "Treat yourself." : "That's our promise.", graphic: offer ? { preset: "badge-sale", position: "top-right" } : undefined }),
      ],
    },
    {
      id: "promo.cta",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [0, 1, 2].map((i) => (cx: CopyCtx) => ({
        heading: cx.lang === "en" ? cat.cta[i % cat.cta.length]! : cx.pack.visit,
        body: ctaFollow(cx),
        graphic: ctaGraphic(cx.brief.platform),
      })),
    },
  ];
  return beats;
}

// ---- GREETING (birthday, anniversary, eid, graduation…) ---------------------------------------------------------

interface OccasionDef {
  hook: (c: CopyCtx) => string;
  hookBody: string[];
  lines: [string, string][];
  close: [string, string][];
  emoji: string;
}

const withName = (lead: string, name?: string, comma = true): string => (name ? `${lead}${comma ? "," : ""} ${name}!` : `${lead}!`);

/** "¡Feliz cumpleaños, Ana!" needs its opening "¡" closed with "!" — the pack already includes the opening mark. */
const greet = (lead: string, name?: string): string => (name ? `${lead}, ${name}!` : `${lead}!`);

const RELATION_LINES: Record<string, [string, string]> = {
  friend: ["Thank you for being you", "Life is brighter with you in it."],
  "best friend": ["Thank you for being you", "Life is brighter with you in it."],
  bestie: ["Thank you for being you", "Life is brighter with you in it."],
  mom: ["You make the world feel like home", "Thank you for every sacrifice, every hug, every prayer."],
  mum: ["You make the world feel like home", "Thank you for every sacrifice, every hug, every prayer."],
  mother: ["You make the world feel like home", "Thank you for every sacrifice, every hug, every prayer."],
  dad: ["My hero, my guide, my friend", "Everything good in me started with you."],
  father: ["My hero, my guide, my friend", "Everything good in me started with you."],
  sister: ["Partner in everything", "Thank you for being my built-in best friend."],
  brother: ["Always had my back", "Thank you for being the best kind of trouble."],
  wife: ["My favourite person", "Every day with you is the best day."],
  husband: ["My favourite person", "Every day with you is the best day."],
  girlfriend: ["My favourite person", "Every day with you is the best day."],
  boyfriend: ["My favourite person", "Every day with you is the best day."],
  boss: ["Thank you for leading with heart", "You make us better at what we do."],
  teacher: ["Thank you for believing in us", "You changed the way we see the world."],
  colleague: ["Work is better with you", "Thanks for the teamwork and the laughs."],
  coworker: ["Work is better with you", "Thanks for the teamwork and the laughs."],
  grandma: ["Your love is our family's superpower", "Thank you for every story and every hug."],
  grandmother: ["Your love is our family's superpower", "Thank you for every story and every hug."],
  grandpa: ["Wisdom, warmth and the best stories", "We learn something from you every day."],
  grandfather: ["Wisdom, warmth and the best stories", "We learn something from you every day."],
  son: ["So proud of you", "Watching you grow is the best gift."],
  daughter: ["So proud of you", "Watching you grow is the best gift."],
  mentor: ["Thank you for showing the way", "Your guidance means more than you know."],
};

const OCCASIONS: Record<string, OccasionDef> = {
  birthday: {
    hook: (c) => greet(c.pack.happyBirthday, c.name),
    hookBody: ["Another year, another reason to celebrate.", "Today is all about you.", "The world is brighter with you in it."],
    lines: [
      ["Wishing you a year full of joy", "Every good thing you've been hoping for is on its way."],
      ["May every day feel like today", "Laughter, cake and the people who love you."],
      ["Here's to new adventures", "Bigger dreams, brighter days and endless reasons to smile."],
    ],
    close: [
      ["Have the best day!", "Enjoy every second. You've earned it."],
      ["With love, always", "Now go and eat some cake."],
    ],
    emoji: "🎂",
  },
  anniversary: {
    hook: (c) => greet(c.pack.happyAnniversary, c.name),
    hookBody: ["Another year of love.", "Look how far you've come together."],
    lines: [
      ["Every moment counts", "From the first hello to today, it's all been worth it."],
      ["Still the best part of the day", "Thank you for choosing each other, every day."],
      ["Here's to many more", "More laughter, more adventures, more us."],
    ],
    close: [["Cheers to you both", "Happy anniversary!"]],
    emoji: "💞",
  },
  eid: {
    hook: (c) => withName(c.pack.eid, c.name),
    hookBody: ["Wishing you peace, joy and blessings.", "May your day be full of light."],
    lines: [
      ["May this Eid bring you peace", "Joy in your heart and happiness in your home."],
      ["Celebrate with the ones you love", "Good food, warm hugs and gratitude for it all."],
      ["Blessings for the year ahead", "May every prayer be answered and every dream grow."],
    ],
    close: [["Eid Mubarak to you and your family", "Wishing you a beautiful celebration."]],
    emoji: "🌙",
  },
  ramadan: {
    hook: () => "Ramadan Mubarak!",
    hookBody: ["Wishing you a blessed month.", "May it bring peace and reflection."],
    lines: [
      ["A month of mercy", "May every fast and every prayer be accepted."],
      ["Time for gratitude", "For family, for health and for each other."],
      ["Share the blessings", "Open your table and your heart."],
    ],
    close: [["Ramadan Kareem", "Wishing you a peaceful month."]],
    emoji: "🌙",
  },
  newyear: {
    hook: (c) => withName("Happy New Year", c.name),
    hookBody: ["A fresh page, a brand-new start.", "Out with the old. In with the bold."],
    lines: [
      ["Thank you for the year behind us", "The wins, the lessons and the laughs."],
      ["Big things are coming", "Bigger dreams, braver steps, better days."],
      ["Make this one count", "You've got everything it takes."],
    ],
    close: [["Cheers to the year ahead", "Here's to the best one yet."]],
    emoji: "🎆",
  },
  graduation: {
    hook: (c) => greet(c.pack.congrats, c.name),
    hookBody: ["You did it.", "Every late night was worth it."],
    lines: [
      ["Hard work, paid off", "All the effort, all the early mornings. It all led here."],
      ["Look how far you've come", "From the first day to the last. We're so proud."],
      ["The best is still ahead", "A whole new chapter is waiting for you."],
    ],
    close: [["Go get them", "The world is lucky to have you."]],
    emoji: "🎓",
  },
  congrats: {
    hook: (c) => greet(c.pack.congrats, c.name),
    hookBody: ["You earned every bit of this.", "What a moment!"],
    lines: [
      ["You made it happen", "Hard work, heart and a little bit of magic."],
      ["We're so proud of you", "Not just for this, but for who you are."],
      ["Keep shining", "This is only the beginning."],
    ],
    close: [["Time to celebrate", "You deserve every cheer."]],
    emoji: "🎉",
  },
  wedding: {
    hook: (c) => greet(c.pack.congrats, c.name),
    hookBody: ["On your wedding day.", "Today, two stories become one."],
    lines: [
      ["Love looks beautiful on you", "May every day feel as special as this one."],
      ["A lifetime of laughter", "And a home full of warmth."],
      ["Here's to forever", "Cheers to the beginning of your happily ever after."],
    ],
    close: [["Congratulations, to you both", "Wishing you a lifetime of love."]],
    emoji: "💍",
  },
  valentine: {
    hook: (c) => withName("Happy Valentine's Day", c.name),
    hookBody: ["For the one who makes it all better.", "Love is in the little things."],
    lines: [
      ["You're my favourite hello", "And my hardest goodbye."],
      ["Every day with you", "Feels like the best day of my life."],
      ["Thank you for being mine", "Today and always."],
    ],
    close: [["Forever yours", "Happy Valentine's Day."]],
    emoji: "❤️",
  },
  diwali: {
    hook: (c) => withName("Happy Diwali", c.name),
    hookBody: ["May your home glow with light.", "Wishing you joy and prosperity."],
    lines: [
      ["Let the lights guide you", "To happiness, health and good fortune."],
      ["Celebrate together", "Sweets, laughter and the people you love."],
      ["A brighter year ahead", "May every day shine like tonight."],
    ],
    close: [["Shubh Deepavali", "Wishing you a joyful festival of lights."]],
    emoji: "🪔",
  },
  christmas: {
    hook: (c) => withName("Merry Christmas", c.name),
    hookBody: ["Wishing you warmth and wonder.", "Peace, joy and a little magic."],
    lines: [
      ["Gather the ones you love", "There's no better gift than time together."],
      ["Spread a little cheer", "Kindness is the best decoration."],
      ["A season of gratitude", "Thank you for being part of our year."],
    ],
    close: [["Happy holidays", "See you in the new year."]],
    emoji: "🎄",
  },
  parentsday: {
    hook: (c) => withName("Happy Mother's & Father's Day", c.name),
    hookBody: ["To the ones who gave us everything."],
    lines: [
      ["Thank you for believing in us", "Even when we didn't believe in ourselves."],
      ["Your love shaped who we are", "Every lesson, every sacrifice, every hug."],
      ["We love you more than words", "But we wanted to try."],
    ],
    close: [["With all our love", "Today and every day."]],
    emoji: "💐",
  },
  thanks: {
    hook: (c) => withName(c.pack.thanks, c.name),
    hookBody: ["From the bottom of our hearts.", "We noticed. We're grateful."],
    lines: [
      ["You made a difference", "More than you know."],
      ["We couldn't have done it without you", "Your support means everything."],
      ["Kindness comes back around", "And we hope it finds you."],
    ],
    close: [["Truly, thank you", "With gratitude."]],
    emoji: "🙏",
  },
  getwell: {
    hook: (c) => withName("Get well soon", c.name),
    hookBody: ["Thinking of you today.", "Sending you strength and sunshine."],
    lines: [
      ["Rest. Recover. Repeat.", "Nothing else matters right now."],
      ["You're stronger than you know", "And so many people are rooting for you."],
      ["We're just a call away", "For anything you need."],
    ],
    close: [["Come back soon", "We miss you already."]],
    emoji: "🌻",
  },
  generic: {
    hook: (c) => withName("Sending you good vibes", c.name, false),
    hookBody: ["Just because you're wonderful.", "A little something to brighten your day."],
    lines: [
      ["You deserve all the good things", "Today and every day."],
      ["Thank you for being you", "The world is better with you in it."],
      ["Keep smiling", "It looks great on you."],
    ],
    close: [["Warmest wishes", "From my heart to yours."]],
    emoji: "🎉",
  },
};

function greetingBeats(c: CopyCtx): BeatDef[] {
  const occ = OCCASIONS[c.brief.occasion ?? "generic"] ?? OCCASIONS.generic!;
  const isBirthday = (c.brief.occasion ?? "generic") === "birthday";
  const rel = c.brief.relation ? RELATION_LINES[c.brief.relation] : undefined;
  const beats: BeatDef[] = [
    {
      id: "greet.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1.3,
      variants: occ.hookBody.map((body) => (cx: CopyCtx) => ({
        heading: occ.hook(cx),
        body: cx.lang === "en" || !isBirthday ? body : undefined,
        emoji: occ.emoji,
        graphic: { preset: "sparkles", position: "top-right" },
      })),
    },
  ];
  if (c.brief.age && isBirthday) {
    beats.push({
      id: "greet.age",
      role: "detail",
      kind: "title",
      priority: 2,
      weight: 1,
      variants: [
        (cx) => ({ heading: `${cx.brief.age} today!`, body: `${cx.brief.age} looks great on ${cx.name ?? "you"}.`, emoji: "🎈" }),
        (cx) => ({ heading: `Turning ${cx.brief.age}`, body: "Older, wiser and better than ever.", emoji: "🎈" }),
      ],
    });
  }
  if (rel) {
    beats.push({
      id: "greet.rel",
      role: "point",
      kind: "body",
      priority: 2,
      weight: 1.2,
      variants: [() => ({ heading: rel[0], body: rel[1], emoji: "💛", graphic: { preset: "heart", position: "bottom-right" } })],
    });
  }
  occ.lines.forEach((line, i) => {
    beats.push({
      id: `greet.l${i}`,
      role: "wish",
      kind: "body",
      priority: i === 0 ? 2 : i + 3,
      weight: 1.1,
      variants:
        c.lang !== "en" && isBirthday
          ? [(cx: CopyCtx) => ({ heading: cx.pack.birthdayLines[i % 3]!, emoji: occ.emoji })]
          : [() => ({ heading: line[0], body: line[1], emoji: occ.emoji }), () => ({ heading: line[0], body: line[1], emoji: occ.emoji })],
    });
  });
  if (isBirthday) {
    beats.splice(Math.min(beats.length, 3), 0, {
      id: "greet.wish",
      role: "detail",
      kind: "title",
      priority: 4,
      weight: 1,
      variants: [
        (cx) => ({ heading: `${cx.pack.makeAWish}.`, body: cx.lang === "en" ? "Close your eyes… and blow out the candles." : undefined, emoji: "🕯️", graphic: { preset: "star", position: "top-left" } }),
      ],
    });
  }
  beats.push({
    id: "greet.close",
    role: "outro",
    kind: "cta",
    priority: 1,
    weight: 1.3,
    variants:
      c.lang !== "en" && isBirthday
        ? [(cx: CopyCtx) => ({ heading: cx.pack.birthdayLines[2], emoji: occ.emoji, graphic: { preset: "heart", position: "bottom" } as SceneGraphic })]
        : occ.close.map(([h, b]) => () => ({ heading: h, body: b, emoji: occ.emoji, graphic: { preset: "heart", position: "bottom" } as SceneGraphic })),
  });
  return beats;
}

// ---- EXPLAINER --------------------------------------------------------------------------------------------

interface Knowledge {
  match: RegExp;
  title: string;
  hook: string;
  steps: [string, string][];
  recap: [string, string];
}

const KNOWLEDGE: Knowledge[] = [
  {
    match: /photosynthesis/,
    title: "Photosynthesis",
    hook: "How does a plant make food from sunlight?",
    steps: [
      ["1. Sunlight is captured", "Chlorophyll in the leaves absorbs light energy from the sun."],
      ["2. Water and air come in", "Roots draw up water. Leaves take in carbon dioxide through tiny pores."],
      ["3. Light becomes sugar", "The plant uses that energy to turn them into glucose, its food."],
      ["4. Oxygen is released", "The leftover oxygen escapes into the air, and it's what we breathe."],
    ],
    recap: ["Sunlight + water + carbon dioxide", "become sugar and oxygen."],
  },
  {
    match: /water cycle|rain (?:form|cycle)|how (?:does )?rain/,
    title: "The water cycle",
    hook: "Where does rain actually come from?",
    steps: [
      ["1. Evaporation", "The sun warms oceans and lakes, and water rises as invisible vapour."],
      ["2. Condensation", "High up, the vapour cools and gathers into tiny droplets, forming clouds."],
      ["3. Precipitation", "When droplets grow heavy enough, they fall as rain, snow or hail."],
      ["4. Collection", "Water flows into rivers and seas, and the cycle starts again."],
    ],
    recap: ["The same water, over and over", "That's the water cycle."],
  },
  {
    match: /internet|wi-?fi|\bweb\b/,
    title: "How the internet works",
    hook: "What happens when you open a website?",
    steps: [
      ["1. You send a request", "Your device asks for a page, using the site's address."],
      ["2. The address is looked up", "A directory called DNS turns the name into a number computers understand."],
      ["3. Data travels in packets", "The page is split into tiny packets that race across cables and routers."],
      ["4. Your device reassembles it", "The packets arrive, snap together, and the page appears."],
    ],
    recap: ["Request, lookup, packets, page", "All in a fraction of a second."],
  },
  {
    match: /black ?holes?/,
    title: "Black holes",
    hook: "What is a black hole?",
    steps: [
      ["1. A giant star runs out of fuel", "When it can no longer push outward, gravity wins."],
      ["2. The core collapses", "Matter is crushed into an incredibly tiny, incredibly dense point."],
      ["3. Gravity becomes extreme", "Nothing nearby can escape, not even light."],
      ["4. The event horizon", "That point of no return is what gives a black hole its edge."],
    ],
    recap: ["A collapsed star", "with gravity too strong for light to escape."],
  },
  {
    match: /compound (?:interest|growth)/,
    title: "Compound interest",
    hook: "Why does money grow faster over time?",
    steps: [
      ["1. You start with a sum", "Say you save or invest an amount, called the principal."],
      ["2. It earns interest", "After a year, you earn a percentage on that amount."],
      ["3. Interest earns interest", "Next year, you earn on the original sum plus last year's interest."],
      ["4. Time does the heavy lifting", "The longer it stays, the faster it snowballs."],
    ],
    recap: ["Start early. Stay patient.", "Compounding rewards time."],
  },
  {
    match: /vaccin\w*|immunity|immune system/,
    title: "How vaccines work",
    hook: "How does a vaccine protect you?",
    steps: [
      ["1. It shows your body a preview", "A vaccine contains a harmless piece or weakened form of a germ."],
      ["2. Your immune system responds", "It learns to recognise the germ and builds antibodies."],
      ["3. Memory cells are made", "Some immune cells remember how to fight it for years."],
      ["4. The real thing meets a ready defence", "If you're exposed later, your body reacts fast."],
    ],
    recap: ["A safe rehearsal", "for your immune system."],
  },
  {
    match: /block ?chain|bitcoin|crypto(?:currency)?/,
    title: "Blockchain",
    hook: "What is a blockchain?",
    steps: [
      ["1. A transaction is made", "Someone sends value or records data."],
      ["2. It's grouped into a block", "Many transactions are bundled together."],
      ["3. The network checks it", "Many computers verify the block follows the rules."],
      ["4. The block is chained on", "Each block links to the one before, so changing the past breaks the chain."],
    ],
    recap: ["A shared record", "that's very hard to rewrite."],
  },
  {
    match: /machine learning|artificial intelligence|\bai\b|neural network/,
    title: "How AI learns",
    hook: "How does an AI actually learn?",
    steps: [
      ["1. It's shown lots of examples", "Thousands or millions of pictures, sentences or numbers."],
      ["2. It makes a guess", "At first, the guess is almost random."],
      ["3. It checks the answer", "The system measures how wrong it was and adjusts itself slightly."],
      ["4. Repeat, many times", "Gradually the guesses improve, until patterns are learned."],
    ],
    recap: ["Guess, check, adjust", "again and again."],
  },
  {
    match: /greenhouse|global warming|climate change/,
    title: "The greenhouse effect",
    hook: "Why is the planet getting warmer?",
    steps: [
      ["1. Sunlight warms the Earth", "Most of the sun's energy passes through the atmosphere."],
      ["2. The Earth gives off heat", "The warmed surface sends heat back toward space."],
      ["3. Some gases trap it", "Carbon dioxide and methane absorb part of that heat."],
      ["4. More gas, more trapped heat", "Burning fuels adds extra gas, so the planet warms."],
    ],
    recap: ["Natural greenhouse effect: essential.", "Too much: a problem."],
  },
  {
    match: /electricity|\bcurrent\b|circuit/,
    title: "How electricity works",
    hook: "What actually flows through a wire?",
    steps: [
      ["1. Atoms hold tiny charges", "Electrons orbit atoms, and in metals some move freely."],
      ["2. A push starts the flow", "A battery or generator creates a voltage that pushes electrons."],
      ["3. A circuit gives them a path", "A closed loop lets the electrons keep moving."],
      ["4. Energy does work", "Along the way, that moving energy lights bulbs and spins motors."],
    ],
    recap: ["A push, a path, and energy", "doing useful work."],
  },
  {
    match: /gravity/,
    title: "Gravity",
    hook: "Why do things fall?",
    steps: [
      ["1. Everything with mass attracts", "Every object pulls on every other object."],
      ["2. Bigger mass, bigger pull", "Earth is so massive that its pull dominates everything near it."],
      ["3. Distance matters", "The farther apart two objects are, the weaker the pull."],
      ["4. It shapes the universe", "Gravity holds us to the ground and keeps planets in orbit."],
    ],
    recap: ["Mass attracts mass", "and that's why we stay grounded."],
  },
];

function explainerBeats(c: CopyCtx): BeatDef[] {
  const T = c.topic ?? c.S;
  const kb = KNOWLEDGE.find((k) => k.match.test(T.toLowerCase()) || k.match.test(c.brief.topic?.toLowerCase() ?? ""));
  const beats: BeatDef[] = [];
  if (kb) {
    beats.push({
      id: "explain.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1.2,
      variants: [() => ({ heading: kb.hook, body: `${kb.title}, explained simply.`, emoji: "💡" }), () => ({ heading: `${kb.title}, explained.`, body: kb.hook, emoji: "💡" })],
    });
    kb.steps.forEach(([h, b], i) =>
      beats.push({
        id: `explain.s${i}`,
        role: "point",
        kind: "item",
        priority: i === 0 ? 2 : i === kb.steps.length - 1 ? 3 : 4 + i,
        weight: 1.5,
        variants: [() => ({ heading: h.replace(/^\d+\.\s*/, ""), body: b, num: String(i + 1).padStart(2, "0") })],
      }),
    );
    beats.push({
      id: "explain.recap",
      role: "outro",
      kind: "cta",
      priority: 1,
      weight: 1.3,
      variants: [() => ({ heading: kb.recap[0], body: kb.recap[1], emoji: "✅", graphic: { preset: "done", position: "bottom" } })],
    });
    return beats;
  }
  // Generic scaffold: a clear arc the user fills with their facts.
  const t = stripEnd(T);
  beats.push(
    {
      id: "explain.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1.2,
      variants: [
        () => ({ heading: `How does ${t} work?`, body: "The short version, in under a minute.", emoji: "💡" }),
        () => ({ heading: `${cap(t)}, explained simply.`, body: "No jargon. Just the parts that matter.", emoji: "💡" }),
        () => ({ heading: `What is ${t}?`, body: "Let's break it down.", emoji: "💡" }),
      ],
    },
    {
      id: "explain.big",
      role: "setup",
      kind: "body",
      priority: 3,
      weight: 1.3,
      variants: [
        () => ({ heading: "Start with the big picture", body: `${cap(t)} comes down to a few simple ideas working together.`, needsEdit: true }),
        () => ({ heading: "Here's the idea", body: `Once you see how ${t} fits together, the rest makes sense.`, needsEdit: true }),
      ],
    },
    {
      id: "explain.s0",
      role: "point",
      kind: "item",
      priority: 2,
      weight: 1.5,
      variants: [
        () => ({ heading: "It starts with a trigger", body: `Every time ${t} happens, something sets it in motion.`, num: "01", needsEdit: true }),
        () => ({ heading: "First, the input", body: `${cap(t)} begins with what goes in. Name it here.`, num: "01", needsEdit: true }),
      ],
    },
    {
      id: "explain.s1",
      role: "point",
      kind: "item",
      priority: 3,
      weight: 1.5,
      variants: [
        () => ({ heading: "Then the process", body: "Inside, the key steps happen one after another.", num: "02", needsEdit: true }),
        () => ({ heading: "Next, the middle", body: "This is where the real work happens.", num: "02", needsEdit: true }),
      ],
    },
    {
      id: "explain.s2",
      role: "point",
      kind: "item",
      priority: 4,
      weight: 1.5,
      variants: [
        () => ({ heading: "Finally, the result", body: `That's what ${t} produces, and why it matters.`, num: "03", needsEdit: true }),
        () => ({ heading: "And out comes the outcome", body: "The end result is what you actually notice.", num: "03", needsEdit: true }),
      ],
    },
    {
      id: "explain.why",
      role: "proof",
      kind: "body",
      priority: 5,
      weight: 1.2,
      variants: [
        () => ({ heading: "Why it matters", body: `Understanding ${t} helps you make better decisions.`, needsEdit: true }),
        () => ({ heading: "So what?", body: "Because small ideas explain big things.", needsEdit: true }),
      ],
    },
    {
      id: "explain.recap",
      role: "outro",
      kind: "cta",
      priority: 1,
      weight: 1.3,
      variants: [
        () => ({ heading: `That's ${t}.`, body: "Simple when you see the parts.", emoji: "✅", graphic: { preset: "done", position: "bottom" } }),
        () => ({ heading: "Now you know.", body: `${cap(t)}, in a nutshell.`, emoji: "✅", graphic: { preset: "done", position: "bottom" } }),
      ],
    },
  );
  return beats;
}

export function explainerKnown(topic: string | undefined): boolean {
  return !!topic && KNOWLEDGE.some((k) => k.match.test(topic.toLowerCase()));
}

// ---- TUTORIAL / TIPS ------------------------------------------------------------------------------------------

const TIP_BANKS: { match: RegExp; tips: [string, string][] }[] = [
  {
    match: /sleep|insomnia|rest\b/,
    tips: [
      ["Keep a steady schedule", "Go to bed and wake up at the same time, even on weekends."],
      ["Cool, dark and quiet", "Aim for a cool room and block out light and noise."],
      ["Screens off an hour before", "Blue light tells your brain it's still daytime."],
      ["Watch caffeine after lunch", "It can linger in your system for up to eight hours."],
      ["Build a wind-down ritual", "Read, stretch or journal. Tell your body it's time."],
      ["Get daylight in the morning", "It sets your body clock for the night ahead."],
    ],
  },
  {
    match: /study|exam|focus|productiv|concentrat|time management/,
    tips: [
      ["Pick one thing", "Decide your single most important task before you begin."],
      ["Work in short bursts", "25 focused minutes, then a 5-minute break."],
      ["Silence the noise", "Phone away, notifications off, tabs closed."],
      ["Test yourself", "Recalling beats rereading every time."],
      ["Plan tomorrow tonight", "Wake up knowing exactly where to start."],
      ["Sleep on it", "Rest is when your brain locks in what you learned."],
    ],
  },
  {
    match: /money|saving|budget|invest|finance|debt/,
    tips: [
      ["Pay yourself first", "Move savings out the day you get paid."],
      ["Track every expense", "You can't improve what you don't measure."],
      ["Build a small emergency fund", "Even one month of costs brings real peace of mind."],
      ["Cut the silent subscriptions", "Cancel what you don't use."],
      ["Wait 24 hours before big buys", "The urge usually passes."],
      ["Automate it", "Let savings happen without willpower."],
    ],
  },
  {
    match: /fitness|workout|exercise|weight|muscle|gym|run(?:ning)?/,
    tips: [
      ["Start smaller than you think", "Ten minutes a day beats an hour once a month."],
      ["Move in ways you enjoy", "The best workout is the one you'll keep doing."],
      ["Fuel your body", "Protein, plants and plenty of water."],
      ["Progress a little each week", "A bit more weight, a bit more time."],
      ["Rest is part of training", "Muscles grow while you recover."],
      ["Track your wins", "Notice how far you've come."],
    ],
  },
  {
    match: /public speaking|presentation|speech|interview|confidence/,
    tips: [
      ["Know your first sentence", "A confident start carries you through."],
      ["Slow down", "Pauses make you sound sure and give people time to think."],
      ["Talk to one person at a time", "Make eye contact and it feels like a conversation."],
      ["Practice out loud", "Rehearse standing up, just like the real thing."],
      ["Tell a story", "People remember stories long after the facts."],
      ["Breathe", "A deep breath resets your nerves."],
    ],
  },
  {
    match: /photograph\w*|camera|photo tips/,
    tips: [
      ["Chase good light", "Golden hour makes everything look better."],
      ["Mind the background", "A clean backdrop makes your subject pop."],
      ["Use the rule of thirds", "Place your subject off-centre for balance."],
      ["Get closer", "Then get closer again."],
      ["Change your angle", "Crouch, climb or tilt for something fresh."],
      ["Edit lightly", "Enhance the shot, don't rescue it."],
    ],
  },
  {
    match: /language|english|speaking a|vocabulary|grammar/,
    tips: [
      ["Practice a little every day", "Fifteen minutes daily beats a weekend cram."],
      ["Learn phrases, not just words", "Chunks of language sound natural."],
      ["Listen constantly", "Podcasts, songs and shows count."],
      ["Speak from day one", "Mistakes are how you learn."],
      ["Use it in real life", "Label things, text a friend, think in the language."],
      ["Be patient", "Fluency comes in layers."],
    ],
  },
  {
    match: /stress|anxiety|mental|mindful|burnout|calm/,
    tips: [
      ["Take three slow breaths", "In for four, out for six."],
      ["Step outside", "Even five minutes of fresh air helps."],
      ["Write it down", "Getting it out of your head makes it smaller."],
      ["Say no to one thing", "Protect your energy."],
      ["Move your body", "A short walk can change your mood."],
      ["Talk to someone", "You don't have to carry it alone."],
    ],
  },
  {
    match: /skin ?care|skin|acne|beauty|glow/,
    tips: [
      ["Cleanse gently", "Twice a day is plenty."],
      ["Moisturise every day", "Even oily skin needs hydration."],
      ["Never skip sunscreen", "It's the best anti-ageing product there is."],
      ["Introduce one product at a time", "So you know what works for you."],
      ["Drink water and sleep well", "Your skin shows it."],
      ["Be patient", "Real results take weeks."],
    ],
  },
  {
    match: /instagram|social media|content|grow(?:th)? (?:your )?(?:audience|followers|channel)|youtube channel|tiktok|creator|reels?/,
    tips: [
      ["Hook them in the first second", "Start with the most interesting part."],
      ["Post consistently", "A steady rhythm beats occasional bursts."],
      ["Say one thing per video", "Clear beats clever."],
      ["Add captions", "Many people watch with the sound off."],
      ["Talk to your audience", "Reply to comments and ask questions."],
      ["Study what works", "Then make it yours."],
    ],
  },
  {
    match: /cod(?:e|ing)|program\w*|developer|software/,
    tips: [
      ["Build small projects", "Finishing beats tutorials."],
      ["Read other people's code", "It's the fastest way to see new ideas."],
      ["Learn to debug calmly", "Read the error. Change one thing at a time."],
      ["Use version control early", "Commit often, thank yourself later."],
      ["Write it down", "Notes and comments save hours."],
      ["Ask good questions", "Show what you tried."],
    ],
  },
];

const GENERIC_TIPS: [string, string][] = [
  ["Start small", "A tiny first step beats a perfect plan."],
  ["Be consistent", "Showing up every day matters more than going big once."],
  ["Learn from the best", "Study people who've already done it."],
  ["Track your progress", "What you measure, you improve."],
  ["Don't fear mistakes", "Every mistake is a lesson in disguise."],
  ["Keep going", "Most people quit right before it starts to work."],
];

const HOWTO_STEPS: [string, string][] = [
  ["Get everything ready", "Gather what you need before you start."],
  ["Begin with the basics", "Get the foundation right and the rest gets easier."],
  ["Take it one step at a time", "No rushing. Follow the order."],
  ["Check as you go", "Pause and make sure it looks right."],
  ["Make it your own", "Add your own touch."],
  ["Finish and share", "You did it. Now show someone."],
];

function tutorialBeats(c: CopyCtx): BeatDef[] {
  const T = stripEnd(c.topic ?? c.S);
  const howto = !!c.brief.howto;
  const lowerPrompt = (c.brief.topic ?? "").toLowerCase();
  const bank = TIP_BANKS.find((b) => b.match.test(lowerPrompt))?.tips ?? (howto ? HOWTO_STEPS : GENERIC_TIPS);
  const n = c.count;
  const ordered = howto && !TIP_BANKS.some((b) => b.match.test(lowerPrompt));
  const beats: BeatDef[] = [
    {
      id: "tut.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1.2,
      variants: c.brief.verbal
        ? [
            () => ({ heading: howto || !c.brief.count ? `How to ${T}` : `${n} ways to ${T}`, body: howto ? "A simple step-by-step guide." : "Quick, practical and easy to start today.", emoji: "📌" }),
            () => ({ heading: howto ? `Want to ${T}?` : `${n} ways to ${T}`, body: howto ? "Here's exactly how." : "Save this for later.", emoji: "📌" }),
          ]
        : [
            () => ({ heading: `${n} tips for ${T}`, body: "Quick, practical and easy to start today.", emoji: "📌" }),
            () => ({ heading: `${n} ways to nail ${T}`, body: "Save this for later.", emoji: "📌" }),
            () => ({ heading: `Better ${T}, starting now`, body: `${n} simple ideas.`, emoji: "📌" }),
          ],
    },
  ];
  for (let i = 0; i < Math.min(n, bank.length, 8); i++) {
    beats.push({
      id: `tut.t${i}`,
      role: "point",
      kind: "item",
      priority: 2 + i * 0.1,
      weight: 1.4,
      variants: ordered
        ? [() => ({ heading: bank[i % bank.length]![0], body: bank[i % bank.length]![1], num: String(i + 1).padStart(2, "0"), needsEdit: true })]
        : bank.map((_, v) => () => {
            const [h, b] = bank[(i + v) % bank.length]!;
            return { heading: h, body: b, num: String(i + 1).padStart(2, "0") };
          }),
    });
  }
  beats.push({
    id: "tut.cta",
    role: "cta",
    kind: "cta",
    priority: 1,
    weight: 1.2,
    variants: [
      (cx) => ({ heading: "Try one today", body: ctaFollow(cx) === "We can't wait to see you" ? "Save this and share it with a friend." : ctaFollow(cx), emoji: "✅", graphic: ctaGraphic(cx.brief.platform) ?? { preset: "done", position: "bottom" } }),
      () => ({ heading: "Which one will you start with?", body: "Save this for later.", emoji: "✅", graphic: { preset: "done", position: "bottom" } }),
    ],
  });
  return beats;
}

// ---- TRAVEL ------------------------------------------------------------------------------------------------

const PLACES: { match: RegExp; lines: string[] }[] = [
  { match: /istanbul/, lines: ["Two continents, one skyline", "Çay by the Bosphorus", "Domes, minarets and golden sunsets", "Lost in the Grand Bazaar", "Simit, baklava and one more çay"] },
  { match: /paris/, lines: ["Café mornings on every corner", "The Seine at golden hour", "Lights, lanes and long walks", "Croissants worth the queue", "Still can't believe it's real"] },
  { match: /dubai/, lines: ["Skylines that touch the clouds", "Golden dunes at sunset", "Where the old souk meets the future", "Every view bigger than the last", "A city that never stops glowing"] },
  { match: /london/, lines: ["Red buses and rainy-day charm", "Big Ben at golden hour", "Tea, markets and secret lanes", "History around every corner", "Hello again, London"] },
  { match: /tokyo|japan/, lines: ["Neon nights, quiet temples", "Ramen at midnight", "Order and wonder everywhere", "Cherry blossoms and city lights", "Already planning the return"] },
  { match: /lahore/, lines: ["The Walled City at dawn", "Badshahi Mosque, golden at sunset", "Food street feasts", "Every lane tells a story", "Dil se Lahore"] },
  { match: /karachi/, lines: ["Sea breeze and city lights", "Streets full of flavour", "The city that never sleeps", "Sunset by the shore", "Karachi, always alive"] },
  { match: /islamabad/, lines: ["The Margalla Hills at sunrise", "Green, calm and beautiful", "Evening walks above the city", "Mountains on the horizon", "Peaceful, polished Islamabad"] },
  { match: /hunza|skardu|swat|gilgit|murree|naran|kaghan|northern areas/, lines: ["Mountains that take your breath away", "Rivers the colour of glass", "Roads that wind through the clouds", "Quiet mornings above the valley", "We left a piece of our hearts here"] },
  { match: /rome|italy/, lines: ["Ancient streets, endless stories", "Pasta, gelato, repeat", "Golden light on old stone", "Every piazza a postcard", "Roma, we'll be back"] },
  { match: /new york|nyc/, lines: ["City lights that never dim", "Yellow cabs and skyline views", "Central Park in the golden hour", "Pizza on every corner", "The city that never sleeps"] },
  { match: /bali/, lines: ["Rice terraces in the morning light", "Temples, waves and slow days", "Sunsets that stop you in your tracks", "Island time, all the time", "Terima kasih, Bali"] },
  { match: /maldives/, lines: ["Water so clear it looks unreal", "Sunrise over the lagoon", "Barefoot and carefree", "Paradise, rediscovered", "Never wanted to leave"] },
  { match: /cappadocia|turkey|türkiye/, lines: ["Balloons rising at sunrise", "Fairy chimneys and ancient caves", "Golden light on the valleys", "Cay with a view", "A dream we'll remember"] },
  { match: /makkah|mecca|madinah|medina|umrah|hajj/, lines: ["A journey of the heart", "Moments of peace we'll never forget", "Grateful for every step", "Prayers answered, hearts full", "Alhamdulillah"] },
];

const TRAVEL_GENERIC = [
  "Lost in the best way",
  "Golden hour hits different",
  "Every corner, a postcard",
  "Tastes we're still dreaming about",
  "Streets we'll walk again",
  "Small moments, big memories",
  "Chasing the light",
  "Found our new favourite spot",
  "No plans, just wandering",
];

function travelBeats(c: CopyCtx): BeatDef[] {
  const P = c.place ?? c.S;
  const flavour = PLACES.find((p) => p.match.test(P.toLowerCase()))?.lines ?? [];
  const bank = [...flavour, ...TRAVEL_GENERIC];
  const caption = (i: number) => (v: number) => () => ({ heading: bank[(i + v) % bank.length]! });
  const beats: BeatDef[] = [
    {
      id: "travel.title",
      role: "title",
      kind: "title",
      priority: 1,
      weight: 1.3,
      variants: [
        () => ({ heading: P, body: "A trip to remember", emoji: "✈️" }),
        () => ({ heading: `Postcards from ${P}`, emoji: "✈️" }),
        () => ({ heading: P, body: "Our story, in moments", emoji: "✈️" }),
      ],
    },
  ];
  const slots = Math.max(c.count, 7);
  for (let i = 0; i < slots; i++) {
    beats.push({
      id: `travel.p${i}`,
      role: "point",
      kind: i % 3 === 2 ? "quote" : "body",
      priority: 2 + i * 0.1,
      weight: 1.2,
      variants: Array.from({ length: bank.length }, (_, v) => caption(i)(v)),
    });
  }
  beats.push({
    id: "travel.out",
    role: "outro",
    kind: "cta",
    priority: 1,
    weight: 1.3,
    variants: [
      () => ({ heading: `Until next time, ${P}`, body: "Already planning the return.", emoji: "🧳", graphic: { preset: "heart", position: "bottom" } }),
      () => ({ heading: "Take me back", body: `${P}, you were unforgettable.`, emoji: "🧳", graphic: { preset: "heart", position: "bottom" } }),
    ],
  });
  return beats;
}

// ---- ANNOUNCEMENT ------------------------------------------------------------------------------------------

function announcementBeats(c: CopyCtx): BeatDef[] {
  const { S, brief, proper, we } = c;
  const hiring = brief.topic === "hiring" || /\bhiring\b|\bjoin (?:our|the) team\b/i.test(S);
  const role = hiring && !c.generic && !/hiring/i.test(S) ? S : undefined;
  const details = [brief.when, brief.where].filter(Boolean).join(" · ");
  return [
    {
      id: "ann.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1,
      variants: [
        (cx) => ({ heading: `${cx.pack.bigNews}.`, body: "Something worth sharing.", emoji: "📣", graphic: { preset: "badge-new", position: "top-right" } }),
        () => ({ heading: "Pay attention.", body: "This one's important.", emoji: "📣" }),
        () => ({ heading: "We have an announcement.", emoji: "📣" }),
      ],
    },
    {
      id: "ann.what",
      role: "point",
      kind: "title",
      priority: 2,
      weight: 1.5,
      variants: [
        () => ({ heading: hiring ? "We're hiring" : cap(S), body: hiring ? (role ? `Looking for a ${role} to join us.` : "Come and build something with us.") : "Here's what's happening." }),
        () => ({ heading: hiring ? "Join the team" : `${cap(S)} is here`, body: hiring ? "We're growing, and we want you." : "And we couldn't be more excited." }),
      ],
    },
    {
      id: "ann.detail",
      role: "detail",
      kind: "body",
      priority: details ? 2 : 4,
      weight: 1.3,
      variants: [
        () => ({ heading: details || "Mark your calendar", body: details ? "Save the details." : "More details coming very soon." }),
        () => ({ heading: details || "Stay tuned", body: details ? "See you there." : "We'll share everything shortly." }),
      ],
    },
    {
      id: "ann.why",
      role: "proof",
      kind: "body",
      priority: 5,
      weight: 1.2,
      variants: [
        () => ({ heading: "We built this for you", body: `${proper ? S : cap(we)} is all about making things better.` }),
        () => ({ heading: "Thank you for being here", body: "None of this happens without you." }),
      ],
    },
    {
      id: "ann.cta",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [
        (cx) => ({ heading: "Spread the word", body: ctaFollow(cx), graphic: ctaGraphic(cx.brief.platform) }),
        () => ({ heading: "Don't miss it", body: "Share with someone who'd love this." }),
      ],
    },
  ];
}

// ---- QUOTE -------------------------------------------------------------------------------------------------

const QUOTE_BANK: { match: RegExp; quotes: string[] }[] = [
  { match: /disciplin|habit|consisten/, quotes: ["Discipline is choosing what you want most over what you want now.", "Small habits, repeated daily, build the life you want.", "Motivation gets you started. Habit keeps you going."] },
  { match: /success|goal|ambition|hustle|win/, quotes: ["Success is the sum of small efforts repeated every day.", "Dream big. Start small. Begin today.", "The work you do when no one is watching builds the life everyone sees."] },
  { match: /resilien|strong|struggle|hard|tough|fail|setback|perseverance|never give up/, quotes: ["You are stronger than the day that tried to break you.", "Every setback is setting you up for a comeback.", "Fall seven times. Stand up eight."] },
  { match: /love|heart|kind/, quotes: ["Be the reason someone believes in kindness today.", "Love is what makes ordinary days feel extraordinary.", "A little kindness goes a very long way."] },
  { match: /creativ|art|imagin|design/, quotes: ["Creativity begins when you stop worrying about perfect.", "Make something. Anything. Today.", "Your ideas matter. Make them real."] },
  { match: /grow|learn|chang|mindset|self/, quotes: ["Growth begins at the edge of your comfort zone.", "You don't have to be perfect. You just have to begin.", "Become the person you needed when you were younger."] },
];
const QUOTE_DEFAULT = [
  "Small steps still move you forward.",
  "Today is a good day to begin again.",
  "Be proud of how far you've come, and excited for how far you can go.",
  "Your only competition is who you were yesterday.",
  "Progress, not perfection.",
];

function splitQuote(q: string): string[] {
  const clean = q.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (words.length <= 10) return [clean];
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= 2 && sentences.length <= 3) return sentences;
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" ") + "…", words.slice(mid).join(" ")];
}

function quoteBeats(c: CopyCtx): BeatDef[] {
  const topic = (c.topic ?? c.brief.topic ?? "").toLowerCase();
  const user = c.brief.quote;
  const author = c.brief.quoteBy ?? user?.match(/\s[—–-]{1,2}\s*([^—–\n]{2,40})$/)?.[1]?.trim();
  const bank = QUOTE_BANK.find((b) => b.match.test(topic))?.quotes ?? QUOTE_DEFAULT;
  const beats: BeatDef[] = [
    {
      id: "quote.title",
      role: "hook",
      kind: "title",
      priority: 3,
      weight: 0.9,
      variants: [() => ({ heading: "Today's reminder", emoji: "💭" }), () => ({ heading: "Read this twice.", emoji: "💭" }), () => ({ heading: "A thought for today", emoji: "💭" })],
    },
    {
      id: "quote.q",
      role: "point",
      kind: "quote",
      priority: 1,
      weight: 2.2,
      variants: user
        ? [() => ({ heading: `“${user.replace(/\s[—–-]{1,2}\s*[^—–\n]{2,40}$/, "")}”`, body: author ? `— ${author}` : undefined })]
        : bank.map((q, i) => () => ({ heading: `“${bank[i % bank.length]!}”` })),
    },
    {
      id: "quote.close",
      role: "outro",
      kind: "cta",
      priority: 2,
      weight: 1,
      variants: [
        (cx) => ({ heading: "Keep going.", body: ctaFollow(cx) === "We can't wait to see you" ? "Share this with someone who needs it." : ctaFollow(cx), emoji: "🌱", graphic: ctaGraphic(cx.brief.platform) }),
        () => ({ heading: "You've got this.", body: "Send this to someone who needs it.", emoji: "🌱" }),
      ],
    },
  ];
  return beats;
}

// ---- INVITE ------------------------------------------------------------------------------------------------

function inviteBeats(c: CopyCtx): BeatDef[] {
  const E = cap(c.S);
  const { when, where } = c.brief;
  return [
    {
      id: "inv.hook",
      role: "hook",
      kind: "title",
      priority: 1,
      weight: 1.2,
      variants: [
        (cx) => ({ heading: `${cx.pack.invited}!`, body: "We'd love for you to be there.", emoji: "💌" }),
        () => ({ heading: "Save the date", body: "Something special is coming.", emoji: "💌" }),
      ],
    },
    {
      id: "inv.event",
      role: "point",
      kind: "title",
      priority: 1,
      weight: 1.6,
      variants: [
        () => ({ heading: E, body: c.name ? `Hosted by ${c.name}` : "Join us for a memorable time.", emoji: "🎉", graphic: { preset: "sparkles", position: "top-right" } }),
        () => ({ heading: `Join us for ${c.S}`, body: "It wouldn't be the same without you.", emoji: "🎉" }),
      ],
    },
    {
      id: "inv.when",
      role: "detail",
      kind: "body",
      priority: 2,
      weight: 1.3,
      variants: [() => ({ heading: when ?? "Mark your calendar", body: when ? "Save the date." : "Details to follow, but keep it free.", emoji: "🗓️", needsEdit: !when })],
    },
    {
      id: "inv.where",
      role: "detail",
      kind: "body",
      priority: 3,
      weight: 1.3,
      variants: [() => ({ heading: where ?? "A place you'll love", body: where ? "We'll see you there." : "Location shared with your RSVP.", emoji: "📍", needsEdit: !where })],
    },
    {
      id: "inv.vibe",
      role: "proof",
      kind: "body",
      priority: 5,
      weight: 1.1,
      variants: [() => ({ heading: "Good food. Great company.", body: "Come as you are." }), () => ({ heading: "Come for the fun", body: "Stay for the memories." })],
    },
    {
      id: "inv.cta",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [
        () => ({ heading: "Can't wait to see you", body: "Please RSVP so we can save you a seat.", emoji: "🙌", graphic: { preset: "heart", position: "bottom" } }),
        () => ({ heading: "Say you'll come", body: "RSVP today.", emoji: "🙌" }),
      ],
    },
  ];
}

// ---- LAUNCH ------------------------------------------------------------------------------------------------

function launchBeats(c: CopyCtx): BeatDef[] {
  const { cat, S, proper } = c;
  const P = proper ? S : cap(S);
  return [
    {
      id: "launch.tease",
      role: "hook",
      kind: "title",
      priority: 2,
      weight: 1,
      variants: [() => ({ heading: "Something new is coming.", emoji: "🚀" }), () => ({ heading: "Get ready.", emoji: "🚀" }), () => ({ heading: "It's finally here.", emoji: "🚀" })],
    },
    {
      id: "launch.reveal",
      role: "point",
      kind: "title",
      priority: 1,
      weight: 1.6,
      variants: [
        () => ({ heading: `Introducing ${P}`, body: cat.tags[0], emoji: cat.emoji, graphic: { preset: "badge-new", position: "top-right" } }),
        () => ({ heading: `Meet ${P}`, body: cat.tags[1] ?? cat.tags[0], emoji: cat.emoji, graphic: { preset: "badge-new", position: "top-right" } }),
      ],
    },
    ...[0, 1, 2].map(
      (k): BeatDef => ({
        id: `launch.f${k}`,
        role: "point",
        kind: "item",
        priority: 2 + k * 0.5,
        weight: 1.3,
        variants: cat.benefits.map((_, i) => () => ({ heading: cat.benefits[(i + k) % cat.benefits.length]![0], body: cat.benefits[(i + k) % cat.benefits.length]![1], num: String(k + 1).padStart(2, "0") })),
      }),
    ),
    {
      id: "launch.avail",
      role: "offer",
      kind: "title",
      priority: 3,
      weight: 1.1,
      variants: [
        (cx) => ({ heading: cx.brief.offer ?? "Available now", body: cx.brief.offer ? "Launch offer." : "Be one of the first.", graphic: cx.brief.offer ? { preset: "badge-sale", position: "top-right" } : undefined }),
      ],
    },
    {
      id: "launch.cta",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [0, 1, 2].map((i) => (cx: CopyCtx) => ({ heading: cat.cta[i % cat.cta.length]!, body: ctaFollow(cx), graphic: ctaGraphic(cx.brief.platform) })),
    },
  ];
}

// ---- TESTIMONIAL -------------------------------------------------------------------------------------------

function testimonialBeats(c: CopyCtx): BeatDef[] {
  const q = c.brief.quote;
  const who = c.name;
  return [
    {
      id: "test.hook",
      role: "hook",
      kind: "title",
      priority: 2,
      weight: 1,
      variants: [() => ({ heading: "Don't take our word for it.", emoji: "⭐" }), () => ({ heading: "Hear it from them.", emoji: "⭐" })],
    },
    {
      id: "test.q",
      role: "point",
      kind: "quote",
      priority: 1,
      weight: 2.4,
      variants: q
        ? [() => ({ heading: `“${q}”`, body: who ? `— ${who}` : undefined })]
        : [
            () => ({ heading: "“It made everything easier. I wouldn't go back.”", body: `— ${who ?? "A happy customer"}`, needsEdit: true }),
            () => ({ heading: "“Exactly what we needed, and better than we hoped.”", body: `— ${who ?? "A happy customer"}`, needsEdit: true }),
          ],
    },
    {
      id: "test.proof",
      role: "proof",
      kind: "body",
      priority: 3,
      weight: 1.2,
      variants: [() => ({ heading: `Real people. Real results.`, body: `That's what ${c.proper ? c.S : c.we} is about.` })],
    },
    {
      id: "test.cta",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [(cx) => ({ heading: "Join them", body: ctaFollow(cx), graphic: ctaGraphic(cx.brief.platform) })],
    },
  ];
}

// ---- INTRO / OUTRO -----------------------------------------------------------------------------------------

function introBeats(c: CopyCtx): BeatDef[] {
  const N = c.name ?? (c.generic ? "Your Channel" : cap(c.S));
  const outro = !!c.brief.outro;
  if (outro) {
    return [
      { id: "intro.thanks", role: "hook", kind: "title", priority: 1, weight: 1.4, variants: [(cx) => ({ heading: "Thanks for watching!", body: N, emoji: "🙏" }), () => ({ heading: "That's a wrap.", body: N, emoji: "🙏" })] },
      { id: "intro.like", role: "point", kind: "body", priority: 2, weight: 1.2, variants: [() => ({ heading: "Enjoyed it?", body: "Like and share with a friend.", graphic: { preset: "like", position: "bottom" } })] },
      { id: "intro.sub", role: "cta", kind: "cta", priority: 1, weight: 1.4, variants: [(cx) => ({ heading: "Subscribe for more", body: "New videos every week.", graphic: { preset: "subscribe", position: "bottom" } }), () => ({ heading: "See you next time", body: "Subscribe so you don't miss it.", graphic: { preset: "subscribe", position: "bottom" } })] },
    ];
  }
  return [
    {
      id: "intro.logo",
      role: "title",
      kind: "title",
      priority: 1,
      weight: 1.6,
      variants: [() => ({ heading: N, body: c.cat.key === "generic" ? "Welcome in." : c.cat.tags[0]!, emoji: c.cat.emoji }), () => ({ heading: N, body: "Let's make something great.", emoji: c.cat.emoji })],
    },
    { id: "intro.welcome", role: "point", kind: "body", priority: 2, weight: 1.2, variants: [() => ({ heading: "Welcome", body: `You're watching ${N}.` }), () => ({ heading: "Hi, I'm glad you're here.", body: "Let's get into it." })] },
    {
      id: "intro.sub",
      role: "cta",
      kind: "cta",
      priority: 1,
      weight: 1.2,
      variants: [() => ({ heading: "Subscribe", body: "New videos every week.", graphic: { preset: "subscribe", position: "bottom" } }), () => ({ heading: "Let's begin", body: "Hit subscribe to join us.", graphic: { preset: "subscribe", position: "bottom" } })],
    },
  ];
}

// ---- SLIDESHOW ---------------------------------------------------------------------------------------------

const MEMORY_LINES = [
  "The little moments",
  "Days worth remembering",
  "Laughter, mostly",
  "Where we were happiest",
  "Blink and you'd miss it",
  "The ones that matter",
  "Just us",
  "Sunshine and good company",
  "This one made us smile",
];

function slideshowBeats(c: CopyCtx): BeatDef[] {
  const T = c.generic ? "Our favourite moments" : cap(c.S);
  const beats: BeatDef[] = [
    {
      id: "slide.title",
      role: "title",
      kind: "title",
      priority: 1,
      weight: 1.4,
      variants: [() => ({ heading: T, body: "A few of our favourites", emoji: "📸" }), () => ({ heading: T, body: "Memories, in motion", emoji: "📸" })],
    },
  ];
  const slots = Math.max(c.count, 6);
  for (let i = 0; i < slots; i++) {
    beats.push({
      id: `slide.m${i}`,
      role: "point",
      kind: "body",
      priority: 2 + i * 0.1,
      weight: 1.2,
      variants: MEMORY_LINES.map((_, v) => () => ({ heading: MEMORY_LINES[(i + v) % MEMORY_LINES.length]! })),
    });
  }
  beats.push({
    id: "slide.out",
    role: "outro",
    kind: "cta",
    priority: 1,
    weight: 1.3,
    variants: [() => ({ heading: "More to come", body: "The best is yet to be.", emoji: "💛", graphic: { preset: "heart", position: "bottom" } }), () => ({ heading: "To many more", body: "Thank you for the memories.", emoji: "💛", graphic: { preset: "heart", position: "bottom" } })],
  });
  return beats;
}

// ---- entry ------------------------------------------------------------------------------------------------

export function beatsFor(genre: Genre, c: CopyCtx): BeatDef[] {
  switch (genre) {
    case "promo":
      return promoBeats(c);
    case "greeting":
      return greetingBeats(c);
    case "explainer":
      return explainerBeats(c);
    case "tutorial":
      return tutorialBeats(c);
    case "travel":
      return travelBeats(c);
    case "announcement":
      return announcementBeats(c);
    case "quote":
      return quoteBeats(c);
    case "invite":
      return inviteBeats(c);
    case "launch":
      return launchBeats(c);
    case "testimonial":
      return testimonialBeats(c);
    case "intro":
      return introBeats(c);
    case "slideshow":
      return slideshowBeats(c);
  }
}

/** Resolve a beat to concrete copy: variant = (seed + bump) mod variants. */
export function copyFor(beat: BeatDef, c: CopyCtx, seed: number, bump: number): Copy {
  const n = beat.variants.length;
  const i = (((seed + bump) % n) + n) % n;
  return beat.variants[i]!(c);
}

export { splitQuote };
