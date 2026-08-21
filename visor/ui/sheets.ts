// The visor's OWN TWO CEREMONIES: naming a component, and the user's
// settings for the visor itself — plus the trust table both of them read
// and write.
//
// This is the second half of the framework layer. visor/ui/visor.ts holds
// what a visor IS (the strip, the anchor colour, the identity record, the
// context line, the drawer host and its tenancy); this file holds the two
// sheets EVERY consumer of that visor wants, because they are not any one
// app's content — they are the visor talking about itself and about the
// components it drew. A consumer that had to reimplement them would
// reimplement the petname triangle, the local-uniqueness rule and the
// live-preview/revert discipline, and would get one of them subtly wrong;
// the todomvc spike proved the milder version of that failure by
// rendering a clickable petname with no ceremony behind it at all.
//
// It is a SEPARATE MODULE from visor.ts on purpose: visor.ts is the
// mechanism (geometry, tenancy, timing) and is consumed by things that
// register their own sheets; this is policy built ON that mechanism. A
// consumer takes visor.ts alone if it wants only the anchor, and both if
// it wants the ceremonies.
//
// WHAT IS PARAMETERISED AND WHAT IS NOT. The storage KEY of the trust
// table is the consumer's (two spikes on one origin must not share a
// table, exactly as they must not share an anchor hue or an identity
// record). Everything else — the palette, the assignment rule, the
// wording, the refusals — is the framework's, because those are the
// parts that carry the security argument.
//
// SCOPING DISCIPLINE, inherited unchanged from visor.ts: nothing here is
// written to the document root, handed to a guest, or put on the frame
// seam. Petnames in particular never cross it — see
// spikes/demo/scripts/check-invariants.sh check (a), and check (b), whose
// VISOR_RENDERERS list includes this file precisely because it renders
// visor-voiced strings.

import {
  APP_MARK_ICONS,
  identityIcon,
  IDENTITY_MAX,
  isAppMarkIcon,
  markIcon,
  nicknameQuote,
  type SurfaceIdentity,
  type Visor,
  VISOR_HUES,
  VISOR_ICONS,
  type VisorIdentity,
} from "./visor.ts";

// --- the trust table: pet icons, first sight, and the user's word -------------
//
// Surface marks: the recognition mark the visor shows for a component is
// a PET ICON the USER picks in the naming ceremony, from the visor's
// curated vocabulary (visor.ts's APP_MARK_ICONS) — never derived, and
// never chosen by the visor on the user's behalf.
//
// WHAT THIS REPLACED. The mark used to be a hue out of the anchor
// palette, rendered as a colour chip. The chip is gone (#22 discussion):
// the ANCHOR colour keeps every job it had — visor-vs-app contrast and
// the spoof lottery — but per-app colour MEMORY was the weak half of the
// scheme. "The blue one" is not something a user can name, rehearse or
// check, and ten hues run out after ten components. A glyph is nameable
// and discriminable, and the vocabulary is big enough that local
// uniqueness stays real.
//
// Two derivations died here BEFORE that change, both to the same attack,
// and the reasoning transfers to glyphs unchanged: making THE VISOR'S
// OWN STRIP vouch the wrong mark. Deriving from component bytes let an
// impersonator grind its artifact until the strip assigned it the
// target's mark (and reshuffled every legitimate update). Deriving from
// HMAC(user-secret, name) fixed the grind only to reopen it through the
// other input: names are self-declared, so declaring the target's name
// yields the target's mark. Anything copyable is trivially fakeable
// INSIDE an attacker's rectangle; the strip is the only place it means
// anything, so what renders there must not be a function of anything an
// attacker chooses. USER CHOICE is the strongest version of that: the
// mark is a function of a gesture made in visor pixels.
//
// A component may NOMINATE a glyph (see `SurfaceIdentity.nomination`),
// which is not a derivation and not an assignment: the nomination is one
// offer among six inside the ceremony, foreign-attributed, and the
// component is never told whether it was taken.
//
// Assignment also buys the property no derivation can: LOCAL
// UNIQUENESS. Icons are offered from the unused set, so two trust
// records on this device never share a mark while the vocabulary lasts.
//
// The record key must be unforgeable PROVENANCE, never self-declared
// identity — a name that can look up someone else's record is the same
// attack through the table. In the spikes the key is the artifact name AS
// FETCHED BY THE VISOR from its own origin (visor-verified provenance);
// when signed releases and publisher identity land (#3, #10), it becomes
// the publisher's verifying key. Durability follows the visor-hue story:
// these live with device state (#11), and a lost table means reassignment
// — visible, so it must be announced, never silent.
//
// THREE NAMES, STRICTLY SEPARATED (the petname triangle):
//   KEY       — the artifact name the visor fetched itself. Unforgeable
//               provenance; the only thing that may address a record.
//   NICKNAME  — what the component calls itself (`nickname()`).
//               Self-declared, so it is rendered as foreign-quoted text
//               and is never a key, never the visor's own voice.
//   PETNAME   — what the USER calls it, typed in the visor's pixels and
//               stored in the record. The visor speaks this one in its own
//               voice, because the user wrote it.
// The demotion is the point: once a petname exists, the component's
// self-description drops to a footnote ("calls itself …") and the name
// with authority is the one the user chose.

export interface SurfaceMark {
  /** THE PET ICON, a member of `APP_MARK_ICONS` — or "" for UNMARKED.
   *
   * "" IS A REAL, HONEST STATE, not a missing value: a record can have a
   * first-sight timestamp, and even a petname, with no icon. That is
   * what a component looks like before the user has picked a mark for
   * it, what a record MIGRATED from the old `hue` schema looks like
   * (see `load` — a hue is not silently reinterpreted as a glyph), and
   * what a mark looks like after the partition's conflict repair cleared
   * the losing side's icon. All three render the same way: no glyph. */
  icon: string;
  firstSeen: number;
  /** THE PETNAME: the user's own word for this component, typed in
   * the visor's own pixels and stored beside the mark. Optional — records
   * written before petnames existed stay valid and simply have none, so
   * there is no migration and an unnamed component keeps working exactly
   * as it did. It is NEVER a key (the key is provenance, above) and it
   * NEVER crosses the frame seam: no component may learn, influence, or
   * collide with the word the user chose for it. */
  petname?: string;
}

/** The trust table, as a consumer sees it.
 *
 * EVERY METHOD IS STATELESS: each one reads (and writes) localStorage
 * afresh, holding nothing between calls. That is what makes it safe for a
 * consumer to build one of these early — before the drawer tenants can be
 * registered in their precedence order — and for `registerVisorSheets` to
 * build its own over the same key: two facades on one key are the same
 * table, not two caches that can disagree. (The demo depends on exactly
 * this: it registers the app's row at boot, long before the sheets are
 * registered behind the credential tenant.) */
export interface SurfaceMarks {
  /** The whole table, for a consumer that renders from it (the demo
   * looks petnames up per pane) and for driving/inspection. */
  load(): Record<string, SurfaceMark>;
  /** The record for this provenance key, CREATING one — first-sight
   * timestamp, and NO icon — if there is none yet. `isNew` is the TOFU
   * moment: true exactly on the boot that created the record.
   *
   * A fresh record is deliberately UNMARKED: the visor does not roll a
   * pet icon on the user's behalf. A mark the user did not choose is a
   * mark they cannot recognise, and inventing one would put a glyph on
   * the anchor in the visor's own voice about a component the user has
   * never said a word about. The ceremony is where marks come from. */
  mark(provenance: string): { mark: SurfaceMark; isNew: boolean };
  /** Commit a petname + pet icon for one record. `icon` must be a member
   * of `APP_MARK_ICONS`, or "" for unmarked; anything else is stored as
   * "" rather than trusted. */
  setPetname(provenance: string, petname: string, icon: string): void;
  /** Delete the WHOLE record — mark, first-sight timestamp and petname
   * together. Forgetting must be honest: a component whose petname was
   * dropped but whose mark survived would still be greeted as familiar.
   * After this the next mount is genuinely NEW again. */
  forget(provenance: string): void;
  /** The pet icons no OTHER record is using. Local uniqueness is the
   * property assignment buys, so the ceremony only ever offers marks
   * that keep it. This record's OWN icon is included (re-picking what
   * you already wear is not a collision). */
  freeIcons(provenance: string): string[];
  /** THE CEREMONY'S SIX OFFERS, in render order.
   *
   * `nomination` is the glyph the component asked to wear, ALREADY
   * VALIDATED by the consumer at the seam (`isAppMarkIcon` — see
   * `SurfaceIdentity.nomination`). It is offered FIRST, and flagged so
   * the sheet can attribute it to the component rather than to the
   * visor — but only if it is genuinely free; a nomination for a glyph
   * another record already wears is DROPPED SILENTLY, exactly like an
   * invalid one. The component learns nothing either way: nothing about
   * the picker or its outcome ever crosses the seam (the same discipline
   * as invariant (e)).
   *
   * When this record already HAS a mark, that glyph is always among the
   * offers (the sheet preselects it), so opening the ceremony to change
   * a petname cannot silently cost a component its mark.
   *
   * The rest are drawn AT RANDOM from the free set, freshly per
   * ceremony. That randomness is deliberate and ecosystem-scale: a
   * stable global ordering would mean every user on every device sees
   * the same first few glyphs, so an app's nomination would win by
   * default-bias alone and a de-facto brand would form out of nothing
   * but list order. Marks are the USER's vocabulary, not a namespace to
   * be squatted. */
  iconOffers(
    provenance: string,
    nomination?: string,
  ): Array<{ glyph: string; nominated: boolean }>;
  /** Is this word already the user's name for a DIFFERENT component?
   * Two records answering to one word would defeat the whole point of a
   * petname — the user would have no way to tell which one is speaking.
   * Compared trimmed and case-insensitively; returns the colliding record
   * (its petname as the user wrote it, and its unforgeable provenance key)
   * so the visor can say, in its own words, what the clash is. */
  collision(provenance: string, petname: string): { key: string; petname: string } | null;
}

/** How many marks the naming ceremony offers. Six: enough that the
 * choice feels like a choice and a nomination cannot be the only thing
 * on screen, few enough to scan in one glance on a phone. */
export const ICON_OFFERS = 6;

/** Build a facade over one consumer's trust table. Stateless — see
 * `SurfaceMarks`. */
export function createSurfaceMarks(marksKey: string): SurfaceMarks {
  /** Read the table, NORMALISING every record on the way out.
   *
   * This is also the `hue` -> `icon` MIGRATION (#22 discussion), and it
   * is deliberately a lossy one: a record written under the old schema
   * carries a palette index, and there is no honest way to turn a number
   * into a glyph the user would recognise. So it becomes UNMARKED. The
   * visor does not invent a mark and pretend the user picked it — that
   * would be the announced-never-silent rule broken by a schema change,
   * which is the quietest possible way to break it. The strip simply
   * shows no glyph until the user next opens the ceremony, and the
   * petname and first-sight date (the parts that ARE the user's) survive
   * untouched.
   *
   * Storage is hand-editable, so this is ALSO the read-side gate: an
   * icon that is not a member of the curated vocabulary is read as ""
   * rather than rendered (see `isAppMarkIcon` for what that refuses and
   * why). Normalisation is not written back — a read is a read — so it
   * is idempotent and cannot corrupt a record it merely displayed. */
  const load = (): Record<string, SurfaceMark> => {
    try {
      const raw = JSON.parse(localStorage.getItem(marksKey) ?? "{}");
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, SurfaceMark> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const rec = value as Record<string, unknown>;
        const icon = typeof rec.icon === "string" && isAppMarkIcon(rec.icon) ? rec.icon : "";
        const mark: SurfaceMark = {
          icon,
          firstSeen: typeof rec.firstSeen === "number" ? rec.firstSeen : Date.now(),
        };
        if (typeof rec.petname === "string" && rec.petname.trim() !== "") {
          mark.petname = rec.petname;
        }
        out[key] = mark;
      }
      return out;
    } catch {
      return {};
    }
  };

  /** The icons no OTHER record wears — see `SurfaceMarks.freeIcons`. A
   * plain function rather than a method so that neither the facade's own
   * `iconOffers` nor a destructuring consumer depends on `this`. */
  const freeIcons = (provenance: string): string[] => {
    const used = new Set(
      Object.entries(load())
        .filter(([k]) => k !== provenance)
        .map(([, m]) => m.icon)
        .filter((i) => i !== ""),
    );
    return APP_MARK_ICONS.filter((g) => !used.has(g));
  };

  const save = (table: Record<string, SurfaceMark>): void => {
    try {
      localStorage.setItem(marksKey, JSON.stringify(table));
    } catch { /* nothing durable to write to */ }
  };

  return {
    load,
    mark(provenance) {
      const table = load();
      const existing = table[provenance];
      if (existing) return { mark: existing, isNew: false };
      // NO ICON IS ROLLED HERE. First sight creates the record and the
      // timestamp; the MARK is the user's to choose, in the ceremony.
      const mark: SurfaceMark = { icon: "", firstSeen: Date.now() };
      table[provenance] = mark;
      save(table);
      return { mark, isNew: true };
    },
    setPetname(provenance, petname, icon) {
      const table = load();
      const mark = table[provenance] ?? { icon: "", firstSeen: Date.now() };
      // The write-side gate, mirroring `load`'s read-side one: a glyph
      // that is not in the curated vocabulary is stored as UNMARKED
      // rather than persisted and rendered later.
      mark.icon = isAppMarkIcon(icon) ? icon : "";
      mark.petname = petname;
      table[provenance] = mark;
      save(table);
    },
    forget(provenance) {
      const table = load();
      delete table[provenance];
      save(table);
    },
    freeIcons,
    iconOffers(provenance, nomination) {
      const free = freeIcons(provenance);
      const mine = load()[provenance]?.icon ?? "";
      const offers: Array<{ glyph: string; nominated: boolean }> = [];
      const taken = new Set<string>();
      const push = (glyph: string, nominated: boolean) => {
        if (glyph === "" || taken.has(glyph)) return;
        taken.add(glyph);
        offers.push({ glyph, nominated });
      };
      // FIRST, and only if it survives BOTH tests: valid (the consumer
      // checked that at the seam) and unclaimed. A claimed nomination is
      // dropped in silence — telling the user "the app wanted a glyph
      // somebody else has" would be the visor relaying a component's
      // request in the visor's own voice, for no decision the user has
      // to make.
      if (nomination !== undefined && isAppMarkIcon(nomination) && free.includes(nomination)) {
        push(nomination, true);
      }
      // The mark this record already wears, so a rename cannot lose it.
      push(mine, false);
      // The rest: a fresh shuffle of the free set, per ceremony (see
      // `iconOffers` on the interface for why the order must not be
      // stable). Fisher-Yates over a copy — the pool is the caller's
      // array, and shuffling it in place would be a surprise.
      const pool = free.filter((g) => !taken.has(g));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const g of pool) {
        if (offers.length >= ICON_OFFERS) break;
        push(g, false);
      }
      return offers.slice(0, ICON_OFFERS);
    },
    collision(provenance, petname) {
      const want = petname.trim().toLowerCase();
      for (const [key, mark] of Object.entries(load())) {
        if (key === provenance) continue;
        const other = (mark.petname ?? "").trim();
        if (other !== "" && other.toLowerCase() === want) return { key, petname: other };
      }
      return null;
    },
  };
}

// --- the two sheets -----------------------------------------------------------

export interface VisorSheetsConfig {
  /** Where THIS consumer's trust table lives. The pet-icon vocabulary
   * and the assignment rule are the framework's; the key is the
   * consumer's, so two spikes on one origin do not share a table. */
  marksKey: string;
  /** Asked before either ceremony opens; false refuses the open outright.
   * This is where a consumer states a precedence its own tenants impose —
   * the demo refuses while its exclusive credential sheet holds the
   * drawer, so a click on the strip while secrets are on screen is a
   * no-op. The drawer host enforces the same rule a second time on
   * `open`; this one exists so the consumer's own preconditions
   * (`beforeOpen`) do not run for an open that is going to be refused. */
  canOpen?: () => boolean;
  /** Run just before either ceremony opens, once `canOpen` has agreed.
   * The demo takes the page back here: a modal <dialog> paints in the TOP
   * LAYER — above the pinned visor zone, and therefore above the sheet
   * the strip is about to reveal — so its panel is retired and the dialog
   * closed first. */
  beforeOpen?: () => void;
  /** A petname + pet icon were just committed for `provenance`. The
   * table is already written; this is for the consumer's IN-MEMORY
   * CACHES of the record (the strip renders from those, so a commit that
   * only touched storage would leave the anchor showing yesterday's
   * answer).
   *
   * `isNew` is deliberately not passed: FIRST SIGHT IS OVER — the naming
   * ceremony IS the TOFU moment completing, so every live copy of this
   * identity should clear its NEW badge. "First time this component draws
   * here" and the user's own name for it are contradictory claims to make
   * side by side. */
  onNamed?: (provenance: string, petname: string, icon: string) => void;
  /** The whole record for `provenance` was just deleted. The consumer's
   * caches must stop speaking a name the visor no longer holds. */
  onForgotten?: (provenance: string) => void;
  /** The identity record and the anchor hue were just COMMITTED from the
   * settings sheet (Save, never Cancel and never a live preview). The
   * visor has already stored and painted both; this is for a consumer
   * that must MIRROR the commit somewhere else — the demo writes it
   * through to the user-system partition, where the profile is the
   * source of truth and localStorage is the boot cache (PAIRING.md §5).
   *
   * It fires AFTER the write, so a consumer that fails cannot leave the
   * visor's own record half-committed; a mirror that fails is the
   * consumer's problem to announce. */
  onIdentityCommitted?: (rec: VisorIdentity, hue: number) => void;
  /** Consumer-supplied actions on the settings sheet.
   *
   * THE ONE EXTENSION POINT ON A VISOR-OWNED SHEET, and deliberately a
   * narrow one: a consumer contributes a LABEL and a callback, never a
   * node. The visor draws the button, in the visor's own chrome, so a
   * consumer cannot paint anything on a sheet whose whole claim is that
   * no one but the visor draws there — the same reason the identity
   * button's face is a fixed glyph set rather than free text.
   *
   * The demo uses exactly one: "add a device…", the entry to the pairing
   * ceremony (PAIRING.md §5's "strip menu → add a device"). TodoMVC
   * passes none, and an empty list renders NOTHING — no heading, no
   * container, no separator — so the sheet is byte-identical to what it
   * was before this hook existed. */
  extraActions?: SheetAction[];
}

/** One consumer-contributed action on the settings sheet (see
 * `VisorSheetsConfig.extraActions`). */
export interface SheetAction {
  /** The button's face. The visor renders it as its own words — a
   * consumer that puts a component's self-declared string here would be
   * lending the visor's voice, which is the consumer's error to avoid
   * (nothing on this path is component-influenced in either spike). */
  label: string;
  /** One line under the button, in the visor's explanatory voice. */
  hint?: string;
  /** Stable key for driving/tests (`data-action`). Defaults to `label`. */
  key?: string;
  onSelect(): void;
}

export interface VisorSheets {
  /** The trust table these sheets read and write — the same key, so a
   * consumer can render from it. */
  readonly marks: SurfaceMarks;
  /** Open the naming ceremony (the App settings sheet) for one surface.
   * Installed as the strip's `requestNaming` handler, so the ceremony is
   * reachable from visor pixels; exposed here for a consumer's own
   * driving hooks. */
  requestNaming(surface: SurfaceIdentity): void;
  /** Open the visor's own settings sheet. Installed as the strip's
   * `requestSettings` handler. */
  requestSettings(): void;
  closeNaming(opts?: { context?: boolean }): void;
  closeSettings(opts?: { context?: boolean; commit?: boolean }): void;
  namingOpen(): boolean;
  settingsOpen(): boolean;
}

/** Register the visor's naming and settings ceremonies on a visor.
 *
 * REGISTRATION ORDER IS PRECEDENCE ORDER (see `DrawerHost.tenant`), so
 * WHERE a consumer calls this matters: a consumer with an EXCLUSIVE
 * tenant of its own — the demo's credential sheet — must register that
 * one FIRST, so the sheet that may be holding secrets outranks both of
 * these. Both tenants registered here are LIGHTWEIGHT: they take the
 * reveal above the strip (the unforgeable part) but not the arming delay,
 * the runner suspension or the page dim, because nothing secret is typed
 * on either, both are opened from strip pixels an app can neither draw
 * nor reach, and the worst a mis-tap costs is a form the user closes.
 * Paying the arming tax where it buys nothing would train users to click
 * through a delay that means something elsewhere, which is the real cost.
 *
 * This also INSTALLS the strip's two handlers (`requestNaming`,
 * `requestSettings`), which is what makes the strip's petname and settings
 * button live. */
export function registerVisorSheets(visor: Visor, config: VisorSheetsConfig): VisorSheets {
  const marks = createSurfaceMarks(config.marksKey);

  /** THE NAMING SESSION. The session's `surface` is REASSIGNED after a
   * Save (the sheet may outlive the click, and a re-open is built from
   * this object), so the host holds the object rather than a copy. */
  const namingTenant = visor.drawer.tenant<{ surface: SurfaceIdentity; icon: string }>({
    name: "naming",
    context: (s) => ({ ...s.surface, kind: "naming" }),
  });

  /** THE SETTINGS SESSION. `hueAtOpen` is the colour the anchor had when
   * the sheet opened: the swatch row previews LIVE, so Cancel (and
   * eviction) must be able to put the anchor back exactly as it was.
   * `commit` — passed by Save and by nothing else — is what distinguishes
   * them. An uncommitted preview must not survive the sheet: a credential
   * sheet that evicts this one is painted in the anchor colour, and it
   * must be painted in the REAL one. */
  const settingsTenant = visor.drawer.tenant<{ hueAtOpen: number }>({
    name: "settings",
    context: () => ({ kind: "settings" }),
    beforeCollapse: (s, opts) => {
      if (!opts.commit) visor.applyHue(s.hueAtOpen);
    },
  });

  const closeNaming = (opts: { context?: boolean } = {}) => namingTenant.close(opts);
  const closeSettings = (opts: { context?: boolean; commit?: boolean } = {}) =>
    settingsTenant.close(opts);

  /** Build the visor's App settings sheet — the naming ceremony GROWN into
   * the one place the visor says everything it knows about a component.
   * EVERY pixel here is the visor's. The only component-influenced strings
   * are the nickname, the provenance key and (for a panel) its declared
   * destination — all quoted, clamped and foreign-styled.
   *
   * It is the SAME tenant and the same session variable as the old
   * naming sheet: evolved, not added to. A fourth drawer tenant would
   * have meant a fourth entry in every occupancy test (see
   * the host's occupancy test), for a sheet that is about exactly what naming was
   * about — this component, and what the user wants to call it. */
  const buildNameSheet = (surface: SurfaceIdentity, icon: string) => {
    const root = document.createElement("div");
    root.className = "cred-sheet name-sheet armed";
    root.style.maxWidth = "72rem";
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "App settings";

    // THE IDENTITY BLOCK — the two voices that are not the user's: what
    // the component says about itself, and what the visor fetched it as.
    const says = document.createElement("div");
    says.className = "cred-line";
    const saysLead = document.createElement("span");
    saysLead.className = "said";
    saysLead.textContent = "calls itself";
    // The record's pet icon, when it has one — same rule as the strip:
    // no mark, no glyph, no placeholder.
    const currentIcon = markIcon(icon);
    if (currentIcon) says.append(currentIcon);
    says.append(saysLead, nicknameQuote(surface.nickname));

    const from = document.createElement("div");
    from.className = "cred-line";
    const fromLead = document.createElement("span");
    fromLead.className = "said";
    fromLead.textContent = "the visor fetched it as";
    const key = document.createElement("q");
    key.className = "foreign";
    key.textContent = surface.name.slice(0, 60);
    from.append(fromLead, key);

    // FIRST SIGHT, from the trust record itself: the date the mark was
    // assigned. This is the visor's own memory of the component, and the
    // only thing on the sheet that answers "have I really seen this
    // before?" with something other than a colour.
    const seen = document.createElement("div");
    seen.className = "cred-line";
    if (surface.firstSeen !== undefined) {
      const seenLead = document.createElement("span");
      seenLead.className = "said";
      seenLead.textContent = "first seen";
      const when = document.createElement("span");
      when.textContent = new Date(surface.firstSeen).toLocaleDateString();
      seen.append(seenLead, when);
    }

    // THE METADATA BLOCK — visor-known facts about this surface, when
    // there are any: a panel's declared destination, or the regions
    // the visor drew the app into. A component-influenced value is
    // foreign-quoted like every other thing a component said.
    const meta = document.createElement("div");
    meta.className = "cred-line";
    if (surface.meta) {
      const metaLead = document.createElement("span");
      metaLead.className = "said";
      // THE VISOR'S word, always — `label` is never component-supplied.
      metaLead.textContent = surface.meta.label;
      if (surface.meta.foreign) {
        const q = document.createElement("q");
        q.className = "foreign";
        q.textContent = surface.meta.value.slice(0, 120);
        meta.append(metaLead, q);
      } else {
        const value = document.createElement("span");
        value.textContent = surface.meta.value.slice(0, 120);
        meta.append(metaLead, value);
      }
    }

    const field = document.createElement("div");

    field.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = "Your name for it";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 40;
    // NEVER PREFILLED FROM THE NICKNAME. A prefilled self-declared name
    // would let attacker-chosen words walk into the visor's voice by
    // accept-the-default — the user would "assign" a petname they never
    // wrote, and the visor would then speak it unquoted, which is exactly
    // the authority the whole three-name split exists to withhold. An
    // EXISTING petname is prefilled, because that one the user typed.
    input.value = surface.petname ?? "";
    input.placeholder = "a word you will recognise";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "the visor will use this name in its own voice; what the component calls itself stays quoted";
    field.append(label, input, hint);

    // THE PET ICON PICKER (was the recognition-colour swatch row).
    //
    // Six offers, every one of them a glyph no other trust record wears
    // (local uniqueness — see `iconOffers`), in a fresh random order per
    // ceremony. The record's CURRENT mark is always among them and comes
    // preselected, so opening this sheet to fix a typo in a petname can
    // never cost a component its mark by accident.
    //
    // A record with NO mark starts with nothing selected, and Save is
    // perfectly happy with that: "" is a real state, and a user who does
    // not want to think about glyphs today gets a petname and no mark
    // rather than a mark the visor picked for them. THIS IS ALSO THE
    // RE-OFFER PATH for a mark the account's conflict repair cleared:
    // the engine resolves an icon collision by clearing the LOSER's icon
    // and setting needs-reconfirm, and it does not choose a replacement
    // — it cannot, because the vocabulary and the curation rules are the
    // VISOR's, not the partition's. So the repaired record arrives here
    // unmarked and the ceremony simply offers six free glyphs again.
    const iconLabel = document.createElement("div");
    iconLabel.className = "cred-line said";
    iconLabel.textContent = "a mark you will recognise";
    const offers = marks.iconOffers(surface.name, surface.nomination);

    // THE FOREIGN ATTRIBUTION. A component may ask to wear a particular
    // glyph, and when the ask survives validation and is unclaimed it is
    // offered FIRST — but it is never offered in the visor's own voice.
    // The visor says the sentence; the component's glyph is quoted, the
    // same way its nickname is, and the button carries `.nominated` so
    // it is visually not one of the visor's own offers. Adoption is the
    // USER's act, and the component is never told the outcome.
    const nominationLine = document.createElement("div");
    nominationLine.className = "cred-line name-nomination";
    const nominated = offers.find((o) => o.nominated);
    if (nominated) {
      const asksLead = document.createElement("span");
      asksLead.className = "said";
      asksLead.textContent = "it asks to wear";
      const asksTail = document.createElement("span");
      asksTail.className = "said";
      asksTail.textContent = "— offered first below; the rest are the visor's own";
      const q = document.createElement("q");
      q.className = "foreign";
      q.textContent = nominated.glyph;
      nominationLine.append(asksLead, q, asksTail);
    }

    const iconRow = document.createElement("div");
    iconRow.className = "name-icons";
    let picked = isAppMarkIcon(icon) ? icon : "";
    const buttons: HTMLButtonElement[] = [];
    for (const offer of offers) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = offer.glyph;
      b.dataset.glyph = offer.glyph;
      if (offer.nominated) b.dataset.nominated = "true";
      // THE VISOR'S OWN WORDS on both, and no component string in
      // either: the nominated one is described, never quoted, here.
      b.title = offer.nominated ? "the component asked for this one" : "use this mark";
      b.classList.toggle("nominated", offer.nominated);
      b.classList.toggle("picked", offer.glyph === picked);
      b.onclick = () => {
        picked = offer.glyph;
        for (const other of buttons) other.classList.toggle("picked", other === b);
      };
      buttons.push(b);
      iconRow.append(b);
    }

    const reason = document.createElement("div");
    reason.className = "cred-reason";

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and the name you choose is never given back to it";

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    // Forgetting is offered only when there is something to forget.
    let forgetBtn: HTMLButtonElement | null = null;
    const forgetRow = document.createElement("div");
    forgetRow.className = "name-forget";
    if ((surface.petname ?? "").trim() !== "") {
      forgetBtn = document.createElement("button");
      forgetBtn.type = "button";
      forgetBtn.className = "forget";
      forgetBtn.textContent = "forget this component";
      const forgetNote = document.createElement("span");
      forgetNote.className = "hint";
      forgetNote.textContent = "drops the name AND the mark — next time it is NEW again";
      forgetRow.append(forgetBtn, forgetNote);
    }

    root.append(h, says, from);
    if (surface.firstSeen !== undefined) root.append(seen);
    if (surface.meta) root.append(meta);
    root.append(field, iconLabel);
    if (nominated) root.append(nominationLine);
    root.append(iconRow, note, reason, row);

    if (forgetBtn) root.append(forgetRow);
    return { root, input, saveBtn, cancelBtn, forgetBtn, reason, icon: () => picked };
  };

  const openNamingDrawer = (surface: SurfaceIdentity) => {
    // MUTUAL EXCLUSION is the host's: it refuses this open outright while
    // an exclusive tenant holds the drawer (a sheet that is collecting —
    // or about to accept — secrets is never displaced by a naming
    // ceremony), and it evicts the settings sheet and any previous naming
    // sheet, in that order, WITHOUT touching the strip context, which
    // this sheet is about to claim. The two LIGHTWEIGHT tenants evict
    // each other freely — neither holds anything a user would lose by a
    // click on the strip.
    const session = { surface, icon: surface.icon };
    namingTenant.open(session, () => {
      const built = buildNameSheet(surface, surface.icon);

      const finish = (status: string) => {
        closeNaming();
        // The visor's own line in the visor's own bar — not a consumer's
        // status line: this is a statement about the shell's trust table,
        // not about anybody's replica. It expires by RE-RENDERING the
        // strip (see `announce`), which matters exactly here: the thing
        // the bottom line shows has just changed — a petname was
        // assigned, or a whole record was forgotten — so restoring what
        // the line said before would put a stale claim back on the
        // anchor.
        if (status) visor.announce(status);
      };

      built.saveBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        const petname = built.input.value.trim();
        if (petname === "") {
          // Refused rather than treated as "forget": clearing the field is
          // an ambiguous gesture, and Cancel is the unambiguous way out.
          built.reason.textContent = "type a name, or Cancel to leave it unnamed";
          return;
        }
        const clash = marks.collision(surface.name, petname);
        if (clash) {
          // The visor's own words, naming the colliding record by BOTH its
          // petname and its unforgeable provenance key — the user needs to
          // know which component already answers to this word.
          built.reason.textContent =
            `you already call another component "${clash.petname}" (fetched as ${clash.key}) — pick a different name`;
          return;
        }
        marks.setPetname(surface.name, petname, built.icon());
        // The consumer's in-memory surfaces are a CACHE of the record; the
        // strip renders from them, so a commit that only touched storage
        // would leave the anchor showing yesterday's answer.
        //
        // FIRST SIGHT IS OVER: the naming ceremony IS the TOFU moment
        // completing, so the NEW badge is cleared on every live copy of
        // this identity. "First time this component draws here —
        // recognition means nothing yet" and the user's own name for it
        // are contradictory claims to make side by side; once the user has
        // decided what to call it, they have done the recognising the
        // badge was asking for. (Forgetting is untouched: it deletes the
        // record, so the next mount is honestly NEW again.)
        config.onNamed?.(surface.name, petname, built.icon());
        // The session's own surface object: the sheet may outlive this
        // click (Save leaves it up only briefly, but the object is also
        // what a re-open would be built from).
        session.surface = { ...session.surface, petname, icon: built.icon(), isNew: false };
        finish(`saved — the visor will call this component ${petname} from now on`);
      };
      built.cancelBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        finish("");
      };
      if (built.forgetBtn) {
        built.forgetBtn.onclick = () => {
          if (!namingTenant.owns(session)) return;
          marks.forget(surface.name);
          // Forgetting must be honest on the strip too: the cached petname
          // goes with the record, so the anchor stops speaking a name
          // the visor no longer holds. (`isNew` stays as it is — this session
          // has seen the component; the NEXT mount is the one that is
          // genuinely new again, and the sheet says so.)
          config.onForgotten?.(surface.name);
          finish("forgotten — this component will be announced as NEW next time");
        };
      }

      // The height budget (the anchor must never be pushed off-screen by a
      // sheet that hangs off it) and the reveal are the host's.
      return {
        root: built.root,
        // No arming delay (see the naming tenant's spec): focus is given
        // immediately, because there is nothing here a mis-tap could spend.
        onShown: () => built.input.focus(),
      };
    });
  };

  /** The visor's settings sheet. EVERY string on it is the visor's own or the
   * user's own — there is no component in this interaction at all, which
   * makes it the only sheet with no foreign-quoted text anywhere. */
  const buildSettingsSheet = (rec: VisorIdentity, hueAtOpen: number) => {
    const root = document.createElement("div");
    // `.armed` from the start: there is no arming delay here (see the
    // settings tenant's spec), so the button row must never be drawn dimmed for
    // a wait that does not exist.
    root.className = "cred-sheet settings-sheet armed";
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Your visor";

    const lead = document.createElement("div");
    lead.className = "cred-line said";
    lead.textContent =
      "these are yours: the visor says them in its own voice, and no component is ever told them";

    // Both text fields are PREFILLED with the current value. That is the
    // same exception the naming sheet makes for an existing petname: the
    // prefill is the user's OWN prior word, not a self-declared name
    // walking into the visor's voice by accept-the-default.
    const mkField = (labelText: string, hint: string, value: string, id: string) => {
      const field = document.createElement("div");
      field.className = "cred-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      label.htmlFor = id;
      const input = document.createElement("input");
      input.id = id;
      input.type = "text";
      input.autocomplete = "off";
      input.maxLength = IDENTITY_MAX;
      input.value = value;
      const hintEl = document.createElement("div");
      hintEl.className = "hint";
      hintEl.textContent = hint;
      field.append(label, input, hintEl);
      return { field, input };
    };

    const nameField = mkField(
      "Your name",
      "shown at the right of this bar — leave it empty and the visor shows nothing there",
      rec.name ?? "",
      "visor-settings-name",
    );
    const deviceField = mkField(
      "This device",
      "your word for the machine you are on — e.g. laptop, study PC",
      rec.device ?? "",
      "visor-settings-device",
    );

    // The icon row: the visor's fixed vocabulary, nothing else (see
    // VISOR_ICONS — a free-text face could spoof words in the visor's
    // voice at the one position that cannot be spoofed).
    const iconLabel = document.createElement("div");
    iconLabel.className = "cred-line said";
    iconLabel.textContent = "the visor's mark on this bar";
    const iconRow = document.createElement("div");
    iconRow.className = "settings-icons";
    let pickedIcon = identityIcon(rec);
    const iconButtons: HTMLButtonElement[] = [];
    for (const glyph of VISOR_ICONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = glyph;
      b.dataset.glyph = glyph;
      b.title = `use ${glyph}`;
      b.classList.toggle("picked", glyph === pickedIcon);
      b.onclick = () => {
        pickedIcon = glyph;
        for (const other of iconButtons) other.classList.toggle("picked", other === b);
      };
      iconButtons.push(b);
      iconRow.append(b);
    }

    // The colour row, moved here whole from the old strip picker.
    // Constrained customisation: same lightness and chroma for every
    // choice, so contrast can never be customised away.
    const hueLabel = document.createElement("div");
    hueLabel.className = "cred-line said";
    hueLabel.textContent = "this bar's colour — yours, and never disclosed to an app";
    const hueRow = document.createElement("div");
    hueRow.className = "settings-hues";
    let pickedHue = hueAtOpen;
    const hueButtons: HTMLButtonElement[] = [];
    for (const hue of VISOR_HUES) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = `oklch(38% .07 ${hue})`;
      b.dataset.hue = String(hue);
      b.title = `hue ${hue}`;
      b.classList.toggle("picked", hue === hueAtOpen);
      b.onclick = () => {
        pickedHue = hue;
        for (const other of hueButtons) other.classList.toggle("picked", other === b);
        // LIVE PREVIEW: the strip and this sheet repaint immediately, so
        // the user judges the anchor colour on the anchor rather than on
        // a swatch. Nothing is ANNOUNCED for this: the announced-reset
        // rule exists for changes the user did NOT make (a lost or
        // evicted record), and telling someone about the change they are
        // in the middle of making would devalue the announcement that
        // matters. Save commits it; Cancel puts it back.
        visor.applyHue(hue);
      };
      hueButtons.push(b);
      hueRow.append(b);
    }

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and none of this is ever given to one";

    // CONSUMER ACTIONS (see `extraActions`). Nothing is rendered at all
    // when there are none, so a consumer that passes no actions gets the
    // sheet exactly as it was before this hook existed.
    const actions = config.extraActions ?? [];
    const actionsBlock = document.createElement("div");
    // NOT `cred-row`: that class is the Save/Cancel pair, and both this
    // sheet's own driving hooks and the demo's select it positionally
    // (`.cred-row button:first-child`). A second `.cred-row` earlier in
    // the sheet would silently steal those clicks.
    actionsBlock.className = "settings-extra";
    for (const action of actions) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-extra-action";
      b.dataset.action = action.key ?? action.label;
      b.textContent = action.label;
      // The action LEAVES this sheet: closing first means the drawer is
      // free for whatever the action opens, and that the settings
      // session cannot be left owning a sheet nobody is looking at. The
      // close is a plain one (no `commit`), so an uncommitted colour
      // preview reverts exactly as Cancel would.
      b.onclick = () => {
        closeSettings();
        action.onSelect();
      };
      line.append(b);
      if (action.hint !== undefined) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = action.hint;
        line.append(hint);
      }
      actionsBlock.append(line);
    }

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    root.append(
      h,
      lead,
      nameField.field,
      deviceField.field,
      iconLabel,
      iconRow,
      hueLabel,
      hueRow,
      note,
    );
    if (actions.length > 0) root.append(actionsBlock);
    root.append(row);
    return {
      root,
      nameInput: nameField.input,
      deviceInput: deviceField.input,
      saveBtn,
      cancelBtn,
      icon: () => pickedIcon,
      hue: () => pickedHue,
    };
  };

  const openSettingsDrawer = () => {
    // Precedence and eviction are the host's (see openNamingDrawer): an
    // exclusive tenant refuses this open outright, and the naming sheet
    // is evicted context-free.
    //
    // The committed colour: the anchor to revert to if this sheet does
    // not end in Save. Read from the visor's committed value rather than
    // re-reading storage, so a live preview from an earlier (evicted)
    // sheet can never be mistaken for the user's committed choice.
    const hueAtOpen = visor.committedHue();
    const session = { hueAtOpen };
    settingsTenant.open(session, () => {
      const built = buildSettingsSheet(visor.identity(), hueAtOpen);

      built.saveBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        visor.saveIdentity({
          name: built.nameInput.value,
          device: built.deviceInput.value,
          icon: built.icon(),
        });
        // Remember, paint, persist — in that order.
        visor.commitHue(built.hue());
        // Mirror the commit outward (see `onIdentityCommitted`): the
        // visor's own record is already written, so a consumer's mirror
        // can only ever be late, never contradictory.
        config.onIdentityCommitted?.(visor.identity(), built.hue());
        // The strip is repainted from the RECORD, not from the inputs, so
        // what the bar shows is exactly what was persisted (clamping and
        // the unset-is-absent rule included).
        visor.renderIdentity();
        closeSettings({ commit: true });
      };
      built.cancelBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        // commit:false — the live colour preview is reverted (by the
        // tenant's own beforeCollapse) and the typed edits are simply
        // dropped with the sheet.
        closeSettings();
      };

      return {
        root: built.root,
        // No arming delay (see the settings tenant's spec): focus goes
        // straight to the first field, because there is nothing here a
        // mis-tap could spend.
        onShown: () => built.nameInput.focus(),
      };
    });
  };

  // The visor's naming ceremony, reachable ONLY from the strip's own
  // pixels — and the consumer's preconditions, in that order: the refusal
  // first (so a click while an exclusive sheet is up is a pure no-op),
  // then whatever the consumer must do to get the page back.
  const requestNaming = (surface: SurfaceIdentity) => {
    if (config.canOpen && !config.canOpen()) return;
    config.beforeOpen?.();
    openNamingDrawer(surface);
  };

  // The visor's settings sheet, reachable ONLY from the strip's own
  // button (rendered by the visor's identity cluster — visor pixels,
  // unreachable from any app rectangle). Same precedence as naming,
  // enforced twice: here, and again by the drawer host on `open`.
  const requestSettings = () => {
    if (config.canOpen && !config.canOpen()) return;
    config.beforeOpen?.();
    openSettingsDrawer();
  };

  // THE STRIP'S LATE-BOUND CONTROLS. The strip is built by `initVisor`,
  // long before the drawer's tenants exist, so the "name it" affordance,
  // the context cluster and the settings button call through the visor's
  // handler slots.
  visor.install({ requestNaming, requestSettings });

  return {
    marks,
    requestNaming,
    requestSettings,
    closeNaming,
    closeSettings,
    namingOpen: () => namingTenant.isOpen(),
    settingsOpen: () => settingsTenant.isOpen(),
  };
}
