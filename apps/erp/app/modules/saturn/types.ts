// Saturn fork (HQ plan 0006B): whether HQ's authz service manages Carbon's
// permissions, and where to change them.

export type AuthzManagement =
  | { managed: false; accessUrl: null }
  | { managed: true; accessUrl: string };
