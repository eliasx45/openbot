import type { AgentModelOption, ProviderAccountStatus } from "@openbot/contracts/ipc";

export function withAccountModelDifference(
  account: ProviderAccountStatus,
  catalogue: readonly Pick<AgentModelOption, "id">[],
): ProviderAccountStatus {
  const own = account.models;
  if (!own) return account;
  const listed = new Set(own.map((model) => model.id));
  const shared = new Set(catalogue.map((model) => model.id));
  const models = own.filter((model) => !shared.has(model.id));
  const missingModels = own.length > 0 ? [...shared].filter((id) => !listed.has(id)) : [];
  return { ...account, models, ...(missingModels.length > 0 ? { missingModels } : {}) };
}
