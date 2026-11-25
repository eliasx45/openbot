import {
  CHANNEL_WEBHOOK_ROUTES,
  parseChannelWebhookChange,
  parseChannelWebhookRead,
} from "@openbot/contracts/fork-channel-webhooks";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelService } from "../../backend/channel-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ChannelWebhookService } from "../fork-channel-webhooks";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";
import { requireChannelAdmin, requireVisibleChannel } from "./route-channels";

export async function routeChannelWebhook(
  context: TeamApiRequestContext,
  channels: Pick<ChannelService, "store"> | undefined,
  webhooks: Pick<ChannelWebhookService, "settings" | "set"> | null,
): Promise<RouteOutcome> {
  const { method, url, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== CHANNEL_WEBHOOK_ROUTES.read && url.pathname !== CHANNEL_WEBHOOK_ROUTES.set)
  )
    return "unmatched";
  if (!channels || !webhooks) throw new HttpError(400, sourceText("error.team.channelsUnsupported"));
  const body = await readJson(request);
  let channelId: string;
  try {
    channelId = parseChannelWebhookRead(body).channelId;
  } catch {
    throw new HttpError(400, "Invalid channel webhook request.");
  }
  if (!channels.store.exists(channelId)) throw new HttpError(404, sourceText("error.backend.channelNotFound"));
  requireVisibleChannel(context, channels, channelId);
  requireChannelAdmin(context);
  if (url.pathname === CHANNEL_WEBHOOK_ROUTES.read) return json(200, webhooks.settings(channelId));
  let change: ReturnType<typeof parseChannelWebhookChange>;
  try {
    change = parseChannelWebhookChange(body);
  } catch {
    throw new HttpError(400, sourceText("error.team.channelWebhookInvalid"));
  }
  return json(200, await runCauseEffect(webhooks.set(change)));
}
