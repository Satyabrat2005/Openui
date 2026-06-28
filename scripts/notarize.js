// afterSign hook called by electron-builder after the app bundle is signed.
// Submits the signed .app to Apple's notary service so Gatekeeper accepts it.
// Skips silently when the required env vars are absent (local/unsigned builds).
const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      'notarize: skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`notarize: submitting ${appPath} to Apple notary service…`);
  await notarize({
    appBundleId: 'com.openui.app',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('notarize: done');
};
