FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/backend/package.json ./packages/backend/
RUN npm install --workspace=packages/backend --omit=dev

COPY packages/backend/ ./packages/backend/

RUN cd packages/backend && npm run build

EXPOSE 3001

CMD ["node", "packages/backend/dist/index.js"]
