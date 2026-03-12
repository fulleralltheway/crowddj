# PartyQueue Go Live

Push all changes to production. Build, commit, push, deploy, and troubleshoot any issues automatically.

## Step 1: Check for changes

Run `git status` and `git diff --stat` to see what's changed. If there are NO changes (no modified, untracked, or staged files), tell the user "Nothing to deploy — working tree is clean" and stop.

## Step 2: Build

Run `npm run build` in `/Users/jonathanfuller/spotifyapp`.

**If the build fails:**
1. Read the error output carefully
2. Identify the failing file(s) and line(s) from the error
3. Read the file(s) and fix the issue
4. Re-run `npm run build`
5. Repeat up to 3 times. If still failing after 3 attempts, stop and report the issue to the user

## Step 3: Bump SW cache version

Read `public/sw.js` and check the `CACHE_NAME` value. Increment the version number (e.g., `partyqueue-v47` -> `partyqueue-v48`). This ensures users get fresh assets after deploy.

## Step 4: Commit

1. Stage all changed files with `git add` (use specific file paths, not `-A`)
2. Write a concise commit message that summarizes all the changes (look at the diff to understand what changed)
3. Commit with the message. End every commit message with:
   ```
   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   ```
4. If the commit fails (pre-commit hook, etc.), diagnose and fix, then retry as a NEW commit

## Step 5: Push to GitHub

Run `git push origin main`.

**If push fails:**
- If rejected (non-fast-forward): run `git pull --rebase origin main`, resolve any conflicts, then push again
- If auth fails: tell the user to check their GitHub credentials
- For other errors: diagnose and report

Since Vercel auto-deploys on push to main, this triggers the production deploy.

## Step 6: Check if socket server needs deploy

Look at the git diff for the commit(s) being deployed. If `socket-server.ts` or `Dockerfile.socket` was modified, tell the user:

> "Socket server changed — run `flyctl deploy --app crowddj-socket` to deploy the socket server to Fly.io too."

Otherwise skip this step silently.

## Step 7: Confirm

Output a short summary:
- What was committed (files changed)
- Commit hash
- That Vercel deploy was triggered
- Whether socket server deploy is needed
