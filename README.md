# SEGUTON ESTATE

A browser-based rental and tenant management system.

## Included features

- Tenant registration with room availability and rent-balance calculations; new applications continue directly to the tenant payment portal
- Database-only persistence through Vercel serverless functions; no browser localStorage is used
- Management dashboard with occupancy, pending approvals, collections, and outstanding balances
- Search and status filters for tenant applications
- Accept/decline workflow with duplicate ID and occupied-room protection
- Payment updates for accepted tenants
- Excel reporting for tenant records and summaries
- Responsive interface with sync-status feedback
- One-time administrator account setup with email, phone number, and password
- Secure management login with HTTP-only sessions and hashed passwords
- Settings tab for changing the administrator password
- Password-confirmed administrator account deletion with explicit `DELETE` confirmation; tenant and room records are preserved
- Non-blocking toast notifications for API errors, validation failures, authentication, payments, and successful actions
- Faster first paint with deferred reporting-library loading, request loading states, disabled duplicate-submit protection, and accessible active navigation
- Tenant registration collects normalized Kenyan phone numbers, validates the 8-digit Kenyan National ID format, auto-fills the rent due, and only shows available rooms
- Tenant Portal login using name, National ID, and phone number shows applications, payment history, total paid, and live balance
- Management payment entry accepts the amount received, adds it to the tenant total, and makes the new payment visible in the Tenant Portal
- Admin payment-history deletion requires confirmation and resets the tenant paid total to Ksh 0 with the full balance restored
- Admin tenant deletion permanently removes the application, payment, fee, and personal details after typed `DELETE TENANT` confirmation; the tenant's room is immediately available again
- Admin monthly rent generation adds one base-rent charge per accepted tenant, updates balances, and prevents duplicate charges for the same month
- Admin fee management for Water, Electricity, Service charge, Garbage collection, Penalty, and custom fees with descriptions, tenant-visible charge history, balance updates, and Excel reporting
- Tenant Portal STK Push payments through CourtneyTech with server-side credentials and confirmed-payment callbacks; successful registration opens this payment flow instead of the admin dashboard
- Admin dashboard live polling with toast and banner notifications for confirmed M-Pesa payments, including amount, room, and receipt
- Automated tenant notifications when monthly rent or a utility fee is generated, using optional email and/or SMS delivery

## Deploy to Vercel with a Database

1. Create the configured database instance and allow Vercel to connect to it.
2. Import this repository into Vercel.
3. Add these Vercel environment variables for the relevant environments:
   - `MONGODB_URI`: MongoDB Atlas connection string
   - `MONGODB_DB`: database name, for example `seguton`
   - `SESSION_SECRET`: a random secret of at least 32 characters for secure administrator sessions
   - `COURTNEY_API_KEY`: CourtneyTech API key
   - `COURTNEY_API_SECRET`: CourtneyTech API secret; never expose this in browser code
   - `COURTNEY_ACCOUNT_ID`: `payment_account_id` from CourtneyTech `GET /v2/accounts`
   - `COURTNEY_BASE_URL`: `https://courtneytech.xyz/api`
   - `COURTNEY_CALLBACK_BASE_URL`: your public Vercel URL, for example `https://seguton.vercel.app`
   - `COURTNEY_CALLBACK_SECRET`: a random callback secret used to protect payment confirmations
   - `RESEND_API_KEY`: optional Resend API key for tenant email notifications
   - `NOTIFICATION_FROM_EMAIL`: verified Resend sender, for example `SEGUTON <notifications@example.com>`
   - `AT_USERNAME`: optional Africa's Talking username for tenant SMS notifications
   - `AT_API_KEY`: Africa's Talking API key
   - `AT_SENDER_ID`: optional approved SMS sender ID

   The primary variable name must be exactly `MONGODB_URI`. The API also accepts `MONGODB_URL` and `MONGO_URI` for compatibility, but `MONGODB_URI` is recommended. Environment variables must be enabled for Production, and the project must be redeployed after changes.
4. Deploy. The static app is served from `index.html`; `/api/data`, `/api/tenant`, `/api/stkpush`, and `/api/stk-callback` are serverless endpoints. Do not add a catch-all rewrite in the Vercel dashboard; Vercel natively routes the root `api/` directory to Functions. On the first successful request, it creates/updates the `rooms` collection with all 14 rooms.

The app requires the API and database environment variables. If the database is unavailable, the UI shows an error and does not save data locally. Notification delivery is optional and never prevents a rent or fee update from being saved; configure either Resend, Africa's Talking, or both.

## API

- `GET /api/data` — connects to the database, automatically seeds the full 14-room catalog, and returns tenants plus room occupancy
- `POST /api/data` — creates a pending tenant application
- `PATCH /api/data` with `{ "id": 123, "status": "accepted" | "declined" }` — updates an application
- `PATCH /api/data` with `{ "id": 123, "paid": 5000 }` — records a tenant payment and recalculates the balance
- `PATCH /api/data` with `{ "id": 123, "action": "delete-payment-history", "confirmation": "DELETE" }` — admin-only destructive reset of payment history and paid total
- `PATCH /api/data` with `{ "id": 123, "action": "delete-tenant", "confirmation": "DELETE TENANT" }` — admin-only permanent tenant deletion; the removed tenant's room is released automatically
- `PATCH /api/data` with `{ "action": "generate-monthly-rent", "month": "2026-10" }` — admin-only idempotent monthly rent generation for accepted tenants
- `PATCH /api/data` with `{ "id": 123, "action": "add-fee", "feeCategory": "Water", "feeAmount": 500, "feeDescription": "October water bill" }` — admin-only fee assessment and balance update
- Monthly rent generation and fee assessment automatically attempt to notify the tenant by SMS and/or email with the charge amount, room, and updated balance
- `/api/auth` — one-time administrator setup, login, logout, session status, and password changes
- `POST /api/tenant` — verifies tenant name, 8-digit ID, and phone and returns applications/payment history
- `POST /api/stkpush` — sends an STK prompt for an outstanding tenant balance; payment is not credited until the provider callback confirms success
- `POST /api/stk-callback` — receives CourtneyTech payment results and records successful M-Pesa payments
- `GET /api/data?view=rooms` — public room catalog for tenant registration; tenant records require administrator login

Never commit `MONGODB_URI` or other secrets to the repository.
