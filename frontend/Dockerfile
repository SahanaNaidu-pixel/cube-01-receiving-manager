# Build context is the frontend/ directory:
#   docker build --build-arg VITE_API_BASE_URL=https://your-backend-domain.com -t receiving-manager-frontend frontend
FROM node:20-alpine AS build

WORKDIR /app

# Reproducible install from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Copy only the sources Vite needs (keeps host node_modules/, dist/ and any local .env files out of the image).
COPY index.html vite.config.js ./
COPY src ./src

# Vite inlines VITE_* variables at build time, so the backend URL must be passed as a build arg.
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
