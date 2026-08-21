// The visor's SYSTEM UI: the strip, the identity cluster, the context
// cluster, and the drawer that unfolds above the strip.
//
// This is the framework layer, extracted whole out of the demo spike
// (spikes/demo/host/demo.ts) so a second spike can consume the same
// anchor rather than reimplement one. What lives here is everything a
// visor IS — the anchor colour, the identity record, the two-line
// context, the announce discipline, and the drawer host with its
// tenancy, arming delay and height budget. What does NOT live here is
// any particular sheet's CONTENT: a consumer registers a tenant and
// builds its own sheet, and the host does the rest.
//
// SCOPING DISCIPLINE, which is the whole security argument of this file:
// nothing here is ever written to the document root, handed to a guest,
// or put on the frame seam. The anchor colour is set on the visor's own
// ELEMENTS; the identity record is rendered only into visor pixels. See
// spikes/demo/scripts/check-invariants.sh checks (b), (c) and (e), which
// grep this file for exactly that.
//
// PER-INSTANCE STATE. Every mutable value below lives on the object
// `initVisor` returns; the module holds only constants. Two visors in
// two documents therefore cannot collide.

// --- visor appearance: the personal, undisclosed anchor -----------------------
//
// The strip's colour is the user's own: RANDOMISED on first run, pickable
// from a constrained palette, and never handed to app code. It is a
// SECONDARY anchor — position is the primary one (apps cannot paint the
// strip at all) — and it is deliberately NOT the dropped #22
// personalization secret: it demands no user action at a decision point
// and no per-prompt verification, so it fails toward "something looks
// off" rather than "I forgot to check".
//
// Why the palette is constrained: fixed lightness and chroma in OKLCH
// means every choice keeps the same text contrast, so the anchor can
// never be customised into an unreadable or a look-alike state.
//
// Why apps cannot learn it: nothing in the surface API carries a colour;
// the app rectangle is opaque so visor pixels and app pixels never
// composite (blend/backdrop-filter pixel-stealing has nothing to
// sample); and the framework's curated DOM must additionally withhold
// blend modes, backdrop filters, CSSOM read-back and system-colour
// keywords — see the #5 ruling table. The demo enforces the structural
// half: this value is never passed to a guest, and the component tint
// is derived from component bytes instead.
export const VISOR_HUES = [265, 210, 175, 140, 95, 60, 35, 10, 330, 300];

/** Read the committed anchor hue, or roll a fresh one.
 *
 * `legacyKey`, when given, is a RENAME-ONLY migration source (chrome ->
 * visor, GitHub issue #22): it is read once and then removed, never
 * re-created. The palette is the framework's; the KEYS are the
 * consumer's, so two spikes on one origin do not share an anchor. */
export function loadVisorHue(
  hueKey: string,
  legacyKey?: string,
): { hue: number; fresh: boolean } {
  try {
    // One-time migration: carry an existing user's hue to the new key
    // without a re-roll (see the no-quiet-reset note below), then drop
    // the old key so this runs at most once per device.
    if (legacyKey !== undefined) {
      if (localStorage.getItem(hueKey) === null) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy !== null) localStorage.setItem(hueKey, legacy);
      }
      localStorage.removeItem(legacyKey);
    }
    const raw = localStorage.getItem(hueKey);
    if (raw !== null) {
      const hue = Number(raw);
      if (VISOR_HUES.includes(hue)) return { hue, fresh: false };
    }
  } catch { /* storage unavailable: fall through to a fresh pick */ }
  // First run (or eviction). A silently-reset anchor would train users
  // that "visor colour changes sometimes", which inverts the training —
  // so a reset is ANNOUNCED, never quiet. In the framework this value
  // belongs with durable device state (#11's identity bundle).
  const hue = VISOR_HUES[Math.floor(Math.random() * VISOR_HUES.length)];
  try {
    localStorage.setItem(hueKey, String(hue));
  } catch { /* nothing durable to write to */ }
  return { hue, fresh: true };
}

/** Paint the anchor colour.
 *
 * Scoped to the strip ELEMENT and to the drawer (the only other surface
 * the visor paints in the user's own colour), never to :root. A custom
 * property on the document root is ambient authority: it inherits into
 * every app region, so a component that ever gained a `style` attribute
 * (or a visor class resolving var(--visor-bg)) could paint the visor's
 * exact colour without ever reading it. Keeping the value out of scope
 * makes the secrecy structural instead of a property of the allowlist. */
export function applyVisorHue(hue: number) {
  for (const id of ["visor-strip", "visor-drawer"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.setProperty("--visor-bg", `oklch(38% .07 ${hue})`);
    el.style.setProperty("--visor-fg", "#f4f6fc");
  }
}

// --- the identity record: the user's own words, in the visor's voice -------------
//
// The user's name for themselves, their word for THIS DEVICE, and the
// glyph they chose for the visor's own button. All three are user-typed or
// user-picked, and all three obey exactly the scoping discipline the
// anchor colour obeys: they are rendered ONLY in visor pixels (the
// strip and the sheets that hang off it), never written to a :root
// custom property, never passed to a panel, an engine, or across the
// frame seam. Nothing in the surface API can carry them, and the
// invariant check (e) in spikes/demo/scripts/check-invariants.sh keeps
// it that way by grepping the seam files.
//
// Why this is worth anything: it gives the anchor a second thing an
// impersonating rectangle cannot reproduce. Position is primary, the
// colour is secondary, and these are words an app can only guess at.
//
// NO FABRICATION. An unset field renders NOTHING — never "user", never
// "this device". A default visor invented would be a word the visor says
// in its own voice that the user never wrote, which is the same
// authority-lending mistake the petname/nickname split exists to
// prevent.

/** The button face is THE VISOR'S VOCABULARY, not free text. The record
 * lives in localStorage, so it is hand-editable; if the face were an
 * arbitrary string, a record edited to say "Verified" or "polymorph"
 * would put attacker- (or accident-) chosen WORDS into the anchor, in
 * the visor's own voice, at the one position that is supposed to be
 * unspoofable. A fixed glyph set has no such reading: anything outside
 * it falls back to the default shield. */
export const VISOR_ICONS = ["⛨", "✶", "✦", "◆", "▲", "☘", "⚑", "✿", "☾", "⚙"];
export const DEFAULT_ICON = VISOR_ICONS[0];

// --- the pet icons: the user's recognition mark for a COMPONENT ---------------
//
// WHAT REPLACED THE COLOUR SWATCH, and why (#22 discussion). A surface
// mark used to be a hue out of the anchor palette, shown as a small chip
// beside the component's quoted nickname. That device is gone. The
// ANCHOR colour stays exactly as it was — it is doing a different job
// (visor-vs-app contrast, plus a spoof lottery an impersonator has to
// win) — but per-app colour MEMORY was the weak half: "the blue one" is
// not a thing a user can name, rehearse, or check, and ten hues run out
// after ten components. A glyph is nameable ("the little envelope"),
// discriminable at a glance, and the vocabulary is large enough to keep
// local uniqueness real.
//
// THE CURATION CRITERIA ARE INVARIANTS, not taste. Every member of this
// array satisfies all of them, and a candidate that fails any one is
// out — there is no "but it looks nice" exception, because each rule is
// closing a concrete failure:
//
//   (1) ONE Unicode scalar, in the BMP. Not a sequence, not a
//       surrogate pair, not a ZWJ join. `isAppMarkIcon` can then decide
//       membership by exact string equality against a fixed list, and a
//       mark is a fixed-width thing at every render site.
//
//   (2) TEXT PRESENTATION BY DEFAULT (Emoji_Presentation=No, UTS #51).
//       A glyph that renders as full-colour emoji by default is a
//       PICTURE the platform draws, in colours the visor did not choose,
//       with a shape that changes between OS versions and vendors — a
//       recognition device the user has to re-learn on a new device is
//       not a recognition device. It also composites badly against the
//       anchor colour. So ☕ U+2615, ⌛ U+231B, ⚡ U+26A1 and ⚓ U+2693
//       are DISQUALIFIED however apt they look; the members below all
//       need a VS16 they will never be given to go colour.
//
//   (3) LONG LEGACY FONT COVERAGE. Preference for Geometric Shapes,
//       Miscellaneous Symbols and Dingbats, and for codepoints that
//       existed by Unicode 5.2 — a mark that renders as a tofu box on
//       somebody's machine is worse than no mark, because two different
//       components then wear the same empty rectangle.
//
//   (4) ONE GLYPH PER VISUAL-CONFUSABILITY CLASS, and NO class overlap
//       with VISOR_ICONS (the USER's own set, above). Marks exist to be
//       told apart at 14px in peripheral vision, so near-duplicates are
//       worse than useless — and a component mark that could be mistaken
//       for the visor's own button glyph is an impersonation aid. Since
//       VISOR_ICONS spans shields, stars, diamonds, triangles, clovers,
//       flags, flowers, moons and gears, there are NO stars, shields,
//       diamonds, triangles, clovers/clubs, flags, flowers, moons or
//       gears here AT ALL — which is why the obvious ☀ ❄ ☄ ⚜ ♠ are
//       absent (sun/snowflake/comet read as stars; fleur-de-lis as a
//       flower; the spade as a clover).
//
//   (5) NO SECURITY OR UI SEMANTICS: no locks, keys, chains, warning
//       signs, check or cross marks, arrows. The visor must never appear
//       to be VOUCHING for a component, and a padlock beside a name is
//       exactly that claim — made in the visor's pixels, about a
//       component, on the user's own authority. (Also no religious or
//       political symbols: a mark is a label, and the visor does not put
//       words in the user's mouth. ☯ went out on this rule.)
//
//   (6) FILLED SILHOUETTES PREFERRED. Outline glyphs lose their
//       interior detail first as size drops.
//
// Local uniqueness is what the SIZE buys: the naming ceremony only ever
// offers icons no other record holds, so two components on this device
// never wear the same mark while the vocabulary lasts.
export const APP_MARK_ICONS: readonly string[] = [
  // Geometric Shapes — the two plainest silhouettes there are.
  "●", // U+25CF BLACK CIRCLE
  "■", // U+25A0 BLACK SQUARE
  // Miscellaneous Technical / Symbols — everyday objects.
  "⌂", // U+2302 HOUSE
  "⌨", // U+2328 KEYBOARD
  "☎", // U+260E BLACK TELEPHONE
  "☁", // U+2601 CLOUD
  "☂", // U+2602 UMBRELLA
  "☃", // U+2603 SNOWMAN  (NOT ⛄ U+26C4, which is Emoji_Presentation=Yes)
  "☻", // U+263B BLACK SMILING FACE
  "♥", // U+2665 BLACK HEART SUIT  (NOT ❤ + VS16)
  "♨", // U+2668 HOT SPRINGS
  "♪", // U+266A EIGHTH NOTE
  "⚒", // U+2692 HAMMER AND PICK
  "⛏", // U+26CF PICK
  "⚖", // U+2696 SCALES
  "⚗", // U+2697 ALEMBIC
  "⚛", // U+269B ATOM SYMBOL
  "⚄", // U+2684 DIE FACE-5
  // Chess pieces: five silhouettes that stay distinct when small.
  "♛", // U+265B BLACK CHESS QUEEN
  "♜", // U+265C BLACK CHESS ROOK
  "♝", // U+265D BLACK CHESS BISHOP
  "♞", // U+265E BLACK CHESS KNIGHT
  "♟", // U+265F BLACK CHESS PAWN
  // Dingbats — the old, well-covered end of the block.
  "✂", // U+2702 BLACK SCISSORS
  "✇", // U+2707 TAPE DRIVE
  "✈", // U+2708 AIRPLANE
  "✉", // U+2709 ENVELOPE
  "✎", // U+270E LOWER RIGHT PENCIL
];

/** THE VALIDATION GATE for every pet icon that did not come out of
 * `APP_MARK_ICONS` itself — and that is every interesting one.
 *
 * This is the bidi/ZWJ/confusable FIREWALL, and it is a membership test
 * rather than a sanitiser on purpose. A pet icon can arrive from three
 * places the visor does not control: a component's own NOMINATION (see
 * `SurfaceIdentity.nomination` — an app asking to wear a particular
 * glyph), a mark SYNCED from the user-system partition (written by
 * another device, possibly a different visor build), and a trust record
 * HAND-EDITED in devtools. Each of those is an attacker-influenceable
 * string in the visor's own pixels, at the position that is supposed to
 * be unspoofable, so the interesting inputs are not typos:
 *
 *   - RTL overrides and other bidi controls (U+202E and friends), which
 *     reorder the text AROUND the mark and can make a foreign-quoted
 *     nickname read as though it were in the visor's voice;
 *   - ZWJ sequences and variation selectors, which turn several
 *     codepoints into one rendered picture — including a colour emoji
 *     the curation rules exclude, arrived at by composition;
 *   - combining marks, which stack arbitrary ink onto a neighbour;
 *   - homoglyphs of the VISOR's own icons (VISOR_ICONS), which is the
 *     component impersonating the visor's button;
 *   - anything long enough to stretch the strip.
 *
 * Trying to enumerate those is a losing game. Membership in a fixed,
 * hand-vetted list of single BMP scalars refuses all of them at once,
 * including the ones nobody has thought of yet — and it degrades safely:
 * a mark that fails renders as NO ICON ANYWHERE (never as a placeholder,
 * never as the raw string), so the worst outcome is a surface the user
 * has not marked yet, which is a state the visor already handles
 * honestly.
 *
 * CALL IT AT THE SEAM, not at the render site. A consumer reading a
 * component's nomination validates it the moment it crosses (see
 * spikes/demo/host/demo.ts's `mark-nomination` read, and invariant (g)
 * in spikes/demo/scripts/check-invariants.sh, which greps for exactly
 * that adjacency): an invalid string must never reach a render path at
 * all, not even the picker's. */
export function isAppMarkIcon(s: string): boolean {
  return APP_MARK_ICONS.includes(s);
}

/** One pet icon, rendered. Returns null for the unmarked case — an
 * empty string, an absent value, or anything `isAppMarkIcon` refuses —
 * so a caller appends nothing rather than a blank slot.
 *
 * NO FABRICATION, the same rule the identity record follows: an
 * unmarked surface gets NO glyph. The visor does not invent a mark for a
 * component the user has never named; the strip simply says nothing
 * before the user has said anything. */
export function markIcon(icon: string | undefined): HTMLElement | null {
  if (icon === undefined || !isAppMarkIcon(icon)) return null;
  const el = document.createElement("span");
  el.className = "mark-icon";
  el.textContent = icon;
  return el;
}

/** Cap for the user's own words on the strip. CSS ellipsis handles the
 * visual overflow; this stops a hand-edited record from being long
 * enough to matter in the first place. */
export const IDENTITY_MAX = 24;

export interface VisorIdentity {
  name?: string;
  device?: string;
  icon?: string;
}

export function loadIdentity(identityKey: string): VisorIdentity {
  try {
    const raw = JSON.parse(localStorage.getItem(identityKey) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const rec = raw as Record<string, unknown>;
    const word = (v: unknown) =>
      typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, IDENTITY_MAX) : undefined;
    return {
      name: word(rec.name),
      device: word(rec.device),
      // Out-of-vocabulary icons are dropped here rather than rendered;
      // `identityIcon` supplies the default.
      icon: typeof rec.icon === "string" && VISOR_ICONS.includes(rec.icon) ? rec.icon : undefined,
    };
  } catch {
    return {};
  }
}

export function saveIdentity(identityKey: string, rec: VisorIdentity): void {
  // Empty fields are stored as ABSENT, not as "": unset must round-trip
  // as unset, so the strip keeps rendering nothing for them.
  const out: VisorIdentity = {};
  if (rec.name && rec.name.trim() !== "") out.name = rec.name.trim().slice(0, IDENTITY_MAX);
  if (rec.device && rec.device.trim() !== "") out.device = rec.device.trim().slice(0, IDENTITY_MAX);
  if (rec.icon && VISOR_ICONS.includes(rec.icon)) out.icon = rec.icon;
  try {
    localStorage.setItem(identityKey, JSON.stringify(out));
  } catch { /* nothing durable to write to */ }
}

/** The glyph the visor's own button wears. Unknown/absent → the default
 * shield (see VISOR_ICONS). */
export function identityIcon(rec: VisorIdentity): string {
  return rec.icon && VISOR_ICONS.includes(rec.icon) ? rec.icon : DEFAULT_ICON;
}

// --- what the visor knows about a surface, and what it shows ------------------

/** What the visor knows about one component surface. `name` is the
 * unforgeable provenance key the visor fetched the artifact by; `nickname`
 * is what the component says about itself; `petname` is what the user
 * decided to call it. Only the last of the three is ever spoken in
 * the visor's own voice. */
export interface SurfaceIdentity {
  name: string;
  nickname: string;
  /** THE PET ICON: the user's own recognition mark for this component,
   * chosen in the naming ceremony from `APP_MARK_ICONS`. "" = UNMARKED,
   * and unmarked renders as nothing at all (see `markIcon`) — the visor
   * says nothing in its own voice about a component the user has not
   * spoken about yet. Replaces the mark hue and its colour chip (#22
   * discussion): the anchor colour keeps its job, per-app colour memory
   * was never doing one. */
  icon: string;
  isNew: boolean;
  petname?: string;
  /** WHAT THIS COMPONENT ASKED TO WEAR — a glyph the component itself
   * nominated (`mark-nomination` in the demo's WIT). PRE-VALIDATED
   * VISOR-SIDE: a consumer puts a value here only after `isAppMarkIcon`
   * has accepted it at the seam, so nothing downstream re-checks and
   * nothing downstream may assume it is unclaimed — the ceremony still
   * drops it if another record already wears it.
   *
   * It is NEVER a key, never rendered in the visor's own voice, and
   * appears in exactly one place: the naming ceremony's picker, first,
   * foreign-attributed. The component is never told the outcome. */
  nomination?: string;
  /** When the visor first assigned this record its mark, from the stored
   * trust record. Shown on the App settings sheet as a locale date — a
   * "you have seen this before, since <date>" the user can check. */
  firstSeen?: number;
  /** One line of visor-known metadata about this surface, for the App
   * settings sheet. `label` is THE VISOR'S word (never a component's);
   * `value` may be component-influenced (a panel's declared
   * destination), so the sheet renders it in APP VOICE — through
   * `foreignToken`, quoted, monospaced and plated. `foreign` says
   * which. */
  meta?: { label: string; value: string; foreign: boolean };
}

/** The visor's context slot: what secondary surface, if any, is on screen.
 * Called with null for "no secondary surface" — which is no longer
 * "nothing": the strip falls back to THE APP's own identity, the
 * artifact the visor fetched and drew into the three regions. `kind` says
 * whose pixels the secondary surface is: a component's config panel,
 * the visor's own credential sheet, the visor's own naming/App-settings sheet,
 * or the visor's own settings sheet. The last has no component behind it at
 * all, which is why it is a bare `kind` rather than a surface. */
export type VisorContext =
  | (SurfaceIdentity & { kind?: "panel" | "credentials" | "naming" })
  | { kind: "settings" }
  | null;

/** USER VOICE: the user's word for a component, in THE VISOR'S voice —
 * not quoted, not monospaced, full opacity, weight 600, because the user
 * wrote it and the visor is entitled to say it. Clamped anyway — the
 * naming sheet caps input at 40, but a record hand-edited in devtools
 * should not be able to stretch the strip. */
export function petnameSpan(petname: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "petname";
  el.textContent = petname.slice(0, 40);
  return el;
}

/** THE APP-VOICE CONSTRUCTOR — the only door in the visor through which
 * an app-influenced string reaches the screen.
 *
 * THREE VOICES (visor/README.md, visor/ui/visor.css's header): every
 * piece of content the visor renders belongs to exactly one provenance
 * class, and the class is visible.
 *
 *   - FRAMEWORK VOICE — the unmarked baseline: the visor's own headings,
 *     labels, hints, `.said` commentary, announcements, SAS digits,
 *     pairing codes, the `.fresh` badge. No marker; it is what the visor
 *     looks like.
 *   - USER VOICE — the user's own vocabulary spoken by the visor:
 *     `.petname`, `.who` (`.who.device` as its quieter half), and pet
 *     icons, which are user voice BY CONSTRUCTION (a nominated glyph is
 *     never rendered outside the naming ceremony's picker) and therefore
 *     carry no extra marker. Weight 600, full opacity, never quoted,
 *     never monospace. NOT italics: CJK has only synthetic oblique,
 *     Arabic has no italics at all, 12px italic legibility is poor, and
 *     italics read as quotation — the wrong connotation for the one
 *     voice that is not being quoted.
 *   - APP VOICE — component-influenced strings: quoted, monospaced,
 *     textually attributed, and PLATED (a recessed background so they
 *     read as embedded tokens rather than as words in the visor's own
 *     sentence). This function, and only this function, assigns the
 *     `foreign` class that carries all of it.
 *
 * THE ONE-DIRECTIONAL SECURITY RULE: app-influenced strings must only be
 * renderable through the app-voice constructor; the reverse direction
 * (visor text accidentally styled as a plate) is ugly but not dangerous.
 * That asymmetry is why the enforcement is a construction funnel rather
 * than a style audit, and why invariant (h) in
 * spikes/demo/scripts/check-invariants.sh pins the `foreign`
 * class-assignment count in this file at exactly one.
 *
 * `maxLen` clamps at the render site (defaults to 40, the petname cap);
 * `quoted` picks the element kind — a `<q>` renders quote marks around
 * the text and is the default, `{ quoted: false }` gives a plain span for
 * a site whose surrounding sentence already supplies the punctuation. */
export function foreignToken(
  text: string,
  { maxLen = 40, quoted = true }: { maxLen?: number; quoted?: boolean } = {},
): HTMLElement {
  const el = document.createElement(quoted ? "q" : "span");
  el.className = "foreign";
  el.textContent = text.slice(0, maxLen);
  return el;
}

/** The component's own account of itself, always app voice: quoted,
 * monospaced, plated, clamped, never joined into a visor sentence. A
 * named wrapper over `foreignToken` because "what it calls itself" is
 * the most-repeated app-voice site in the UI and deserves to read as
 * itself at the call sites. */
export function nicknameQuote(nickname: string): HTMLElement {
  return foreignToken(nickname, { maxLen: 40 });
}

// --- the drawer host's timing ------------------------------------------------

/** The arming delay, ported from the todomvc visor spike
 * (spikes/todomvc/host/visor.ts:18): controls and inputs stay disabled
 * until it elapses, which defeats a baited mis-tap — an app training
 * rapid taps at a position where a visor control is about to appear.
 * The TIMER is the enforcement; the slide is only its visible form, so
 * prefers-reduced-motion drops the animation and never the delay.
 *
 * It is ALSO the deferred-teardown delay: a close animates for this long,
 * so the drawer is only blanked after it (and only if no other tenant
 * claimed it meanwhile — see `occupied`). */
export const ARM_MS = 700;

// --- the drawer host ----------------------------------------------------------

/** One sheet, as a tenant builds it. The host owns the drawer's geometry,
 * arming and teardown; this is the tenant's half of the contract. */
export interface DrawerSheet {
  /** The sheet's root element; the host mounts exactly this. */
  root: HTMLElement;
  /** Controls to hold disabled until the arming delay elapses. Ignored
   * for a tenant that is not `armed`. */
  controls?: Array<HTMLButtonElement | HTMLInputElement>;
  /** Run when the arming delay elapses, after the controls are enabled
   * and before `.armed` lands on the root. Only the still-current
   * session ever reaches this. */
  onArmed?: () => void;
  /** Run once the reveal animation has been started — where a sheet with
   * no arming delay takes focus. */
  onShown?: () => void;
}

/** Close options every tenant understands, plus whatever the tenant's own
 * hooks read off it (the demo's settings sheet reads `commit`). */
export interface DrawerCloseOptions {
  /** False = close WITHOUT touching the strip context, because the caller
   * is about to claim it. */
  context?: boolean;
  [key: string]: unknown;
}

export interface DrawerTenantSpec<S> {
  /** Diagnostic only; the host does not render it. */
  name: string;
  /** THE HIGHEST PRECEDENCE. An exclusive tenant is never evicted — every
   * other tenant's `open` refuses while it holds the drawer — and its own
   * open evicts everything else. In the demo this is the credential
   * sheet: a sheet that is collecting (or about to accept) secrets is
   * never displaced by a convenience. */
  exclusive?: boolean;
  /** Apply the arming delay (see ARM_MS). The LIGHTWEIGHT tenants do not:
   * arming defends SECRET ENTRY against a baited mis-tap, and paying the
   * tax where nothing secret is typed would train users to click through
   * a delay that means something elsewhere. */
  armed?: boolean;
  /** Dim and freeze the page behind the sheet (the host owns #visor-dim;
   * freezing whatever else the consumer runs is `beforeShow`/
   * `afterCollapse` work). */
  dim?: boolean;
  /** The strip context this tenant claims while it holds the drawer. Also
   * what `restoreContext` recomputes from. */
  context: (session: S) => VisorContext;
  /** Before the drawer is revealed (the demo pauses every runner here, so
   * no component code is live while a secret is on screen). */
  beforeShow?: (session: S) => void;
  /** After the session is dropped and the resize listener removed, before
   * the sheet collapses (the demo's settings sheet reverts its live
   * colour preview here — an uncommitted preview must not survive the
   * sheet). */
  beforeCollapse?: (session: S, opts: DrawerCloseOptions) => void;
  /** After the collapse and the un-dim, before the context is restored
   * (the demo resumes its runners here). */
  afterCollapse?: (session: S, opts: DrawerCloseOptions) => void;
  /** After the context has been restored (the demo drops its held
   * credentials here — the visor keeps nothing after the interaction it
   * collected them for is over). */
  afterRestore?: (session: S, opts: DrawerCloseOptions) => void;
}

export interface DrawerTenant<S> {
  readonly name: string;
  isOpen(): boolean;
  session(): S | null;
  /** The still-the-current-session guard every deferred handler needs. */
  owns(session: S): boolean;
  /** Take (or drop) the session WITHOUT any DOM work. The demo claims the
   * credential session before retiring the panel, so the panel's
   * retirement — and any late `close` event from the dialog — leaves the
   * held values alone. A subsequent `open` with the SAME session object
   * is then a reveal, not a re-entry. */
  claim(session: S | null): void;
  /** Reveal the sheet. Returns false when a higher-precedence tenant
   * holds the drawer (see `exclusive`), in which case nothing happened. */
  open(session: S, build: (session: S) => DrawerSheet): boolean;
  close(opts?: DrawerCloseOptions): void;
}

export interface DrawerHost {
  /** Register a tenant. REGISTRATION ORDER IS PRECEDENCE ORDER: it is the
   * order `restoreContext` consults, and the order evictions run in.
   * Adding a tenant is then one call instead of an audit of every timer
   * and every close path. */
  tenant<S>(spec: DrawerTenantSpec<S>): DrawerTenant<S>;
  /** ONE occupancy test for every tenant. Every deferred
   * `drawer.hidden = true` is gated on this rather than on the session
   * that scheduled it: the teardown is DRAWER-scoped work, so it must ask
   * about the drawer, not about one session. */
  occupied(): boolean;
  /** PUT THE STRIP BACK IN THE HANDS OF WHOEVER ACTUALLY OWNS IT NOW.
   *
   * The strip is the trust anchor, and its top line answers "whose
   * rectangle is this". Every path that ENDS something — a sheet
   * closing, a panel retiring — has to restore that line, and the naive
   * restore ("back to the app") is a lie whenever something else has
   * claimed the strip in the meantime. Since the ending paths are all
   * DEFERRED in one way or another (a close runs on an animation, a
   * retirement runs off a dialog event that at least one embedding
   * delivers late), "in the meantime" is not hypothetical.
   *
   * So no caller states what the context should become. Each one says
   * only "I am done", and the answer is recomputed HERE from what is
   * live: the consumer's `contextOverride` first (a live component
   * surface is the only tenant that is not the visor's own, which makes
   * mislabelling it the one error with a victim), then each registered
   * tenant in precedence order, then nothing. */
  restoreContext(): void;
  /** The open sheet's refusal line, in the visor's own words. A no-op
   * while no sheet has declared one. */
  note(text: string): void;
  /** Declare the element `note` writes into. Called by a tenant while it
   * builds its sheet; cleared by the host on close, so a note aimed at a
   * sheet that is gone cannot land in the next one. */
  setNote(el: HTMLElement | null): void;
}

// --- the visor instance -------------------------------------------------------

export interface VisorConfig {
  /** Where the committed anchor hue lives. */
  hueKey: string;
  /** Rename-only migration source, read once and removed. */
  legacyHueKey?: string;
  /** Where the identity record lives. */
  identityKey: string;
  /** THE APP'S OWN ROW IN THE TRUST TABLE — what the strip's top line
   * falls back to when no secondary surface is on screen. */
  appSurface?: () => SurfaceIdentity | null;
  /** Consulted FIRST by `restoreContext`: a live component surface, if
   * the consumer has one. Undefined/null = nothing claimed here. */
  contextOverride?: () => VisorContext | null | undefined;
}

/** Late-installed handlers for controls the STRIP renders. The strip is
 * built by `initVisor`, before a consumer's sheets exist, so the controls
 * it draws call through here. */
export interface VisorHandlers {
  /** The strip's "name it" control and its context cluster. */
  requestNaming?: (surface: SurfaceIdentity) => void;
  /** The strip's own settings button. */
  requestSettings?: () => void;
}

export interface Visor {
  /** True when this boot rolled a FRESH anchor colour — the consumer is
   * expected to announce it (a reset is announced, never quiet). */
  readonly fresh: boolean;
  install(handlers: VisorHandlers): void;
  /** Move the context: a MOVE preempts any live announcement. */
  setContext(ctx: VisorContext): void;
  /** Repaint the CONTEXT cluster from whatever context is current —
   * for when something the current context is drawn from changes
   * underneath it (the app surface being registered at boot, for
   * instance) without the context itself moving. A mere repaint does NOT
   * preempt a live announcement. */
  renderContext(): void;
  /** Repaint the identity cluster from the stored record. */
  renderIdentity(): void;
  /** Say something in THE VISOR'S OWN VOICE on the strip's bottom line,
   * for `ms`, and then put the line back by RE-RENDERING the live
   * context.
   *
   * The re-render is the whole design of this helper. The obvious version
   * saves the line's previous content and restores it — which is wrong
   * here, because the thing the line is about can change while the
   * announcement is showing: a sheet opens or closes, a petname is
   * assigned, the context moves to another surface. Restoring a saved
   * string would then put a stale sentence back on the anchor, in the
   * visor's voice, which is the one place a wrong word costs something.
   *
   * ANNOUNCEMENT POLICY (the three voices, see `foreignToken`): this
   * takes a FLAT STRING, so it cannot carry class marking — an
   * announcement is therefore spoken entirely in FRAMEWORK VOICE, and
   * may embed USER-voice words inline (a petname, the user's word for a
   * device), because the user's vocabulary is already something the
   * visor is entitled to say in its own sentence. An APP-INFLUENCED
   * string must NEVER be passed here: there is no way to plate it, so it
   * would arrive on the anchor's own line indistinguishable from the
   * visor's words. A fact about a component is announced by DESCRIBING
   * it in the visor's vocabulary; the component's own string belongs on
   * a surface where `foreignToken` can dress it. */
  announce(text: string, ms?: number): void;
  identity(): VisorIdentity;
  saveIdentity(rec: VisorIdentity): void;
  /** The hue currently COMMITTED as the user's anchor colour — as opposed
   * to a live preview a settings sheet is painting. `applyHue` paints;
   * this moves only where the choice is persisted, so a Cancel has
   * something truthful to revert to even in a browser where storage is
   * unavailable (and a re-read would otherwise re-roll). */
  committedHue(): number;
  /** Paint, without committing (live preview). */
  applyHue(hue: number): void;
  /** Commit: remember, paint, persist. */
  commitHue(hue: number): void;
  readonly drawer: DrawerHost;
  // NO CONSUMER-CONTROL SLOT. There was one — an optional strip element
  // a consumer could mount its own buttons into, exposed here as a
  // nullable node. Its only user was the todomvc spike's
  // pair of demonstration buttons, and both are gone. It is not
  // reinstated on demand either — every control the strip carries is one
  // more thing on the trust anchor whose provenance a user has to
  // reason about, so a new one is a framework decision with a framework
  // argument behind it, not a slot a consumer fills.
}

export function initVisor(config: VisorConfig): Visor {
  const { hue, fresh } = loadVisorHue(config.hueKey, config.legacyHueKey);
  let committedHue = hue;
  applyVisorHue(hue);

  // FIXED IDS. They are part of the trust model and of the e2e contract —
  // "the visor's pixels" is a claim about named elements a component
  // cannot reach — so they are not parameterised.
  const context = document.getElementById("visor-context")!;
  const ctxTop = context.querySelector(".ctx-top") as HTMLElement;
  const ctxBottom = context.querySelector(".ctx-bottom") as HTMLElement;
  const identityBox = document.getElementById("visor-identity")!;
  const drawer = document.getElementById("visor-drawer") as HTMLElement;
  const drawerInner = document.getElementById("visor-drawer-inner") as HTMLElement;
  /** The bar the sheet opens above — measured for the sheet's height
   * budget, so the anchor can never be pushed off-screen. */
  const strip = document.getElementById("visor-strip") as HTMLElement | null;
  const dim = document.getElementById("visor-dim") as HTMLElement;

  const handlers: VisorHandlers = {};
  const requestNaming = (surface: SurfaceIdentity) => handlers.requestNaming?.(surface);
  const requestSettings = () => handlers.requestSettings?.();
  const appSurface = () => config.appSurface?.() ?? null;

  // THE IDENTITY CLUSTER, rebuilt from the record on every commit. Every
  // word here is the user's own, said in the visor's voice (plain, full
  // opacity) — and every word here stays inside the visor's pixels: nothing
  // below is written to a custom property, handed to a panel, or put on
  // the frame seam. Same discipline as `applyVisorHue`, for the same
  // reason: an ambient value is a disclosed value.
  //
  // TWO LINES: the user's name above their word for this device,
  // each ellipsizing in place. They are not hidden on a narrow
  // viewport — the cluster's 45% cap and the per-line ellipsis handle
  // narrowness, and dropping them was dropping half of what an
  // impersonating rectangle cannot reproduce, at the width where the
  // strip is most crowded.
  const renderIdentity = () => {
    const rec = loadIdentity(config.identityKey);
    identityBox.replaceChildren();
    const lines = document.createElement("span");
    lines.className = "id-lines";
    // textContent, never innerHTML: the record is hand-editable storage,
    // so it is treated as data even though it is the user's own.
    // An unset field renders NOTHING — no fabricated "user"/"this
    // device", and no leftover punctuation (the separator the one-line
    // cluster needed is gone with the line).
    if (rec.name) {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = rec.name.slice(0, IDENTITY_MAX);
      lines.append(who);
    }
    if (rec.device) {
      const dev = document.createElement("span");
      dev.className = "who device";
      dev.textContent = rec.device.slice(0, IDENTITY_MAX);
      lines.append(dev);
    }
    identityBox.append(lines);
    const btn = document.createElement("button");
    btn.id = "visor-settings";
    btn.type = "button";
    // The face is a glyph from the visor's fixed vocabulary — never a
    // string out of the record (see VISOR_ICONS).
    btn.textContent = identityIcon(rec);
    btn.title = "your visor: name, device, colour";
    btn.setAttribute("aria-label", "your visor: name, device, colour");
    btn.onclick = () => requestSettings();
    identityBox.append(btn);
  };
  renderIdentity();

  /** The context currently on the strip, kept so an expiring
   * announcement can re-render it rather than restore a saved string. */
  let current: VisorContext = null;
  /** Bumped by every render and every announcement: a revert timer whose
   * token is stale has been overtaken and must do nothing. */
  let announceToken = 0;
  let announceTimer = 0;
  /** True while an announcement owns the bottom line. A CONTEXT MOVE
   * preempts it (a sheet opening is more urgent than any timed note),
   * but a mere repaint of the same context must not: the app surface
   * being registered a second after boot would otherwise silently eat
   * the "new visor colour" announcement. */
  let announcing = false;

  /** The surface the TOP line is about. The visor's own settings sheet has
   * no component behind it, so the top line keeps naming the app: the
   * component identity is a property of what is INSTALLED, not of which
   * visor sheet happens to be open — that is what "static after
   * install" means here. */
  const topSurface = (ctx: VisorContext): SurfaceIdentity | null => {
    if (ctx === null) return appSurface();
    if (ctx.kind === "settings") return appSurface();
    return ctx;
  };

  const renderContext = ({ keepAnnouncement = false }: { keepAnnouncement?: boolean } = {}) => {
    const holdBottom = keepAnnouncement && announcing;
    if (!holdBottom) {
      announceToken++;
      clearTimeout(announceTimer);
      announcing = false;
    }
    const ctx = current;
    const surface = topSurface(ctx);
    ctxTop.replaceChildren();
    if (!holdBottom) ctxBottom.replaceChildren();

    // --- the TOP line: the COMPONENT's identity, and only that -------
    // Component-said words only: its assigned mark and what it calls
    // itself, quoted/monospaced/clamped as ever. Nothing the visor does to
    // its own sheets rewrites this line.
    if (surface) {
      // THE PET ICON, or nothing. A marked surface wears the glyph the
      // USER picked for it, in plain text inheriting --visor-fg — not a
      // coloured chip, and not a swatch the visor chose on its own. An
      // UNMARKED surface renders NO glyph: before the user has said
      // anything about this component, the visor has nothing of its own
      // to say about it either, and a placeholder in the visor's pixels
      // would be the visor speaking first.
      const icon = markIcon(surface.icon);
      if (icon) ctxTop.append(icon);
      // A component that declares nothing gets nothing quoted: an empty
      // app-voice token would render as a bare plate with quote marks —
      // punctuation in the visor's pixels standing for a claim nobody
      // made.
      if (surface.nickname !== "") ctxTop.append(nicknameQuote(surface.nickname));
    }

    // --- the BOTTOM line: THE VISOR'S voice ----------------------------
    // What is NOT here any more: the sentence "— provider configuration
    // panel · drawn by the component, not by the visor". It was a standing
    // description competing for a line that now has to hold the
    // petname, the first-sight marker and the open sheet's name in one
    // ellipsizing row; and the claim it made is made better by the
    // sheets themselves, at the moment they open.
    const kind = ctx === null ? "app" : (ctx.kind ?? "panel");
    const sheet = kind === "credentials" || kind === "naming" || kind === "settings";
    if (sheet && !holdBottom) {
      // While a visor sheet is open the strip NAMES it: the anchor and
      // the surface hanging off it say the same thing, so "which pixels
      // am I typing into" has a visor-side answer. This is the part of
      // the deleted standing-rule line that was worth keeping.
      const lead = document.createElement("span");
      lead.className = "said";
      lead.textContent = kind === "credentials"
        ? "storage credentials"
        : kind === "naming"
        ? "naming"
        : "visor settings";
      ctxBottom.append(lead);
    }
    if (surface && !holdBottom) {
      // THE DEMOTION. With a petname, the name the visor SAYS is the user's
      // own, in the visor's voice, on the visor's line — and the component's
      // self-description stays upstairs where it belongs, as a quote.
      // Without one, the visor offers to fix that.
      const petname = (surface.petname ?? "").trim();
      if (petname !== "") {
        const named = petnameSpan(petname);
        if (!sheet) {
          // The click target is visor pixels in the strip — a place no
          // component can draw — so the ceremony cannot be baited from
          // inside an app rectangle. (The whole cluster is a tap target
          // too; this inner one stops the event so one gesture is one
          // opening.)
          named.setAttribute("role", "button");
          named.setAttribute("tabindex", "0");
          named.classList.add("clickable");
          named.title = "app settings: rename, re-mark, forget";
          named.onclick = (ev: MouseEvent) => {
            ev.stopPropagation();
            requestNaming(surface);
          };
          // A control that announces itself as a button to assistive tech
          // must BE one: Enter and Space activate it, exactly as they
          // would a real <button>. (Space is prevented from scrolling the
          // page out from under the ceremony it is about to open.)
          named.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            if (ev.key === " ") ev.preventDefault();
            ev.stopPropagation();
            requestNaming(surface);
          };
        }
        ctxBottom.append(named);
      }
      if (surface.isNew && !sheet) {
        // The TOFU moment is the one worth interrupting for: recognition
        // marks mean nothing the first time, and the first time is when
        // impersonation would land.
        const freshEl = document.createElement("span");
        freshEl.className = "fresh";
        freshEl.textContent = "NEW — first time this component draws here";
        ctxBottom.append(freshEl);
      }
      if (petname === "" && !sheet) {
        // The visor's own control, in the visor's own pixels: the offer to stop
        // relying on what the component says about itself.
        const nameIt = document.createElement("button");
        nameIt.id = "visor-name-it";
        nameIt.type = "button";
        nameIt.textContent = "name it";
        nameIt.title = "give this component your own name";
        nameIt.onclick = (ev: MouseEvent) => {
          ev.stopPropagation();
          requestNaming(surface);
        };
        ctxBottom.append(nameIt);
      }
    }

    // THE CLUSTER IS ONE TAP TARGET, opening the visor's App settings sheet
    // for the surface the top line names. Offered only when there is a
    // surface and no credential/naming sheet already owns the drawer —
    // a control that would be a no-op must not announce itself as a
    // button to assistive tech.
    const tappable = surface !== null && kind !== "credentials" && kind !== "naming";
    if (tappable) {
      context.setAttribute("role", "button");
      context.setAttribute("tabindex", "0");
      context.title = "app settings for this component";
      context.onclick = () => requestNaming(surface!);
      context.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        if (ev.key === " ") ev.preventDefault();
        requestNaming(surface!);
      };
    } else {
      context.removeAttribute("role");
      context.removeAttribute("tabindex");
      context.removeAttribute("title");
      context.onclick = null;
      context.onkeydown = null;
    }
  };

  const announce = (text: string, ms = 8000) => {
    const token = ++announceToken;
    announcing = true;
    ctxBottom.replaceChildren();
    const said = document.createElement("span");
    said.className = "said announce";
    said.textContent = text;
    ctxBottom.append(said);
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      // Overtaken by a newer render or announcement: that one owns the
      // line now.
      if (token !== announceToken) return;
      announcing = false;
      // REVERT BY RE-RENDER, never by restoring what was there: the
      // context may have moved while this was showing.
      renderContext();
    }, ms);
  };

  /** Same strip subject? A context MOVE preempts a live announcement; a
   * repaint that does NOT move the context must let it finish. The
   * distinction earns its keep on the close paths: teardown restores are
   * DEFERRED (a dialog retirement waits a macrotask for in-flight frame
   * messages), so a restore from an EARLIER gesture can land milliseconds
   * after a LATER gesture's announcement — observed with the forget
   * announcement, clobbered after 4ms by the storage dialog's retirement
   * restoring the same app context it was announced over. Contexts are
   * recomputed objects, so compare by subject (kind + surface name), not
   * identity. */
  const sameContext = (a: VisorContext, b: VisorContext): boolean => {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if ((a.kind ?? "panel") !== (b.kind ?? "panel")) return false;
    return (a as { name?: string }).name === (b as { name?: string }).name;
  };

  const setContext = (ctx: VisorContext) => {
    const moved = !sameContext(current, ctx);
    current = ctx;
    renderContext({ keepAnnouncement: !moved });
  };
  setContext(null);

  // The colour picker used to live on the strip, as a button plus an
  // inline swatch row. It moved WHOLE into the consumer's settings sheet
  // (same constrained palette, same fixed lightness/chroma, same storage
  // key): the strip is the anchor, and an anchor with its own editing
  // controls dangling off it is a busier target than one control that
  // opens the visor's own surface.

  // --- the drawer host --------------------------------------------------------
  //
  // The sheet unfolds ABOVE the pinned strip, painted in the user's own
  // anchor colour.
  //
  // ABOVE, not below, and the distinction is the whole defence. A sheet
  // BENEATH the strip is forgeable by adjacency: the strip floats over
  // scrollable content, so an app frame can be scrolled flush to the
  // strip's bottom edge and paint a counterfeit that appears attached to
  // the real bar. The band ABOVE the strip is unreachable at every scroll
  // offset — the strip is pinned to the viewport's top edge, so there is
  // no position an app can occupy there. And the sheet ARRIVES by pushing
  // the real strip down: an app can paint a sheet, but it cannot move
  // the visor's bar, so the reveal motion is itself unforgeable. Position
  // is the anchor, the motion is its proof, and the colour is secondary.

  // deno-lint-ignore no-explicit-any
  const tenants: TenantImpl<any>[] = [];

  interface TenantImpl<S> extends DrawerTenant<S> {
    readonly spec: DrawerTenantSpec<S>;
  }

  let noteEl: HTMLElement | null = null;
  const drawerNote = (text: string) => {
    if (noteEl) noteEl.textContent = text;
  };

  const occupied = () => tenants.some((t) => t.isOpen());

  const restoreContext = () => {
    const override = config.contextOverride?.();
    if (override !== undefined && override !== null) {
      setContext(override);
      return;
    }
    for (const t of tenants) {
      const s = t.session();
      if (s !== null) {
        setContext(t.spec.context(s));
        return;
      }
    }
    setContext(null);
  };

  /** The height budget every sheet shares. The sheet grows ABOVE the
   * strip inside one sticky assembly, so a sheet taller than the viewport
   * would push the strip off the bottom of the screen — losing the anchor
   * at the exact moment a secret is on screen. The sheet is therefore
   * capped at viewport-minus-strip and scrolls internally past that (see
   * .cred-sheet's --visor-sheet-max). Measured rather than hardcoded
   * because the strip wraps to two rows on a phone, and re-measured on
   * resize/rotation.
   *
   * ceil: a fractional strip height would otherwise leave the bar hanging
   * a subpixel off the bottom. */
  const fit = () => {
    const stripH = Math.ceil(strip?.getBoundingClientRect().height ?? 0);
    const budget = Math.max(0, globalThis.innerHeight - stripH);
    drawer.style.setProperty("--visor-sheet-max", `${budget}px`);
  };

  /** Animate 0 → the measured content height. One property drives the
   * whole assembly: the sheet's growth pushes the strip down and the
   * page content with it, on one curve (spikes/todomvc/host/visor.ts:82-90
   * — scrollHeight misses the flex-end top-overflow, so measure at auto). */
  const reveal = () => {
    drawerInner.style.height = "auto";
    const target = drawerInner.offsetHeight;
    drawerInner.style.height = "0px";
    void drawerInner.offsetHeight;
    drawerInner.style.height = `${target}px`;
  };

  function makeTenant<S>(spec: DrawerTenantSpec<S>): TenantImpl<S> {
    let session: S | null = null;
    let anchor: (() => void) | null = null;
    let armTimer = 0;

    const detach = () => {
      if (anchor) globalThis.removeEventListener("resize", anchor);
      anchor = null;
    };

    const tenant: TenantImpl<S> = {
      spec,
      name: spec.name,
      isOpen: () => session !== null,
      session: () => session,
      owns: (s) => session === s,
      claim: (s) => {
        session = s;
      },
      close(opts: DrawerCloseOptions = {}) {
        const s = session;
        if (s === null) return;
        session = null;
        clearTimeout(armTimer);
        detach();
        // A note aimed at a sheet that is gone must not land in the next
        // one; the tenant re-declares its own on the way up.
        noteEl = null;
        spec.beforeCollapse?.(s, opts);
        drawerInner.style.height = "0px";
        if (spec.dim) dim.hidden = true;
        spec.afterCollapse?.(s, opts);
        // Ownership-aware, never a bare `setContext(null)`: this close may
        // be running late, and the strip may already belong to somebody
        // else (see restoreContext).
        if (opts.context !== false) restoreContext();
        spec.afterRestore?.(s, opts);
        setTimeout(() => {
          // Occupancy-aware, not tenant-scoped: another tenant may have
          // claimed the drawer in the meantime, and blanking it here
          // would erase a live sheet belonging to somebody else.
          if (!occupied()) {
            drawerInner.replaceChildren();
            drawer.hidden = true;
          }
        }, ARM_MS);
      },
      open(s, build) {
        // MUTUAL EXCLUSION. An exclusive tenant holding the drawer refuses
        // every other opener outright.
        for (const other of tenants) {
          if (other === tenant) continue;
          if (other.isOpen() && other.spec.exclusive) return false;
        }
        // Everything else is evicted — in registration (precedence) order,
        // and WITHOUT touching the strip context, which this tenant is
        // about to claim.
        for (const other of tenants) {
          if (other === tenant) continue;
          if (other.isOpen()) other.close({ context: false });
        }
        // Re-entry with a NEW session closes the old one first (the
        // lightweight tenants are re-opened this way, and the old sheet's
        // resize listener must go with it). Re-entry with the SAME session
        // object is a claim being revealed — see `claim` — so it is not a
        // close.
        // CONTRACT: an exclusive tenant re-opened with a DIFFERENT session
        // would therefore run its full close (dropping whatever it held).
        // The demo never does this; the conservative reading is that a
        // second secret-collecting session must not inherit the first
        // one's state.
        if (session !== null && session !== s) tenant.close({ context: false });
        session = s;
        spec.beforeShow?.(s);
        if (spec.dim) dim.hidden = false;
        drawer.hidden = false;
        // The strip names the sheet hanging off it, in the same colour it
        // has always had (the anchor never changes colour per surface).
        setContext(spec.context(s));

        const sheet = build(s);
        drawerInner.replaceChildren(sheet.root);

        const refit = () => {
          fit();
          // The animated height is a pixel target, so it goes stale when
          // the budget changes under it; re-measure at auto and retarget.
          if (session !== s) return;
          drawerInner.style.height = "auto";
          drawerInner.style.height = `${drawerInner.offsetHeight}px`;
        };
        fit();
        anchor = refit;
        globalThis.addEventListener("resize", refit);

        const controls = sheet.controls ?? [];
        if (spec.armed) {
          // Disabled BEFORE the first frame, inputs included: a secret must
          // not be typeable into a sheet the user has not yet had time to
          // see.
          for (const c of controls) c.disabled = true;
        }

        reveal();

        if (spec.armed) {
          clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            if (session !== s) return;
            for (const c of controls) c.disabled = false;
            sheet.onArmed?.();
            sheet.root.classList.add("armed");
          }, ARM_MS);
        }
        // Where a sheet with no arming delay takes focus: there is nothing
        // on it a mis-tap could spend.
        sheet.onShown?.();
        return true;
      },
    };
    tenants.push(tenant);
    return tenant;
  }

  const drawerHost: DrawerHost = {
    tenant: makeTenant,
    occupied,
    restoreContext,
    note: drawerNote,
    setNote: (el) => {
      noteEl = el;
    },
  };

  return {
    fresh,
    install(h) {
      if (h.requestNaming) handlers.requestNaming = h.requestNaming;
      if (h.requestSettings) handlers.requestSettings = h.requestSettings;
    },
    setContext,
    renderContext: () => renderContext({ keepAnnouncement: true }),
    renderIdentity,
    announce,
    identity: () => loadIdentity(config.identityKey),
    saveIdentity: (rec) => saveIdentity(config.identityKey, rec),
    committedHue: () => committedHue,
    applyHue: applyVisorHue,
    commitHue: (h) => {
      committedHue = h;
      applyVisorHue(h);
      try {
        localStorage.setItem(config.hueKey, String(h));
      } catch { /* not durable here */ }
    },
    drawer: drawerHost,
  };
}
