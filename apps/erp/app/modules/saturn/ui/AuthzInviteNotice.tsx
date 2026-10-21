import { Trans } from "@lingui/react/macro";

/**
 * Shown on the invite page while HQ manages Carbon's permissions (HQ plan
 * 0006B). Joining then writes membership only; the person's access arrives with
 * the next projection sync, about a minute later. The page is public, so it
 * never shows where HQ's access page is.
 */
const AuthzInviteNotice = () => (
  <p className="text-sm text-muted-foreground text-center max-w-md">
    <Trans>
      Your access in Carbon is managed in HQ. After you join, it may take a
      minute to appear.
    </Trans>
  </p>
);

export default AuthzInviteNotice;
