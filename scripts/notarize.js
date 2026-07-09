// afterSign hook — electron-builder calls this after it packages the .app.
//
// Two paths, chosen by whether real Apple credentials are present:
//
//   • Apple creds set (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
//     → submit the Developer-ID-signed app to Apple's notary service so
//       Gatekeeper accepts it with no warning (the GA path).
//
//   • Apple creds absent (the current BETA path)
//     → ad-hoc sign the bundle ourselves. Apple Silicon refuses to launch an
//       unsigned/invalidly-signed app at all, and electron-builder invalidates
//       Electron's shipped ad-hoc signature when it injects our app into the
//       bundle. Re-applying an ad-hoc signature (`codesign -s -`) guarantees the
//       .app launches after the user clears quarantine (right-click → Open, or
//       `xattr -dr com.apple.quarantine`). See docs/INSTALL-MACOS-BETA.md.
//       This is idempotent and safe; it does NOT make the app notarized.
const { notarize } = require('@electron/notarize');
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  // ── Beta path: no Apple account → ad-hoc sign so the app is runnable ────────
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      'notarize: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set ' +
        '— ad-hoc signing for beta (app will require right-click → Open on first launch).'
    );
    try {
      // --force replaces the (now-invalid) signature; -s - is the ad-hoc identity.
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
        stdio: 'inherit',
      });
      console.log(`notarize: ad-hoc signed ${appPath}`);
    } catch (err) {
      console.error('notarize: ad-hoc codesign failed:', err.message);
      throw err;
    }
    return;
  }

  // ── GA path: real credentials → notarize with Apple ─────────────────────────
  console.log(`notarize: submitting ${appPath} to Apple notary service…`);
  await notarize({
    appBundleId: 'com.openui.app',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('notarize: done');

  // ── Staple + verify ──────────────────────────────────────────────────────
  // Notarizing alone isn't enough for a fully offline Gatekeeper check — the
  // ticket must be stapled to the bundle so the first launch works without
  // phoning home to Apple. Both steps are warn-not-fail: a failure here means
  // the app is still correctly notarized (Apple's servers have the ticket),
  // just not staple/locally-verified — it should not block the release build.
  try {
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    console.log(`notarize: stapled ticket to ${appPath}`);
  } catch (err) {
    console.warn('notarize: stapling failed (non-fatal):', err.message);
  }

  try {
    execFileSync('spctl', ['--assess', '--type', 'execute', '-vv', appPath], {
      stdio: 'inherit',
    });
    console.log('notarize: spctl verification passed — Gatekeeper accepts this build.');
  } catch (err) {
    console.warn('notarize: spctl verification failed (non-fatal):', err.message);
  }
};
