import { LogOutIcon } from "lucide-react";
import { useId } from "react";
import { ActorAvatar, ActorBadge } from "@/components/actor";
import type { ShellViewer } from "@/components/app-shell";
import { KeyText } from "@/components/text";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { themeChoices, themeLabels } from "@/lib/theme";

/** The Account tab's screen below 1024px: who you are, the theme, Sign out. */
export function AccountPanel({
  viewer,
  onSignOut,
}: {
  viewer: ShellViewer;
  onSignOut: () => void;
}) {
  const { choice, setChoice } = useTheme();
  const themeHeading = useId();
  return (
    <div className="flex flex-col p-4">
      <div className="flex items-center gap-2">
        <ActorAvatar
          actor={{
            name: viewer.name,
            kind: "human",
            photoUrl: viewer.photoUrl,
          }}
          size="lg"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{viewer.name}</span>
          <KeyText className="truncate font-normal">@{viewer.login}</KeyText>
        </div>
        <ActorBadge kind="human" />
      </div>
      <h2 id={themeHeading} className="mt-6 mb-2 font-medium">
        Theme
      </h2>
      <ToggleGroup
        aria-labelledby={themeHeading}
        spacing={0}
        value={[choice]}
        onValueChange={(value) => {
          // pressing the current choice again empties the group; keep the choice instead
          const next = themeChoices.find((choice) => choice === value[0]);
          if (next) setChoice(next);
        }}
        className="w-full rounded-xl border p-0.5"
      >
        {themeChoices.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className="h-10 flex-1 text-muted-foreground group-data-[spacing=0]/toggle-group:rounded-md aria-pressed:text-foreground"
          >
            {themeLabels[option]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Button variant="outline" className="mt-6 h-11" onClick={onSignOut}>
        <LogOutIcon data-icon="inline-start" aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}
