import {
  ArrowRight02Icon,
  ComputerIcon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { authMessages as m } from "./auth.messages";
import { AuthShell } from "./auth-shell";
import { safeAuthenticationReturnTo } from "./authentication-return-to";
import {
  type DesktopLocalAccount,
  useDesktopLocalAccount,
} from "./desktop-local-account";
import {
  type AuthenticationResult,
  useTeamHubAuthentication,
} from "./teamhub-authentication";

type AuthenticationController = ReturnType<typeof useTeamHubAuthentication>;

export function TeamHubLoginPage({
  onAuthenticated,
}: {
  onAuthenticated?: (result: AuthenticationResult) => Promise<void> | void;
}) {
  const [searchParams] = useSearchParams();
  const returnTo = safeAuthenticationReturnTo(searchParams.get("return_to"));
  const authentication = useTeamHubAuthentication({
    onAuthenticated,
    returnTo,
  });
  const localAccount = useDesktopLocalAccount();
  const t = useT();
  const reason = searchParams.get("reason");
  const [dismissedReason, setDismissedReason] = useState<string | null>(null);
  const dismissNotice = () => {
    if (reason) setDismissedReason(reason);
  };
  const authenticationNotice =
    reason === "session-expired" &&
    dismissedReason !== reason &&
    !authentication.state.error
      ? t(m.sessionExpired)
      : null;

  return (
    <AuthShell subtitle={t(m.loginSubtitle)} title={t(m.loginTitle)}>
      {authenticationNotice ? (
        <div className="mb-4">
          <FormFeedback tone="danger">{authenticationNotice}</FormFeedback>
        </div>
      ) : null}
      {localAccount ? (
        <LocalAccountSignIn
          account={localAccount}
          authentication={authentication}
          onAttempt={dismissNotice}
        />
      ) : null}
      <AuthenticationForm
        authentication={authentication}
        autoFocusEmail={!localAccount}
        onInteract={dismissNotice}
      />
    </AuthShell>
  );
}

function LocalAccountSignIn({
  account,
  authentication,
  onAttempt,
}: {
  account: DesktopLocalAccount;
  authentication: AuthenticationController;
  onAttempt: () => void;
}) {
  const t = useT();
  return (
    <div className="auth-local-account">
      <Button
        className="w-full"
        disabled={authentication.state.isSubmitting}
        onClick={() => {
          onAttempt();
          void authentication.signInWithDesktopAccount(account);
        }}
        size="large"
        tone="secondary"
        type="button"
      >
        <Icon icon={ComputerIcon} size={16} />
        <span>{t(m.localAccountSignIn)}</span>
      </Button>
      <div className="auth-divider">
        <span />
        <span>{t(m.or)}</span>
        <span />
      </div>
    </div>
  );
}

function AuthenticationForm({
  authentication,
  autoFocusEmail,
  onInteract,
}: {
  authentication: AuthenticationController;
  autoFocusEmail: boolean;
  onInteract: () => void;
}) {
  const { email, error, isSubmitting, password } = authentication.state;
  const { changeField, handleSubmit } = authentication;
  const formRef = useRef<HTMLFormElement>(null);
  const t = useT();

  useEffect(() => {
    if (!autoFocusEmail) return;
    formRef.current
      ?.querySelector<HTMLInputElement>('input[type="email"]')
      ?.focus();
  }, [autoFocusEmail]);

  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={(event) => {
        onInteract();
        void handleSubmit(event);
      }}
      ref={formRef}
    >
      <Field
        autoComplete="email"
        label={t(m.email)}
        onChange={(event) => {
          onInteract();
          changeField("email", event.target.value);
        }}
        placeholder="you@company.com"
        type="email"
        value={email}
      />
      <PasswordField
        autoComplete="current-password"
        label={t(m.password)}
        onChange={(value) => {
          onInteract();
          changeField("password", value);
        }}
        value={password}
      />
      {error ? <FormFeedback tone="danger">{error}</FormFeedback> : null}
      <Button
        className="auth-submit w-full"
        loading={isSubmitting}
        size="large"
        type="submit"
        tone="primary"
      >
        <span>{t(m.signIn)}</span>
        {!isSubmitting ? <Icon icon={ArrowRight02Icon} size={16} /> : null}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {t(m.accessHelp)}
      </p>
    </form>
  );
}

function PasswordField({
  autoComplete,
  label,
  onChange,
  value,
}: {
  autoComplete: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [visible, setVisible] = useState(false);
  const t = useT();

  return (
    <Field
      autoComplete={autoComplete}
      label={label}
      onChange={(event) => onChange(event.target.value)}
      suffix={
        <button
          aria-label={t(visible ? m.hidePassword : m.showPassword)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? (
            <Icon icon={ViewOffIcon} size={16} />
          ) : (
            <Icon icon={ViewIcon} size={16} />
          )}
        </button>
      }
      type={visible ? "text" : "password"}
      value={value}
    />
  );
}
