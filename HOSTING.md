# Hosted assignment (what the ClickUp form wants)

The form has **two GitHub/video fields and two “hosted” fields**. They are not
a second codebase.

| Form field | What to paste |
|---|---|
| Assignment Github repository | `https://github.com/Chakresh7/reachinbox-email-scheduler` |
| Assignment Demo Video | Loom or Drive link after you record ([DEMO.md](./DEMO.md)) |
| Hosted Link of the project you have built | The **public dashboard URL** from Render (below), e.g. `https://reachinbox-web.onrender.com` |
| Hosted Assignment | **The same URL** as Hosted Link |

Do not paste `localhost`. Reviewers must open the site without cloning.

This app is **API + worker + SPA**. The session cookie only works if the
browser talks to **one HTTPS origin** that proxies `/api` (same as Vite in
dev). Render is set up that way: the **web** service is the public URL.

You already have Neon, Redis Cloud, and Elastic Cloud. Reuse those. Do not
put `backend/.env` in Git.

## 1. Create a Render account

1. Sign up at [https://render.com](https://render.com) with GitHub.
2. New → **Blueprint** → this repository → `render.yaml`.
3. Fill the env group `reachinbox` (dashboard → Environment Groups) **before**
   the first deploy finishes, using the same secrets as local `backend/.env`
   except the URLs below.

## 2. Public URL and OAuth

After the **web** service is live, copy its URL. Call it `https://YOUR-WEB.onrender.com`.

Set these on the **api** service (and keep web `API_UPSTREAM` pointing at the
api’s **internal** host `http://reachinbox-api:4000`):

```
NODE_ENV=production
FRONTEND_URL=https://YOUR-WEB.onrender.com
API_PUBLIC_URL=https://YOUR-WEB.onrender.com
GOOGLE_REDIRECT_URI=https://YOUR-WEB.onrender.com/api/auth/google/callback
SLACK_REDIRECT_URI=https://YOUR-WEB.onrender.com/api/slack/callback
```

Google Cloud Console → OAuth client → authorised **redirect URI** (exact match):

```
https://YOUR-WEB.onrender.com/api/auth/google/callback
```

Authorised JavaScript origin:

```
https://YOUR-WEB.onrender.com
```

Slack app → redirect URL:

```
https://YOUR-WEB.onrender.com/api/slack/callback
```

Leave the localhost URIs in place as extra rows so local `npm run dev` still
works.

If Redis Cloud blocks `CONFIG GET`, set `REDIS_ASSERT_NOEVICTION=false` (you
already verified `noeviction` locally).

## 3. Redeploy

Trigger a manual deploy of **api**, then **worker**, then **web**. Open:

```
https://YOUR-WEB.onrender.com
```

Sign in with Google (production ignores `DEV_USER_ID`). Compose a two-line CSV.
If the first request is slow, Render’s free web may be waking up.

Paste that URL into **both** hosted fields on the ClickUp form.

## 4. What you still record locally

The demo video (restart worker, Slack) is easier on `localhost`. Hosted is for
reviewers clicking the form link.
