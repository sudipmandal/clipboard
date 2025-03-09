# Stage 1: Build the Vue.js project
FROM node:23-alpine AS build-stage

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Set up the backend and initialize SQLite
FROM node:23-alpine AS backend-stage

WORKDIR /app

COPY src/backend/package*.json ./backend/
RUN mkdir -p backend && cd backend && npm install sqlite3 express body-parser cors path

COPY src/backend ./backend
COPY --from=build-stage /app/dist /app/dist
RUN node /app/backend/initSQLite.js

# Stage 3: Run the backend server and serve the Vue.js files
FROM node:23-alpine AS production-stage

WORKDIR /app

COPY --from=backend-stage /app /app

EXPOSE 3000

CMD ["node", "/app/backend/server.js"]