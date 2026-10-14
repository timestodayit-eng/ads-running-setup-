# Creative International — Full-stack Ads Manager (GitHub → Hostinger Cloud)

A functional **admin login + 10 account database + individual settings + 1 GiB R2 video upload + campaign draft and review + authorized Meta account discovery/mapping** application.

**IMPORTANT LIMITATION:** Real Meta campaign creation and insights synchronization are NOT implemented. The builder **saves drafts only**. There is no mock “publish succeeded” button. Meta campaigns require account-specific Page/identity, pixel/event/lead/phone destination support, policy-approved targeting, creatives and objective-specific payload validation, rate-limit handling, and safe job processing. Do not describe this version as a finished live Meta publisher.

## 1. Upload to GitHub

- Create a **private** GitHub repository, e.g. `creative-international-ads-manager`.
- Upload the **contents** of this folder to the repository root (`package.json`, `src/`, `server/`, `sql/`, `vite.config.js`, `index.html`).
- `.env` and `node_modules/` must NOT be uploaded. `.gitignore` protects them.

## 2. Supabase project

1. Create a Supabase project. Open **SQL Editor**, run `sql/schema.sql` once.
2. Open **Authentication → Users** and **invite** your admin email (or create the user using the Supabase dashboard).
3. Copy the user's UUID, and add them as admin in SQL editor:
   ```sql
   insert into public.staff(id,role,active)
   values('REPLACE_WITH_AUTH_USER_UUID','super_admin',true)
   on conflict(id) do update set role='super_admin',active=true;
   ```
4. Disable public signups in Supabase Auth settings. Configure your site URL and allowed redirect URLs for your real Hostinger domain.
5. Copy Supabase Project URL, **anon key**, and **service_role key** from the project. Service role must stay in server environment variables only.

## 3. Cloudflare R2 for 500 MB–1 GB videos

1. Create a **private R2 bucket** such as `ci-ads-videos` (do not make video assets public).
2. Create R2 S3-compatible API token/credentials with write permissions on that bucket.
3. Set bucket CORS to permit **PUT** from your deployed site (`https://ads.creativeinternationalbd.com`) and **expose the `ETag` header**. Example CORS JSON in `r2-cors.example.json`.
4. Enter R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in Hostinger environment settings.
5. Videos are streamed browser→R2 in 16 MiB parts. Large files never go through the Hostinger Express upload endpoint. An interrupted browser upload can leave incomplete multipart uploads; configure an R2 lifecycle rule to abort incomplete uploads and clean up DB upload records when needed.

## 4. Hostinger Cloud from GitHub

1. In **hPanel → Websites → Add Website → Node.js Web App / Deploy Web App**, choose **GitHub repository**.
2. Authorize Hostinger to your selected **private** GitHub repository and select the default branch.
3. Build command: `npm run build`; install command: `npm install`; start command: `npm start`; Node.js **20+** (prefer supported LTS). The server uses `process.env.PORT`.
4. Add server environment variables from `.env.example` in Hostinger project settings (actual secrets only there).
5. Add **client-side build-time environment variables**: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (use the same public URL and anon key; these are intentionally public). They MUST exist during `npm run build`.
6. Deploy and connect `ads.creativeinternationalbd.com` as a subdomain, without replacing your main site. Enable HTTPS.
7. Browse `/api/health` to check database/storage/Meta configuration flags, then visit `/` to sign in.

**Hostinger caveat:** Hosting features and UI labels vary by Cloud plan. You need a deployment offering supporting a persistent Node.js/Express server (not static-only Vite hosting). If your Cloud product cannot start `node server/index.js`, deploy backend to an appropriate Node.js host/VPS and point frontend `/api` to that backend via configured reverse proxy. Do not expose the service-role key to the browser.

## 5. Connecting Meta (account discovery)

1. Create/configure Meta Business/Developer App; obtain appropriate permissions and business assets via an authorized process according to current Meta Marketing API rules.
2. Securely set `META_ACCESS_TOKEN` on the **server**. Never put Meta tokens in GitHub, frontend code or localStorage.
3. In the application, open **Integration Settings → Discover available accounts**, then assign discovered `act_...` account IDs to CI-01–CI-10.
4. Each Meta account requires proper ad-account asset access. Only admins can sync and map accounts. A mapped account is **not** proof of current publish permission.
5. Any real employment advertising must comply with Employment Special Ad Category restrictions. The `audience_note` column is informational and does not constitute Meta targeting JSON.

## 6. Roles / API

- **super_admin:** account discovery/mapping, account edits, video upload, draft creation.
- **ads_manager:** account edits, video upload, draft creation.
- **analyst:** read-only.
- Express verifies the Supabase bearer token via `auth.getUser` on every request and checks the server-side `staff` allowlist. SQL tables have RLS enabled; browser does not directly access data tables.
- Endpoints: `/api/health`, `/api/me`, `/api/accounts`, `/api/videos`, `/api/videos/start`, `/api/videos/:id/part-url`, `/api/videos/:id/complete`, `/api/drafts`, `/api/meta/sync-accounts`, `/api/meta/map-account`.

## 7. Development and build check

For a local development run **only** (production is GitHub/Hostinger):

```bash
cp .env.example .env
# fill server secrets in .env, and create .env.local with PUBLIC VITE_* keys
npm install
npm run dev
```

`npm run build` produces the frontend `dist/`; `npm start` serves it and API routes from Express.

## 8. Production readiness checklist

- [ ] Private GitHub repo, successful Hostinger build
- [ ] Supabase Auth + SQL schema + first admin allowlist entry
- [ ] HTTPS, secure server environment variables, backups
- [ ] Cloudflare R2 private bucket, ETag CORS, upload tested at 1 GiB
- [ ] Authorized Meta token and mapping CI-01…CI-10
- [ ] Campaign objective-specific Meta ad creation implementation and tested **paused** ads
- [ ] Async publishing queue/idempotency/retries, per-account errors, Meta compliance
- [ ] Audit logs, token rotation, access reviews, storage lifecycle, observability

The last three items are **future development** and must be completed before any live publishing claims.
