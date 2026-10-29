# Clientword

Client onboarding for freelancers. A freelancer sets their branding, questions, contract and booking link,
then sends each client a private link. The client answers questions, signs the contract, pays a deposit,
uploads files, books a call and can message back. The freelancer sees everything in one dashboard and gets
emailed when a client finishes.

## Run locally (no AWS, no installs)
    node server.mjs        # http://localhost:3000 (Node 20+)
    node test.mjs          # 148 checks: local store, DynamoDB logic on an in-memory table, and the serverless path

Locally, data is a JSON file in `data/` and emails are printed to the console.

## Run the Next.js version (what Amplify runs)
    npm install
    npm run dev            # http://localhost:3000, still uses the local JSON store unless you set STORE=dynamo

## How it fits together
The app logic lives in one file written against standard `Request`/`Response`, so the same code runs in two hosts:

| Host | Used for |
|---|---|
| `server.mjs` | Local development and tests. Plain Node, no packages. |
| Next.js route handler `app/api/[[...path]]/route.js` | Production on AWS Amplify |

| File | What it does |
|---|---|
| `core.mjs` | Every API route, validation, security checks |
| `runtime.mjs` | Builds the app once per Amplify instance from environment settings |
| `store-local.mjs` / `store-dynamo.mjs` | Same storage interface: JSON file for dev, DynamoDB for AWS |
| `dynamo-adapter.mjs`, `files.mjs`, `mail.mjs` | Thin AWS SDK wrappers (DynamoDB, S3 with presigned links, SES) |
| `limiter.mjs` | Rate limits: in memory locally, DynamoDB counters on Amplify |
| `security.mjs`, `next.config.mjs` | Security headers (CSP etc.) and page routes for Next.js |
| `config.mjs` | Environment settings, and refuses unsafe production config |
| `public/` | Landing page, dashboard, client page (plain JS, served by Next.js as static files) |
| `amplify.yml` | Amplify build settings |
| `infra/template.yaml` | CloudFormation: DynamoDB, S3, the app's IAM role, daily reminders |

See `DEPLOY.md` to put it on AWS.
