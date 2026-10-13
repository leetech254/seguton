# SEGUTON ESTATE

A browser-based rental and tenant management system.

## Included features

- Tenant registration with room availability and rent-balance calculations
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
- Tenant registration collects normalized Kenyan phone numbers, validates the 8-digit Kenyan National ID format, auto-fills the full room payment, and only shows available rooms

## Deploy to Vercel with a Database

1. Create the configured database instance and allow Vercel to connect to it.
2. Import this repository into Vercel.
3. Add these Vercel environment variables for the relevant environments:
   - `MONGODB_URI`: MongoDB Atlas connection string
   - `MONGODB_DB`: database name, for example `seguton`
   - `SESSION_SECRET`: a random secret of at least 32 characters for secure administrator sessions

   The primary variable name must be exactly `MONGODB_URI`. The API also accepts `MONGODB_URL` and `MONGO_URI` for compatibility, but `MONGODB_URI` is recommended. Environment variables must be enabled for Production, and the project must be redeployed after changes.
4. Deploy. The static app is served from `index.html`; `/api/data` is the database-backed serverless endpoint. Do not add a catch-all rewrite in the Vercel dashboard; Vercel natively routes the root `api/` directory to Functions. On the first successful request, it creates/updates the `rooms` collection with all 14 rooms.

The app requires the API and database environment variables. If the database is unavailable, the UI shows an error and does not save data locally.

## API

- `GET /api/data` — connects to the database, automatically seeds the full 14-room catalog, and returns tenants plus room occupancy
- `POST /api/data` — creates a pending tenant application
- `PATCH /api/data` with `{ "id": 123, "status": "accepted" | "declined" }` — updates an application
- `PATCH /api/data` with `{ "id": 123, "paid": 5000 }` — records a tenant payment and recalculates the balance
- `/api/auth` — one-time administrator setup, login, logout, session status, and password changes
- `GET /api/data?view=rooms` — public room catalog for tenant registration; tenant records require administrator login

Never commit `MONGODB_URI` or other secrets to the repository.
