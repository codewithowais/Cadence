/**
 * build_demo — turn a set of app/UI screenshots into an animated product
 * walkthrough: each screenshot becomes a full-frame screen, screens are
 * sequenced with a transition, and (for a "login-like" first screen) a moving
 * cursor types into fields and clicks a button before moving on.
 *
 * This is creation, not editing: no source video or transcript required, just the
 * project's IMAGE media in order (= the screens). It assembles a valid EditDoc
 * from the same typed primitives the manual tools use (typewriter text, cursor,
 * callout), so nothing here is special-cased downstream — the same renderers draw
 * it.
 *
 * VISION CAVEAT: exact field/button pixels can't be detected from a raw
 * screenshot without a vision model, so the login defaults below place the email
 * field, password field and button at sensible FRACTIONS of the frame that the
 * user can nudge (add_cursor / type_text / add_callout). Auto field detection is a
 * money-gated follow-up (a hosted vision API).
 */
import { parseEditDoc, type EditDoc, type MediaAsset, type TransitionType } from "@cadence/core";
import { addCursor, typeText } from "./edits";

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface DemoScreenAction {
  /** Typed lines to reveal on this screen: text at a fractional position. */
  type?: { text: string; xFrac?: number; yFrac?: number; atSec?: number; mask?: boolean }[];
  /** Move the cursor to this fractional point and click it. */
  clickAt?: { xFrac: number; yFrac: number };
}

export interface BuildDemoOptions {
  /** Seconds each screen holds (the first screen is extended when it has actions). */
  perScreenSec?: number;
  /** Transition between screens (default crossfade). */
  transition?: TransitionType;
  /** Crossfade / transition duration between screens. */
  transitionSec?: number;
  width?: number;
  height?: number;
  /** Seed a login interaction (typed email + password, then a button click) on screen 0. */
  login?: boolean;
  /** Optional per-screen actions (index-aligned to `screens`); overrides `login` for screen 0 when present. */
  actions?: DemoScreenAction[];
}

/**
 * Default fractional positions for the login interaction — the pixels the user
 * nudges. Chosen to sit around the middle of a typical centered login card.
 */
const LOGIN = {
  fieldXFrac: 0.34,
  emailYFrac: 0.42,
  passwordYFrac: 0.52,
  buttonXFrac: 0.5,
  buttonYFrac: 0.63,
  email: "you@example.com",
  password: "••••••••",
} as const;

/** Build a walkthrough EditDoc from ordered screenshot media. */
export function buildDemo(screens: MediaAsset[], opts: BuildDemoOptions = {}): EditDoc {
  const imgs = screens.filter((m) => m.kind === "image");
  if (imgs.length === 0) throw new Error("Add screenshots (images) first to build a demo.");

  const per = opts.perScreenSec ?? 3.5;
  const xf = opts.transitionSec ?? 0.5;
  const transition: TransitionType = opts.transition ?? "crossfade";
  // Even dimensions (libx264/yuv420p safe); derive from the first screenshot.
  const first = imgs[0]!;
  const width = Math.max(2, Math.round((opts.width ?? first.width ?? 1920) / 2) * 2);
  const height = Math.max(2, Math.round((opts.height ?? first.height ?? 1080) / 2) * 2);

  const action0 = opts.actions?.[0];
  const hasScreen0Interaction = !!action0 || opts.login;
  // Screen 0 gets extra time when it hosts an interaction (typing + click).
  const durations = imgs.map((_, i) => (i === 0 && hasScreen0Interaction ? Math.max(per, 6) : per));

  // ---- screens track: full-frame stills, sequenced with a transition --------
  const clips: unknown[] = [];
  let pos = 0;
  imgs.forEach((img, i) => {
    const start = i === 0 ? 0 : pos;
    clips.push({
      id: `screen-${i}`,
      kind: "image",
      start: round(start),
      duration: round(durations[i]!),
      mediaId: img.id,
      transform: { x: width / 2, y: height / 2 },
      // Screens are static (no Ken Burns) so the UI stays readable.
      transitionInSec: i === 0 ? 0 : xf,
      transitionType: transition,
    });
    pos = start + durations[i]! - xf;
  });

  let doc = parseEditDoc({
    version: 1,
    meta: { title: "Walkthrough", width, height, fps: 30, background: "#0a0d12" },
    media: imgs,
    tracks: [{ id: "screens", kind: "visual", clips }],
  });

  // ---- interaction on screen 0 ----------------------------------------------
  const screen0End = durations[0]!;
  if (action0) {
    doc = applyScreenAction(doc, action0, width, height, screen0End);
  } else if (opts.login) {
    doc = applyLoginInteraction(doc, width, height, screen0End);
  }

  return doc;
}

/** Type-per-char rate mirrored from edits.ts, for timing the login sequence. */
const RATE = 0.075;
const typeSecFor = (text: string): number => Math.max(0.4, text.length * RATE);

/** Seed the default login interaction (typed email + password, then a click). */
function applyLoginInteraction(doc: EditDoc, W: number, H: number, screenEnd: number): EditDoc {
  const fieldX = round(W * LOGIN.fieldXFrac);
  const emailY = round(H * LOGIN.emailYFrac);
  const passwordY = round(H * LOGIN.passwordYFrac);
  const buttonX = round(W * LOGIN.buttonXFrac);
  const buttonY = round(H * LOGIN.buttonYFrac);
  const fontSize = Math.round(H * 0.03);
  const pill = "#12151ccc";

  const emailStart = 0.6;
  const emailType = typeSecFor(LOGIN.email);
  const passwordStart = round(emailStart + emailType + 0.4);
  const passwordType = typeSecFor(LOGIN.password);

  let out = typeText(doc, {
    text: LOGIN.email,
    x: fieldX,
    y: emailY,
    atSec: emailStart,
    typeSec: emailType,
    holdSec: Math.max(0.4, screenEnd - emailStart - emailType),
    fontSize,
    background: pill,
  });
  out = typeText(out, {
    text: LOGIN.password,
    x: fieldX,
    y: passwordY,
    atSec: passwordStart,
    typeSec: passwordType,
    holdSec: Math.max(0.4, screenEnd - passwordStart - passwordType),
    fontSize,
    background: pill,
  });

  // Cursor: rest near the fields, glide to the button, click.
  const moveStart = round(passwordStart + passwordType + 0.3);
  const arriveAt = round(moveStart + 0.9);
  const clickAt = round(arriveAt + 0.1);
  out = addCursor(out, {
    waypoints: [
      { x: fieldX, y: passwordY, atSec: moveStart },
      { x: buttonX, y: buttonY, atSec: arriveAt },
    ],
    clicks: [clickAt],
    start: 0.6,
    duration: round(Math.max(0.4, Math.min(screenEnd, clickAt + 0.6) - 0.6)),
  });
  return out;
}

/** Apply a caller-provided screen action (typed lines + an optional click). */
function applyScreenAction(
  doc: EditDoc,
  action: DemoScreenAction,
  W: number,
  H: number,
  screenEnd: number,
): EditDoc {
  let out = doc;
  const fontSize = Math.round(H * 0.03);
  let cursor = 0.5;
  for (const line of action.type ?? []) {
    const x = round(W * (line.xFrac ?? 0.34));
    const y = round(H * (line.yFrac ?? 0.42));
    const at = line.atSec ?? cursor;
    const tSec = typeSecFor(line.text);
    out = typeText(out, {
      text: line.text,
      x,
      y,
      atSec: at,
      typeSec: tSec,
      holdSec: Math.max(0.4, screenEnd - at - tSec),
      fontSize,
      background: "#12151ccc",
    });
    cursor = round(at + tSec + 0.4);
  }
  if (action.clickAt) {
    const bx = round(W * action.clickAt.xFrac);
    const by = round(H * action.clickAt.yFrac);
    const moveStart = round(cursor);
    const arriveAt = round(moveStart + 0.9);
    const clickAt = round(arriveAt + 0.1);
    out = addCursor(out, {
      waypoints: [
        { x: round(W * 0.4), y: round(H * 0.5), atSec: moveStart },
        { x: bx, y: by, atSec: arriveAt },
      ],
      clicks: [clickAt],
      start: moveStart,
      duration: round(Math.max(0.4, Math.min(screenEnd, clickAt + 0.6) - moveStart)),
    });
  }
  return out;
}
