// Playwright gate for Track B (PAIRING.md §6): drives the join+add
// panes side by side against the mock driver (host/pairing-mock.ts)
// driving the visor's pairing UI (visor/ui/pairing.ts), real headless
// Chromium.
//
// Run (from spikes/demo): `just pairing-site` first, then serve
// serve/ on some port and point PAIRING_DEMO_URL at it, e.g.:
//   deno run --allow-net --allow-read jsr:@std/http/file-server serve --port 8611 &
//   PAIRING_DEMO_URL=http://127.0.0.1:8611/pairing-demo.html \
//     npx playwright test spikes/demo/tests/pairing.spec.mjs
//
// Uses Playwright directly (real Chromium) per the "browser
// verification: Playwright first" house rule — this is a development/
// regression gate, not a final pre-push look.
import { test, expect } from "@playwright/test";

const URL = process.env.PAIRING_DEMO_URL ?? "http://127.0.0.1:8611/pairing-demo.html";

test("join + add panes: SAS equality, arming delay, announcements, hue adoption", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(URL);

  // Start both flows.
  await page.click("#add-pane button"); // "add a device"
  await page.click("#join-pane button"); // "join existing account"

  // The join pane renders the code (grouped by 4) — grab it and strip
  // the grouping before pasting into the add pane's field.
  await expect(page.locator("#join-pane .pm-code")).toBeVisible();
  const joinCode = (await page.textContent("#join-pane .pm-code")) ?? "";
  expect(joinCode.trim()).not.toBe("");
  // 79 chars, grouped in 4s with a separating space between groups.
  const stripped = joinCode.replace(/\s+/g, "");
  expect(stripped.length).toBe(79);

  await page.fill("#add-pane textarea", stripped);
  await page.click("#add-pane button:has-text('connect')");

  // --- SAS equality across panes -------------------------------------
  await expect(page.locator("#add-pane .pm-sas")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#join-pane .pm-sas")).toBeVisible({ timeout: 5000 });
  const addSas = await page.textContent("#add-pane .pm-sas");
  const joinSas = await page.textContent("#join-pane .pm-sas");
  expect(addSas).toBe(joinSas);
  // PAIRING.md §2: u32BE mod 10^6, zero-padded to 6 digits — exactly 6
  // digits, always (unlike an un-modded low-20-bits reading, which
  // overflows to 7 digits ~4.6% of the time).
  expect(addSas).toMatch(/^\d{6}$/);

  await page.click("#add-pane button:has-text('codes match')");

  // --- statement of consequence + arming delay ------------------------
  await expect(page.locator("#add-pane .pm-consequence")).toContainText(
    "full access to everything in your account",
  );
  const armedBtn = page.locator("#add-pane button.pm-armed");
  await expect(armedBtn).toBeDisabled();

  // Forced early click must NOT advance the flow — the click handler
  // refuses even if `disabled` were bypassed (defence in depth), and
  // the natural click is blocked by Playwright's actionability check
  // (a disabled button refuses pointer events), so try both.
  await armedBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(50);
  await expect(page.locator("#add-status")).toHaveText("connecting…"); // unchanged — no premature grant

  // Device-name field must start EMPTY — never prefilled.
  const nameInput = page.locator("#add-pane input[type=text]");
  await expect(nameInput).toHaveValue("");

  // Wait past the arming delay, then the confirm must actually work.
  await expect(armedBtn).toBeEnabled({ timeout: 3000 });
  await nameInput.fill("tablet");
  await armedBtn.click();

  await page.click("#join-pane button:has-text('I initiated')");

  // --- announcements + hue adoption -----------------------------------
  await expect(page.locator("#join-status")).toContainText(
    "this device now follows your profile",
    { timeout: 5000 },
  );
  await expect(page.locator("#add-status")).toContainText("device added", { timeout: 5000 });

  const joinBg = await page.$eval("#join-pane", (el) => getComputedStyle(el).backgroundColor || getComputedStyle(el).background);
  // Alice's profile carries hue INDEX 0 (PAIRING.md §4: hues are
  // palette indices, not raw angles); visor/ui/pairing.ts's
  // `paletteAngle` maps index 0 to 265° (the visor's own VISOR_HUES[0],
  // visor/ui/visor.ts) — assert the MAPPED angle landed, not the raw index.
  expect(joinBg).toMatch(/265/);

  expect(consoleErrors).toEqual([]);
});
