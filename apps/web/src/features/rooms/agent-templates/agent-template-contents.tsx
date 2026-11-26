import { useQuery } from "@tanstack/react-query";
import {
  AlarmClockIcon,
  BookOpen01Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import type { ReactNode } from "react";

import type { TeamHubRoutineCadence } from "@/features/teamhub/teamhub-types";
import { cadenceLabel } from "../task-sidebar/routine-cadence";

import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import { useT } from "@/i18n/use-translation";

import { agentTemplateMessages as m } from "./agent-templates.messages";

/** One named thing a template carries, with the detail that makes it concrete. */
export interface TemplateContentItem {
  detail?: string;
  instruction?: string;
  key: string;
  name: string;
  /** Listed so the consumer sees it, but this Workspace cannot give it to the Agent. */
  unavailable?: boolean;
}

export interface TemplateContentGroups {
  connectors: TemplateContentItem[];
  skills: TemplateContentItem[];
}

/**
 * Turns a template's stored references into named rows. Connector keys are
 * catalog keys, so they are resolved to App display names when the catalog is
 * available and shown as the raw key otherwise.
 */
export function useTemplateContentGroups(template: {
  connector_bindings?: readonly string[];
  skill_bindings: readonly { name: string; skill_id: string }[];
}): TemplateContentGroups {
  const client = useOptionalTeamHubRuntime()?.client;
  const t = useT();
  const connectorKeys = template.connector_bindings ?? [];
  const apps = useQuery({
    ...externalAppsQueryOptions(client!),
    enabled: Boolean(client) && connectorKeys.length > 0,
  });
  const appsByKey = new Map(
    (apps.data?.apps ?? []).map((app) => [app.key, app]),
  );
  return {
    connectors: connectorKeys.map((key) => ({
      detail: t(m.needsAuthorization),
      key,
      name: appsByKey.get(key)?.display_name ?? key,
    })),
    skills: template.skill_bindings.map((binding) => ({
      key: binding.skill_id,
      name: binding.name,
    })),
  };
}

/**
 * What a template actually contains, listed by name. A consumer decides whether
 * to use a template from this, so the names are shown rather than only counted.
 */
export function TemplateContents({
  connectorNote,
  groups,
  instructions,
  routines = [],
}: {
  connectorNote?: ReactNode;
  groups: TemplateContentGroups;
  instructions?: string;
  routines?: readonly {
    key?: string;
    id?: string;
    name: string;
    instruction: string;
    cadence: TeamHubRoutineCadence;
    enabled: boolean;
  }[];
}) {
  const t = useT();
  const sections = [
    {
      icon: BookOpen01Icon,
      items: groups.skills,
      label: t(m.skills),
      title: t(m.skillsTitle),
    },
    {
      icon: AlarmClockIcon,
      items: routines.map<TemplateContentItem>((routine) => ({
        key: routine.key ?? routine.id ?? routine.name,
        name: routine.name,
        instruction: routine.instruction,
        detail: t(routine.enabled ? m.routineEnabled : m.routinePaused, {
          cadence: cadenceLabel(routine.cadence, t),
          timezone: routine.cadence.timezone,
        }),
      })),
      label: t(m.routines),
      title: t(m.routinesTitle),
      note: t(m.routinesNote),
    },
    {
      icon: Plug01Icon,
      items: groups.connectors,
      label: t(m.connectors),
      note: connectorNote,
      title: t(m.connectorsTitle),
    },
  ].filter((section) => section.items.length > 0);

  if (!instructions && sections.length === 0) return null;

  return (
    <div className="space-y-3">
      {instructions ? (
        <section aria-label={t(m.instructions)}>
          <SectionHeading
            label={t(m.instructions)}
            title={t(m.instructionsTitle)}
          />
          <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-sm leading-5 text-app-body [overflow-wrap:anywhere]">
            {instructions}
          </p>
        </section>
      ) : null}
      {sections.map((section) => (
        <section aria-label={section.label} key={section.label}>
          <SectionHeading
            count={section.items.filter((item) => !item.unavailable).length}
            label={section.label}
            title={section.title}
          />
          {section.note ? (
            <p className="mt-1 text-xs leading-5 text-app-muted">
              {section.note}
            </p>
          ) : null}
          <ul className="mt-1.5 rounded-lg border border-border">
            {section.items.map((item) => (
              <ContentRow icon={section.icon} item={item} key={item.key} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SectionHeading({
  count,
  label,
  title,
}: {
  count?: number;
  label: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <h4 className="text-sm font-medium text-app-ink">{label}</h4>
      {count === undefined ? null : (
        <span className="text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      <span className="truncate text-xs text-app-muted">{title}</span>
    </div>
  );
}

function ContentRow({
  icon,
  item,
}: {
  icon: IconSvgElement;
  item: TemplateContentItem;
}) {
  if (item.instruction !== undefined) {
    return (
      <li>
        <details className="px-3 py-2">
          <summary className="cursor-pointer text-sm text-app-ink">
            <span className="inline-flex items-center gap-2">
              <Icon icon={icon} size={14} />
              {item.name}
            </span>
            <span className="mt-1 block text-xs text-app-muted">
              {item.detail}
            </span>
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-app-body">
            {item.instruction}
          </p>
        </details>
      </li>
    );
  }
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description / aria-disabled / aria-invalid are valid ARIA 1.3 global or form-group attributes missing from the rule data
    <li
      aria-disabled={item.unavailable || undefined}
      className="flex items-center gap-2.5 px-3 py-2"
    >
      <span aria-hidden className="shrink-0 text-app-muted">
        <Icon icon={icon} size={14} />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-sm ${item.unavailable ? "text-app-subtle" : "text-app-ink"}`}
      >
        {item.name}
      </span>
      {item.detail ? (
        <span
          className={`shrink-0 text-xs leading-4 ${item.unavailable ? "rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground" : "text-app-subtle"}`}
        >
          {item.detail}
        </span>
      ) : null}
    </li>
  );
}
