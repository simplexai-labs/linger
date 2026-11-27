import { Camera01Icon } from "@hugeicons/core-free-icons";
import {
  inlineNameButtonClassName,
  inlineNameInputClassName,
} from "@/components/ui/inline-name";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import background from "./profile-background.png";
import { Button } from "@/components/ui/button";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { AvatarEditButton } from "@/features/rooms/members/avatar-edit-button";
import { accountProfileQueryKey } from "./account-profile-queries";
import {
  teamHubIdentityQueryKey,
  teamHubIdentityQueryOptions,
  tenantActorsQueryKey,
} from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAccountProfile,
  TeamHubAccountProfileUpdate,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { accountSettingsMessages } from "./account-settings.messages";
import { prepareProfileImage } from "./profile-image";

export function AccountProfileHero({
  account,
  client,
  tenantId,
}: {
  account: TeamHubAccountProfile;
  client: TeamHubClient;
  tenantId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  // The Actor ID seeds the initials tint, so this avatar matches the rail's.
  const actorId = useQuery(
    teamHubIdentityQueryOptions(client),
  ).data?.actors.find((actor) => actor.tenant_id === tenantId)?.id;
  const avatarInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [processing, setProcessing] = useState(false);
  const [imageError, setImageError] = useState("");
  const update = useMutation({
    mutationFn: (input: TeamHubAccountProfileUpdate) =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/account-profile", {
          params: { path: { tenantId } },
          body: input,
        }),
      ),
    onSuccess: async (next) => {
      queryClient.setQueryData(accountProfileQueryKey(tenantId), next);
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamHubIdentityQueryKey }),
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
      ]);
    },
  });
  const busy = processing || update.isPending;
  async function upload(file: File | undefined, avatar: boolean) {
    if (!file) return;
    setImageError("");
    update.reset();
    setProcessing(true);
    try {
      const image = await prepareProfileImage(file, avatar);
      await update.mutateAsync(
        avatar ? { avatar_image: image } : { background_image: image },
      );
    } catch (error) {
      setImageError(
        error instanceof Error
          ? error.message
          : translate(accountSettingsMessages.imageUploadFailed),
      );
    } finally {
      setProcessing(false);
    }
  }
  function saveName() {
    const next = name.trim();
    if (!next || next === account.name) {
      setName(account.name);
      setEditing(false);
      return;
    }
    update.mutate({ name: next });
  }
  return (
    <section aria-label={t(accountSettingsMessages.profileAppearance)}>
      <div className="relative h-32 overflow-hidden rounded-xl bg-muted">
        <img
          alt=""
          src={account.background_image || background}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute right-2.5 top-2.5">
          <Button
            className="bg-card shadow-md"
            size="compact"
            disabled={busy}
            onClick={() => backgroundInput.current?.click()}
          >
            <Icon icon={Camera01Icon} size={14} />
            {t(accountSettingsMessages.changeCover)}
          </Button>
        </div>
      </div>
      {/* The avatar overlaps the cover's lower edge; a ring in the page's
          colour sets it apart from the photo and keeps the photo from showing
          through a Human's translucent tile. */}
      <div className="-mt-6 flex items-end gap-3 px-5">
        <div className="relative shrink-0 rounded-2xl bg-background p-1">
          <AvatarEditButton
            disabled={busy}
            label={t(accountSettingsMessages.uploadProfilePhoto)}
            onClick={() => avatarInput.current?.click()}
          >
            {account.avatar_image ? (
              <img
                alt={t(commonMessages.avatar, { name: account.name })}
                src={account.avatar_image}
                className="size-16 rounded-[20%] object-cover"
              />
            ) : (
              <ActorAvatar
                actorId={actorId}
                kind="human"
                name={account.name}
                showTitle={false}
                size="lg"
              />
            )}
          </AvatarEditButton>
        </div>
        <div className="min-w-0 flex-1 pb-1">
          {/* Edited in place as an Agent's name is: Enter or leaving the
              field saves, Escape cancels. */}
          {editing ? (
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the field replaces the name the person just clicked
              autoFocus
              aria-label={t(accountSettingsMessages.profileDisplayName)}
              className={`text-lg font-semibold leading-6 text-foreground ${inlineNameInputClassName}`}
              disabled={busy}
              maxLength={120}
              onBlur={saveName}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(account.name);
                  setEditing(false);
                }
              }}
              value={name}
            />
          ) : (
            <h2 className="max-w-full text-lg font-semibold leading-6 text-foreground">
              <button
                aria-label={t(accountSettingsMessages.editDisplayName)}
                className={`text-left ${inlineNameButtonClassName}`}
                title={account.name}
                disabled={busy}
                onClick={() => {
                  setName(account.name);
                  setEditing(true);
                  update.reset();
                }}
                type="button"
              >
                {account.name}
              </button>
            </h2>
          )}
        </div>
      </div>
      <input
        ref={avatarInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label={t(accountSettingsMessages.profilePhotoFile)}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void upload(event.target.files?.[0], true);
          event.target.value = "";
        }}
      />
      <input
        ref={backgroundInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label={t(accountSettingsMessages.profileCoverFile)}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void upload(event.target.files?.[0], false);
          event.target.value = "";
        }}
      />
      {busy ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t(accountSettingsMessages.savingProfile)}
        </p>
      ) : null}
      {imageError || update.error ? (
        <p role="alert" className="mt-2 text-sm text-app-danger">
          {imageError || update.error?.message}
        </p>
      ) : null}
    </section>
  );
}
