# Questions for Expo (draft for Russell to send)

Shogo runs an Expo/React Native stack for its users. We want to build, test and publish
their iOS and Android apps for them on EAS, billed to us and recharged to the user's
workspace — the user never sees or needs an Expo account. We already resell another API
this way (`services/social/`), so the model is not new to us; what we need from Expo is
the commercial and provisioning footing.

We have already read the public GraphQL schema, so please treat the technical questions
as specific rather than exploratory.

## 1. Creating organisations programmatically

The public GraphQL API exposes `app.createApp`, `robot.createRobotForAccount`,
`accessToken.createAccessToken` and `webhook.createWebhook`, but **no mutation creates an
organisation** (`AccountMutation` only operates on an existing account id).

- Is there a supported way for us to create an organisation under our own Expo user,
  at sign-up scale, without a browser?
- If yes: what is the rate limit, and can the org be created with a robot user and a
  token in the same call?
- If no: would Expo consider opening that mutation to us, or provisioning orgs for us
  through an account-manager arrangement?

We ask because our current design creates **one org per customer workspace**, so that a
leaked robot token exposes one customer's builds and credentials rather than every
customer's.

## 2. Billing across many orgs

- Can a single Expo account be invoiced for a set of organisations it owns, one
  consolidated invoice, rather than one subscription per org?
- Are EAS Build / Workflows / Updates usage reports exposed per org through an API we
  can reconcile against our own metering (build id, resource class, duration, MAUs)?
- Is there a per-org or per-account concurrency ceiling we should plan capacity around?

## 3. Resale

- Do your terms allow us to resell EAS capacity to our customers as part of our product,
  under our brand, with the customer never holding an Expo account or seeing an
  expo.dev URL?
- If yes, is there a reseller / OEM agreement, and what does it change about support
  (who does a customer's build failure go to)?

## 4. Limits

- Projects per account: what is the current, enforced number, and what happens at the
  cap? Our model is one EAS project per Shogo project.
- Builds per hour, and workflow-run limits, for an account operating many projects.
- Updates: is MAU billing the only meter, and how is it reported per project?

## 5. Robot permissions

`robot.createRobotForAccount` takes `Permission` (`OWN | ADMIN | PUBLISH_PROTECTED |
PUBLISH | RUN | VIEW`), which is not the dashboard's `Role` enum. Which `Permission`
gives a robot the equivalent of the dashboard's `Developer` role — build, run workflows
and submit, but not manage billing, members or other projects' credentials?

## 6. Known bug we are working around

[expo/eas-cli#4623](https://github.com/expo/eas-cli/issues/4623): `eas build -p ios` with
a team App Store Connect API key fails with an Apple 401, because `@expo/apple-utils`
signs the ASC JWT with a lifetime of exactly 1200 s — Apple's hard maximum — and any
positive clock skew invalidates it. Every published `eas-cli` (through 27.4.1 /
`@expo/apple-utils` 2.3.0) carries the constant.

- Is a fix planned, and is a safety margin below 1200 s acceptable to ship?
- Meanwhile, is using the GraphQL `build.createIosBuild` mutation with credentials
  resolved client-side a supported path, or is that reserved for your own CLI?

## 7. Webhooks

`webhook.createWebhook` has `event: BUILD | SUBMIT`. Is the `expo-signature` header
HMAC-SHA1 over the raw body with the per-webhook secret, and what is the retry/redelivery
policy? We meter on delivery, so we need to know whether a `finished` event can be
delivered more than once (we de-duplicate, but we would like the delivery semantics in
writing).
