// Minimal Playwright config for the pairing-visor gate (Track B).
// Assumes the pairing demo is already served (see justfile's
// `pairing-serve`, or PAIRING_DEMO_URL for a custom port).
export default {
  testDir: ".",
  timeout: 15_000,
  use: { headless: true },
};
