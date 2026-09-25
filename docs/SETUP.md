# CJ Command — one-time setup

About 45 minutes in total. Everything here is on free plans. Do the steps in order. Where it says **send to Claude**, paste the value into the chat; none of those values are secret. Secrets (the Meta token and Wix key) go only into Cloudflare, never into the chat.

---

## Step 1 — Create a Cloudflare account (3 min)

1. Go to **dash.cloudflare.com/sign-up**.
2. Sign up with your business email and confirm it from your inbox.
3. You do not need to add a website or domain. Skip any prompt that asks for one.

---

## Step 2 — Create the database (5 min)

1. In the Cloudflare dashboard, open **Storage & Databases → D1 SQL Database**.
2. Click **Create database**. Name it exactly `cj-command`. Location: leave automatic. Click **Create**.
3. Open the new database and click **Console**.
4. Open `backend/schema.sql` from the GitHub repo, copy all of it, paste it into the console, and click **Execute**.
5. Paste the contents of `cj-import.sql` (the file Claude sent you in the chat — it is not in GitHub because it holds customer names and your job numbers) and click **Execute**. This brings over your 8 leads and 7 jobs.
6. Add yourself as the owner. Paste this with your own email and name, then **Execute**:

   ```sql
   INSERT INTO users (email, role, name, added_at) VALUES ('you@yourbusiness.com', 'owner', 'Your Name', 0);
   ```

   Use the same email you will sign in with on your phone. Team members are added later from the app.
7. At the top of the database page, copy the **Database ID** (looks like `a1b2c3d4-...`).

**Send to Claude:** the Database ID. Claude puts it in `backend/wrangler.toml` and pushes the change.

---

## Step 3 — Put the server online from GitHub (5 min)

Wait until Claude confirms the Database ID is pushed.

1. In Cloudflare, open **Workers & Pages → Create → Import a repository**.
2. Connect your GitHub account when asked and allow access to `kikosrq99/CJ-COMMAND-CENTER`.
3. Select the repository and set:
   - **Project name:** `cj-command-center`
   - **Production branch:** `claude/jolly-noether-tw3xsg`
   - **Root directory:** `backend`
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
4. Click **Save and Deploy**. After a minute it shows a web address like `https://cj-command-center.<your-name>.workers.dev`.

From now on, every change Claude pushes to that branch goes live by itself.

If the first build ran on the wrong branch or folder, fix the settings under **Settings → Builds**, then ask Claude to push any update. **Retry build** re-runs the old build with its old branch, so it fails the same way.

**Send to Claude:** the `workers.dev` web address.

---

## Step 4 — Turn on the login (5 min)

This makes sure only people you approve can open the app. Each person signs in with a code emailed to them.

1. Open **Workers & Pages → cj-command-center → Settings → Domains & Routes**.
2. Next to the `workers.dev` route, click the **⋯** menu and choose **Enable Cloudflare Access**. If Cloudflare asks you to pick a team name first, choose something like `cjventures` (this becomes `cjventures.cloudflareaccess.com`).
3. Click **Manage Cloudflare Access**. In the application's **Policies**, edit the policy so **Include → Emails** lists your email and any team members' emails. (You can add people here later; they must also be added in the app.)
4. On the same application page, copy the **Application Audience (AUD) Tag** (a long string of letters and numbers).

**Send to Claude:** the AUD tag and your team domain (for example `cjventures.cloudflareaccess.com`).

---

## Step 5 — Connect Meta ad data (15 min)

The server needs its own Meta key so it can pull numbers without your personal login. You must be an **admin** in Meta Business Manager.

### 5a. Put both ad accounts in one business

Your two ad accounts sit in different businesses in Meta:
- `1275464164004722` (CJ Flooring) is owned by **CJFlooring Style**.
- `1171862311644217` (Pool Resurfacing) is owned by **CJ Ventures Professional Bookkeeping**.

A Meta key can only read accounts in its own business, so share the pool account with CJFlooring Style:

1. Go to **business.facebook.com/settings** and switch to the **CJ Ventures Professional Bookkeeping** business (top-left menu).
2. **Accounts → Ad accounts →** select `1171862311644217` → **Assign partners**.
3. Enter the CJFlooring Style business ID **859077960171549**, turn on **View performance**, and save.

### 5b. Create a Meta app (needed to make a key)

1. Go to **developers.facebook.com/apps** → **Create app**.
2. Use case: **Other** → type **Business**. Name it `CJ Command`. Connect it to the **CJFlooring Style** business. Create.

### 5c. Create the key

1. Back in **business.facebook.com/settings** (switch to **CJFlooring Style**), open **Users → System users → Add**.
2. Name `CJ Command`, role **Employee**. Create.
3. With the system user selected, click **Assign assets → Ad accounts**. Select both ad accounts and turn on **View performance** only. Save.
4. Also **Assign assets → Apps →** `CJ Command` with **Develop app**. Save.
5. Click **Generate new token**. App: `CJ Command`. Expiration: **Never**. Permissions: **ads_read** only. Generate.
6. Copy the token. Meta shows it only once.

### 5d. Give the key to the server (not to Claude)

1. In Cloudflare, open **Workers & Pages → cj-command-center → Settings → Variables and Secrets → Add**.
2. Type **Secret**, name `META_TOKEN`, paste the token, **Deploy**.

---

## Step 6 — Connect website and Google Search data (5 min)

1. Go to **manage.wix.com/account/api-keys** → **Generate API Key**.
2. Name it `CJ Command`. Under permissions for your site `cjfloorstyle.com`, give read access to **Site Analytics** and **SEO** (includes Google Search Console). Nothing else.
3. Generate and copy the key.
4. In Cloudflare: **cj-command-center → Settings → Variables and Secrets → Add** → type **Secret**, name `WIX_API_KEY`, paste, **Deploy**.

---

## Step 7 — Check it works (2 min)

1. On your phone, open `https://cj-command-center.<your-name>.workers.dev/api/me`.
2. Enter your email, then the code Cloudflare emails you.
3. You should see your email and `"role":"owner"`.
4. Within 15 minutes, `/api/snapshot` fills with your ad, website and Google numbers.

Tell Claude it's working. The phone app is built on top of this next.

---

## Optional — Floco live ads (takes days, Meta's process)

Meta requires ID verification for its Ad Library data.

1. Go to **facebook.com/ID** and confirm your identity (photo ID, then a code Meta mails to your address).
2. When confirmed, tell Claude. Claude walks you through creating `ADLIB_TOKEN` the same way as step 5d.

Until then, the Floco section shows "not connected yet" and everything else works.

---

## Adding or removing team members later

1. Add their email in **Cloudflare Access** (step 4, item 3) so they can sign in.
2. Add them in the app's team screen (or ask Claude) as `team` or `owner`.

Removing is the reverse. Removing them in either place blocks them.
