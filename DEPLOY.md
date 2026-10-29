# Deploying Clientword on AWS Amplify

Everything here is serverless, so you pay close to nothing until you have real users.
Do these in order. Use one region for everything (e.g. `eu-west-2`, London).

> **Status:** the app logic, DynamoDB layout, presigned uploads and rate limiting are covered by `node test.mjs`
> (against an in-memory table and a fake bucket). The Next.js wrapper, `amplify.yml`, the CloudFormation template
> and the real AWS calls have **not** been run end to end yet. Expect to fix small things on your first deploy,
> and do a test run (steps 6 and 7) before inviting anyone real.

## 1. Check it runs on your machine
    npm install
    npm run dev        # open http://localhost:3000, sign up, add a client, open its link
    node test.mjs
If `npm run dev` fails, fix that first: send me the error.
Commit the `package-lock.json` that `npm install` creates.

## 2. Create the data layer (DynamoDB, S3, IAM role)
AWS Console > CloudFormation > Create stack > upload `infra/template.yaml`.
- `AppUrl`: your final address if you know it (e.g. `https://clientword.co.uk`), otherwise leave the placeholder and update the stack in step 5.
- `CronSecret`: a long random string (24+ characters). Save it.
- `EnableReminders`: leave `false` for now.

When it finishes, open the **Outputs** tab. You need `TableName`, `BucketName` and `AppRoleArn`.

## 3. Verify email sending (SES)
SES > Verified identities > create one for your domain (or, to test, your own address) and add the DNS records.
New accounts start in the SES sandbox (can only email verified addresses): request production access
(SES > Account dashboard) before real clients use it.

## 4. Create the Amplify app
Amplify > Create new app > GitHub > `keekz1/clientword`, branch `main`. It detects Next.js and `amplify.yml`.
Before the first build, add **Environment variables**:

| Name | Value |
|---|---|
| `STORE` | `dynamo` |
| `TABLE_NAME` | from step 2 |
| `BUCKET` | from step 2 |
| `APP_REGION` | e.g. `eu-west-2` |
| `APP_URL` | your public https address, no trailing slash |
| `MAIL` | `ses` |
| `MAIL_FROM` | e.g. `Clientword <hello@yourdomain.co.uk>` (must be on the SES identity) |
| `TRUST_PROXY` | `1` |
| `CRON_SECRET` | the same secret as step 2 |

Then App settings > **IAM roles** > Compute role > choose the role from `AppRoleArn`. Without this the app
cannot reach DynamoDB, S3 or SES. Deploy.

## 5. Address and final URL
If you use the Amplify address (`https://main.dxxxx.amplifyapp.com`) or add a custom domain (Amplify > Domain management),
put the final address in `APP_URL` (redeploy) **and** update the CloudFormation stack's `AppUrl` parameter. That parameter
controls which website may upload files to your bucket, so uploads fail until it matches.

## 6. Test it properly
- Sign up, confirm the email link arrives, log in.
- Add a client and open the client link in a private window.
- Upload a file (this goes straight from the browser to S3) and download it from the dashboard.
- Sign the contract, send a message each way, check the emails arrive.
- If something fails: Amplify > your app > Hosting > Monitoring > Logs (the server's log lines are JSON).

## 7. Turn on reminders
Update the stack with `EnableReminders = true` (and the right `AppUrl`). EventBridge then calls
`/api/cron/reminders` daily with your secret.

## Cost
Amplify hosting, DynamoDB on-demand, S3 and SES are all pay-per-use. At small scale expect pennies a month
(Amplify has a free tier for builds and hosting). The cost to watch is email volume and stored files.

## Things to know
- Uploads are capped at 25 MB each because freelancers should share big deliverables as links (Drive, Dropbox, WeTransfer).
  The cap is `MAX_UPLOAD` in `core.mjs`; raising it is safe now that files go straight to S3.
- A client who starts an upload and never finishes leaves an unused object in the bucket. Harmless at this scale; add an S3 lifecycle rule later if it ever matters.
- Sessions last 14 days and live in DynamoDB, so deploys don't log anyone out.
- Not yet done: privacy policy and terms pages, solicitor review of the e-sign wording, Stripe payments.
