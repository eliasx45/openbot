// Fork (docs/fork/FEATURES.md entry 19): Elias's own iPhone build, next to the App Store OpenBot.
// Upstream's ids (`run.openbot.mobile`, its App Group, `applinks:openbot.run`, its Expo project) belong
// to Nightly Labs' Apple team and Expo account, so a build under Elias's team needs its own. This file
// rewrites them; `app.json` stays upstream's, so merges stay simple.
//
// `fork-ios.json` names Elias's Expo account and project (`eas init` prints the id). Without it the
// build keeps upstream's owner and project, and over-the-air updates are off, so the fork never
// downloads upstream's JavaScript.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const BUNDLE_ID = "com.eliasx45.openbot";
const APP_GROUP = "group.com.eliasx45.openbot";
const APPLE_TEAM_ID = "GQQBT37P3D";
const UPSTREAM_BUNDLE_ID = "run.openbot.mobile";
const UPSTREAM_APP_GROUP = "group.run.openbot.mobile";

function readProject() {
  const file = join(__dirname, "fork-ios.json");
  if (!existsSync(file)) return null;
  const { owner, projectId } = JSON.parse(readFileSync(file, "utf8"));
  return typeof owner === "string" && typeof projectId === "string" ? { owner, projectId } : null;
}

/** Each upstream id in a plugin's options, as the fork's id. */
function forkPluginOptions(value) {
  if (typeof value === "string") {
    if (value === UPSTREAM_APP_GROUP) return APP_GROUP;
    if (value === UPSTREAM_BUNDLE_ID || value.startsWith(`${UPSTREAM_BUNDLE_ID}.`))
      return BUNDLE_ID + value.slice(UPSTREAM_BUNDLE_ID.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(forkPluginOptions);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forkPluginOptions(item)]));
  return value;
}

/** @param {import('expo/config').ExpoConfig} config */
function forkIos(config) {
  const project = readProject();
  const { associatedDomains: _upstreamLinks, ...ios } = config.ios ?? {};
  return {
    ...config,
    name: "OpenBot Fork",
    ios: { ...ios, bundleIdentifier: BUNDLE_ID, appleTeamId: APPLE_TEAM_ID },
    plugins: (config.plugins ?? []).map(forkPluginOptions),
    extra: {
      ...config.extra,
      forkAppGroup: APP_GROUP,
      eas: project ? { ...config.extra?.eas, projectId: project.projectId } : config.extra?.eas,
    },
    owner: project ? project.owner : config.owner,
    updates: project
      ? { ...config.updates, url: `https://u.expo.dev/${project.projectId}` }
      : { ...config.updates, enabled: false },
  };
}

module.exports = { forkIos, APP_GROUP };
