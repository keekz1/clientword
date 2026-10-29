# Clientword

Client onboarding for freelancers. A freelancer sets their branding, questions, contract and booking link,
then sends each client a private link. The client answers questions, signs the contract, uploads files,
books a call and can message back. The freelancer sees everything in one dashboard and gets emailed when a client finishes.

## Run locally (no AWS, no installs)
    node server.mjs        # http://localhost:3000 (Node 20+)
    node test.mjs          # 110 checks on both storage back ends

Locally, data is a JSON file in `data/` and emails are printed to the console.

## Layout
| File | What it does |
|---|---|
| `server.mjs` | All routes, security headers, rate limits |
| `store-local.mjs` / `store-dynamo.mjs` | Same storage interface: JSON file for dev, DynamoDB for AWS |
| `dynamo-adapter.mjs`, `files.mjs`, `mail.mjs` | Thin AWS SDK wrappers (DynamoDB, S3, SES) |
| `config.mjs` | Environment settings, and refuses unsafe production config |
| `public/` | Landing page, dashboard, client page (plain JS, no build step) |
| `infra/template.yaml`, `Dockerfile` | AWS deployment |

See `DEPLOY.md` to put it on AWS.
