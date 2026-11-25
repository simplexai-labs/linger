import { WikiProfileSourcesRow } from "./wiki-profile-sources";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { ReadOnlyBlockNoteDocument } from "@/components/read-only-blocknote-document";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  personalProfileQueryKey,
  personalProfileQueryOptions,
} from "@/features/settings/personal-profile-queries";
import { accountProfileQueryOptions } from "@/features/settings/account-profile-queries";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { teamHubIdentityQueryOptions } from "@/features/rooms/room-queries";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubPersonalProfileDocument,
  TeamHubPersonalProfileModule,
  TeamHubPersonalProfileTimelineEntry,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import {
  useAnotherMeActorId,
  WikiWorkingCenter,
  WikiWorkingLine,
} from "./wiki-working-card";
import { WikiProfileEditor } from "./wiki-profile-editor";
import { wikiMessages as m } from "./wiki.messages";
import "./wiki-profile-page.css";

type ProfilePart =
  | { kind: "markdown"; markdown: string }
  | { kind: "timeline"; entries: TeamHubPersonalProfileTimelineEntry[] };

// Profile fields are plain text; escape Markdown syntax so field content can
// never change the article structure.
function plainMarkdown(text: string): string {
  return text
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace(/([\\`*_{}[\]<>#|!~])/g, "\\$1")
    .replace(/^([-+])(\s)/, "\\$1$2")
    .replace(/^(\d+)([.)]\s)/, "$1\\$2");
}

function pointsMarkdown(points: TeamHubPersonalProfileModule["points"]) {
  return points.flatMap((point) => {
    const text = point.text.trim();
    return [
      `- **${plainMarkdown(point.title)}**${text ? `: ${plainMarkdown(text)}` : ""}`,
      ...point.items.map((item) => `  - ${plainMarkdown(item)}`),
    ];
  });
}

// The infobox already titles the page with the account name, so the article
// starts at the five modules as level-2 sections; each point is one
// "**Title**: text" bullet with its items nested under it. Background shows
// its overview first, then its Timeline and points.
function profileArticleParts(
  profile: TeamHubPersonalProfileDocument,
  t: Translate,
): ProfilePart[] {
  const { background } = profile;
  const parts: ProfilePart[] = [
    { kind: "markdown", markdown: `## ${plainMarkdown(t(m.background))}` },
  ];
  if (background.overview.trim())
    parts.push({
      kind: "markdown",
      markdown: plainMarkdown(background.overview),
    });
  if (background.timeline.length)
    parts.push({ kind: "timeline", entries: oldestFirst(background.timeline) });
  if (background.points.length)
    parts.push({
      kind: "markdown",
      markdown: pointsMarkdown(background.points).join("\n"),
    });
  for (const [label, module] of [
    [t(m.communicationStyle), profile.communication_style],
    [t(m.workingStyle), profile.working_style],
    [t(m.preferences), profile.preferences],
    [t(m.writingStyle), profile.writing_style],
  ] as const) {
    const overview = module.overview.trim();
    parts.push({
      kind: "markdown",
      markdown: [
        `## ${plainMarkdown(label)}`,
        ...(overview ? ["", plainMarkdown(overview)] : []),
        ...(module.points.length ? ["", ...pointsMarkdown(module.points)] : []),
      ].join("\n"),
    });
  }
  return parts.filter(
    (part) => part.kind === "timeline" || part.markdown.trim(),
  );
}

// Orders entries by start date, oldest first, whatever order the model wrote;
// an entry without a readable year keeps its place after the dated ones.
function oldestFirst(
  entries: TeamHubPersonalProfileTimelineEntry[],
): TeamHubPersonalProfileTimelineEntry[] {
  // A bare year is a start year. Known ends and upper bounds sort before
  // starts in the same year; periods without a year retain their relative
  // order last.
  const start = (period: string) => {
    const match = /(\d{4})/.exec(period);
    if (!match) return Infinity;
    const endsHere = /^\s*[–≤-]\s*\d{4}/.test(period);
    return Number(match[1]) * 10 + (endsHere ? 0 : 1);
  };
  return entries
    .map((entry, index) => ({ entry, index, key: start(entry.period) }))
    .sort((left, right) =>
      left.key === right.key ? left.index - right.index : left.key - right.key,
    )
    .map(({ entry }) => entry);
}

function ProfileTimeline({
  entries,
}: {
  entries: TeamHubPersonalProfileTimelineEntry[];
}) {
  const t = useT();
  return (
    <ol aria-label={t(m.timeline)} className="wiki-profile-timeline">
      {entries.map((entry, index) => (
        <li className="wiki-profile-timeline-entry" key={index}>
          <span className="wiki-profile-timeline-period">
            {entry.period.replace(/^\s*≤\s*(\d{4})\s*$/, "–$1")}
          </span>
          <div className="min-w-0">
            <p className="wiki-profile-timeline-organization">
              {entry.organization}
              {entry.place ? (
                <span className="wiki-profile-timeline-place">
                  {" "}
                  · {entry.place}
                </span>
              ) : null}
            </p>
            {entry.role ? (
              <p className="wiki-profile-timeline-role">{entry.role}</p>
            ) : null}
            {entry.description ? (
              <p className="wiki-profile-timeline-detail">
                {entry.description}
              </p>
            ) : null}
            {entry.details.length ? (
              <ul className="wiki-profile-timeline-highlights">
                {entry.details.map((highlight, highlightIndex) => (
                  <li key={highlightIndex}>{highlight}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function WikiProfilePage() {
  const { tenantId = "" } = useParams();
  const { client } = useTeamHubRuntime();
  const t = useT();
  const profile = useQuery(personalProfileQueryOptions(client, tenantId));
  const account = useQuery(accountProfileQueryOptions(client, tenantId));
  // The Actor ID seeds the initials tint, so this avatar matches the rail's.
  const actorId = useQuery(
    teamHubIdentityQueryOptions(client),
  ).data?.actors.find((actor) => actor.tenant_id === tenantId)?.id;
  const anotherMe = useAnotherMeActorId(tenantId);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const editing = searchParams.get("edit") === "1";
  const setEditing = (next: boolean) =>
    setSearchParams(next ? { edit: "1" } : {});
  const save = useMutation({
    mutationFn: (input: Parameters<typeof client.replacePersonalProfile>[1]) =>
      client.replacePersonalProfile(tenantId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: personalProfileQueryKey(tenantId),
      });
      setEditing(false);
    },
  });
  const saveError =
    save.error instanceof TeamHubError && save.error.status === 409
      ? t(m.profileChanged)
      : (save.error?.message ?? null);
  if (profile.isPending || account.isPending)
    return (
      <p
        className="flex items-center gap-2 text-sm text-app-muted"
        role="status"
      >
        <Spinner size={16} />
        {t(m.loadingProfile)}
      </p>
    );
  if (profile.error || account.error)
    return (
      <div role="alert">
        <p>{profile.error?.message ?? account.error?.message}</p>
        <Button
          tone="secondary"
          onClick={() => {
            void profile.refetch();
            void account.refetch();
          }}
        >
          {t(m.retryProfile)}
        </Button>
      </div>
    );
  const current = profile.data.current;
  const building = Boolean(profile.data.building_since);
  const person = account.data;
  const parts = current ? profileArticleParts(current.profile, t) : [];
  // The infobox title already names the person.
  const details = [
    { key: "organization", label: m.organization, value: person.organization },
    { key: "email", label: m.email, value: person.email },
  ].filter((detail) => detail.value);
  return (
    <div className="wiki-profile mx-auto w-full max-w-[1000px] pb-4">
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-8">
        <aside
          aria-label={t(m.profileDetails)}
          className="wiki-profile-infobox xl:sticky xl:top-6 xl:order-2"
        >
          <h2 className="wiki-profile-infobox-title">{person.name}</h2>
          <div className="wiki-profile-infobox-avatar flex justify-center px-4 py-4">
            {person.avatar_image ? (
              <img
                alt={t(commonMessages.avatar, { name: person.name })}
                className="size-24 rounded-lg object-cover"
                src={person.avatar_image}
              />
            ) : (
              <ActorAvatar
                actorId={actorId}
                kind="human"
                name={person.name}
                size="lg"
              />
            )}
          </div>
          <dl>
            {details.map((detail) => (
              <div className="wiki-profile-infobox-row" key={detail.key}>
                <dt>{t(detail.label)}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
            <WikiProfileSourcesRow client={client} tenantId={tenantId} />
          </dl>
        </aside>
        <div className="wiki-profile-body min-w-0 xl:order-1">
          {building && parts.length ? (
            <WikiWorkingLine
              actorId={anotherMe}
              className="mb-6"
              text={t(m.updatingProfile)}
            />
          ) : null}
          {current && editing ? (
            <WikiProfileEditor
              error={saveError}
              markdown={current.markdown}
              onCancel={() => {
                save.reset();
                setEditing(false);
              }}
              onSave={(markdown) =>
                save.mutate({ base_revision_id: current.id, markdown })
              }
              pending={save.isPending}
            />
          ) : parts.length ? (
            <div
              aria-label={t(m.profileContent)}
              className="wiki-profile-article"
              data-editable="false"
              role="article"
            >
              {parts.map((part, index) =>
                part.kind === "timeline" ? (
                  <ProfileTimeline entries={part.entries} key={index} />
                ) : (
                  <ReadOnlyBlockNoteDocument
                    ariaLabel={t(m.profileSection)}
                    key={index}
                    markdown={part.markdown}
                    presentation="knowledge"
                    documentTitle={t(m.profileTab)}
                  />
                ),
              )}
            </div>
          ) : building ? (
            <WikiWorkingCenter
              actorId={anotherMe}
              title={t(m.gettingToKnowYou)}
            />
          ) : (
            <p className="text-sm text-app-muted">{t(m.profileEmpty)}</p>
          )}
        </div>
      </div>
    </div>
  );
}
