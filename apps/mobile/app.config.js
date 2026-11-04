const { existsSync } = require("node:fs");
const { join } = require("node:path");
// Fork: Elias's own iPhone ids and Expo project (fork-ios.js).
const { forkIos } = require("./fork-ios");

// Android notifications come through Firebase Cloud Messaging, which needs the Firebase file of the
// app. The file is optional, so the app builds before the Firebase project exists, and such a build
// gets no notifications on Android. The file has public identifiers only; the account service has the
// key that sends.
const GOOGLE_SERVICES_FILE = "./google-services.json";

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config }) =>
  forkIos(
    existsSync(join(__dirname, GOOGLE_SERVICES_FILE))
      ? { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } }
      : config,
  );
