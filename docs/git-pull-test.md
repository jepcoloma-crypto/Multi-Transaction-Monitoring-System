# Git pull test (new PC)

This file exists to verify the update flow on the new server PC:

1. On the new PC, run the preview — it should list exactly **one** incoming
   commit (`chore: add git-pull test file ...`):

   ```powershell
   cd "C:\Projects\Mutli-Account Balance & Transaction Monitoring System\scripts\migration"
   .\06-pull-updates-new-pc.ps1 -Preview -RepoPath "C:\Projects\Mutli-Account Balance & Transaction Monitoring System"
   ```

2. Then run the real update (typed confirmation):

   ```powershell
   .\06-pull-updates-new-pc.ps1 -RepoPath "C:\Projects\Mutli-Account Balance & Transaction Monitoring System"
   ```

   It pulls, migrates, rebuilds, restarts `monitor-backend`, and asserts the
   health endpoint reports the new commit.

3. When the flow is confirmed working, this file can be deleted in a later
   commit — it has no other purpose.

Added: 2026-11-06
