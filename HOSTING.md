# Hosted assignment (what the ClickUp form wants)

The form has **two GitHub/video fields and two “hosted” fields**. They are not
a second codebase.

| Form field | What to paste |
|---|---|
| Assignment Github repository | `https://github.com/Chakresh7/reachinbox-email-scheduler` |
| Assignment Demo Video | Loom or Drive link after you record ([DEMO.md](./DEMO.md)) |
| Hosted Link of the project you have built | The **public Render URL** of the web service (below) |
| Hosted Assignment | **The same URL** as Hosted Link |

Do not paste `localhost`. Reviewers must open the site without cloning.

This app is **API + worker + SPA**. The session cookie only works if the
browser talks to **one HTTPS origin**. The hosted image serves the Vite build
from the API process **and** runs the worker in the same container (Render’s
free tier has no background-worker service).

You already have Neon, Redis Cloud, and Elastic Cloud. Reuse those. Do not
put `backend/.env` in Git.

## Why Render this way

Render’s GitHub App is what failed earlier. This path never uses it.

GitHub Actions (already logged in as Chakresh7) **builds the Docker image**
and pushes it to GHCR. Render only **pulls that image**.

Railway is unused: that account’s trial expired.

## 1. Push the image-build workflow

Commit and push `.github/workflows/hosted-image.yml` to `main`. That starts
the build at:

https://github.com/Chakresh7/reachinbox-email-scheduler/actions

Wait until **hosted-image** is green. The image is:

```
ghcr.io/chakresh7/reachinbox-email-scheduler:latest
```

## 2. Let Render pull the private image

Repo is private, so the package is private. Create a GitHub token with
**read:packages** (and SSO if asked):

https://github.com/settings/tokens → Generate new token (classic) →
`read:packages` only.

Render dashboard → **Account Settings → Registry Credentials → Add** →
GitHub, username `Chakresh7`, password = that token.

## 3. Create one Free web service

1. [https://dashboard.render.com](https://dashboard.render.com) → **New → Web Service**
2. **Existing Image** (not GitHub)
3. Image URL:

   ```
   ghcr.io/chakresh7/reachinbox-email-scheduler:latest
   ```

4. Instance type: **Free**
5. Health check path: `/healthz`
6. Env vars from local `backend/.env`, with these overrides:

```
NODE_ENV=production
LOG_LEVEL=info
REDIS_ASSERT_NOEVICTION=false
FRONTEND_DIST=/app/public
```

Do **not** set `DEV_USER_ID`. Do **not** force `PORT` — Render injects it.

Leave `FRONTEND_URL`, `API_PUBLIC_URL`, and OAuth redirect URIs blank until
the `onrender.com` URL exists, then set them (next step) and redeploy.

## 4. Public URL and OAuth

Copy the service URL. Call it `https://YOUR-SERVICE.onrender.com`.

Set:

```
FRONTEND_URL=https://YOUR-SERVICE.onrender.com
API_PUBLIC_URL=https://YOUR-SERVICE.onrender.com
GOOGLE_REDIRECT_URI=https://YOUR-SERVICE.onrender.com/api/auth/google/callback
SLACK_REDIRECT_URI=https://YOUR-SERVICE.onrender.com/api/slack/callback
```

Manual deploy once more.

Google Cloud Console → authorised **redirect URI** (exact match):

```
https://YOUR-SERVICE.onrender.com/api/auth/google/callback
```

Authorised JavaScript origin:

```
https://YOUR-SERVICE.onrender.com
```

Slack app → redirect URL:

```
https://YOUR-SERVICE.onrender.com/api/slack/callback
```

Keep the localhost URIs as extra rows so local `npm run dev` still works.

## 5. Check it

Open the Render URL. The first hit after idle can take a minute (Free instances
sleep). Sign in with Google. Compose a two-line CSV.

Paste that URL into **both** hosted fields on the ClickUp form.

The demo video (restart worker, Slack) is still easier on `localhost`.
