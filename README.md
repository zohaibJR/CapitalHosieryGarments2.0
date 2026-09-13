# Capital Hosiery Ledger

Deployment-ready split:

- `backend/` is the Render Node/Express/MongoDB API.
- `frontend/` is the Vercel static frontend.

## Local Backend

```powershell
cd backend
npm install
npm start
```

API runs on `http://localhost:4000`.

## Local Frontend

Open `frontend/index.html` directly, or run:

```powershell
cd frontend
npm run dev
```

## Clear Database

```powershell
cd backend
npm run db:clear
```

## Vercel Frontend Config

After Render gives you a backend URL, update `frontend/config.js`:

```js
window.CHGL_CONFIG = {
  API_BASE: 'https://your-render-backend.onrender.com/api'
};
```

## Render Backend Env Vars

Set these in Render:

```text
MONGODB_URI=your MongoDB Atlas URI
FRONTEND_ORIGIN=https://your-vercel-domain.vercel.app
JWT_SECRET=a random value at least 32 characters long
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your first admin password, at least 8 characters
RESET_PASSWORD_TOKEN=a private token used by the reset password screen
```

The backend creates the first admin user on startup if it does not exist yet.
After that, users can change their password inside the app. The reset password
screen works only when the private `RESET_PASSWORD_TOKEN` is entered.
