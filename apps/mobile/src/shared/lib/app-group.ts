import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";

const APP_GROUP: string =
  typeof Constants.expoConfig?.extra?.forkAppGroup === "string"
    ? Constants.expoConfig.extra.forkAppGroup
    : "group.run.openbot.mobile";

export function appGroupFile(name: string): File | null {
  const container = Paths.appleSharedContainers[APP_GROUP];
  return container ? new File(container, name) : null;
}

export function appGroupDirectory(name: string): Directory | null {
  const container = Paths.appleSharedContainers[APP_GROUP];
  return container ? new Directory(container, name) : null;
}

export function lockAppGroupFile(name: string): boolean {
  const file = appGroupFile(name);
  if (!file?.exists) return false;
  const value = JSON.parse(file.textSync());
  if (!isDynamicRecord(value) || value.locked === true) return false;
  file.writeSync(JSON.stringify({ ...value, locked: true }));
  return true;
}
