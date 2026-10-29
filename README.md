# Clientword

Freelancer signs up, sets branding, intake questions and a booking link, adds a client and sends them a private link.
The client answers questions, uploads files and books a call. The freelancer sees everything per client.

    node server.mjs        # http://localhost:3000  (Node 20+, no packages)
    node test.mjs          # 29 API checks

All data access goes through `store.mjs`. For AWS: replace it with DynamoDB (+ S3 for uploads),
swap login for Cognito, and send "your client finished" emails via SES.
