import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";

/** Persist onboarding completion into `argus.json` (`state.onboardingCompleted`), so the welcome
 *  modal doesn't show again on the next startup. Fire-and-forget from the caller's point of view;
 *  errors are the caller's to handle (e.g. surface nothing and let the modal still dismiss locally). */
export async function saveOnboardingCompleted(completed: boolean): Promise<void> {
  const res = await fetchOrOffline("/api/onboarding", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...APP_HEADER },
    body: JSON.stringify({ completed }),
  });
  await jsonOrThrow<{ completed: boolean }>(res, "Failed to save");
}
