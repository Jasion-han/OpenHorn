/**
 * Which hero line the welcome screen shows, by hour.
 *
 * Only the mapping lives here — the copy itself stays in the i18n dictionary,
 * where every piece of user-facing Chinese belongs. Splitting it this way keeps
 * the one part with an off-by-one risk (the boundaries) testable without
 * pinning the wording, so the copy can be rewritten without touching a test.
 *
 * Boundaries follow when people work rather than astronomy: the small hours
 * read as still being up, not as an early morning.
 *
 * The morning is split in two because it is the one stretch where a single
 * phrase ages badly — a line about the day just breaking is still on screen at
 * 11am, which reads as broken rather than as atmosphere.
 */
export type WelcomeTitleKey =
  | "chat.welcome.title.lateNight"
  | "chat.welcome.title.morning"
  | "chat.welcome.title.forenoon"
  | "chat.welcome.title.afternoon"
  | "chat.welcome.title.evening";

export function welcomeTitleKeyFor(hour: number): WelcomeTitleKey {
  if (hour < 5) return "chat.welcome.title.lateNight";
  if (hour < 9) return "chat.welcome.title.morning";
  if (hour < 12) return "chat.welcome.title.forenoon";
  if (hour < 18) return "chat.welcome.title.afternoon";
  return "chat.welcome.title.evening";
}
