# Deploying Clientword to AWS

> **Warning (checked 29 Oct 2026):** AWS has closed App Runner to new customers. Existing customers can keep using it, but a new AWS
> account may not be able to create an App Runner service, and AWS recommends **Amazon ECS Express Mode** instead.
> `infra/template.yaml` currently targets App Runner, so treat it as a reference until it is changed to ECS Express Mode
> or the app is moved to Next.js on Amplify. See https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html

Runs as one container on **AWS App Runner**, with **DynamoDB** (data), **S3** (uploaded files) and **SES** (email).
`infra/template.yaml` creates all of it. Costs a few pounds a month at small scale (check the AWS pricing calculator).

> Status: the app logic is tested (110 checks, including the DynamoDB logic on an in-memory table).
> The thin AWS SDK wrappers (`dynamo-adapter.mjs`, `files.mjs`, `mail.mjs`) and `infra/template.yaml`
> have **not** been run against real AWS yet. Do a first deployment in a throwaway stack and click through it.

## 1. One-off setup
1. **Region:** use `eu-west-2` (London) unless you have a reason not to.
2. **SES (email):** SES > Verified identities > add your domain (or an address). Add the DNS records it gives you.
   New accounts start in the *sandbox* (can only email verified addresses): request production access.
3. **ECR (image store):** `aws ecr create-repository --repository-name clientword`

## 2. Build and push the image
```
docker build -t clientword .
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag clientword <account>.dkr.ecr.<region>.amazonaws.com/clientword:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/clientword:latest
```

## 3. Create the stack
```
aws cloudformation deploy --template-file infra/template.yaml --stack-name clientword \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=<account>.dkr.ecr.<region>.amazonaws.com/clientword:latest \
    AppUrl=https://app.yourdomain.co.uk MailFrom="Clientword <hello@yourdomain.co.uk>" CronSecret=<long random string>
```
`AppUrl` is the public https address used in emails. The app refuses to start in production without it.
If you don't have a domain yet, deploy once with a placeholder, read `ServiceUrl` from the stack outputs,
then run the command again with `AppUrl=https://<that url>`.

## 4. Custom domain
App Runner console > your service > Custom domains > add `app.yourdomain.co.uk` and create the DNS records it shows.

## 5. Daily reminders
Call this once a day from any scheduler that can send an HTTPS POST (e.g. EventBridge with an API destination, or a cron service):
```
POST https://app.yourdomain.co.uk/api/cron/reminders
x-cron-secret: <your CronSecret>
```
It emails clients who were invited but haven't finished, every 3 days, up to 3 times.

## 6. Updating
Push a new image, then in App Runner choose **Deploy** (auto-deploy is off on purpose).

## Before you take real customers
- [ ] Privacy policy and terms of service pages (and a cookie notice if you add analytics)
- [ ] Have a solicitor review the e-signature wording and your contract template
- [ ] Email verification for new freelancer accounts (not built yet)
- [ ] Account deletion and data export for freelancers (GDPR; not built yet)
- [ ] SES bounce and complaint handling
- [ ] A billing alarm in AWS Budgets
- [ ] Rate limits are per instance: keep App Runner at 1 instance until you move them to DynamoDB/Redis
- [ ] Test restoring DynamoDB from point-in-time backup once
