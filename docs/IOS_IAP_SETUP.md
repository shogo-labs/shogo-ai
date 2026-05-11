# iOS In-App Purchase Setup (Apple Guideline 3.1.1)

This doc covers the **out-of-repo configuration** required before the iOS IAP code paths added in this branch will work end-to-end. All code is already in place; what remains is App Store Connect / Apple Developer / env vars.

## 1. App Store Connect — create subscription products

In App Store Connect → My Apps → **shogo** → Monetization → In-App Purchases → **Subscriptions**:

Create one subscription group (e.g. `shogo_plans`) containing the following auto-renewable subscriptions. **Product IDs must match exactly** (they're hardcoded in `apps/mobile/lib/iap.ts` and `apps/api/src/services/apple-iap.service.ts`):

| Product ID                    | Plan     | Duration  | Suggested Price |
| ----------------------------- | -------- | --------- | --------------- |
| `ai.shogo.basic.monthly`      | Basic    | 1 month   | match web       |
| `ai.shogo.basic.annual`       | Basic    | 1 year    | match web       |
| `ai.shogo.pro.monthly`        | Pro      | 1 month   | match web       |
| `ai.shogo.pro.annual`         | Pro      | 1 year    | match web       |
| `ai.shogo.business.monthly`   | Business | 1 month   | match web       |
| `ai.shogo.business.annual`    | Business | 1 year    | match web       |

For each product: add display name, description, review screenshot, and submit for review (you can submit IAP products along with the next app version).

> iOS purchases include **1 seat** per subscription. Multi-seat upgrades stay on web (see UX note in `iap.ts`).

## 2. App-Specific Shared Secret

App Store Connect → My Apps → **shogo** → App Information → **App-Specific Shared Secret** → Generate.

Copy the secret and set in your API env:
```
APPLE_IAP_SHARED_SECRET=<the secret>
APPLE_IAP_BUNDLE_ID=com.odin.ai
```

This is what the `/verifyReceipt` endpoint uses to authenticate our server.

## 3. App Store Server Notifications V2

App Store Connect → My Apps → **shogo** → App Information → **App Store Server Notifications**:

- **Production Server URL**: `https://<your-api-host>/api/billing/ios/notifications`
- **Sandbox Server URL**: same, but on the staging API host
- **Version**: V2

Apple will POST renewal / cancellation / refund events to this endpoint.

## 4. Apple Developer Portal — enable IAP capability

developer.apple.com → Certificates, IDs & Profiles → Identifiers → `com.odin.ai`:

- Ensure **In-App Purchase** capability is checked.
- Re-generate the App Store distribution provisioning profile so EAS picks up the new capability on the next build.

## 5. EAS build

After the env vars are set on the API and the App ID has IAP capability, kick off:
```
eas build --platform ios --profile production
```

The `react-native-iap` config plugin (`app.json` line 38) handles linking the native module automatically.

## 6. Testing

- Use a **Sandbox Tester** account (App Store Connect → Users and Access → Sandbox Testers).
- Sign out of the real App Store on the device, then trigger a purchase in TestFlight / dev build — iOS will prompt to sign in with the sandbox account.
- The server verifier auto-falls back from production to sandbox on Apple status `21007`.

## 7. Code map

| File                                                  | Purpose                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `apps/mobile/lib/iap.ts`                              | StoreKit purchase / restore / finish wrapper              |
| `apps/mobile/app/(app)/billing.tsx`                   | iOS branch in `handleCheckout` & `handleManageSubscription` |
| `apps/mobile/lib/api.ts`                              | `verifyAppleReceipt` client                               |
| `apps/api/src/services/apple-iap.service.ts`          | Receipt verification + ASSN V2 handler                    |
| `apps/api/src/server.ts`                              | `POST /api/billing/ios/verify-receipt` + `/notifications` |

## 8. Known limitations / follow-ups

- **JWS signature verification**: the ASSN V2 webhook verifies the outer notification, transaction, and renewal JWS payloads against Apple's x5c certificate chain anchored to Apple Root CA G3. Do not set `APPLE_IAP_SKIP_JWS_VERIFY=1` outside local development.
- **StoreKit 2 JWS path**: the verifier uses the legacy `/verifyReceipt` endpoint, which still works for both SK1 and SK2 receipts as of 2026. Migrating to App Store Server API v2 (`/inApps/v1/transactions/{transactionId}`) is a future optimization.
- **Seat upgrades on iOS**: not supported — iOS purchases include 1 seat per Apple subscription. Additional seats are managed from the web app.
- **Usage overage on iOS**: not sold through IAP. Usage costs remain charged to the Stripe card on file from the web app because adding usage plus Apple's commission would make the price too high.
- **Instance compute upgrades on iOS**: not sold through IAP. Instance resizing stays on Stripe and is managed from the web app.
- **Plan changes (upgrade/downgrade between Pro ↔ Business)**: handled by App Store's subscription group automatic proration. The webhook updates `planId` from `DID_CHANGE_RENEWAL_PREF`.
- **Refunds**: handled via `REFUND` notification → flips status to `canceled`. Wallet balance reset is the responsibility of `billingService.syncFromStripe` (already runs on every receipt sync).
