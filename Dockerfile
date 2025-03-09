# Stage 1: Build the Vue.js project
FROM node:23-alpine AS build-stage

WORKDIR /app

COPY . .
RUN npm install
RUN npm run build

# Stage 2: Set up the backend and initialize SQLite
FROM node:23-alpine AS backend-stage

WORKDIR /app

RUN mkdir -p backend && cd backend && npm install sqlite3 express body-parser cors

COPY src/backend ./backend
RUN node /app/backend/initSQLite.js


# Stage 3: Serve the built project with Nginx and run the backend server
FROM nginx:alpine AS production-stage

WORKDIR /app

# Install PM2 globally
RUN apk add --no-cache nodejs npm && npm install -g pm2

COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY --from=backend-stage /app/backend /app/backend
COPY --from=backend-stage /app/backend/node_modules /app/backend/node_modules
COPY --from=backend-stage /app/database.sqlite /app/backend/database.sqlite
COPY --from=backend-stage /app/database.sqlite /database.sqlite


# Copy Nginx configuration file
COPY nginx.conf /etc/nginx/nginx.conf

# Copy PM2 configuration file
COPY ecosystem.config.js /app/ecosystem.config.js

EXPOSE 80
EXPOSE 3000

CMD ["pm2-runtime", "start", "ecosystem.config.js"]