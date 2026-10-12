# SEGUTON ESTATE

A browser-based rental and tenant management system.

## Deploy to Vercel with MongoDB

1. Create a MongoDB Atlas cluster and allow Vercel to connect to it.
2. Import this repository into Vercel.
3. Add these Vercel environment variables for the relevant environments:
   - `MONGODB_URI`: MongoDB Atlas connection string
   - `MONGODB_DB`: database name, for example `seguton`
4. Deploy. The static app is served from `index.html`; `/api/data` is the MongoDB-backed serverless endpoint.

The app automatically uses the API when those variables are configured. If the API is unavailable, it falls back to browser `localStorage`, so local UI testing still works.

## API

- `GET /api/data` — returns tenants and calculated room occupancy
- `POST /api/data` — creates a pending tenant application
- `PATCH /api/data` with `{ "id": 123, "status": "accepted" | "declined" }` — updates an application

Never commit `MONGODB_URI` or other secrets to the repository.
