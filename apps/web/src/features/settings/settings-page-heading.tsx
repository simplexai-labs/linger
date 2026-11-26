import type { ReactNode } from "react";

export function SettingsPageHeading({
  description,
  title,
}: {
  description?: ReactNode;
  title: string;
}) {
  return (
    <header>
      <h1 className="text-2xl text-foreground">{title}</h1>
      {description ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
