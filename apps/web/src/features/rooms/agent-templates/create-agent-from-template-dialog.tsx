import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft01Icon,
  BotIcon,
  Cancel01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActor,
  TeamHubAgentReasoningEffort,
  TeamHubAgentTemplate,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { ActorAvatar } from "../members/actor-avatar";
import {
  avatarKeyFromSeed,
  isAgentAvatarKey,
  storeAgentAvatarKey,
} from "../members/agent-avatar";
import { AgentPlacementFields } from "../members/agent-placement-fields";
import { loadAllManifestPages } from "../members/manifest-pages";
import {
  reasoningEffortLabel,
  useAgentModelSelection,
} from "../members/use-agent-model-selection";
import { createTenantAgent } from "../members/create-tenant-agent";
import { useAgentPlacementFlow } from "../members/use-agent-placement-flow";

import { templateResourceChips } from "./agent-template";
import { templateDescription, templateName } from "./builtin-template-text";
import { agentTemplateMessages as m } from "./agent-templates.messages";
import {
  TemplateContents,
  useTemplateContentGroups,
} from "./agent-template-contents";
import {
  agentTemplatesQueryKey,
  agentTemplatesQueryOptions,
} from "./agent-template-queries";
import {
  type ResolvedAgentTemplateBindings,
  resolveAgentTemplateBindings,
  withImportedTemplateSkills,
} from "./resolve-agent-template-bindings";

const NO_BINDINGS: ResolvedAgentTemplateBindings = {
  importableSkills: [],
  skillBindings: [],
  unavailableSkills: [],
};

export function CreateAgentFromTemplateDialog({
  onClose,
  onCreated,
  tenantId,
}: {
  onClose: () => void;
  onCreated: (actor: TeamHubActor) => Promise<void> | void;
  tenantId: string;
}) {
  const [template, setTemplate] = useState<TeamHubAgentTemplate | null>(null);
  const { client } = useTeamHubRuntime();
  const t = useT();
  const templates = useQuery(agentTemplatesQueryOptions(client, tenantId));
  return (
    <ModalDialog
      ariaLabel={t(m.title)}
      className="flex flex-col overflow-hidden"
      onClose={onClose}
      size="xl"
    >
      {template ? (
        <TemplateSetup
          onBack={() => setTemplate(null)}
          onClose={onClose}
          onCreated={onCreated}
          template={template}
          tenantId={tenantId}
        />
      ) : (
        <TemplatePicker
          error={Boolean(templates.error)}
          onClose={onClose}
          onRetry={() => void templates.refetch()}
          onSelect={setTemplate}
          pending={templates.isPending}
          templates={templates.data?.items ?? []}
          tenantId={tenantId}
        />
      )}
    </ModalDialog>
  );
}

// One scrolling list with a heading per origin. Tabs hid half the catalog
// behind a click and made the two sources look like separate features.
const TEMPLATE_SECTIONS = [
  {
    empty: m.officialEmpty,
    origin: "builtin",
    title: m.officialTitle,
  },
  {
    empty: m.publishedEmpty,
    origin: "published",
    title: m.publishedTitle,
  },
] as const;

function TemplatePicker({
  error,
  onClose,
  onRetry,
  onSelect,
  pending,
  templates,
  tenantId,
}: {
  error: boolean;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (template: TeamHubAgentTemplate) => void;
  pending: boolean;
  templates: readonly TeamHubAgentTemplate[];
  tenantId: string;
}) {
  const canRemove = useTemplateRemovalPermission(tenantId);
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 pb-4 pt-5">
        <div>
          <h2 className="text-lg">{t(m.title)}</h2>
          <p className="mt-1 text-sm text-app-muted">
            {t(m.pickerDescription)}
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </header>
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {pending ? (
          <div
            aria-label={t(m.loadingTemplates)}
            className="space-y-5"
            role="status"
          >
            {TEMPLATE_SECTIONS.map((section) => (
              <section key={section.origin}>
                <h3 className="mb-2.5 text-base font-semibold text-app-ink">
                  {t(section.title)}
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((slot) => (
                    <div
                      className="h-[144px] animate-pulse rounded-xl bg-muted/50 motion-reduce:animate-none"
                      key={slot}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : error ? (
          <PickerNotice tone="danger">
            <span className="flex items-center justify-between gap-3">
              {t(m.unavailable)}
              <Button onClick={onRetry} size="compact" type="button">
                {t(commonMessages.retry)}
              </Button>
            </span>
          </PickerNotice>
        ) : (
          <div className="space-y-5">
            {TEMPLATE_SECTIONS.map((section) => {
              const listed = templates.filter(
                (template) => template.origin === section.origin,
              );
              return (
                <section key={section.origin}>
                  <h3 className="mb-2.5 text-base font-semibold text-app-ink">
                    {t(section.title)}
                  </h3>
                  {listed.length ? (
                    <ul
                      aria-label={t(section.title)}
                      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                    >
                      {listed.map((template, index) => (
                        <li
                          className="template-card-enter group relative h-[144px] overflow-hidden rounded-xl border border-transparent bg-card shadow-outline transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring hover:border-border-hover"
                          key={template.template_id}
                          style={
                            {
                              "--template-card-index": index,
                            } as CSSProperties
                          }
                        >
                          <button
                            className="flex h-full w-full items-start gap-3 p-4 text-left outline-none"
                            onClick={() => onSelect(template)}
                            type="button"
                          >
                            <ActorAvatar
                              avatarKey={template.avatar_key}
                              kind="agent"
                              name={templateName(template, t)}
                              size="md"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-baseline gap-1.5 pr-7">
                                <span className="truncate text-sm font-semibold text-app-ink">
                                  {templateName(template, t)}
                                </span>
                                {template.published_by ? (
                                  <span className="shrink-0 truncate text-xs leading-4 text-muted-foreground">
                                    {t(m.publishedBy, {
                                      name: template.published_by.display_name,
                                    })}
                                  </span>
                                ) : null}
                              </span>
                              {/* One chip per resource kind: a combined string
                                  hid which kinds a template actually carries. */}
                              {templateResourceChips(template, t).length ? (
                                <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                                  {templateResourceChips(template, t).map(
                                    (chip) => (
                                      <span
                                        className="rounded-sm bg-muted px-1.5 py-0.5 text-xs leading-4 text-muted-foreground"
                                        key={chip}
                                      >
                                        {chip}
                                      </span>
                                    ),
                                  )}
                                </span>
                              ) : null}
                              {template.instructions ? (
                                <span className="mt-1.5 line-clamp-3 h-[60px] break-words text-sm leading-5 text-app-muted [overflow-wrap:anywhere]">
                                  {template.instructions}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {canRemove(template) ? (
                            <RemoveTemplateButton
                              template={template}
                              tenantId={tenantId}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <PickerNotice>{t(section.empty)}</PickerNotice>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Space's Human may take out of the market any template published from
 * this Space.
 */
function useTemplateRemovalPermission(tenantId: string) {
  return (template: TeamHubAgentTemplate) =>
    template.origin === "published" &&
    template.published_by?.tenant_id === tenantId;
}

function RemoveTemplateButton({
  template,
  tenantId,
}: {
  template: TeamHubAgentTemplate;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const { client } = useTeamHubRuntime();
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      teamHubDone(
        client.api.DELETE(
          "/v0/tenants/{tenantId}/agent-templates/{templateId}",
          { params: { path: { tenantId, templateId: template.template_id } } },
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: agentTemplatesQueryKey(tenantId),
      }),
  });
  if (confirming || remove.isPending || remove.error) {
    // Confirming over the whole card instead of in a chip beside the title:
    // the inline row had to squeeze a question and two buttons into the corner,
    // so it covered the name it was asking about.
    return (
      <span className="absolute inset-0 z-10 flex flex-col justify-center gap-2 rounded-xl bg-card/95 p-4 text-center backdrop-blur-sm">
        <span className="text-sm font-medium text-app-ink">
          {t(m.removeQuestion)}
        </span>
        <span className="text-xs leading-4 text-app-muted">
          {t(m.removeNote)}
        </span>
        {remove.error ? (
          <span className="text-xs leading-4 text-app-danger" role="alert">
            {remove.error.message}
          </span>
        ) : null}
        <span className="mt-1 flex items-center justify-center gap-2">
          <Button
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              setConfirming(false);
            }}
            size="compact"
            type="button"
          >
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            size="compact"
            tone="danger"
            type="button"
          >
            {remove.isPending
              ? t(m.removing)
              : remove.error
                ? t(commonMessages.tryAgain)
                : t(commonMessages.remove)}
          </Button>
        </span>
      </span>
    );
  }
  return (
    <span className="absolute right-2 top-2">
      <Button
        data-voice-risk="never"
        aria-label={t(m.removeFromMarketplace, { name: template.name })}
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => setConfirming(true)}
        size="compactIcon"
        tone="ghost"
        type="button"
      >
        <Icon icon={Delete02Icon} size={14} />
      </Button>
    </span>
  );
}

function PickerNotice({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "danger";
}) {
  return (
    <p
      className={`rounded-xl border border-border bg-muted/40 p-3 text-sm ${tone === "danger" ? "text-app-danger" : "text-app-muted"}`}
      role="status"
    >
      {children}
    </p>
  );
}

function TemplateSetup({
  onBack,
  onClose,
  onCreated,
  template,
  tenantId,
}: {
  onBack: () => void;
  onClose: () => void;
  onCreated: (actor: TeamHubActor) => Promise<void> | void;
  template: TeamHubAgentTemplate;
  tenantId: string;
}) {
  const t = useT();
  const [name, setName] = useState(() => templateName(template, t));
  const { client } = useTeamHubRuntime();
  const placement = useAgentPlacementFlow({ tenantId });
  const modelSelection = useAgentModelSelection(
    placement.selection.runtimeModels,
  );
  const hasBindings =
    template.skill_bindings.length +
      (template.connector_bindings?.length ?? 0) >
    0;
  // A Local Agent gets platform Skills too: the Local Context
  // projects them read-only into `.agents/skills` alongside whatever the
  // Computer already has, so both placements resolve against the catalog.
  const resolveBindings = hasBindings;
  const bindings = useQuery({
    enabled: resolveBindings,
    queryFn: async () => {
      // Only a published template shares Skills that may need copying here.
      const [skills, imports] = await Promise.all([
        loadAllManifestPages((page) =>
          teamHubData(
            client.api.GET("/v0/tenants/{tenantId}/skill-manifests", {
              params: { path: { tenantId }, query: page },
            }),
          ),
        ),
        template.origin === "published" && template.skill_bindings.length
          ? teamHubData(
              client.api.GET(
                "/v0/tenants/{tenantId}/agent-templates/{templateId}/skill-imports",
                {
                  params: {
                    path: { tenantId, templateId: template.template_id },
                  },
                },
              ),
            )
          : { items: [] },
      ]);
      return resolveAgentTemplateBindings(template, {
        imports: imports.items,
        skills,
      });
    },
    queryKey: [
      "teamhub",
      "agent-template-bindings",
      tenantId,
      template.template_id,
    ],
    retry: false,
  });
  const resolved = resolveBindings ? bindings.data : NO_BINDINGS;
  const createAgent = useMutation({
    mutationFn: async () => {
      if (!resolved) {
        throw new Error(t(m.creationUnavailable));
      }
      const input = {
        agentType: "general" as const,
        description: templateDescription(template, t),
        instructions: template.instructions,
        model: modelSelection.model,
        ...(modelSelection.reasoningEffort
          ? { reasoningEffort: modelSelection.reasoningEffort }
          : {}),
        name: name.trim(),
        ...(placement.localPlacement
          ? { placement: placement.localPlacement }
          : {}),
        ...(template.avatar_key ? { avatarKey: template.avatar_key } : {}),
        skillBindings: resolved.skillBindings,
        tenantId,
        templateId: template.template_id,
        visibilityScope: "sponsor" as const,
      };
      // Copies are reused by content, so a retried import yields the same
      // Skills.
      const skillBindings = resolved.importableSkills.length
        ? withImportedTemplateSkills(
            input.skillBindings,
            (
              await teamHubData(
                client.api.POST(
                  "/v0/tenants/{tenantId}/agent-templates/{templateId}/skill-imports",
                  {
                    params: {
                      path: { tenantId, templateId: template.template_id },
                    },
                  },
                ),
              )
            ).items,
          )
        : input.skillBindings;
      return createTenantAgent(client, { ...input, skillBindings });
    },
    onSuccess: async (actor) => {
      const avatarKey = template.avatar_key;
      storeAgentAvatarKey(
        actor.id,
        avatarKey && isAgentAvatarKey(avatarKey)
          ? avatarKey
          : avatarKeyFromSeed(template.name),
      );
      await onCreated(actor);
    },
  });
  const busy = createAgent.isPending || bindings.isFetching;
  const canSubmit =
    Boolean(name.trim()) &&
    Boolean(modelSelection.model) &&
    (modelSelection.reasoningEfforts.length === 0 ||
      Boolean(modelSelection.reasoningEffort)) &&
    Boolean(placement.localPlacement) &&
    Boolean(resolved) &&
    !busy;

  function beginNewCommand() {
    createAgent.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) createAgent.mutate();
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <header className="flex shrink-0 items-start justify-between gap-3 px-5 pb-4 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            aria-label={t(m.backToTemplates)}
            onClick={onBack}
            size="icon"
            tone="ghost"
            type="button"
          >
            <Icon icon={ArrowLeft01Icon} size={16} />
          </Button>
          <ActorAvatar
            avatarKey={template.avatar_key}
            kind="agent"
            name={templateName(template, t)}
            size="sm"
          />
          <div className="min-w-0">
            <h2 className="truncate text-lg">{templateName(template, t)}</h2>
            <p className="mt-1 text-sm text-app-muted">
              {templateDescription(template, t) || t(m.chooseWhere)}
            </p>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <fieldset className="space-y-4" disabled={createAgent.isPending}>
          <Field
            label={t(m.name)}
            maxLength={120}
            onChange={(event) => {
              beginNewCommand();
              setName(event.target.value);
            }}
            value={name}
          />
          <TemplateContents
            groups={{ connectors: [], skills: [] }}
            instructions={template.instructions}
            routines={template.routines}
          />
          <AgentPlacementFields
            disabled={createAgent.isPending}
            onSelectionChange={beginNewCommand}
            selection={placement.selection}
          />
          <div>
            <span className="mb-1.5 block text-sm font-medium">
              {t(m.model)}
            </span>
            <Select
              aria-label={t(m.modelLabel)}
              className="ui-field-control w-full"
              disabled={!modelSelection.model}
              onValueChange={(value) => {
                beginNewCommand();
                modelSelection.selectModel(value);
              }}
              value={modelSelection.model}
            >
              {modelSelection.items.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </Select>
          </div>
          {modelSelection.reasoningEfforts.length > 0 ? (
            <div>
              <span className="mb-1.5 block text-sm font-medium">
                {t(m.reasoning)}
              </span>
              <Select
                aria-label={t(m.reasoningLabel)}
                className="ui-field-control w-full"
                disabled={!modelSelection.reasoningEffort}
                onValueChange={(value) => {
                  beginNewCommand();
                  modelSelection.selectReasoningEffort(
                    value as TeamHubAgentReasoningEffort,
                  );
                }}
                value={modelSelection.reasoningEffort ?? ""}
              >
                {modelSelection.reasoningEfforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {reasoningEffortLabel(effort, t)}
                  </SelectItem>
                ))}
              </Select>
            </div>
          ) : null}
          <TemplateBindingsNote
            error={bindings.isError}
            onRetry={() => void bindings.refetch()}
            pending={resolveBindings && bindings.isPending}
            resolved={resolved}
            template={template}
          />
        </fieldset>
      </div>

      {/* Failures stay pinned next to the button that caused them rather than
          scrolling away under the template contents. */}
      {createAgent.error ? (
        <p
          className="shrink-0 border-t border-app-border bg-app-surface px-5 pt-3 text-sm leading-5 text-app-danger"
          role="alert"
        >
          {createAgent.error.message}
        </p>
      ) : null}

      <footer className="flex shrink-0 justify-end gap-2 border-t border-app-border px-5 py-4">
        <Button onClick={onClose} type="button">
          {t(commonMessages.cancel)}
        </Button>
        <Button disabled={!canSubmit} tone="primary" type="submit">
          <Icon icon={BotIcon} size={16} />
          {createAgent.isPending ? t(m.creating) : t(m.createAgent)}
        </Button>
      </footer>
    </form>
  );
}

/**
 * What this template will give the new Agent, by name. A count alone does not
 * tell someone whether a template is the one they want, so the Skills and
 * Connectors are listed, and anything this Workspace cannot bind stays in its
 * own list, marked, instead of collapsing into a sentence.
 */
function TemplateBindingsNote({
  error,
  onRetry,
  pending,
  resolved,
  template,
}: {
  error: boolean;
  onRetry: () => void;
  pending: boolean;
  resolved?: ResolvedAgentTemplateBindings;
  template: TeamHubAgentTemplate;
}) {
  const t = useT();
  const connectorKeys = template.connector_bindings ?? [];
  const hasBindings = template.skill_bindings.length + connectorKeys.length > 0;
  const appliedGroups = useTemplateContentGroups({
    connector_bindings: connectorKeys,
    skill_bindings: [
      ...(resolved?.skillBindings ?? []),
      ...(resolved?.importableSkills ?? []),
    ],
  });

  if (pending) {
    return <Note>{t(m.checkingSkills)}</Note>;
  }
  if (error || !resolved) {
    return (
      <Note tone="danger">
        <span className="flex items-center justify-between gap-3">
          {t(m.skillsCheckFailed)}
          <Button onClick={onRetry} size="compact" type="button">
            {t(commonMessages.retry)}
          </Button>
        </span>
      </Note>
    );
  }
  const importable = new Set(
    resolved.importableSkills.map((skill) => skill.skill_id),
  );
  const groups = {
    connectors: appliedGroups.connectors,
    skills: [
      ...appliedGroups.skills.map((item) =>
        importable.has(item.key) ? { ...item, detail: t(m.skillAdded) } : item,
      ),
      ...resolved.unavailableSkills.map((item) => ({
        ...item,
        detail: t(m.skillUnavailable),
        unavailable: true,
      })),
    ],
  };
  const nothingApplies =
    resolved.skillBindings.length === 0 &&
    resolved.importableSkills.length === 0 &&
    connectorKeys.length === 0;
  return (
    <div className="space-y-2">
      <TemplateContents connectorNote={t(m.connectorNote)} groups={groups} />
      {nothingApplies && hasBindings ? (
        <Note>{t(m.nothingAvailable)}</Note>
      ) : null}
      {!nothingApplies ? <Note>{t(m.usedAlongside)}</Note> : null}
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <p
      className={`rounded-xl border border-border bg-muted/40 p-3 text-sm leading-5 ${tone === "danger" ? "text-app-danger" : "text-app-muted"}`}
      role="status"
    >
      {children}
    </p>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Button
      data-voice-close
      aria-label={t(m.closeDialog)}
      onClick={onClose}
      size="icon"
      tone="ghost"
      type="button"
    >
      <Icon icon={Cancel01Icon} size={16} />
    </Button>
  );
}
