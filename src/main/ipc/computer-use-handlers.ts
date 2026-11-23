import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ComputerUseChromeProfileStore } from "../computer-use-chrome-profile-store";
import type { ComputerUsePermissionHelpWindowController } from "../computer-use-permission-help-window";
import type { CuaDriverRuntime } from "../cua-driver-runtime";
import { MAC_PERMISSION_URLS } from "../mac-permission-urls";
import { parseComputerUseChromeProfileChange, parseMacPermission } from "./app-inputs";
import { eventHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

const logger = createOpenBotLogger("computer-use");

export interface ComputerUseIpcDependencies {
  cuaDriver: Pick<CuaDriverRuntime, "state" | "running" | "existingChromeProfileGranted">;
  chromeProfile: ComputerUseChromeProfileStore;
  openExternal: (url: string) => Promise<void>;
  permissionHelp: Pick<
    ComputerUsePermissionHelpWindowController,
    "show" | "close" | "permissionApp" | "startDrag" | "reveal"
  >;
}

export function computerUseIpcHandlers({
  cuaDriver,
  chromeProfile,
  openExternal,
  permissionHelp,
}: ComputerUseIpcDependencies): Pick<IpcGroupHandlers, "computerUse"> {
  const state = () => runCauseEffect(cuaDriver.state());
  const chromeProfileAnswer = () => {
    const enabled = chromeProfile.get().existingProfile;
    return {
      enabled,
      restartNeeded: cuaDriver.running() && cuaDriver.existingChromeProfileGranted() !== enabled,
    };
  };
  return {
    computerUse: {
      getState: handler(state),
      openPermissionPane: payloadHandler(parseMacPermission, async (permission) => {
        await openExternal(MAC_PERMISSION_URLS[permission]);
        await runCauseEffect(permissionHelp.show(permission)).catch((cause) => {
          logger.warn("The Computer Use permission steps could not be shown.", { cause: toLogValue(cause) });
        });
        return state();
      }),
      closePermissionHelp: handler(async () => {
        permissionHelp.close();
      }),
      getPermissionApp: eventHandler((event) => runCauseEffect(permissionHelp.permissionApp(event.sender.id))),
      startPermissionAppDrag: eventHandler((event) => runCauseEffect(permissionHelp.startDrag(event.sender))),
      revealPermissionApp: eventHandler(async (event) => {
        permissionHelp.reveal(event.sender.id);
      }),
      getChromeProfile: handler(async () => chromeProfileAnswer()),
      setChromeProfile: payloadHandler(parseComputerUseChromeProfileChange, async ({ enabled }) => {
        await runCauseEffect(chromeProfile.set({ existingProfile: enabled }));
        return chromeProfileAnswer();
      }),
    },
  };
}
