import { BulkActionType } from "@trigger.dev/database";
import { BaseService } from "../baseService.server";
import { generateFriendlyId } from "../../friendlyIdentifiers";
import { logger } from "~/services/logger.server";
import { PerformBulkActionService } from "./performBulkAction.server";

type BulkAction = {
  projectId: string;
  action: BulkActionType;
  runIds: string[];
};

export class CreateBulkActionService extends BaseService {
  public async call({ projectId, action, runIds }: BulkAction) {
    const group = await this._prisma.bulkActionGroup.create({
      data: {
        friendlyId: generateFriendlyId("bulk"),
        projectId,
        type: action,
      },
    });

    const items = await this._prisma.bulkActionItem.createMany({
      data: runIds.map((runId) => ({
        friendlyId: generateFriendlyId("bulkitem"),
        type: action,
        groupId: group.id,
        sourceRunId: runId,
      })),
    });

    logger.debug("Created bulk action group", {
      groupId: group.id,
      action,
      runIds,
    });

    await PerformBulkActionService.enqueue(group.id, this._prisma);

    return group;
  }
}
