import { useState, type ReactNode } from "react";

import { TaskActivityLinksProvider } from "../../runtime-status/task-activity-block";
import { TaskActivitiesPanelTab } from "./task-activities-panel-tab";

/**
 * Lets the task blocks in an activity log open their Task's activity in
 * place, with a way back, instead of in another panel tab.
 */
export function TaskActivityDrillDown({
  children,
  hidden,
  tenantId,
}: {
  children: ReactNode;
  hidden: boolean;
  tenantId: string;
}) {
  const [task, setTask] = useState<{ id: string; title: string }>();
  return (
    <TaskActivityLinksProvider
      openTask={(id, title) => setTask({ id, title })}
      tenantId={tenantId}
    >
      <div className={task ? "hidden" : "contents"}>{children}</div>
      {task ? (
        <TaskActivitiesPanelTab
          hidden={hidden}
          onBack={() => setTask(undefined)}
          taskId={task.id}
          tenantId={tenantId}
          title={task.title}
        />
      ) : null}
    </TaskActivityLinksProvider>
  );
}
