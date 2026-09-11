# Multi-Account Balance & Transaction Monitoring System

A production-quality local-first financial monitoring system for managing multiple accounts, transactions, fund transfers, and loading operations.

## Features

### Core Features
- **Dashboard** - Real-time KPIs, charts, today's summary
- **Account Management** - Multiple accounts with balance tracking
- **Transactions** - CRUD with fees, additional charges, reversal
- **Fund Transfers** - Transfer between accounts
- **Loading** - Load products and sales tracking
- **Reports** - Financial reports and analytics

### Administration
- **Transaction Fees** - Fixed, percentage, tiered, flat+per step
- **Additional Charges** - Predefined charge types
- **Customer Management** - Customer profiles with transaction history
- **Providers** - Service provider management
- **Import Data** - CSV/Excel import
- **Settings** - System configuration
- **Audit Logs** - Activity tracking
- **Backup/Restore** - Database backup and restore

### Security
- JWT authentication with token blacklist
- Role-based access control (RBAC)
- Password hashing with bcryptjs
- Rate limiting (500 req/15min general, 20 req/15min auth)
- Security headers, XSS sanitization

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 18 |
| Auth | JWT (access + refresh tokens) |

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 18+
- npm

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup Database
```bash
# Create database
createdb multi_account_monitor

# Run migrations (from backend directory)
cd packages/backend
npx ts-node src/database/migrate.ts
```

### 3. Configure Environment
Create `packages/backend/.env`:
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=multi_account_monitor
DB_USER=postgres
DB_PASSWORD=postgres
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:5173
```

### 4. Start Development
```bash
# From root - starts both backend and frontend
npm run dev

# Or start separately
cd packages/backend && npm run dev
cd packages/frontend && npm run dev
```

### 5. Login
- URL: http://localhost:5173
- Username: `admin`
- Password: `password`

## Project Structure

```
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── routes/        # API endpoints
│   │   │   ├── middleware/     # Auth, error handling
│   │   │   ├── services/      # Business logic
│   │   │   ├── database/      # Connection, migrations
│   │   │   └── index.ts       # Entry point
│   │   └── package.json
│   └── frontend/
│       ├── src/
│       │   ├── pages/         # React pages
│       │   ├── components/    # Reusable components
│       │   ├── contexts/      # Auth context
│       │   ├── lib/           # API, utilities
│       │   └── App.tsx        # Router
│       └── package.json
└── package.json               # Root workspace
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh` - Refresh token

### Transactions
- `GET /api/transactions` - List (with filters)
- `GET /api/transactions/summary` - Summary
- `GET /api/transactions/today` - Today's summary
- `POST /api/transactions` - Create
- `PATCH /api/transactions/:id/notes` - Update notes
- `POST /api/transactions/:id/reverse` - Reverse

### Accounts
- `GET /api/accounts` - List
- `POST /api/accounts` - Create
- `PUT /api/accounts/:id` - Update
- `DELETE /api/accounts/:id` - Delete

### Customers
- `GET /api/customers` - List
- `GET /api/customers/:id` - Detail with transactions
- `POST /api/customers` - Create
- `PUT /api/customers/:id` - Update
- `DELETE /api/customers/:id` - Deactivate

### Transaction Fees
- `GET /api/transaction-fees` - List
- `GET /api/transaction-fees/calculate/:typeId` - Calculate fee
- `POST /api/transaction-fees` - Create
- `PUT /api/transaction-fees/:id` - Update

### Backup
- `GET /api/backup` - List backups
- `POST /api/backup/create` - Create backup
- `POST /api/backup/restore` - Restore backup
- `GET /api/backup/download/:filename` - Download
- `DELETE /api/backup/:filename` - Delete

## Fee Types

| Type | Description | Example |
|------|-------------|---------|
| Fixed | Flat fee | ₱5 per transaction |
| Percentage | % of amount | 1% of ₱1000 = ₱10 |
| Flat + Per Step | Base + increment | ₱30 base + ₱10 per ₱1000 above ₱3000 |
| Tiered | Different rates by amount | ₱0-999: ₱10, ₱1000+: ₱20 |

## Transactions Page Filters

- Search (reference, description, customer name)
- Account
- Transaction Type
- Status (pending, completed, reversed)
- Date Range (start/end)
- Amount Range (min/max)

## Keyboard Shortcuts

- `Ctrl + K` - Global search

## License

Private - All rights reserved.
