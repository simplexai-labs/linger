import type { SharedTaskScope } from "../executor/context-ref.js";

/** The envelope schema's SharedTaskScope, carried inside a Context View manifest. */
export interface SharedTaskScopeWire {
  readonly version: 1;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly origin_room_id: string;
  readonly role: "meta" | "alter_ego";
  readonly task_id?: string;
}

/** The receiver resolves the scope under its own shared root. */
export const sharedTaskScopeWire = (
  scope: SharedTaskScope | undefined,
): { shared_task_scope?: SharedTaskScopeWire } =>
  scope
    ? {
        shared_task_scope: {
          version: scope.version,
          tenant_id: scope.tenantId,
          agent_id: scope.agentId,
          origin_room_id: scope.originRoomId,
          role: scope.role,
          ...(scope.role === "alter_ego" ? { task_id: scope.taskId } : {}),
        },
      }
    : {};
