## Service-managed state directories reject relocated symlinks

**Context:** Keeping a server's Tailscale identity on a retained data disk.

**Problem:** The packaged service's `StateDirectory=tailscale` rejected the relocated directory symlink and failed with `238/STATE_DIRECTORY` before enrollment.

**Rule:** When bootstrap owns and secures a relocated state directory, clear the conflicting packaged `StateDirectory` in its service override and retain the mount dependency. Verify the actual service starts on the target operating system.

**Applies to:** Persistent Tailscale state and other systemd services with relocated directories.
