# Stage 1: Build the Vue.js project
FROM node:16-alpine as build-stage

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Set up the backend and initialize SQLite
FROM node:16-alpine as backend-stage

WORKDIR /app

RUN cd backend && npm install sqlite3 pm2

COPY src/backend ./backend
COPY --from=build-stage /app/dist /app/dist

RUN node backend/initSQLite.js

# Stage 3: Serve the built project with Nginx and run the backend server
FROM nginx:alpine as production-stage

WORKDIR /app

COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY --from=backend-stage /app/backend /app/backend
COPY --from=backend-stage /app/backend/node_modules /app/backend/node_modules

# Copy Nginx configuration file
COPY nginx.conf /etc/nginx/nginx.conf

# Copy PM2 configuration file
COPY ecosystem.config.js /app/ecosystem.config.js

EXPOSE 80

CMD ["pm2-runtime", "start", "ecosystem.config.js"]