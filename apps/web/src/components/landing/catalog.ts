/**
 * The landing page's plain-language FEATURE CATALOG — what Cadence can do,
 * grouped by the job a person is trying to get done. Every entry names the
 * feature the way a user would, says what it does in one sentence, and (where
 * useful) gives the words you can type to get it. Keep this honest: only list
 * what ships, and say when something needs export or an optional install.
 */

export interface CatalogItem {
  name: string;
  what: string;
  /** Something you can literally type to the Director. */
  say?: string;
  /** Honest caveat (export-only, optional install, money-gated). */
  note?: string;
}

export interface CatalogGroup {
  id: string;
  title: string;
  summary: string;
  items: CatalogItem[];
}

export const CATALOG: CatalogGroup[] = [
  {
    id: "cut",
    title: "Cut and tidy footage",
    summary: "Turn a long, messy recording into a tight video.",
    items: [
      { name: "Highlight cut", what: "Keeps the strongest moments up to the length you ask for.", say: "cut a 60-second highlight" },
      { name: "Remove filler words", what: "Drops the “um”s, “uh”s and filler-heavy lines from talking videos.", say: "remove the filler words" },
      { name: "Remove silence", what: "Tightens long pauses and dead air while keeping everything that was said.", say: "remove the dead air" },
      { name: "Edit by transcript", what: "Cut or keep sentences by their words — like editing a document.", say: "cut the sentence about pricing" },
      { name: "Split, trim, reorder", what: "Drag clip edges, press S to split, drag clips to reorder, ripple-delete gaps." },
      { name: "Pro trims", what: "Roll, slip and slide edits for exact cut points, with nudge buttons." },
      { name: "Speed, reverse, freeze", what: "Slow motion, fast motion, speed ramps, play backwards, or hold a frame.", say: "slow motion" },
      { name: "Beat markers", what: "Finds the beats in your music and lets you split every clip on the beat." },
      { name: "Pro keyboard editing", what: "J/K/L to shuttle at 2× or 4×, frame-by-frame stepping, I/O to mark a range, then remove it or keep only it.", say: "remove from 2s to 5s" },
      { name: "Snapping and gaps", what: "Clips snap to the playhead, markers and each other; empty gaps show up so you can close them in one click." },
      { name: "Multi-select", what: "Select several clips at once to delete, duplicate or nudge them together, and copy one clip's look or motion onto others." },
      { name: "Split all, speed, freeze", what: "Cut every track at once, set 0.5×–2× speed in a tap, or freeze the frame under the playhead." },
    ],
  },
  {
    id: "words",
    title: "Captions and words",
    summary: "Make every word readable, even with the sound off.",
    items: [
      { name: "Auto captions", what: "Captions from the transcript, timed to the speech and kept in sync through your cuts.", say: "add captions" },
      { name: "Caption styles", what: "Font, size, color, outline, shadow, background box and position — or one-tap presets." },
      { name: "Karaoke captions", what: "Highlights each word as it's spoken, TikTok-style." },
      { name: "Caption animations", what: "Words pop in, rise in, type out, or fade in." },
      { name: "Subtitle files", what: "Download captions as .srt or .vtt for YouTube and other players." },
    ],
  },
  {
    id: "text",
    title: "Text videos and titles",
    summary: "Make a whole video from words alone — no footage needed.",
    items: [
      { name: "Text video from a script", what: "Paste a script, a quote, a list or an announcement and get animated scenes with backgrounds and transitions.", say: "make a text video: Big news. We just launched." },
      { name: "10 themes", what: "Bold, Minimal, Neon, Elegant, Playful, Corporate, Retro, Aurora, Cinematic and Handwritten. Switch anytime — your words stay.", say: "switch to the neon theme" },
      { name: "21 text animations", what: "Rise, pop, typewriter, glitch, scramble, blur-in and more — by whole block, line, word or letter.", say: "letters pop in one by one" },
      { name: "Exits and loops", what: "Text can leave with style (fade, sink, blur-out…) and keep moving while on screen (float, wiggle, wave)." },
      { name: "Text effects", what: "Neon glow, echo, splice, hollow outline, glitch, highlighter and gradient-filled text.", say: "gradient text" },
      { name: "24 fonts built in", what: "From clean sans to handwriting to pixel — and the export uses the exact same fonts." },
      { name: "Ready-made text styles", what: "20 animated looks like Neon sign, Retro shadow, Cinematic caps and Lower third, one click each." },
      { name: "Titles and lower-thirds", what: "Title cards, name bars and kinetic intro titles.", say: "add a title that says “Welcome”" },
    ],
  },
  {
    id: "graphics",
    title: "Graphics and stickers",
    summary: "The animated extras creators add to every post.",
    items: [
      { name: "Subscribe and like buttons", what: "Animated Subscribe, Like, Follow, Link in bio, Swipe up and Comment buttons, one click each.", say: "add a subscribe button" },
      { name: "Countdowns and timers", what: "3-2-1 go, an mm:ss timer, a ring timer, or a count-up like “10,000 followers”.", say: "add a 30 second timer in the top right" },
      { name: "Progress bars", what: "A line or bar that fills as the video plays, story-style segments, or a percent ring." },
      { name: "Lower thirds", what: "Six animated name-and-title styles that slide, draw or pop in." },
      { name: "Stickers and doodles", what: "Hearts, stars, NEW and SALE badges, sparkles, and hand-drawn circles and arrows that draw themselves on.", say: "circle it" },
      { name: "Animated shapes", what: "Any shape can pop, slide, draw on, pulse, bounce or wiggle." },
    ],
  },
  {
    id: "look",
    title: "Color and look",
    summary: "Give footage a mood in one tap, then fine-tune it.",
    items: [
      { name: "One-tap looks", what: "Warm, cinematic, vintage, noir, golden hour, moody and more, previewed on your own frame.", say: "give it a cinematic look" },
      { name: "Color controls", what: "Brightness, contrast, saturation, warmth, hue, curves and live scopes." },
      { name: "LUTs and adjustment layers", what: "Import a .cube LUT or grade several clips at once with one layer.", note: "LUTs apply on export." },
      { name: "Backgrounds", what: "Solid colors, gradients, animated aurora and drifting gradients, and subtle patterns.", say: "aurora background" },
      { name: "Finishing effects", what: "Vignette, film grain and a warm light leak.", say: "add film grain" },
    ],
  },
  {
    id: "motion",
    title: "Motion, layers and effects",
    summary: "Add movement and polish without keyframe homework.",
    items: [
      { name: "55 transitions", what: "Fades, wipes, slides, circles, zooms and more on any cut, with a hover preview.", say: "use dissolve transitions" },
      { name: "Punch-in and zoom", what: "A quick zoom to land a point, or a slow push-in over time.", say: "punch in at 2s" },
      { name: "Picture-in-picture and layouts", what: "B-roll in a corner, split-screen, and grid layouts." },
      { name: "Keyframes", what: "Animate position, size, rotation and opacity right on the timeline." },
      { name: "Green screen and masks", what: "Remove a solid background, reveal part of a clip, or blend layers." },
      { name: "Blur a face or plate", what: "Blur or pixelate any region to hide it." },
      { name: "Shapes, stickers and callouts", what: "Arrows, boxes, emoji stickers and highlight boxes for tutorials." },
      { name: "Product walkthroughs", what: "Turn screenshots into a demo with a moving cursor, clicks and typed text.", say: "make a walkthrough from these screenshots" },
      { name: "Stabilize shaky footage", what: "Smooths handheld camera shake.", note: "Applied on export." },
    ],
  },
  {
    id: "sound",
    title: "Sound",
    summary: "Clean, balanced audio without an audio engineer.",
    items: [
      { name: "Background music", what: "Add a track and it sits under your video automatically, ducked under speech.", say: "add background music" },
      { name: "Music generator", what: "Composes royalty-free background music on your computer in five moods, timed to end exactly with your video.", say: "add upbeat music" },
      { name: "Sound effects", what: "Whoosh, pop, click, ding, riser and boom, or let Cadence add them to every transition and text pop.", say: "add sound effects" },
      { name: "Smart ducking", what: "Music dips only while someone speaks and comes back up between sentences." },
      { name: "Voice enhance", what: "One switch makes voices clearer and more even.", note: "Applied on export." },
      { name: "Cut to the beat", what: "Photo slideshows and text-video scenes change right on the beat of the music." },
      { name: "Auto-mix", what: "Levels speech and lowers music whenever someone talks.", say: "auto-mix the audio" },
      { name: "Fades, pan and volume", what: "Per-clip and per-track volume, fade handles and stereo pan." },
      { name: "Clean audio", what: "Reduces steady background noise like hum and hiss.", note: "Applied on export." },
      { name: "Loudness for streaming", what: "Normalizes the final mix to a standard streaming loudness.", note: "Applied on export." },
      { name: "Record a voice-over", what: "Record straight into the project with your microphone." },
    ],
  },
  {
    id: "deliver",
    title: "Formats and export",
    summary: "Get the right file for every platform.",
    items: [
      { name: "Any shape", what: "Vertical 9:16, square, 4:5, widescreen and cinematic 2.39:1 — text videos re-lay out instead of stretching.", say: "make it vertical" },
      { name: "Platform presets", what: "One tap for YouTube, Shorts, TikTok, Reels and Instagram feed.", say: "export for tiktok" },
      { name: "Real .mp4 export", what: "Renders a finished video file that looks exactly like the preview." },
      { name: "Export progress", what: "See the percent and time left while it renders, and cancel anytime." },
      { name: "Up to 4K", what: "Detail-preserving upscaling and sharpening that never alters faces or content.", say: "make it 4K" },
      { name: "Thumbnails", what: "Grab the current frame as a thumbnail image." },
    ],
  },
  {
    id: "workflow",
    title: "Work your way",
    summary: "Talk to it, click it, or both.",
    items: [
      { name: "The Director", what: "Describe the edit in plain words and it runs the right steps — several in one request.", say: "cut a 30s highlight, make it vertical with captions" },
      { name: "Search every action", what: "Press ⌘K (Ctrl+K) to find any edit, room or setting by typing a word." },
      { name: "Getting started checklist", what: "A short checklist that ticks itself off as you make your first video." },
      { name: "What to try next", what: "After each edit, suggestions for the next useful step, plus a library of 60+ things you can say." },
      { name: "Never lose work", what: "Your edit and media are saved in the browser as you go; after a refresh or crash, restore your session." },
      { name: "Project files", what: "Save your project as a file and open it again later, on any computer." },
      { name: "One-tap actions", what: "The most common edits as buttons that change with what you're working on." },
      { name: "Undo everything", what: "Every change, AI or manual, can be undone and redone." },
      { name: "Multi-track timeline", what: "Layers you can rename, hide, lock, mute, solo and reorder." },
      { name: "Keyboard shortcuts", what: "Play, seek, split, mark and more — press ? in the editor to see them all." },
      { name: "Projects and versions", what: "Sign in to save projects; every save keeps a version." },
      { name: "Starter templates", what: "Begin from a talking-head, slideshow or text-video template." },
    ],
  },
];

export const CATALOG_COUNT = CATALOG.reduce((n, g) => n + g.items.length, 0);
