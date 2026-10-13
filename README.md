# SEGUTON ESTATE

A browser-based rental and tenant management system.

## Included features

- Tenant registration with room availability and rent-balance calculations
- MongoDB-only persistence through Vercel serverless functions; no browser localStorage is used
- Management dashboard with occupancy, pending approvals, collections, and outstanding balances
- Search and status filters for tenant applications
- Accept/decline workflow with duplicate ID and occupied-room protection
- Payment updates for accepted tenants
- Excel reporting for tenant records and summaries
- Responsive interface with sync-status feedback

## Deploy to Vercel with MongoDB

1. Create a MongoDB Atlas cluster and allow Vercel to connect to it.
2. Import this repository into Vercel.
3. Add these Vercel environment variables for the relevant environments:
   - `MONGODB_URI`: MongoDB Atlas connection string
   - `MONGODB_DB`: database name, for example `seguton`
4. Deploy. The static app is served from `index.html`; `/api/data` is the MongoDB-backed serverless endpoint. On the first successful request, it creates/updates the `rooms` collection with all 14 rooms.

The app requires the API and MongoDB environment variables. If the database is unavailable, the UI shows an error and does not save data locally.

## API

- `GET /api/data` — connects to MongoDB, automatically seeds the full 14-room catalog, and returns tenants plus room occupancy
- `POST /api/data` — creates a pending tenant application
- `PATCH /api/data` with `{ "id": 123, "status": "accepted" | "declined" }` — updates an application
- `PATCH /api/data` with `{ "id": 123, "paid": 5000 }` — records a tenant payment and recalculates the balance

Never commit `MONGODB_URI` or other secrets to the repository.
