import Constants from "expo-constants";

/**
 * The App Group of the app and its extensions. Fork: the fork's own build has its own group
 * (`fork-ios.js` puts it in `extra.forkAppGroup`); upstream's group stays the fallback.
 */
export const APP_GROUP: string =
  typeof Constants.expoConfig?.extra?.forkAppGroup === "string"
    ? Constants.expoConfig.extra.forkAppGroup
    : "group.run.openbot.mobile";
