export function dashboardPath(tenantId: string) {
  return `/t/${encodeURIComponent(tenantId)}/dashboard`;
}

export function dashboardWorkItemPath(tenantId: string, workItemId: string) {
  return `${dashboardPath(tenantId)}/${encodeURIComponent(workItemId)}`;
}
